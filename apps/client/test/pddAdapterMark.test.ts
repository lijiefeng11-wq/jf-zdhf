import assert from "node:assert/strict";
import Module from "node:module";
import { describe, test } from "node:test";
import type { MarkResult } from "../src/core/adapter.js";
import type { MarkColor } from "../src/core/protocol.js";

// 用 Electron 替身实例化真实的 PddPageAdapter，经真实的网络监听（Fetch 拦截 + Network 响应）执行标星；
// 不创建真实窗口、不连接平台。全部为虚构编号与虚构响应。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter, CONV_STAR_SNAPSHOT, starOptionsScript, POPUP_BLOCK_PATHS, popupBlockPath } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const BUYER = "880011223344";
const OTHER = "880099887766";
const MARK = "/plateau/chat/mark_conversation";
const UNMARK = "/plateau/chat/unmark_conversation";
const REQ_ID = 1790000000123;
const okBody = (requestId: number = REQ_ID) => JSON.stringify({ success: true, result: { success: true, result: "ok", request_id: requestId, response: "虚构" } });

type Option = { color: string; checked: boolean; x: number; y: number };
type Page = {
  /** 同一次快照里打开的会话 key 与星标是否已收藏；字符串为脚本返回的原因。 */
  snap: { keys: unknown[]; active: boolean } | string;
  star: { x: number; y: number; active: boolean } | string;
  /** 悬停后第几次读取浮层才出现（之前返回 popover_missing）。 */
  popAfter: number;
  pop: { keys: unknown[]; active: boolean; options: Option[] } | string;
  owned: string;
  /** 点击后再读快照（页面观察）。 */
  after: { keys: unknown[]; active: boolean } | string;
};

const OPTIONS: Option[] = [
  { color: "orange", checked: false, x: 100, y: 200 },
  { color: "red", checked: false, x: 100, y: 230 },
  { color: "green", checked: false, x: 100, y: 260 },
  { color: "blue", checked: false, x: 100, y: 290 },
];
const PAGE: Page = {
  snap: { keys: [`${BUYER}-0`], active: false },
  star: { x: 50, y: 20, active: false },
  popAfter: 1,
  pop: { keys: [`${BUYER}-0`], active: false, options: OPTIONS },
  owned: "ok",
  after: { keys: [`${BUYER}-0`], active: true },
};

type Net = {
  /** 页面发出一条请求：先 Network.requestWillBeSent，再 Fetch.requestPaused。networkId=null 模拟拦截事件不带浏览器编号。 */
  request(id: string, path: string, data: unknown, networkId?: string | null): void;
  respond(id: string, body: string): void;
  /** 加载结束但取不到响应体。 */
  finishNoBody(id: string): void;
  fail(id: string): void;
};

type Opts = {
  page?: Partial<Page>;
  onClick?: (net: Net, a: any, h: Hooks) => void;
  onScript?: (name: string, a: any, h: Hooks) => void;
  /** 读取响应体期间发生的事（如页面重建）。 */
  onBody?: (a: any) => void;
  /** 前台每条鼠标命令产生几条页面输入事件（真实 Electron 实测为 1）。 */
  inputsPerCommand?: number;
};
type Hooks = { human(type: string): void; identity: { shop: string; logged_in: boolean } };

function harness(opts: Opts = {}) {
  const page = { ...PAGE, ...opts.page };
  const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
  let listener: (e: unknown, method: string, params: any) => void = () => undefined;
  let onInput: (e: unknown, input: { type: string }) => void = () => undefined;
  const identity = { shop: "pdd-shop-x", logged_in: true };
  const hooks: Hooks = { human: (type) => onInput(null, { type }), identity };
  const CDP_INPUT: Record<string, string> = { mouseMoved: "mouseMove", mousePressed: "mouseDown", mouseReleased: "mouseUp" };
  let attached = false;
  const bodies = new Map<string, string>();
  const log = { clicks: [] as { x: number; y: number }[], hovers: [] as { x: number; y: number }[], continued: [] as string[], failed: [] as string[], fulfilled: [] as { requestId: string; body: string }[], fetchPatterns: [] as string[], scripts: [] as string[], ownedCode: "" };
  let pops = 0;
  const net: Net = {
    request(id, path, data, networkId) {
      const url = "https://mms.pinduoduo.com" + path;
      const postData = JSON.stringify({ data });
      listener(null, "Network.requestWillBeSent", { requestId: id, request: { url, postData } });
      listener(null, "Fetch.requestPaused", { requestId: `f-${id}`, ...(networkId === null ? {} : { networkId: networkId ?? id }), request: { url, postData } });
    },
    respond(id, body) {
      bodies.set(id, body);
      listener(null, "Network.loadingFinished", { requestId: id });
    },
    finishNoBody(id) {
      listener(null, "Network.loadingFinished", { requestId: id });
    },
    fail(id) {
      listener(null, "Network.loadingFailed", { requestId: id });
    },
  };
  const dbg = {
    isAttached: () => attached,
    attach: () => void (attached = true),
    on: (_e: string, fn: typeof listener) => void (listener = fn),
    sendCommand: async (method: string, params: any) => {
      if (method === "Fetch.enable") log.fetchPatterns.push(...params.patterns.map((p: any) => p.urlPattern));
      if (method === "Fetch.continueRequest") log.continued.push(params.requestId);
      if (method === "Fetch.failRequest") log.failed.push(params.requestId);
      if (method === "Fetch.fulfillRequest") log.fulfilled.push({ requestId: params.requestId, body: Buffer.from(params.body, "base64").toString() });
      if (method === "Network.getResponseBody") {
        const body = bodies.get(params.requestId);
        opts.onBody?.(adapter);
        if (body === undefined) throw new Error("no body");
        return { body, base64Encoded: false };
      }
      // 与真实 Electron 一致：调试通道的鼠标命令在返回前产生对应类型的页面输入事件。
      if (method === "Input.dispatchMouseEvent") for (let i = 0; i < (opts.inputsPerCommand ?? 1); i++) onInput(null, { type: CDP_INPUT[params.type] });
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") log.hovers.push({ x: params.x, y: params.y });
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        log.clicks.push({ x: params.x, y: params.y });
        opts.onClick?.(net, adapter, hooks);
      }
      return {};
    },
  };
  const script = (code: string): unknown => {
    if (code.includes("freshBuyer")) return { items: [{ key: `${BUYER}-0`, unread: false, active: true }], freshBuyer: false };
    if (code.includes("all-chat-list")) return true;
    if (code === CONV_STAR_SNAPSHOT) return log.clicks.length ? page.after : page.snap;
    if (code.includes("aria-describedby")) {
      if (code.includes("const check = null")) return ++pops < page.popAfter ? "popover_missing" : page.pop;
      return page.owned;
    }
    if (code.includes("收藏该用户")) return page.star;
    return null;
  };
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html",
    debugger: dbg,
    executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
      const name = code === CONV_STAR_SNAPSHOT ? (log.clicks.length ? "after" : "snap") : code.includes("aria-describedby") ? (code.includes("const check = null") ? "pop" : "owned") : code.includes("收藏该用户") ? "star" : "other";
      log.scripts.push(name);
      if (name === "owned") log.ownedCode = code;
      opts.onScript?.(name, adapter, hooks);
      return script(code);
    },
    on: (event: string, fn: typeof onInput) => {
      if (event === "input-event") onInput = fn;
    },
  };
  const win = { isDestroyed: () => false, webContents };
  adapter.window = win;
  adapter.tracker = { status: () => ({ logged_in: identity.logged_in, identity: identity.logged_in ? { platform_shop_id: identity.shop, display_name: "虚构店铺" } : null }), history: () => ({ messages: [] }) };
  adapter.attachNetwork(win);
  const mark = (color: MarkColor = "red", seconds = 3, recheck: () => string | null = () => null): Promise<MarkResult> =>
    adapter.markConversation({ conversation_id: BUYER, color, attempt_id: "att-1", deadline: Date.now() / 1000 + seconds, recheck });
  return { adapter, log, net, mark, hooks };
}

/** 本阶段的“全部满足”：没有正向绑定依据，结论仍是 unknown（mark_binding_unproven），不报成功。 */
const criteriaMet = (r: MarkResult) => r.status === "unknown" && r.reason === "mark_binding_unproven";

/** 页面对点击的正常反应：发出一条与本次一致的标星请求，稍后得到响应。 */
const pageSends = (color = 2, body = okBody(), uid = BUYER) => (net: Net) => {
  net.request("n-1", MARK, { uid, color, request_id: REQ_ID });
  setTimeout(() => net.respond("n-1", body), 30);
};

describe("标星：点击与成功判据（Electron 替身）", () => {
  test("拦截规则包含标星与取消收藏接口", () => {
    const h = harness();
    for (const p of [MARK, UNMARK]) assert.ok(h.log.fetchPatterns.includes(`*://mms.pinduoduo.com${p}*`));
  });

  test("推广与考核提醒弹窗接口：本机回空结果，不到达平台；发送等其他请求照常放行", () => {
    const h = harness();
    for (const p of POPUP_BLOCK_PATHS) assert.ok(h.log.fetchPatterns.includes(`*://mms.pinduoduo.com${p}*`), p);
    POPUP_BLOCK_PATHS.forEach((p, i) => h.net.request(`p-${i}`, p, {}));
    assert.deepEqual(h.log.fulfilled.map((f) => f.requestId), POPUP_BLOCK_PATHS.map((_, i) => `f-p-${i}`));
    for (const f of h.log.fulfilled) assert.deepEqual(JSON.parse(f.body), { success: true, errorCode: 1000000, errorMsg: null, result: {} });
    assert.deepEqual(h.log.continued, []);
    assert.deepEqual(h.log.failed, []);
    // 未分配会话等与收发有关的提醒、以及其他域名上的同名路径不屏蔽。
    for (const url of ["https://mms.pinduoduo.com/tornado/popup/judgePushUnAssignPopup", "https://mms.pinduoduo.com/chats/checkMallChatEnabled", "https://example.invalid/tornado/popup/popupExistPreCheck", "https://mms.pinduoduo.com/tornado/popup/popupExistPreCheckX", null]) assert.equal(popupBlockPath(url), null, String(url));
    assert.equal(popupBlockPath("https://mms.pinduoduo.com/desert/stat/popup/mallReplyRateWarning?x=1"), "/desert/stat/popup/mallReplyRateWarning");
    h.net.request("s-1", "/plateau/chat/send_message", { text: "虚构" });
    assert.deepEqual(h.log.continued, ["f-s-1"]);
    assert.equal(h.log.fulfilled.length, POPUP_BLOCK_PATHS.length);
  });

  test("全部满足：只点目标颜色项一次，放行一条请求，按它自己的响应确认；不点星标本身", async () => {
    const h = harness({ onClick: pageSends() });
    const r = await h.mark("red");
    assert.deepEqual(r, { status: "unknown", reason: "mark_binding_unproven", page_observed: "marked" });
    assert.deepEqual(h.log.clicks, [{ x: 100, y: 230 }]);
    assert.deepEqual(h.log.continued, ["f-n-1"]);
    assert.deepEqual(h.log.failed, []);
    // 先悬停星标，再移到目标颜色项，结束后移开鼠标。
    assert.deepEqual(h.log.hovers, [{ x: 50, y: 20 }, { x: 100, y: 230 }, { x: 1, y: 1 }]);
    assert.equal(h.adapter.markWatch, null);
    assert.equal(h.adapter.sending, false);
    assert.ok(h.log.ownedCode.includes(`"buyer":"${BUYER}"`), "最终核对带本事件买家");
  });

  test("默认色（黄色）用数值 1 核对", async () => {
    const h = harness({ onClick: pageSends(1) });
    assert.ok(criteriaMet(await h.mark("orange")));
    assert.deepEqual(h.log.clicks, [{ x: 100, y: 200 }]);
  });

  test("同一买家同时出现在两个列表：按买家去重后视为唯一", async () => {
    const keys = [`${BUYER}-0`, `${BUYER}-1`];
    const h = harness({ page: { snap: { keys, active: false }, pop: { keys, active: false, options: OPTIONS } }, onClick: pageSends() });
    assert.ok(criteriaMet(await h.mark()));
  });

  test("页面观察只供显示：确认成功但星标读不到时观察为 unknown，仍按响应确认", async () => {
    const h = harness({ page: { after: "star_missing" }, onClick: pageSends() });
    assert.deepEqual(await h.mark(), { status: "unknown", reason: "mark_binding_unproven", page_observed: "unknown" });
  });
});

describe("标星：点击前核对不通过一律不点击", () => {
  for (const [name, page, reason] of [
    ["打开的是另一个买家", { snap: { keys: [`${OTHER}-0`], active: false } }, "conv_state_changed"],
    ["两个不同买家都打开", { snap: { keys: [`${BUYER}-0`, `${OTHER}-0`], active: false } }, "conv_state_changed"],
    ["打开项混入坏 key", { snap: { keys: [`${BUYER}-0`, null], active: false } }, "conv_state_changed"],
    ["已收藏", { snap: { keys: [`${BUYER}-0`], active: true } }, "conv_state_changed"],
    ["星标缺失", { snap: "star_missing" }, "conv_state_unavailable"],
    ["星标不唯一", { snap: "star_not_unique" }, "conv_state_unavailable"],
    ["快照格式不对", { snap: { keys: `${BUYER}-0`, active: false } }, "conv_state_unavailable"],
    ["星标坐标取不到", { star: "star_missing" }, "conv_state_unavailable"],
    ["浮层始终没有出现", { popAfter: 99 }, "conv_state_unavailable"],
    ["浮层不能证明属于星标", { pop: "popover_unlinked" }, "conv_state_unavailable"],
    ["浮层不唯一", { pop: "popover_not_unique" }, "conv_state_unavailable"],
    ["悬停后打开的会话变了", { pop: { keys: [`${OTHER}-0`], active: false, options: OPTIONS } }, "conv_state_changed"],
    ["悬停后发现已收藏", { pop: { keys: [`${BUYER}-0`], active: true, options: OPTIONS } }, "conv_state_changed"],
    ["目标颜色缺失", { pop: { keys: [`${BUYER}-0`], active: false, options: OPTIONS.filter((o) => o.color !== "red") } }, "conv_state_unavailable"],
    ["目标颜色重复", { pop: { keys: [`${BUYER}-0`], active: false, options: [...OPTIONS, OPTIONS[1]] } }, "conv_state_unavailable"],
    ["目标颜色已勾选", { pop: { keys: [`${BUYER}-0`], active: false, options: OPTIONS.map((o) => (o.color === "red" ? { ...o, checked: true } : o)) } }, "conv_state_unavailable"],
    ["目标点不在星标浮层内", { owned: "target_not_in_star_popover" }, "conv_state_unavailable"],
    ["目标点颜色不符", { owned: "target_color_mismatch" }, "conv_state_unavailable"],
    ["最终核对时会话已换走（页面代次不变）", { owned: "conversation_mismatch" }, "conv_state_changed"],
    ["最终核对时同买家已被收藏（页面代次不变）", { owned: "already_marked" }, "conv_state_changed"],
    ["最终核对时目标颜色已勾选", { owned: "target_checked" }, "conv_state_unavailable"],
  ] as const) {
    test(`${name}：not_sent（${reason}），不点击`, async () => {
      const h = harness({ page: page as Partial<Page> });
      assert.deepEqual(await h.mark(), { status: "not_sent", reason });
      assert.equal(h.log.clicks.length, 0);
      assert.equal(h.adapter.sending, false);
    });
  }

  for (const at of ["snap", "star", "pop", "owned"]) {
    test(`核对期间页面代次变化（${at}）：not_sent conv_state_changed，不点击`, async () => {
      const h = harness({ onScript: (name, a) => void (name === at && a.watchEpoch++) });
      assert.deepEqual(await h.mark(), { status: "not_sent", reason: "conv_state_changed" });
      assert.equal(h.log.clicks.length, 0);
    });
  }

  test("运行时再核验不通过：按其原因 not_sent，不点击", async () => {
    const h = harness();
    assert.deepEqual(await h.mark("red", 3, () => "superseded"), { status: "not_sent", reason: "superseded" });
    assert.equal(h.log.clicks.length, 0);
  });

  test("离确认截止不足 1.5 秒：not_sent，不点击", async () => {
    const h = harness();
    assert.deepEqual(await h.mark("red", 1.2), { status: "not_sent", reason: "claim_expiring" });
    assert.equal(h.log.clicks.length, 0);
  });

  test("页面正忙（发送进行中）：not_sent，不碰页面", async () => {
    const h = harness();
    h.adapter.sending = true;
    assert.deepEqual(await h.mark(), { status: "not_sent", reason: "pdd_send_busy" });
    assert.equal(h.log.scripts.length, 0);
  });
});

describe("标星：点击窗口内的请求核对", () => {
  for (const [name, color, uid, reason] of [
    ["目标买家不符", 2, OTHER, "mark_request_blocked"],
    ["颜色不符", 1, BUYER, "mark_request_blocked"],
  ] as const) {
    test(`${name}：在本机拦截，不到达平台；unknown`, async () => {
      const h = harness({ onClick: pageSends(color, okBody(), uid) });
      const r = await h.mark("red", 2);
      assert.deepEqual([r.status, r.status !== "confirmed" && r.reason], ["unknown", reason]);
      assert.deepEqual(h.log.failed, ["f-n-1"]);
      assert.deepEqual(h.log.continued, []);
    });
  }

  test("第二条 mark 与任何 unmark 都拦截；窗口内不止一条请求就不能证明来源：即使放行的那条成功也是 unknown", async () => {
    const h = harness({
      onClick: (net) => {
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        net.request("n-2", MARK, { uid: BUYER, color: 2, request_id: REQ_ID + 1 });
        net.request("n-3", UNMARK, { uid: BUYER, request_id: REQ_ID + 2 });
        setTimeout(() => net.respond("n-1", okBody()), 30);
      },
    });
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_ambiguous");
    assert.deepEqual(h.log.continued, ["f-n-1"]);
    assert.deepEqual(h.log.failed, ["f-n-2", "f-n-3"]);
  });

  test("同买家同颜色的人工或旧请求先于本次点击的请求到达：先到的放行、本次的被拦截，结论 unknown（不认领成功）", async () => {
    const h = harness({
      onClick: (net) => {
        net.request("r-old", MARK, { uid: BUYER, color: 2, request_id: REQ_ID - 5 });
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        setTimeout(() => net.respond("r-old", okBody(REQ_ID - 5)), 20);
      },
    });
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_ambiguous");
    assert.deepEqual(h.log.continued, ["f-r-old"]);
    assert.deepEqual(h.log.failed, ["f-n-1"]);
  });

  test("点击后页面代次变化：随后的请求拦截；unknown", async () => {
    const h = harness({
      onClick: (net, a) => {
        a.watchEpoch++;
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
      },
    });
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "page_changed_during_mark");
    assert.deepEqual(h.log.failed, ["f-n-1"]);
  });

  test("拦截事件不带浏览器请求编号：无法配对响应，拦截；unknown", async () => {
    const h = harness({ onClick: (net) => net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID }, null) });
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_blocked");
  });

  test("点击后页面没有发出请求：unknown（不判 not_sent）", async () => {
    const h = harness();
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_not_observed");
    assert.equal(h.log.clicks.length, 1);
  });

  test("没有进行中的标星、或标星结束之后：页面的标星 / 取消收藏请求照常放行（店主手动操作不受影响）", async () => {
    const h = harness({ onClick: pageSends() });
    h.net.request("m-1", MARK, { uid: OTHER, color: 4, request_id: 1 });
    h.net.request("m-2", UNMARK, { uid: OTHER, request_id: 2 });
    h.adapter.lastMarkRequestAt = Date.now() - 3100;
    assert.ok(criteriaMet(await h.mark()));
    h.net.request("m-3", MARK, { uid: OTHER, color: 3, request_id: 3 });
    assert.deepEqual(h.log.continued, ["f-m-1", "f-m-2", "f-n-1", "f-m-3"]);
    assert.deepEqual(h.log.failed, []);
  });
});

describe("标星：响应判定一律按放行请求自己的编号", () => {
  for (const [name, body, reason] of [
    ["外层 success 为 false", JSON.stringify({ success: false, result: { success: true, result: "ok", request_id: REQ_ID } }), "mark_response_not_ok"],
    ["result.success 缺失", JSON.stringify({ success: true, result: { result: "ok", request_id: REQ_ID } }), "mark_response_not_ok"],
    ["result.result 不是 ok", JSON.stringify({ success: true, result: { success: true, result: "fail", request_id: REQ_ID } }), "mark_response_not_ok"],
    ["request_id 不等", okBody(REQ_ID + 1), "mark_response_not_ok"],
    ["不是 JSON", "<html>", "mark_response_not_ok"],
  ] as const) {
    test(`${name}：unknown（${reason}）`, async () => {
      const h = harness({ onClick: pageSends(2, body) });
      const r = await h.mark();
      assert.deepEqual(r.status === "unknown" && r.reason, reason);
    });
  }

  test("响应加载失败：unknown", async () => {
    const h = harness({ onClick: (net) => (net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID }), setTimeout(() => net.fail("n-1"), 30)) });
    const r = await h.mark();
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_failed");
  });

  test("取不到响应体：unknown", async () => {
    const h = harness({ onClick: (net) => (net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID }), setTimeout(() => net.finishNoBody("n-1"), 30)) });
    const r = await h.mark();
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_request_failed");
  });

  test("确认截止前没有响应：unknown；截止后才到的成功响应不改变结论", async () => {
    let later: (() => void) | null = null;
    const h = harness({ onClick: (net) => (net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID }), (later = () => net.respond("n-1", okBody()))) });
    const r = await h.mark("red", 2);
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_response_timeout");
    later!();
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(h.adapter.markWatch, null);
  });

  // 乱序：3 秒多以前店主手动发出的请求（窗口外、已放行），其响应恰好在本次窗口内到达。
  const earlier = (h: ReturnType<typeof harness>) => {
    h.net.request("m-0", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
    h.adapter.lastMarkRequestAt = Date.now() - 3100;
  };

  test("乱序到达也不串：先到的是窗口外另一条请求的成功响应，不算；放行请求自己的失败响应决定结论", async () => {
    const h = harness({
      onClick: (net) => {
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        setTimeout(() => net.respond("m-0", okBody()), 10);
        setTimeout(() => net.respond("n-1", JSON.stringify({ success: false })), 60);
      },
    });
    earlier(h);
    const r = await h.mark();
    assert.deepEqual(r.status === "unknown" && r.reason, "mark_response_not_ok");
  });

  test("乱序到达也不串：放行请求的成功响应晚于窗口外另一条请求的失败，仍按自己的响应确认", async () => {
    const h = harness({
      onClick: (net) => {
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        setTimeout(() => net.fail("m-0"), 10);
        setTimeout(() => net.respond("n-1", okBody()), 60);
      },
    });
    earlier(h);
    assert.ok(criteriaMet(await h.mark()));
    assert.deepEqual(h.log.continued, ["f-m-0", "f-n-1"]);
  });
});

describe("标星：来源绑定（操作独占、无外来输入、点击前静默、窗口内唯一）", () => {
  test("旧请求是窗口内唯一请求、本次点击没有产生请求：四项条件与响应判据都满足，仍不报成功（unknown）", async () => {
    // 本次点击零请求；静默期之前已排队的旧写入恰在窗口内发出唯一一条同买家同颜色请求并成功。
    const h = harness({ onClick: (net) => (net.request("old-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID }), setTimeout(() => net.respond("old-1", okBody()), 20)) });
    const r = await h.mark();
    assert.notEqual(r.status, "confirmed");
    assert.ok(criteriaMet(r));
  });

  test("前台自己的悬停与点击各产生一条输入事件：配对后不算外来", async () => {
    const h = harness({ onClick: pageSends() });
    assert.ok(criteriaMet(await h.mark()));
  });

  test("一条命令产生了多条输入事件：多出的算外来，不点击", async () => {
    const h = harness({ inputsPerCommand: 2 });
    assert.deepEqual(await h.mark(), { status: "not_sent", reason: "conv_state_changed" });
    assert.equal(h.log.clicks.length, 0);
  });

  for (const at of ["snap", "star", "pop", "owned"]) {
    test(`核对期间（${at}）平台页面有人工输入：不点击（conv_state_changed）`, async () => {
      const h = harness({ onScript: (name, _a, k) => void (name === at && k.human("mouseMove")) });
      assert.deepEqual(await h.mark(), { status: "not_sent", reason: "conv_state_changed" });
      assert.equal(h.log.clicks.length, 0);
    });
  }

  test("点击后窗口内有人工输入：即使请求与响应全部满足也是 unknown", async () => {
    const h = harness({ onClick: (net, a, k) => (k.human("mouseDown"), pageSends()(net)) });
    const r = await h.mark();
    assert.deepEqual(r.status === "unknown" && r.reason, "manual_input_during_mark");
  });

  test("核对期间页面发出标星 / 取消收藏请求：照常放行，但本次不点击", async () => {
    const h = harness({ onScript: (name) => void (name === "owned" && h.net.request("m-1", MARK, { uid: BUYER, color: 2, request_id: 9 })) });
    assert.deepEqual(await h.mark(), { status: "not_sent", reason: "conv_state_changed" });
    assert.deepEqual(h.log.continued, ["f-m-1"]);
    assert.equal(h.log.clicks.length, 0);
  });

  test("点击前 3 秒内页面发出过此类请求（含前台自己上一次）：不点击；静默满 3 秒后可以", async () => {
    const h = harness({ onClick: pageSends() });
    h.net.request("m-1", UNMARK, { uid: OTHER, request_id: 1 });
    assert.deepEqual(await h.mark(), { status: "not_sent", reason: "conv_state_changed" });
    assert.equal(h.log.clicks.length, 0);
    h.adapter.lastMarkRequestAt = Date.now() - 3100;
    assert.ok(criteriaMet(await h.mark()));
    // 刚完成的这次标星本身也计入静默：紧接着再来一次不点击。
    assert.deepEqual(await h.mark(), { status: "not_sent", reason: "conv_state_changed" });
    assert.equal(h.log.clicks.length, 1);
  });

  test("点击前平台登录店铺变化：不点击（由运行时归为 not_started）", async () => {
    const h = harness({ onScript: (name, _a, k) => void (name === "pop" && (k.identity.shop = "pdd-other")) });
    assert.deepEqual(await h.mark(), { status: "not_sent", reason: "platform_changed_during_mark" });
    assert.equal(h.log.clicks.length, 0);
  });

  test("放行后页面重建：旧响应满足判据也是 unknown", async () => {
    const h = harness({
      onClick: (net, a) => {
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        a.watchEpoch++;
        setTimeout(() => net.respond("n-1", okBody()), 30);
      },
    });
    const r = await h.mark();
    assert.deepEqual(r.status === "unknown" && r.reason, "page_changed_during_mark");
  });

  test("读取响应期间页面重建：unknown", async () => {
    const h = harness({ onClick: pageSends(), onBody: (a) => void a.watchEpoch++ });
    const r = await h.mark();
    assert.deepEqual(r.status === "unknown" && r.reason, "page_changed_during_mark");
  });

  for (const [name, change] of [
    ["平台登录失效", (k: Hooks) => void (k.identity.logged_in = false)],
    ["登录店铺变化", (k: Hooks) => void (k.identity.shop = "pdd-other")],
  ] as const) {
    test(`放行后${name}：unknown`, async () => {
      const h = harness({ onClick: (net, _a, k) => (pageSends()(net), change(k)) });
      const r = await h.mark();
      assert.deepEqual(r.status === "unknown" && r.reason, "platform_changed_during_mark");
    });
  }

  for (const [name, change] of [
    ["平台登录失效", (k: Hooks) => void (k.identity.logged_in = false)],
    ["登录店铺变化", (k: Hooks) => void (k.identity.shop = "pdd-other")],
    ["页面重建", (_k: Hooks, a: any) => void a.watchEpoch++],
  ] as const) {
    test(`点击后、请求放行前${name}：首条同 uid/颜色请求在本机拦截，不到达平台；unknown`, async () => {
      const h = harness({ onClick: (net, a, k) => (change(k, a), net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID })) });
      const r = await h.mark("red", 2);
      assert.equal(r.status, "unknown");
      assert.deepEqual([h.log.continued, h.log.failed], [[], ["f-n-1"]]);
    });
  }

  test("不是本次标星页面监听到的请求：在窗口内拦截", async () => {
    const failed: string[] = [];
    const other = { sendCommand: async (m: string, p: any) => void (m === "Fetch.failRequest" && failed.push(p.requestId)) };
    const h = harness({
      onClick: (_net, a) => a.onMarkPaused(other, { requestId: "x-1", networkId: "x-1", request: { postData: JSON.stringify({ data: { uid: BUYER, color: 2, request_id: REQ_ID } }) } }, "mark", { isDestroyed: () => false }),
    });
    const r = await h.mark("red", 2);
    assert.equal(r.status, "unknown");
    assert.deepEqual(failed, ["x-1"]);
  });

  test("资格失效后才到的成功响应不改写结论", async () => {
    let later: (() => void) | null = null;
    const h = harness({
      onClick: (net, a) => {
        net.request("n-1", MARK, { uid: BUYER, color: 2, request_id: REQ_ID });
        a.watchEpoch++;
        later = () => net.respond("n-1", okBody());
      },
    });
    const r = await h.mark("red", 2);
    later!();
    assert.deepEqual(r.status === "unknown" && r.reason, "page_changed_during_mark");
  });
});

// 极简虚构 DOM：只实现 starOptionsScript 用到的接口。
function fakeDom(opts: { linked?: boolean; activeKeys: string[]; hit?: "red" | "other" | "outside"; starActive?: boolean; redChecked?: boolean; dupRed?: boolean }) {
  const colors: Record<string, string> = { orange: "rgb(250, 170, 40)", red: "rgb(240, 60, 60)", green: "rgb(60, 180, 90)", blue: "rgb(50, 120, 230)" };
  const entries = Object.entries(colors);
  if (opts.dupRed) entries.push(["red", colors.red]);
  const tick = { getClientRects: () => [{}], style: "rgba(0, 0, 0, 0)" };
  const lis = entries.map(([name, bg], i) => {
    const dot = { style: bg, querySelectorAll: () => [] };
    const li: any = {
      name,
      style: "rgba(0, 0, 0, 0)",
      querySelectorAll: () => [dot],
      querySelector: () => (opts.redChecked && name === "red" ? tick : null),
      getBoundingClientRect: () => ({ left: 90, top: 190 + i * 30, width: 20, height: 20 }),
      closest: () => li,
    };
    return li;
  });
  const pop: any = { id: "el-popover-1", getClientRects: () => [{}], querySelectorAll: () => lis, contains: (e: unknown) => lis.includes(e), style: "rgba(0, 0, 0, 0)" };
  const star: any = { getClientRects: () => [{}], getAttribute: (n: string) => (n === "aria-describedby" && opts.linked !== false ? "el-popover-1" : null), querySelectorAll: () => [], parentElement: null, matches: () => true, classList: { contains: (c: string) => c === "active" && !!opts.starActive }, querySelector: () => null };
  const items = opts.activeKeys.map((k) => ({ classList: { contains: (c: string) => c === "active" }, getAttribute: () => k }));
  const outside = { closest: () => null };
  const document = {
    querySelectorAll: (s: string) => (s.includes("收藏该用户") ? [star] : s === "div.el-popover" ? [pop] : items),
    elementFromPoint: () => (opts.hit === "outside" ? outside : opts.hit === "other" ? lis[0] : lis[1]),
  };
  const getComputedStyle = (e: any) => ({ backgroundColor: e.style, visibility: "visible" });
  return { document, getComputedStyle };
}
const runStar = (dom: ReturnType<typeof fakeDom>, check?: { x: number; y: number; color: "red"; buyer?: string }) =>
  new Function("document", "getComputedStyle", `return ${starOptionsScript(check)};`)(dom.document, dom.getComputedStyle);

describe("真实浮层脚本（虚构 DOM）", () => {
  test("快照返回全部打开项 key（由调用方按买家去重）、星标状态与各颜色项", () => {
    const r = runStar(fakeDom({ activeKeys: [`${BUYER}-0`, `${BUYER}-1`] }));
    assert.deepEqual(r.keys, [`${BUYER}-0`, `${BUYER}-1`]);
    assert.equal(r.active, false);
    assert.deepEqual(r.options.map((o: Option) => o.color), ["orange", "red", "green", "blue"]);
    assert.deepEqual([r.options[1].x, r.options[1].y], [100, 230]);
  });

  test("浮层没有由星标关联：不认", () => {
    assert.equal(runStar(fakeDom({ linked: false, activeKeys: [] })), "popover_unlinked");
  });

  test("点击前核对：目标点须是星标浮层中的目标颜色项", () => {
    assert.equal(runStar(fakeDom({ activeKeys: [] }), { x: 100, y: 230, color: "red" }), "ok");
    assert.equal(runStar(fakeDom({ activeKeys: [], hit: "other" }), { x: 100, y: 230, color: "red" }), "target_color_mismatch");
    assert.equal(runStar(fakeDom({ activeKeys: [], hit: "outside" }), { x: 100, y: 230, color: "red" }), "target_not_in_star_popover");
    assert.equal(runStar(fakeDom({ activeKeys: [], redChecked: true }), { x: 100, y: 230, color: "red" }), "target_checked");
    assert.equal(runStar(fakeDom({ activeKeys: [], dupRed: true }), { x: 100, y: 230, color: "red" }), "target_not_unique");
  });

  test("标星执行的最终核对（同一次快照）：唯一打开的会话仍是本事件买家、星标仍未收藏", () => {
    const at = { x: 100, y: 230, color: "red" as const, buyer: BUYER };
    assert.equal(runStar(fakeDom({ activeKeys: [`${BUYER}-0`, `${BUYER}-1`] }), at), "ok");
    // 同页异步变化（页面代次不变）：会话换走、没有打开的会话、两个买家、同买家已被收藏，都不放过。
    assert.equal(runStar(fakeDom({ activeKeys: [`${OTHER}-0`] }), at), "conversation_mismatch");
    assert.equal(runStar(fakeDom({ activeKeys: [] }), at), "conversation_mismatch");
    assert.equal(runStar(fakeDom({ activeKeys: [`${BUYER}-0`, `${OTHER}-0`] }), at), "conversation_mismatch");
    assert.equal(runStar(fakeDom({ activeKeys: [`${BUYER}-0`], starActive: true }), at), "already_marked");
  });
});


test("formal mark: hung page read releases busy and never clicks or retries", async () => {
  const h = harness(), wc = h.adapter.window.webContents, original = wc.executeJavaScriptInIsolatedWorld;
  wc.executeJavaScriptInIsolatedWorld = () => new Promise(() => {});
  const start = Date.now(), result = await h.mark();
  assert.equal(result.status, "not_sent"); assert(Date.now() - start < 2500);
  assert.equal(h.adapter.sending, false); assert.deepEqual(h.log.clicks, []);
  wc.executeJavaScriptInIsolatedWorld = original;
  const next = await h.mark("red", 3, () => "superseded");
  assert(next.status !== "not_sent" || next.reason !== "pdd_send_busy"); assert.deepEqual(h.log.clicks, []);
});

test("formal mark: hung final hover releases busy after one attempt", async () => {
  const h = harness({ onClick: pageSends() }), dbg = h.adapter.window.webContents.debugger, original = dbg.sendCommand;
  dbg.sendCommand = (method: string, params: any) => params.type === "mouseMoved" && params.x === 1 && params.y === 1 ? new Promise(() => {}) : original(method, params);
  const start = Date.now(), result = await h.mark();
  assert.equal(result.status, "unknown"); assert(Date.now() - start < 2500);
  assert.equal(h.adapter.sending, false); assert.equal(h.log.clicks.length, 1); assert.equal(h.adapter.markWatch, null);
});
