import assert from "node:assert/strict";
import Module from "node:module";
import vm from "node:vm";
import { test } from "node:test";
const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { PddPageAdapter, transferUnmarkScript } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");
const OPEN = { x: 100, y: 100 }, ROW = { x: 300, y: 200 }, CONFIRM = { x: 400, y: 260 }, UNMARK = { x: 500, y: 350 }, KEEP = { x: 700, y: 350 };

function harness(scenario = "normal") {
  const a = new PddPageAdapter("fictional", "fictional") as any;
  const clicks: string[] = [], intents: string[] = [];
  let confirmed = false, transferred = false, epochChanged = false, blocked: string | null = null;
  const page = { isDestroyed: () => false, webContents: { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: (_method: string, p: any): Promise<unknown> => {
    if (p.type !== "mousePressed") return Promise.resolve({});
    const kind = p.x === OPEN.x ? "open" : p.x === ROW.x ? "row" : p.x === CONFIRM.x ? "confirm" : p.x === KEEP.x ? "keep" : "unmark";
    clicks.push(kind);
    if (kind === "confirm") confirmed = true;
    if (kind === "keep") confirmed = false;
    if (kind === "unmark") {
      assert.equal(intents.length, 1, "intent persisted before any unmark command");
      if (scenario === "sync_throw") throw Error("fictional-command-threw");
      if (scenario === "reject") return Promise.reject(Error("fictional-command-rejected"));
      if (scenario === "hang") return new Promise(() => {});
      if (["native_request", "wrong_request", "duplicate_request", "wrong_page"].includes(scenario)) {
        const dbg = { sendCommand: async () => ({}) };
        const params = { requestId: "fictional-unmark", request: { postData: JSON.stringify({ data: { uid: scenario === "wrong_request" ? "9002" : "9001" } }) } };
        a.onMarkPaused(dbg, params, "unmark", scenario === "wrong_page" ? {} : page);
        if (scenario === "duplicate_request") a.onMarkPaused(dbg, params, "unmark", page);
      }
      confirmed = false;
      transferred = scenario !== "no_departure";
    }
    return Promise.resolve({});
  } } } };
  a.window = page; a.tracker = { status: () => ({ logged_in: true, identity: { platform_shop_id: "mall-1" } }) };
  a.freshActive = async () => "9001"; a.openConversation = async () => null;
  a.scanKeepingFresh = async () => ({ items: [{ key: "9001-x", active: true }] });
  a.starMarked = async () => false;
  a.run = async (script: string) => {
    if (script.includes('"转移失败"')) {
      if (!confirmed && scenario !== "leftover") return null;
      if (scenario === "ambiguous") return "failure_not_unique";
      if (script.includes('return "ok";')) {
        if (scenario === "covered") return "unmark_covered";
        if (scenario === "switch" && !epochChanged) { a.watchEpoch++; epochChanged = true; }
        if (scenario === "input") a.markWatch.foreign++;
        if (scenario === "lease" || scenario === "deadline") blocked = scenario === "lease" ? "lease_invalid" : "claim_expiring";
        if (scenario === "login_restored") {
          const saved = a.tracker;
          a.tracker = { status: () => ({ logged_in: false }) }; a.markCheck(); a.tracker = saved;
        }
        return "ok";
      }
      return { text: "已收藏", unfav: UNMARK, keep: KEEP };
    }
    if (script.includes("const popovers")) return { dialogs: 0, popovers: 0 };
    if (script.includes("return { cells")) return [{ cells: ["fictional-main", "online"], button: ROW }];
    if (script.includes("aria-describedby")) return script.includes("const check = null") ? [{ text: "无原因直接转移", ...CONFIRM }] : "ok";
    if (script.includes("target_button_not_unique")) return ROW;
    if (script.includes('"转移会话"')) return OPEN;
    if (script.includes("freshBuyer")) return { items: [{ key: transferred ? "9002-x" : "9001-x", active: !transferred }] };
    throw Error("Unexpected fictional script");
  };
  const request = (allow = true) => ({ conversation_id: "9001", account: "fictional-main", allow_unmark: allow,
    before_unmark: () => { intents.push("unmark_and_transfer"); }, attempt_id: "fictional-attempt", deadline: Date.now() / 1000 + 8, recheck: () => blocked });
  return { a, clicks, intents, request };
}

for (const scenario of ["normal", "native_request", "wrong_request", "duplicate_request", "wrong_page", "sync_throw", "reject", "hang"]) {
  test(`${scenario}: actual formal helper tries the native combined button once, records intent first and releases busy`, async () => {
    const h = harness(scenario), start = Date.now();
    const result = await h.a.transferConversation(h.request());
    const success = scenario === "normal" || scenario === "native_request";
    assert.equal(result.status, success ? "confirmed" : "unknown");
    if (success) assert.equal(result.unmarked, true);
    else assert.equal(result.reason, "transfer_binding_unproven");
    assert.deepEqual(h.clicks, ["open", "row", "confirm", "unmark"]); assert.equal(h.intents.length, 1);
    assert.equal(h.a.sending, false); assert.equal(h.a.markWatch, null); assert.equal(h.a.transferUnmarkWatch, null);
    assert(Date.now() - start < 4000); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(h.clicks.filter(c => c === "unmark").length, 1);
  });
}

for (const scenario of ["ambiguous", "covered", "switch", "input", "lease", "deadline", "login_restored"]) {
  test(`${scenario}: a refused transfer never permits a stale or ambiguous unmark click`, async () => {
    const h = harness(scenario), result = await h.a.transferConversation(h.request());
    assert.equal(result.status, "unknown"); assert.equal(h.intents.length, 0);
    assert(!h.clicks.includes("unmark")); assert.equal(h.a.sending, false);
  });
}

test("combined button dispatched without observed departure remains unknown and is not clicked twice", async () => {
  const h = harness("no_departure");
  const result = await h.a.transferConversation({ ...h.request(), deadline: Date.now() / 1000 + 3 });
  assert.equal(result.status, "unknown");
  assert.equal(h.clicks.filter(c => c === "unmark").length, 1);
  assert.equal(h.intents.length, 1);
});

test("permission off preserves favorite, while a failure box left from another attempt prevents all clicks", async () => {
  const off = harness(); assert.equal((await off.a.transferConversation(off.request(false))).status, "unknown");
  assert.deepEqual(off.clicks, ["open", "row", "confirm", "keep"]); assert.equal(off.intents.length, 0);
  assert.equal(await off.a.run(transferUnmarkScript("9001")), null, "the refusal is dismissed without cancelling favorite");
  const old = harness("leftover"); assert.equal((await old.a.transferConversation(old.request())).status, "not_sent");
  assert.deepEqual(old.clicks, []); assert.equal(old.intents.length, 0);
});

class Element {
  children: Element[] = []; parentElement: Element | null = null;
  constructor(public text = "", public disabled = false) {}
  get innerText(): string { return this.text || this.children.map(c => c.innerText).join(" "); }
  add(...children: Element[]) { this.children.push(...children); for (const c of children) c.parentElement = this; return this; }
  querySelectorAll(): Element[] { return this.children.flatMap(c => [c, ...c.querySelectorAll()]); }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 470, top: 340, width: 60, height: 20 }; }
  contains(e: Element): boolean { return e === this || this.children.some(c => c.contains(e)); }
  closest() { return this.disabled ? this : null; }
}

test("actual generated unmark script checks unique visible failure, buyer and exact hit in one DOM snapshot", () => {
  for (const scenario of ["ok", "same_buyer_twice", "other_buyer", "two_buyers", "bad_key", "no_buyer", "duplicate_title", "duplicate_button", "disabled", "covered"]) {
    const button = new Element("取消收藏并转移", scenario === "disabled");
    const box = new Element().add(new Element("转移失败"), new Element("已收藏的会话不可转移"), button, new Element("暂不转移收藏会话"));
    if (scenario === "duplicate_title") box.add(new Element("转移失败"));
    if (scenario === "duplicate_button") box.add(new Element("取消收藏并转移"));
    const body = new Element().add(box);
    const keys = scenario === "other_buyer" ? ["9002-x"] : scenario === "two_buyers" ? ["9001-x", "9002-x"] : scenario === "bad_key" ? ["bad"] : scenario === "no_buyer" ? [] : scenario === "same_buyer_twice" ? ["9001-x", "9001-y"] : ["9001-x"];
    const document = { body, querySelectorAll: () => keys.map(k => ({ getClientRects: () => [{}], classList: { contains: () => true }, getAttribute: () => k })), elementFromPoint: () => scenario === "covered" ? body : button };
    const context = { document, getComputedStyle: () => ({ visibility: "visible" }) };
    const result = vm.runInNewContext(transferUnmarkScript("9001", UNMARK), context);
    if (scenario === "ok" || scenario === "same_buyer_twice") assert.equal(result, "ok");
    else assert.notEqual(result, "ok", scenario);
  }
});

test("actual generated refusal reader retains and validates the keep-favorite button", () => {
  const unfav = new Element("取消收藏并转移"), keep = new Element("暂不转移收藏会话");
  const body = new Element().add(new Element().add(new Element("转移失败"), new Element("已收藏的会话不可转移"), unfav, keep));
  let hit = unfav;
  const document = { body, querySelectorAll: () => [{ getClientRects: () => [{}], classList: { contains: () => true }, getAttribute: () => "9001-x" }], elementFromPoint: () => hit };
  const context = { document, getComputedStyle: () => ({ visibility: "visible" }) };
  const failure = vm.runInNewContext(transferUnmarkScript("9001"), context);
  assert(failure.keep && Number.isFinite(failure.keep.x), "keep target must survive the actual page reader");
  hit = keep;
  assert.equal(vm.runInNewContext(transferUnmarkScript("9001", failure.keep, true), context), "ok");
  hit = body;
  assert.notEqual(vm.runInNewContext(transferUnmarkScript("9001", failure.keep, true), context), "ok");
});
