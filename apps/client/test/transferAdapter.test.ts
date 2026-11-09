import assert from "node:assert/strict";
import Module from "node:module";
import vm from "node:vm";
import { test } from "node:test";
const req = Module.createRequire(__filename), electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: {} } } as unknown as NodeModule;
const { PddPageAdapter, transferDialogBlankScript } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

for (const [name, options, expected] of [
  ["owned backdrop", {}, "dispatched"],
  ["same buyer repeated", { keys: ["9001-a", "9001-b"] }, "dispatched"],
  ["dialog already gone", { count: 0 }, "missing"],
  ["two dialogs", { count: 2 }, "dialog_not_unique"],
  ["different buyer", { keys: ["9002-a"] }, "conversation_mismatch"],
  ["multiple buyers", { keys: ["9001-a", "9002-a"] }, "conversation_mismatch"],
  ["bad key", { keys: ["bad"] }, "conversation_mismatch"],
  ["no active buyer", { keys: [] }, "conversation_mismatch"],
  ["no owned wrapper", { noWrapper: true }, "missing"],
  ["underlying send button", { covered: true }, "covered"],
  ["late evaluation", { expired: true }, "expired"],
] as [string, { keys?: string[]; count?: number; noWrapper?: boolean; covered?: boolean; expired?: boolean }, string][]) {
  test(`actual blank-dismiss script: ${name}, never clicks underlying page`, () => {
    let clicks = 0, underlying = 0;
    const visible = { getClientRects: () => [{}] };
    const backdrop = { ...visible, click: () => clicks++, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 700 }) };
    const dialog = { ...visible, querySelector: () => ({ innerText: "转移会话" }), closest: () => options.noWrapper ? null : backdrop,
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 900, bottom: 600 }) };
    const button = { click: () => underlying++ };
    const document = { querySelectorAll: (s: string) => s === "div.el-dialog" ? Array(options.count ?? 1).fill(dialog) :
      (options.keys ?? ["9001-a"]).map(key => ({ ...visible, classList: { contains: () => true }, getAttribute: () => key })),
      elementFromPoint: () => options.covered ? button : backdrop };
    const result = vm.runInNewContext(transferDialogBlankScript("9001", options.expired ? 0 : Date.now() + 1000),
      { document, innerWidth: 1000, innerHeight: 700, getComputedStyle: () => ({ visibility: "visible" }) });
    assert.equal(result, expected); assert.equal(clicks, expected === "dispatched" ? 1 : 0); assert.equal(underlying, 0);
  });
}
const OPEN = { x: 100, y: 100 }, ROW = { x: 300, y: 200 }, CONFIRM = { x: 400, y: 260 };

type Options = {
  names?: readonly string[]; marked?: boolean | null; hangingRows?: boolean; rowDelay?: number;
  onRow?: (a: any) => void; stateReadHangs?: boolean; openFails?: string;
  observation?: "missing" | "present" | "empty" | "malformed" | "page_changed" | "login_changed" | "input";
};
function harness(opts: Options = {}) {
  const a = new PddPageAdapter("fictional", "fictional") as any;
  const clicks: string[] = [], scripts: string[] = [], keys: string[] = [];
  let dialogOpen = false, openedAt = 0, conversationOpen = true, confirmed = false, observed = false;
  const page = { isDestroyed: () => false, webContents: { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: async (method: string, p: any) => {
    if (method === "Input.dispatchKeyEvent") { keys.push(p.type); conversationOpen = false; }
    if (p.type === "mousePressed") {
      clicks.push(p.x === OPEN.x ? "open" : p.x === ROW.x ? "row" : p.x === CONFIRM.x ? "confirm" : "unexpected");
      if (p.x === OPEN.x) { dialogOpen = true; openedAt = Date.now(); }
      if (p.x === ROW.x) opts.onRow?.(a);
      if (p.x === CONFIRM.x) confirmed = true;
    }
    return {};
  } } } };
  a.window = page; a.tracker = { status: () => ({ logged_in: true, identity: { platform_shop_id: "mall-1" } }) };
  a.freshActive = async () => "9001";
  const opened: string[] = [];
  a.openConversation = async (uid: string) => {
    assert.equal(a.sending, true, "switching conversations must own the page");
    opened.push(uid); return opts.openFails ?? null;
  };
  a.starMarked = async () => {
    assert.equal(a.sending, true, "execution-time reads must own the page");
    return opts.stateReadHangs ? new Promise(() => {}) : opts.marked === undefined ? false : opts.marked;
  };
  a.scanKeepingFresh = async () => ({ items: [{ key: "9001-x", active: true }] });
  a.run = async (script: string) => {
    scripts.push(script);
    if (script.includes('"转移失败"')) return null;
    if (script.includes("const popovers")) return { dialogs: dialogOpen ? 1 : 0, popovers: 0 };
    if (script.includes("const backdrop =")) {
      if (!dialogOpen) return "missing";
      clicks.push("blank"); dialogOpen = false;
      return "dispatched";
    }
    if (script.includes("return { cells")) {
      if (opts.hangingRows) return new Promise(() => {});
      if (Date.now() - openedAt < (opts.rowDelay ?? 0)) return [];
      return (opts.names ?? ["fictional-main"]).map(n => ({ cells: [n, "online", "fictional-main"], button: ROW }));
    }
    if (script.includes("aria-describedby")) return script.includes("const check = null") ? [{ text: "无原因直接转移", ...CONFIRM }] : "ok";
    if (script.includes("target_button_not_unique")) return ROW;
    if (script.includes('"转移会话"')) return OPEN;
    if (script.includes("freshBuyer")) {
      if (confirmed) observed = true;
      if (!confirmed || opts.observation === "present") return { items: [{ key: "9001-x", active: true }] };
      if (opts.observation === "empty") return { items: [] };
      if (opts.observation === "malformed") return { items: [{ key: "invalid", active: false }] };
      if (opts.observation === "page_changed") a.watchEpoch++;
      if (opts.observation === "login_changed") a.tracker = { status: () => ({ logged_in: false }) };
      if (opts.observation === "input") a.markWatch.foreign++;
      return { items: [{ key: "9002-x", active: false }] };
    }
    return "unexpected_script";
  };
  return { a, page, clicks, scripts, keys, opened, isDialogOpen: () => dialogOpen, isConversationOpen: () => conversationOpen, hasObserved: () => observed, setDialogOpen: () => { dialogOpen = true; } };
}
function request(extra = {}) { return { conversation_id: "9001", account: "fictional-main", allow_unmark: false,
  attempt_id: "fictional-attempt", deadline: Date.now() / 1000 + 10, recheck: (): string | null => null, ...extra }; }

test("on-demand transfer needs no recipient cache and opens its dialog once", async () => {
  const h = harness(), result = await h.a.transferConversation(request());
  assert.equal(result.status, "confirmed");
  assert.equal(result.page_observed, "left_list");
  assert.deepEqual(h.clicks, ["open", "row", "confirm"]);
  assert.deepEqual(h.opened, ["9001"], "switches to the buyer's conversation before transferring");
  assert.equal(h.a.sending, false); assert.equal(h.a.markWatch, null);
  assert(h.scripts.some(s => s.includes('"fictional-main"') && s.includes("target_button_not_unique")));
});

test("buyer conversation cannot be opened: not_sent with that reason and no click", async () => {
  const h = harness({ openFails: "pdd_conversation_not_in_list" }), result = await h.a.transferConversation(request());
  assert.deepEqual(result, { status: "not_sent", reason: "pdd_conversation_not_in_list" });
  assert.deepEqual(h.clicks, []); assert.equal(h.a.sending, false); assert.equal(h.a.markWatch, null);
});

test("recipient loading longer than the former preparation budget still transfers within the send deadline", async () => {
  const h = harness({ rowDelay: 2100 }), result = await h.a.transferConversation(request());
  assert.equal(result.status, "confirmed"); assert.deepEqual(h.clicks, ["open", "row", "confirm"]);
});

for (const [name, names, reason] of [
  ["missing", ["other-account"], "transfer_target_missing"],
  ["nickname or remark only", ["different-first-column"], "transfer_target_missing"],
  ["prefix is not exact", ["fictional-main-extra"], "transfer_target_missing"],
  ["duplicate exact accounts", ["fictional-main", "fictional-main"], "transfer_target_ambiguous"],
] as const) {
  test(`${name}: never choose a recipient by row position or another column`, async () => {
    const h = harness({ names }), result = await h.a.transferConversation(request());
    assert.equal(result.status, "not_sent"); assert.equal(result.reason, reason);
    assert.deepEqual(h.clicks, ["open", "blank"]);
    assert.equal(h.isDialogOpen(), false); assert.equal(h.isConversationOpen(), true);
    assert.deepEqual(h.keys, []); assert.equal(h.a.sending, false);
  });
}

for (const [name, opts, reason] of [
  ["unknown state", { marked: null }, "conv_state_unavailable"],
  ["state read hangs", { stateReadHangs: true }, "conv_state_unavailable"],
  ["marked without permission", { marked: true }, "transfer_blocked_by_mark"],
] as const) {
  test(`execution-time ${name}: no dialog or target click`, async () => {
    const h = harness(opts), result = await h.a.transferConversation(request());
    assert.equal(result.status, "not_sent"); assert.equal(result.reason, reason);
    assert.deepEqual(h.clicks, []); assert.equal(h.a.markWatch, null);
  });
}

test("a dialog left by another operation prevents all new clicks", async () => {
  const h = harness(); h.setDialogOpen();
  const result = await h.a.transferConversation(request());
  assert.equal(result.status, "not_sent"); assert.equal(result.reason, "transfer_leftover_popup");
  assert.deepEqual(h.clicks, []); assert.equal(h.isDialogOpen(), true);
});

test("expired decision and hung identity gate never open a dialog", async () => {
  const expired = harness();
  assert.equal((await expired.a.transferConversation(request({ deadline: Date.now() / 1000 - 1 }))).status, "not_sent");
  assert.deepEqual(expired.clicks, []);
  const hung = harness(); hung.a.actionGate = () => new Promise(() => {});
  const result = await hung.a.transferConversation(request());
  assert.equal(result.status, "not_sent"); assert.deepEqual(hung.clicks, []); assert.equal(hung.a.sending, false);
});

test("recipient rows arriving after the action deadline never allow a late target click", async () => {
  const h = harness({ rowDelay: 900 });
  const result = await h.a.transferConversation(request({ deadline: Date.now() / 1000 + 0.6 }));
  assert.equal(result.status, "not_sent");
  assert(!h.clicks.includes("row")); assert(!h.clicks.includes("confirm"));
});

test("hung recipient reading stops at its action deadline and releases the page", async () => {
  const h = harness({ hangingRows: true }), started = Date.now();
  const result = await h.a.transferConversation(request({ deadline: Date.now() / 1000 + 0.7 }));
  assert.equal(result.status, "not_sent"); assert(Date.now() - started < 2500);
  assert(!h.clicks.includes("row")); assert.equal(h.a.sending, false);
});

for (const scenario of ["page", "login", "lease"] as const) {
  test(`after row ${scenario} changes: unknown with no confirmation or retry`, async () => {
    let revoked = false;
    const h = harness({ onRow: a => {
      if (scenario === "page") a.watchEpoch++;
      if (scenario === "login") a.tracker = { status: () => ({ logged_in: false }) };
      if (scenario === "lease") revoked = true;
    } });
    const result = await h.a.transferConversation(request({ recheck: () => revoked ? "lease_invalid" : null }));
    assert.equal(result.status, "unknown");
    assert.equal(h.clicks.filter(x => x === "row").length, 1); assert(!h.clicks.includes("confirm"));
    assert.equal(h.a.sending, false);
  });
}

test("confirmation starts within the original budget and completion after it still succeeds within the claim deadline", async () => {
  const h = harness();
  const result = await h.a.transferConversation(request({ recheck: () => h.hasObserved() ? "reply_deadline_exceeded" : null }));
  assert.equal(result.status, "confirmed");
  assert.deepEqual(h.clicks, ["open", "row", "confirm"]);
});

for (const observation of ["present", "empty", "malformed", "page_changed", "login_changed", "input"] as const) {
  test(`after confirmation ${observation}: cannot complete as success and never retries`, async () => {
    const h = harness({ observation });
    const result = await h.a.transferConversation(request({ deadline: Date.now() / 1000 + 2.2 }));
    assert.equal(result.status, "unknown");
    assert.equal(h.clicks.filter(x => x === "row").length, 1);
    assert.equal(h.clicks.filter(x => x === "confirm").length, 1);
    assert.equal(h.a.sending, false);
  });
}

test("warmup yields before on-demand transfer; a changed page cannot use the old decision", async () => {
  const h = harness(); h.a.yieldWarm = async () => { h.a.watchEpoch++; };
  const result = await h.a.transferConversation(request());
  assert.equal(result.status, "not_sent"); assert.deepEqual(h.clicks, []);
});

test("actual generated row script checks unique buyer and exact account in its own DOM snapshot", async () => {
  const h = harness(); await h.a.transferConversation(request());
  const script = h.scripts.find(s => s.includes("target_button_not_unique") && s.includes("scrollIntoView"))!; assert(script);
  const button: any = { innerText: "转移", children: [], getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 200, top: 100, width: 80, height: 30 }), scrollIntoView() {}, contains: (e: unknown) => e === button };
  const row = { querySelector: () => ({ innerText: "fictional-main" }), querySelectorAll: () => [button], getClientRects: () => [{}] };
  const dlg = { querySelector: () => ({ innerText: "转移会话" }), querySelectorAll: () => [row], getClientRects: () => [{}] };
  for (const [keys, ok] of [[["9001-a"], true], [["9001-a", "9001-b"], true], [["9002-a"], false], [["9001-a", "9002-a"], false], [["bad"], false], [[], false]] as const) {
    const doc = { querySelectorAll: (selector: string) => selector === "div.el-dialog" ? [dlg] : keys.map(key => ({ classList: { contains: () => true }, getAttribute: () => key })), elementFromPoint: () => button };
    const result = vm.runInNewContext(script, { document: doc, getComputedStyle: () => ({ visibility: "visible" }) });
    if (ok) assert.equal(typeof result.x, "number"); else assert.equal(result, "conversation_mismatch");
  }
});
