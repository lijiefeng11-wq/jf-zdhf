import assert from "node:assert/strict";
import Module from "node:module";
import { describe, test } from "node:test";
import type { PlatformSendOption, SendResult } from "../src/core/adapter.js";

// 用 Electron 替身实例化真实的 PddPageAdapter，执行 sendItem 与刷新确认；不创建真实窗口或会话，全部为虚构数据。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const BUYER = "9001";
const cover = (id: number) => `https://img.example.invalid/c${id}.jpg`;
const url = (id: number) => `https://video.example.invalid/${id}.mp4`;
const ROWS = [
  { key: "video:1", name: "安装视频", url: url(1), cover: cover(1) },
  { key: "video:2", name: "收纳视频", url: url(2), cover: cover(2) },
];
const OPTION: PlatformSendOption = { type: "video", key: "video:2", name: "收纳视频", observed_at: 1 };
const videoMsg = (msg_id: string, file_id: string) => ({ msg_id, buyer: BUYER, raw: { msg_id, from: { role: "mall_cs" }, to: { role: "user", uid: BUYER }, template_name: "library_video", type: 14, info: { file_id } } });

type Scenario = { srcs: string[][]; api: { success: boolean; error_code: number }; onReload?: (watch: any) => void };

function harness(s: Scenario) {
  const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
  const counts = { clicks: 0, reloads: 0 };
  const webContents = {
    isDestroyed: () => false,
    capturePage: async () => undefined,
    getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html",
    reload: () => {
      counts.reloads++;
      if (s.onReload) setTimeout(() => s.onReload!(adapter.itemWatch), 100);
    },
    debugger: { isAttached: () => true, sendCommand: async (_method: string, e: { type: string }) => {
      if (e.type !== "mouseReleased") return;
      counts.clicks++;
      const watch = adapter.itemWatch;
      if (!watch?.clicked) return;
      // 页面对点击的反应：发出一条与本次候选一致的发送请求并得到响应。
      if (watch.url) watch.requests++;
      setTimeout(() => adapter.onItemResponse("/plateau/message/library_file/send", JSON.stringify(s.api)), 50);
    } },
    executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
      if (code.includes("freshBuyer")) return { items: [{ key: `${BUYER}-x`, unread: false, active: true }], freshBuyer: false };
      if (code.includes("chat-detail")) return true;
      if (code.includes("pdd_video_entry_missing")) return "open";
      if (code.includes("?.point()")) return { x: 10, y: 10 };
      if (code.includes("pdd_video_button_missing")) return { texts: ROWS.map((r) => `${r.name} 00:10 发送`), srcs: s.srcs, x: 10, y: 10 };
      return null;
    },
  };
  adapter.window = { isDestroyed: () => false, webContents };
  adapter.tracker = { status: () => ({ logged_in: true }), history: () => ({ messages: [{ platform_message_id: "old-1" }] }) };
  adapter.videoRows = ROWS;
  const send = (seconds: number): Promise<SendResult> =>
    adapter.sendItem({ conversation_id: BUYER, option: OPTION, attempt_id: "a-1", deadline: Date.now() / 1000 + seconds, recheck: () => null });
  return { adapter, counts, send };
}

describe("拼多多适配器：视频附加发送（Electron 替身）", () => {
  test("页面行缺少文件身份：不点击、不刷新，not_sent", async () => {
    const h = harness({ srcs: [[], []], api: { success: true, error_code: 1000000 } });
    const r = await h.send(5);
    assert.deepEqual(r, { status: "not_sent", reason: "pdd_video_row_identity_missing" });
    assert.deepEqual(h.counts, { clicks: 0, reloads: 0 });
  });

  test("接口成功但无即时回执：只刷新一次，按原基线确认新增的同一视频", async () => {
    const h = harness({
      srcs: [[cover(1)], [cover(2)]],
      api: { success: true, error_code: 1000000 },
      onReload: (watch) => watch?.seen.push(videoMsg("old-1", "2"), videoMsg("new-1", "2")),
    });
    const r = await h.send(6);
    assert.deepEqual(r, { status: "confirmed", platform_message_id: "new-1" });
    assert.deepEqual(h.counts, { clicks: 1, reloads: 1 });
  });

  test("刷新后仍无回执：到截止 unknown，只点击一次、刷新一次", async () => {
    const h = harness({ srcs: [[cover(1)], [cover(2)]], api: { success: true, error_code: 1000000 } });
    const r = await h.send(3);
    assert.equal(r.status, "unknown");
    assert.deepEqual(h.counts, { clicks: 1, reloads: 1 });
  });

  test("接口失败：unknown，不刷新", async () => {
    const h = harness({ srcs: [[cover(1)], [cover(2)]], api: { success: false, error_code: 54001 } });
    const r = await h.send(5);
    assert.deepEqual(r, { status: "unknown", reason: "platform_send_failed" });
    assert.deepEqual(h.counts, { clicks: 1, reloads: 0 });
  });
});

describe("拼多多适配器：商品卡片附加发送（Electron 替身）", () => {
  const thumb = (id: number) => `https://img.example.invalid/g${id}.jpg`;
  const GOODS = [
    { goods_id: "601", name: "虚构商品六〇一", thumb: thumb(601), section: "onSaleGoods" },
    { goods_id: "602", name: "虚构商品六〇二", thumb: thumb(602), section: "onSaleGoods" },
  ];
  const goodsMsg = (msg_id: string, goodsID: number) => ({ msg_id, buyer: BUYER, raw: { msg_id, from: { role: "mall_cs" }, to: { role: "user", uid: BUYER }, template_name: "goods_info_card", type: 0, sub_type: 2, info: { goodsID } } });

  function goodsHarness(s: { srcs: string[][]; body: (watch: any) => unknown; api: unknown; onReload?: (watch: any) => void }) {
    const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
    const counts = { clicks: 0, reloads: 0, blocked: 0 };
    const webContents = {
      isDestroyed: () => false,
      getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html",
      reload: () => {
        counts.reloads++;
        if (s.onReload) setTimeout(() => s.onReload!(adapter.itemWatch), 100);
      },
      debugger: { isAttached: () => true, sendCommand: async (_method: string, e: { type: string }) => {
        if (e.type !== "mouseReleased") return;
        counts.clicks++;
        const watch = adapter.itemWatch;
        if (!watch?.clicked) return;
        // 页面对点击的反应：发出商品卡片请求，经本机核对后放行或拦截。
        const dbg = { sendCommand: async (m: string) => void (m === "Fetch.failRequest" && counts.blocked++) };
        adapter.onItemSendPaused(dbg, { requestId: "r1", request: { postData: JSON.stringify(s.body(watch)) } }, "/plateau/message/send/mallGoodsCard");
        if (watch.requests) setTimeout(() => adapter.onItemResponse("/plateau/message/send/mallGoodsCard", JSON.stringify(s.api)), 50);
      } },
      executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
        if (code.includes("freshBuyer")) return { items: [{ key: `${BUYER}-x`, unread: false, active: true }], freshBuyer: false };
        if (code.includes("chat-detail")) return true;
        if (code.includes("bar-select")) return "already";
        if (code.includes("pdd_goods_rows_missing")) return { srcs: s.srcs, hasBtn: s.srcs.map(() => true) };
        if (code.includes("pdd_goods_button_missing")) return { x: 20, y: 20 };
        return null;
      },
    };
    adapter.window = { isDestroyed: () => false, webContents };
    adapter.tracker = { status: () => ({ logged_in: true }), history: () => ({ messages: [{ platform_message_id: "old-1" }] }) };
    adapter.goodsRows.set(BUYER, { rows: GOODS, at: Date.now() });
    const option: PlatformSendOption = { type: "goods_card", key: "goods:602", goods_title: "虚构商品六〇二", observed_at: 1 };
    const send = (seconds: number): Promise<SendResult> =>
      adapter.sendItem({ conversation_id: BUYER, option, attempt_id: "a-1", deadline: Date.now() / 1000 + seconds, recheck: () => null });
    return { counts, send };
  }

  test("所选行缩略图对得上：点击一次、请求放行，刷新后确认新增的同一商品卡片", async () => {
    const h = goodsHarness({
      srcs: [[thumb(601)], [thumb(602)]],
      body: (w) => ({ uid: BUYER, goods_id: Number(w.goodsId), biz_type: 1 }),
      api: { success: true, result: true, error_code: 1000000 },
      onReload: (w) => w?.seen.push(goodsMsg("new-1", 602)),
    });
    assert.deepEqual(await h.send(6), { status: "confirmed", platform_message_id: "new-1" });
    assert.deepEqual(h.counts, { clicks: 1, reloads: 1, blocked: 0 });
  });

  test("页面行缺少缩略图身份：不点击", async () => {
    const h = goodsHarness({ srcs: [[thumb(601)], []], body: () => ({}), api: {} });
    assert.deepEqual(await h.send(5), { status: "not_sent", reason: "pdd_goods_row_identity_missing" });
    assert.equal(h.counts.clicks, 0);
  });

  test("页面请求的商品编号不符：本机拦截，unknown，不刷新", async () => {
    const h = goodsHarness({ srcs: [[thumb(601)], [thumb(602)]], body: () => ({ uid: BUYER, goods_id: 601 }), api: { success: true, result: true } });
    assert.deepEqual(await h.send(3), { status: "unknown", reason: "pdd_item_blocked_mismatch" });
    assert.deepEqual(h.counts, { clicks: 1, reloads: 0, blocked: 1 });
  });
});

describe("拼多多适配器：说明书附加发送（Electron 替身）", () => {
  const instructRes = (goodsId: number, templateId: number) => ({
    success: true,
    result: { templateVO: { templateId, templateName: "虚构说明书", version: 3 }, goodsVO: { goodsId, goodsName: "虚构商品" }, instructStatus: 1 },
  });
  const manualMsg = (msg_id: string, goods: number, book: number) => ({ msg_id, buyer: BUYER, raw: { msg_id, from: { role: "mall_cs" }, to: { role: "user", uid: BUYER }, template_name: "mall_after_sales_service_product_manual_card", type: 64, info: { data: { goods_info: { goods_id: goods }, book_info: { book_id: book } } } } });
  const OPTION_I: PlatformSendOption = { type: "instruction", key: "instruction:502:78:3", goods_title: "虚构商品", name: "虚构说明书", observed_at: 1 };

  function instructHarness(s: { body: (watch: any) => unknown; onReload?: (watch: any) => void; covered?: number }) {
    let covered = s.covered ?? 0;
    const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
    const counts = { clicks: 0, reloads: 0, blocked: 0, opened: 0, closed: 0 };
    // 订单上两个“发送说明书”按钮：第 1 个是另一商品，第 2 个是候选商品。
    const buttons = [{ goodsId: 501, templateId: 77 }, { goodsId: 502, templateId: 78 }];
    const webContents = {
      isDestroyed: () => false,
      getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html",
      reload: () => {
        counts.reloads++;
        if (s.onReload) setTimeout(() => s.onReload!(adapter.itemWatch), 100);
      },
      debugger: { isAttached: () => true, sendCommand: async (_method: string, e: { type: string }) => {
        if (e.type !== "mouseReleased") return;
        counts.clicks++;
        const watch = adapter.itemWatch;
        if (!watch?.clicked) return;
        const dbg = { sendCommand: async (m: string) => void (m === "Fetch.failRequest" && counts.blocked++) };
        adapter.onItemSendPaused(dbg, { requestId: "r1", request: { postData: JSON.stringify(s.body(watch)) } }, "/latitude/goodsInstruct/sendToUser");
        if (watch.requests) setTimeout(() => adapter.onItemResponse("/latitude/goodsInstruct/sendToUser", JSON.stringify({ success: true, result: null })), 50);
      } },
      executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
        if (code.includes("freshBuyer")) return { items: [{ key: `${BUYER}-x`, unread: false, active: true }], freshBuyer: false };
        if (code.includes("chat-detail")) return true;
        if (code.includes("个人订单")) return "already";
        if (code.includes("pdd_instruct_dialog_already_open")) return buttons.length;
        if (code.includes("pdd_instruct_button_missing")) {
          const i = Number(/\)\[(\d+)\];/.exec(code)?.[1] ?? -1);
          counts.opened++;
          setTimeout(() => (adapter.lastInstruct = { request: { goodsId: buttons[i].goodsId }, response: instructRes(buttons[i].goodsId, buttons[i].templateId), at: Date.now() }), 50);
          return "clicked";
        }
        if (code.includes("pdd_instruct_dialog_name_mismatch")) return covered-- > 0 ? "pdd_instruct_send_button_covered:div.v-modal" : { x: 30, y: 30 };
        if (code.includes("el-dialog__headerbtn")) {
          counts.closed++;
          return "closed";
        }
        return null;
      },
    };
    adapter.window = { isDestroyed: () => false, webContents };
    adapter.tracker = { status: () => ({ logged_in: true }), history: () => ({ messages: [{ platform_message_id: "old-1" }] }) };
    const send = (seconds: number): Promise<SendResult> =>
      adapter.sendItem({ conversation_id: BUYER, option: OPTION_I, attempt_id: "a-1", deadline: Date.now() / 1000 + seconds, recheck: () => null });
    return { counts, send };
  }

  test("跳过说明书不符的对话框；对上后点击一次、请求放行，刷新后确认新增的同一说明书", async () => {
    const h = instructHarness({
      body: (w) => ({ uid: BUYER, goodsId: Number(w.goodsId), bookId: Number(w.bookId), goodsName: "虚构商品", thumbUrl: "https://example.invalid/t.jpg" }),
      onReload: (w) => w?.seen.push(manualMsg("new-1", 502, 78)),
    });
    assert.deepEqual(await h.send(8), { status: "confirmed", platform_message_id: "new-1" });
    assert.equal(h.counts.opened, 2);
    assert.deepEqual({ clicks: h.counts.clicks, reloads: h.counts.reloads, blocked: h.counts.blocked }, { clicks: 1, reloads: 1, blocked: 0 });
    assert.ok(h.counts.closed >= 1);
  });

  test("页面请求的 bookId 不符：本机拦截，unknown，不刷新", async () => {
    const h = instructHarness({ body: () => ({ uid: BUYER, goodsId: 502, bookId: 77 }) });
    assert.deepEqual(await h.send(4), { status: "unknown", reason: "pdd_item_blocked_mismatch" });
    assert.deepEqual({ clicks: h.counts.clicks, reloads: h.counts.reloads, blocked: h.counts.blocked }, { clicks: 1, reloads: 0, blocked: 1 });
  });

  test("发送说明书期间页面发出的商品卡片请求（同买家同商品）也在本机拦截", () => {
    const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
    adapter.itemWatch = { buyer: BUYER, path: "/latitude/goodsInstruct/sendToUser", url: null, goodsId: "502", bookId: "78", seen: [], clicked: true, requests: 0, blocked: 0, apiOk: null };
    const calls: string[] = [];
    const dbg = { sendCommand: async (m: string) => void calls.push(m) };
    adapter.onItemSendPaused(dbg, { requestId: "g1", request: { postData: JSON.stringify({ uid: BUYER, goods_id: 502, biz_type: 1 }) } }, "/plateau/message/send/mallGoodsCard");
    adapter.onItemSendPaused(dbg, { requestId: "i1", request: { postData: JSON.stringify({ uid: BUYER, goodsId: 502, bookId: 78 }) } }, "/latitude/goodsInstruct/sendToUser");
    assert.deepEqual(calls, ["Fetch.failRequest", "Fetch.continueRequest"]);
    assert.deepEqual({ blocked: adapter.itemWatch.blocked, requests: adapter.itemWatch.requests }, { blocked: 1, requests: 1 });
  });

  test("对话框过渡中按钮被遮挡：短暂重试，就绪后才点击并确认", async () => {
    const h = instructHarness({
      covered: 2,
      body: (w) => ({ uid: BUYER, goodsId: Number(w.goodsId), bookId: Number(w.bookId) }),
      onReload: (w) => w?.seen.push(manualMsg("new-2", 502, 78)),
    });
    assert.deepEqual(await h.send(8), { status: "confirmed", platform_message_id: "new-2" });
    assert.equal(h.counts.clicks, 1);
  });

  test("截止前时间不够逐个打开对话框：不点击，not_sent", async () => {
    const h = instructHarness({ body: () => ({}) });
    assert.deepEqual(await h.send(2.5), { status: "not_sent", reason: "claim_expiring" });
    assert.equal(h.counts.clicks, 0);
  });
});

describe("拼多多适配器：提交前加载候选的顺序（Electron 替身）", () => {
  test("先切商品推荐页签，再切回订单页签，最后点开订单上的说明书；提交时停在订单页签", async () => {
    const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
    const steps: string[] = [];
    adapter.window = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
          if (code.includes("个人订单")) return (steps.push("orders_tab"), "already");
          if (code.includes('includes("商品")')) return (steps.push("goods_tab"), "already");
          if (code.includes("pdd_instruct_dialog_already_open")) return (steps.push("instruct_buttons"), 0);
          return null;
        },
      },
    };
    adapter.sendOptions.response("/latitude/order/userAllOrder", { uid: BUYER }, { success: true, result: { orders: [{ uid: Number(BUYER), orderSn: "sn-1", orderGoodsList: [{ goodsId: 501, goodsName: "虚构商品" }] }] } }, 1);
    await adapter.sendOptionsSettled(BUYER, 3000);
    assert.deepEqual(steps, ["goods_tab", "orders_tab", "instruct_buttons"]);
  });

  test("1 分钟后同一买家的下一条消息不再切商品推荐页签（5 分钟限流），页面停在订单页签不重读订单", async () => {
    const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
    const steps: string[] = [];
    adapter.window = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
          if (code.includes("个人订单")) return (steps.push("orders_tab"), "already");
          if (code.includes('includes("商品")')) return (steps.push("goods_tab"), "already");
          return null;
        },
      },
    };
    await adapter.sendOptionsSettled(BUYER, 3000);
    adapter.goodsTabAt.set(BUYER, Date.now() - 60_000);
    await adapter.sendOptionsSettled(BUYER, 3000);
    assert.deepEqual(steps, ["goods_tab", "orders_tab", "orders_tab"]);
  });

  test("一个说明书对话框也没打开：30 秒后即可再收集，不按 10 分钟限流", async () => {
    const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
    let counted = 0;
    adapter.window = { isDestroyed: () => false, webContents: { executeJavaScriptInIsolatedWorld: async (_w: number, [{ code }]: { code: string }[]) => (code.includes("pdd_instruct_dialog_already_open") ? (counted++, 0) : "already") } };
    adapter.sendOptions.response("/latitude/order/userAllOrder", { uid: BUYER }, { success: true, result: { orders: [{ uid: Number(BUYER), orderSn: "sn-1", orderGoodsList: [{ goodsId: 501, goodsName: "虚构商品" }] }] } }, 1);
    await adapter.sendOptionsSettled(BUYER, 3000);
    const at = adapter.instructTriedAt.get(BUYER);
    assert.equal(counted, 1);
    assert.ok(Date.now() - at >= 569_000 && Date.now() - at < 600_000);
  });
});

describe("拼多多适配器：准备预算与预热（Electron 替身）", () => {
  const ORDER = { success: true, result: { orders: [{ uid: Number(BUYER), orderSn: "sn-1", orderGoodsList: [{ goodsId: 501, goodsName: "虚构商品" }] }] } };
  function page(opts: { idle?: string; instructButtons?: number; unread?: string } = {}) {
    const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
    const steps: string[] = [];
    adapter.window = {
      isDestroyed: () => false,
      webContents: {
        getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html",
        executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
          if (code.includes("page_focused")) return (steps.push("idle_check"), opts.idle ?? "idle");
          if (code.includes("freshBuyer")) return { items: [{ key: `${BUYER}-x`, unread: false, active: true }, ...(opts.unread ? [{ key: `${opts.unread}-x`, unread: true, active: false }] : [])], freshBuyer: false };
          if (code.includes("chat-detail")) return (steps.push("open_conversation"), opts.unread ? true : false);
          if (code.includes("个人订单")) return (steps.push("orders_tab"), "already");
          if (code.includes('includes("商品")')) return (steps.push("goods_tab"), "already");
          if (code.includes('closest("div.order-item")')) return (steps.push("instruct_buttons"), Array.from({ length: opts.instructButtons ?? 0 }, (_, i) => `k:订单${i}`));
          if (code.includes("pdd_instruct_dialog_already_open")) return (steps.push("instruct_buttons"), opts.instructButtons ?? 0);
          if (code.includes("pdd_instruct_button_missing")) return (steps.push("instruct_open"), "clicked");
          if (code.includes("el-dialog__headerbtn")) return (steps.push("instruct_close"), "closed");
          return null;
        },
      },
    };
    adapter.tracker = { status: () => ({ logged_in: true }), lastLoadedAt: () => 0 };
    adapter.sendOptions.response("/latitude/order/userAllOrder", { uid: BUYER }, ORDER, 1);
    // 页签已选中、推荐商品早已读到：准备阶段不再等列表（没读到时的等待另有测试）。
    adapter.goodsRows.set(BUYER, { rows: [], at: 1 });
    return { adapter, steps };
  }

  test("商品页签已选中但还没读到推荐商品：等列表到了再继续，免得提交后候选变化使判断失效", async () => {
    const { adapter, steps } = page();
    adapter.goodsRows.delete(BUYER);
    setTimeout(() => adapter.goodsRows.set(BUYER, { rows: [], at: Date.now() }), 300);
    const started = Date.now();
    await adapter.sendOptionsSettled(BUYER, 2000);
    assert.ok(Date.now() - started >= 280, "waited for the late goods list");
    assert.ok(steps.indexOf("orders_tab") > steps.indexOf("goods_tab"));
    // 已读到过就不再等。
    adapter.goodsTabAt.delete(BUYER);
    const again = Date.now();
    await adapter.sendOptionsSettled(BUYER, 2000);
    assert.ok(Date.now() - again < 280);
  });

  test("准备预算不足 1 秒：读完商品与订单就返回，不在准备中打开说明书对话框", async () => {
    const { adapter, steps } = page({ instructButtons: 2 });
    const started = Date.now();
    await adapter.sendOptionsSettled(BUYER, 800);
    assert.ok(Date.now() - started < 800);
    assert.deepEqual(steps, ["goods_tab", "orders_tab"]);
  });

  test("预热：页面空闲时补齐推荐商品与说明书，结束停在订单页签并释放页面", async () => {
    const { adapter, steps } = page();
    await adapter.warmConversation(BUYER);
    assert.deepEqual(steps, ["idle_check", "goods_tab", "orders_tab", "instruct_buttons"]);
    assert.equal(adapter.warmRun, null);
    assert.equal(adapter.sending, false);
  });

  test("有人在用页面（页面有焦点）时不预热，只做空闲检查", async () => {
    const { adapter, steps } = page({ idle: "page_focused" });
    await adapter.warmConversation(BUYER);
    assert.deepEqual(steps, ["idle_check"]);
  });

  test("候选都在缓存期内时不预热", async () => {
    const { adapter, steps } = page();
    adapter.goodsTabAt.set(BUYER, Date.now());
    adapter.instructTriedAt.set(BUYER, Date.now());
    await adapter.warmConversation(BUYER);
    assert.deepEqual(steps, []);
  });

  test("发送抢占预热：预热在下一步之间停下并关闭对话框，发送不因“忙”被拒", async () => {
    const { adapter, steps } = page({ instructButtons: 3 });
    // Isolate warm-up preemption from the separately tested delayed-list wait.
    adapter.clickConversation = async () => { steps.push("open_conversation"); throw new Error("fictional page refusal"); };
    const warm = adapter.warmConversation(BUYER);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(steps.includes("instruct_open"));
    const started = Date.now();
    const r: SendResult = await adapter.send({ conversation_id: BUYER, text: "虚构回复", attempt_id: "a-1", deadline: Date.now() / 1000 + 8 });
    await warm;
    assert.deepEqual(r, { status: "not_sent", reason: "pdd_page_script_failed" });
    assert.ok(Date.now() - started < 1000, `preempt took ${Date.now() - started} ms`);
    assert.equal(steps.filter((s) => s === "instruct_open").length, 1);
    assert.ok(steps.indexOf("instruct_close") > steps.indexOf("instruct_open") && steps.indexOf("instruct_close") < steps.indexOf("open_conversation"));
    assert.equal(adapter.sending, false);
  });

  test("准备抢占预热：下一条消息的候选收集先让预热停下", async () => {
    const { adapter, steps } = page({ instructButtons: 3 });
    const warm = adapter.warmConversation(BUYER);
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    await adapter.sendOptionsSettled(BUYER, 2000);
    await warm;
    assert.ok(Date.now() - started < 2500);
    // 预热先关掉自己打开的对话框，准备阶段才切回订单页签；被抢占不算失败，准备可在自身预算内接着收集。
    const prepOrders = steps.indexOf("orders_tab", steps.indexOf("instruct_open"));
    assert.ok(steps.indexOf("instruct_close") < prepOrders);
  });

  test("预热进行中出现未读对话：消息扫描先抢占预热，再照常点开该对话", async () => {
    const { adapter, steps } = page({ instructButtons: 3, unread: "9002" });
    const warm = adapter.warmConversation(BUYER);
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    await adapter.watch();
    await warm;
    assert.ok(Date.now() - started < 1000);
    assert.ok(steps.indexOf("open_conversation") > steps.indexOf("instruct_close"));
    assert.equal(adapter.clicked?.uid, "9002");
  });
});

describe("拼多多适配器：说明书部分收集与预热续读（Electron 替身）", () => {
  const res = (goodsId: number) => ({ success: true, result: { templateVO: { templateId: goodsId + 100, templateName: "虚构说明书", version: 1 }, goodsVO: { goodsId, goodsName: "虚构商品" }, instructStatus: 1 } });
  /** goods：订单中的商品；buttons：订单区“发送说明书”按钮依次对应的商品；loadMs：页面加载说明书的耗时（null 表示永不加载）。 */
  /**
   * “准备只读到 1 个说明书”的时间设计：准备阶段剩余 ≥1000 ms 才开始打开说明书，剩余 ≤500 ms 停止；
   * 每个对话框约为加载时间 + 等待轮询（≤100 ms）+ 关闭前 300 ms。预算 1300 ms、加载 600 ms 时，
   * 开始前留有约 300 ms 余量（慢机器上商品与订单步骤也来得及），读完 1 个后剩余必然 ≤400 ms，只会读 1 个。
   * 原先预算 1050 ms 只留 50 ms 余量，macOS CI 上偶发“一个都没读”（run 41305801841）。
   */
  const PARTIAL_BUDGET_MS = 1300;
  const PARTIAL_LOAD_MS = 600;

  function page(goods: number[], buttons: number[], loadMs: number | null, keyless = new Set<number>()) {
    const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
    const opened: number[] = [];
    adapter.window = {
      isDestroyed: () => false,
      webContents: {
        getURL: () => "https://mms.pinduoduo.com/chat-merchant/index.html",
        executeJavaScriptInIsolatedWorld: async (_w: number, [{ code }]: { code: string }[]) => {
          if (code.includes("page_focused")) return "idle";
          if (code.includes("个人订单") || code.includes('includes("商品")')) return "already";
          if (code.includes('closest("div.order-item")')) return buttons.map((g) => (keyless.has(g) ? null : `k:订单${g}`));
          if (code.includes("pdd_instruct_button_missing")) {
            const i = Number(/\)\[(\d+)\];/.exec(code)?.[1] ?? -1);
            const goodsId = buttons[i];
            opened.push(goodsId);
            if (loadMs !== null) setTimeout(() => {
              adapter.sendOptions.response("/tornado/instruct/getGoodsInstruct", { goodsId }, res(goodsId), Math.floor(Date.now() / 1000));
              adapter.lastInstruct = { request: { goodsId }, response: res(goodsId), at: Date.now() };
            }, loadMs);
            return "clicked";
          }
          if (code.includes("el-dialog__headerbtn")) return "closed";
          return null;
        },
      },
    };
    adapter.tracker = { status: () => ({ logged_in: true }) };
    adapter.sendOptions.response("/latitude/order/userAllOrder", { uid: BUYER }, { success: true, result: { orders: [{ uid: Number(BUYER), orderSn: "sn-1", orderGoodsList: goods.map((goodsId) => ({ goodsId, goodsName: "虚构商品" })) }] } }, 1);
    adapter.goodsRows.set(BUYER, { rows: [], at: 1 });
    const stale = () => adapter.sendOptions.instructStale(BUYER, Math.floor(Date.now() / 1000), 600).length;
    /** 页面按钮顺序变化（原地修改，模拟订单区重排、插入或删除）。 */
    const setButtons = (next: number[]) => buttons.splice(0, buttons.length, ...next);
    return { adapter, opened, stale, setButtons };
  }

  test("准备只完成 1/3 → 不限流，随后预热只补齐剩下的 2 个", async () => {
    const { adapter, opened, stale } = page([501, 502, 503], [501, 502, 503], PARTIAL_LOAD_MS);
    await adapter.sendOptionsSettled(BUYER, PARTIAL_BUDGET_MS);
    assert.deepEqual(opened, [501]);
    assert.equal(stale(), 2);
    assert.equal(adapter.instructTriedAt.has(BUYER), false);
    await adapter.warmConversation(BUYER);
    assert.deepEqual(opened, [501, 502, 503]);
    assert.equal(stale(), 0);
    assert.ok(Date.now() - adapter.instructTriedAt.get(BUYER) < 1000);
    assert.equal(adapter.instructRound.has(BUYER), false);
  });

  test("预热被抢占且一个也没读完：不算失败、不退避，本轮进度保留", async () => {
    const { adapter, opened } = page([501, 502], [501, 502], null);
    const warm = adapter.warmConversation(BUYER);
    await new Promise((r) => setTimeout(r, 150));
    await adapter.yieldWarm();
    await warm;
    assert.deepEqual(opened, [501]);
    assert.equal(adapter.instructTriedAt.has(BUYER), false);
  });

  test("预算充足但页面没有加载说明书：真正失败，30 秒后再试", async () => {
    const { adapter } = page([501], [501], null);
    await adapter.warmConversation(BUYER);
    const at = adapter.instructTriedAt.get(BUYER);
    assert.ok(Date.now() - at >= 569_000 && Date.now() - at < 600_000);
  });

  test("本轮 3 个按钮都试过仍有未新鲜的：10 分钟后再来一轮", async () => {
    const { adapter, opened, stale } = page([501, 502, 503, 504], [501, 502, 503, 504], 30);
    await adapter.warmConversation(BUYER);
    assert.deepEqual(opened, [501, 502, 503]);
    assert.equal(stale(), 1);
    assert.ok(Date.now() - adapter.instructTriedAt.get(BUYER) < 1000);
    assert.equal(adapter.instructRound.has(BUYER), false);
    await adapter.warmConversation(BUYER);
    assert.deepEqual(opened, [501, 502, 503]);
  });

  test("部分完成后按钮重排：按订单项指纹续读，不跳过未读商品，不误判试满", async () => {
    const { adapter, opened, stale, setButtons } = page([501, 502, 503], [501, 502, 503], PARTIAL_LOAD_MS);
    await adapter.sendOptionsSettled(BUYER, PARTIAL_BUDGET_MS);
    assert.deepEqual(opened, [501]);
    setButtons([502, 501, 503]);
    await adapter.warmConversation(BUYER);
    assert.deepEqual(opened, [501, 502, 503]);
    assert.equal(stale(), 0);
  });

  test("部分完成后插入新订单按钮：新按钮照常读取，已读的不重读", async () => {
    const { adapter, opened, stale, setButtons } = page([501, 502, 503], [501, 503], PARTIAL_LOAD_MS);
    await adapter.sendOptionsSettled(BUYER, PARTIAL_BUDGET_MS);
    assert.deepEqual(opened, [501]);
    setButtons([502, 501, 503]);
    await adapter.warmConversation(BUYER);
    assert.deepEqual(opened, [501, 502, 503]);
    assert.equal(stale(), 0);
  });

  test("部分完成后删除已读按钮：剩余按钮照常读取", async () => {
    const { adapter, opened, stale, setButtons } = page([502, 503], [501, 502, 503], PARTIAL_LOAD_MS);
    await adapter.sendOptionsSettled(BUYER, PARTIAL_BUDGET_MS);
    assert.deepEqual(opened, [501]);
    setButtons([502, 503]);
    await adapter.warmConversation(BUYER);
    assert.deepEqual(opened, [501, 502, 503]);
    assert.equal(stale(), 0);
  });

  test("指纹取不到的按钮不按旧位置跳过：重新打开核验", async () => {
    const { adapter, opened, stale } = page([501, 502], [501, 502], PARTIAL_LOAD_MS, new Set([501]));
    await adapter.sendOptionsSettled(BUYER, PARTIAL_BUDGET_MS);
    assert.deepEqual(opened, [501]);
    await adapter.warmConversation(BUYER);
    assert.deepEqual(opened, [501, 501, 502]);
    assert.equal(stale(), 0);
  });
});

describe("拼多多适配器：预先展开视频弹窗加载视频库", () => {
  test("没打开对话时入口不在：每次照常重试，同一结果只记一次日志；入口出现后展开成功不再重试", async () => {
    const adapter = new PddPageAdapter("shop-x", "虚构店铺") as any;
    let panel: unknown = "pdd_video_entry_missing";
    let runs = 0;
    adapter.window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: async () => (runs++, panel) } };
    adapter.tracker = { status: () => ({ logged_in: true }) };
    const logs: string[] = [];
    const log = console.log;
    console.log = (line: string) => logs.push(String(line));
    try {
      for (let i = 0; i < 3; i++) await adapter.prepareSendOptions();
      panel = "open";
      await adapter.prepareSendOptions();
      await adapter.prepareSendOptions();
    } finally {
      console.log = log;
    }
    assert.equal(runs, 4);
    assert.deepEqual(logs.filter((l) => l.includes("prepare result")), [
      "[shop-x] platform send options prepare result=pdd_video_entry_missing",
      "[shop-x] platform send options prepare result=already",
    ]);
  });
});
