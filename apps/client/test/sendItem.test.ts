import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { PlatformSendOption } from "../src/core/adapter.js";
import type { FetchLike } from "../src/core/backend.js";
import { ShopRuntime } from "../src/core/runtime.js";
import { TestBackend, eventsOf, makeShop, settle, waitFor } from "./helpers.js";

// 契约“聊天页附加发送”：用内存中的虚构后台验证前台执行边界；全部为虚构店铺与虚构内容。

type Decide = (body: any) => Record<string, unknown>;

function fakeBackend(opts: { capabilities?: boolean; decide: Decide; claimSeconds?: number }) {
  const state = {
    capabilities: opts.capabilities ?? true,
    hold: false,
    claimSeconds: opts.claimSeconds ?? 10,
    heartbeats: [] as any[],
    bodies: [] as any[],
    claims: [] as string[],
    receipts: [] as any[],
    events: new Map<string, any>(),
  };
  const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    const now = Date.now() / 1000;
    const p = url.pathname;
    if (p === "/health") return json(200, { service: "claw-next", status: "ok", protocol_version: "1.0" });
    if (p === "/api/v1/me") return json(200, { role: "client", client_id: "client-a", shop_id: "shop-a", protocol_version: "1.0" });
    if (p === "/api/v1/heartbeat") {
      state.heartbeats.push(body);
      const caps = state.capabilities && body.capabilities?.includes("send_item") ? { capabilities: ["send_item"] } : {};
      return json(200, { shop_id: "shop-a", client_id: "client-a", instance_id: body.instance_id, session_id: body.session_id, generation: 1, expires_at: now + 60, ...caps });
    }
    if (p === "/api/v1/events" && method === "POST") {
      state.bodies.push(body);
      const snap = {
        event_id: body.event_id, shop_id: "shop-a", client_id: "client-a", conversation_id: body.conversation_id, message_id: body.message_id,
        context_revision: body.context_revision, session_id: body.session_id, generation: body.generation, state: "ready",
        decision: { reason: "rule:test", expires_at: now + 120, ...opts.decide(body) },
        delivery: { status: "unclaimed", attempt_id: null, platform_message_id: null }, created_at: now,
      };
      state.events.set(body.event_id, snap);
      return json(202, state.hold ? { ...snap, state: "pending", decision: null } : snap);
    }
    const m = /^\/api\/v1\/events\/([^/]+)(?:\/(claim|receipt))?$/.exec(p);
    const snap = m && state.events.get(decodeURIComponent(m[1]));
    if (!m || !snap) return json(404, { error: { code: "not_found" } });
    if (!m[2]) return json(200, state.hold ? { ...snap, state: "pending", decision: null } : snap);
    if (m[2] === "claim") {
      state.claims.push(snap.event_id);
      if (snap.decision.action === "send_item" && !state.capabilities) return json(409, { error: { code: "capability_not_confirmed" } });
      snap.delivery = { status: "claimed", attempt_id: body.attempt_id, platform_message_id: null, claim_expires_at: now + state.claimSeconds };
      return json(200, snap);
    }
    state.receipts.push(body);
    snap.delivery = { ...snap.delivery, status: body.status, platform_message_id: body.platform_message_id ?? null };
    return json(200, snap);
  }) as FetchLike;
  return { state, fetchImpl };
}

const FAKE = { url: "http://127.0.0.1:9" } as TestBackend;
const running: ShopRuntime[] = [];

async function shop(fake: ReturnType<typeof fakeBackend>, opts: { oldClient?: boolean; timing?: Parameters<typeof makeShop>[0]["timing"]; mode?: Parameters<typeof makeShop>[0]["mode"]; monotonicNow?: () => number } = {}) {
  const h = await makeShop({ backend: FAKE, fetchImpl: fake.fetchImpl, timing: opts.timing, mode: opts.mode, monotonicNow: opts.monotonicNow, login: false });
  if (opts.oldClient) (h.mock as { sendItem?: unknown }).sendItem = undefined;
  await h.mock.login();
  await waitFor(() => h.rt.lease.state === "held", "lease");
  running.push(h.rt);
  return h;
}

afterEach(async () => {
  for (const rt of running.splice(0)) await rt.stop(false);
});

const T = Date.now() / 1000;
const OPTIONS: PlatformSendOption[] = [
  { type: "instruction", key: "goods-1|tpl-1|v1", goods_title: "虚构商品一", name: "虚构说明书", observed_at: T },
  { type: "goods_card", key: "goods-2", goods_title: "虚构商品二", observed_at: T },
  { type: "video", key: "file-1", name: "虚构视频", duration: 30, observed_at: T },
];

/** 选中本事件候选中某类的第一项。 */
function pick(type: "instruction" | "goods_card" | "video"): Decide {
  const kind = type === "instruction" ? "instructions" : type === "goods_card" ? "goods" : "videos";
  return (body) => ({ action: "send_item", item: { type, option_id: body.context.send_options?.[kind]?.[0]?.option_id ?? "missing" } });
}

async function buyerAsks(h: Awaited<ReturnType<typeof shop>>, options = OPTIONS) {
  h.mock.injectSendOptions("buyer-1", options);
  h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "怎么安装？" });
  await waitFor(() => eventsOf(h.rt).some((e) => e.snapshot?.state === "ready"), "decision");
  await settle(h.rt);
}

describe("附加发送：能力协商", () => {
  test("新客户端 + 新后台：声明能力、带候选、执行一次并以聊天记录消息编号回执 sent", async () => {
    const fake = fakeBackend({ decide: pick("instruction") });
    const h = await shop(fake);
    // reply_deadline（契约 A）与 goods_snapshot（商品快照草案）是独立能力，与 send_item 分开声明。
    assert.deepEqual(fake.state.heartbeats[0].capabilities, ["send_item", "reply_deadline", "goods_snapshot"]);
    await buyerAsks(h);
    const opts = fake.state.bodies[0].context.send_options;
    assert.equal(opts.instructions.length, 1);
    assert.equal(h.mock.platformItemSends.length, 1);
    assert.equal(h.mock.platformItemSends[0].option.key, "goods-1|tpl-1|v1");
    assert.equal(fake.state.receipts.length, 1);
    assert.equal(fake.state.receipts[0].status, "sent");
    assert.match(fake.state.receipts[0].platform_message_id, /^mock-p-/);
  });

  test("新客户端 + 旧后台：响应无能力 → 不传候选；即使收到 send_item 也不 claim、不执行", async () => {
    const fake = fakeBackend({ capabilities: false, decide: () => ({ action: "send_item", item: { type: "video", option_id: "v-x" } }) });
    const h = await shop(fake);
    await buyerAsks(h);
    assert.equal(fake.state.bodies[0].context.send_options, undefined);
    assert.equal(fake.state.claims.length, 0);
    assert.equal(h.mock.platformItemSends.length, 0);
    assert.equal(eventsOf(h.rt)[0].blocked, "capability_not_confirmed");
  });

  test("不能附加发送的客户端 + 新后台：不声明 send_item（只声明独立的 reply_deadline、goods_snapshot）、不传候选", async () => {
    const fake = fakeBackend({ decide: () => ({ action: "none", text: "" }) });
    const h = await shop(fake, { oldClient: true });
    await buyerAsks(h);
    assert.deepEqual(fake.state.heartbeats[0].capabilities, ["reply_deadline", "goods_snapshot"]);
    assert.equal(fake.state.bodies[0].context.send_options, undefined);
    assert.equal(h.rt.sendItemConfirmed(), false);
  });

  test("只在自动模式且能力已确认时让页面加载候选", async () => {
    const auto = await shop(fakeBackend({ decide: () => ({ action: "none", text: "" }) }));
    await waitFor(() => auto.mock.prepareCalls > 0, "prepare");
    const manual = await shop(fakeBackend({ decide: () => ({ action: "none", text: "" }) }), { mode: "manual" });
    const old = await shop(fakeBackend({ capabilities: false, decide: () => ({ action: "none", text: "" }) }));
    await settle(manual.rt);
    await settle(old.rt);
    assert.equal(manual.mock.prepareCalls, 0);
    assert.equal(old.mock.prepareCalls, 0);
  });

  test("只在自动模式且能力已确认时，提交前让页面加载该买家的推荐商品", async () => {
    const auto = await shop(fakeBackend({ decide: () => ({ action: "none", text: "" }) }));
    const old = await shop(fakeBackend({ capabilities: false, decide: () => ({ action: "none", text: "" }) }));
    await buyerAsks(auto);
    await buyerAsks(old);
    assert.deepEqual(auto.mock.sendOptionsSettledCalls, ["buyer-1"]);
    assert.deepEqual(old.mock.sendOptionsSettledCalls, []);
  });

  test("不认识的 action 按 none 记录，不 claim", async () => {
    const fake = fakeBackend({ decide: () => ({ action: "change_price", text: "" }) });
    const h = await shop(fake);
    await buyerAsks(h);
    const ev = eventsOf(h.rt)[0];
    assert.equal(ev.snapshot?.decision?.action, "none");
    assert.match(ev.snapshot?.decision?.reason ?? "", /^unsupported_action:/);
    assert.equal(fake.state.claims.length, 0);
  });

  test("决定生成后同一租约撤回能力：不再 claim", async () => {
    const fake = fakeBackend({ decide: pick("video") });
    const h = await shop(fake);
    fake.state.hold = true;
    h.mock.injectSendOptions("buyer-1", OPTIONS);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "有视频吗？" });
    await waitFor(() => fake.state.bodies.length === 1, "submit");
    fake.state.capabilities = false;
    await h.rt.refresh();
    assert.equal(h.rt.sendItemConfirmed(), false);
    fake.state.hold = false;
    await waitFor(() => eventsOf(h.rt).some((e) => e.snapshot?.state === "ready"), "decision");
    await settle(h.rt);
    assert.equal(fake.state.claims.length, 0);
    assert.equal(eventsOf(h.rt)[0].blocked, "capability_not_confirmed");
  });

  test("点击前发现能力已撤回：不点击，回执 not_sent", async () => {
    const fake = fakeBackend({ decide: pick("video") });
    const h = await shop(fake);
    h.mock.beforeItemClick = async () => {
      fake.state.capabilities = false;
      await h.rt.refresh();
    };
    await buyerAsks(h);
    assert.equal(h.mock.platformItemSends.length, 0);
    assert.equal(fake.state.receipts[0].status, "not_sent");
  });
});

describe("附加发送：候选字段", () => {
  test("按类白名单与上限提交，option_id 唯一且不含平台编号", async () => {
    const many: PlatformSendOption[] = [
      ...Array.from({ length: 12 }, (_, i): PlatformSendOption => ({ type: "instruction", key: `g${i}|t|v1`, goods_title: `虚构商品${i}`, name: `说明书${i}`, observed_at: T })),
      ...Array.from({ length: 25 }, (_, i): PlatformSendOption => ({ type: "goods_card", key: `g${i}`, goods_title: `虚构商品${i}`, observed_at: T })),
      ...Array.from({ length: 60 }, (_, i): PlatformSendOption => ({ type: "video", key: `f${i}`, name: `视频${i}`, ...(i % 2 ? { duration: 10 } : {}), observed_at: T })),
    ];
    const fake = fakeBackend({ decide: () => ({ action: "none", text: "" }) });
    const h = await shop(fake);
    await buyerAsks(h, many);
    const o = fake.state.bodies[0].context.send_options;
    assert.deepEqual([o.instructions.length, o.goods.length, o.videos.length], [10, 20, 50]);
    assert.deepEqual(Object.keys(o.instructions[0]).sort(), ["goods_title", "name", "observed_at", "option_id"]);
    assert.deepEqual(Object.keys(o.goods[0]).sort(), ["goods_title", "observed_at", "option_id"]);
    assert.deepEqual(Object.keys(o.videos[1]).sort(), ["duration", "name", "observed_at", "option_id"]);
    assert.deepEqual(Object.keys(o.videos[0]).sort(), ["name", "observed_at", "option_id"]);
    const ids = [...o.instructions, ...o.goods, ...o.videos].map((x: { option_id: string }) => x.option_id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id.length <= 64));
    assert.ok(!JSON.stringify(o).includes("|t|v1"));
    const stored = eventsOf(h.rt)[0];
    assert.equal(stored.has_send_options, true);
    assert.ok(!stored.body.includes("send_options"));
  });

  test("编号不在候选中或类型不符：不 claim", async () => {
    for (const decide of [
      () => ({ action: "send_item", item: { type: "video", option_id: "v-not-offered" } }),
      (body: any) => ({ action: "send_item", item: { type: "video", option_id: body.context.send_options.goods[0].option_id } }),
    ] as Decide[]) {
      const fake = fakeBackend({ decide });
      const h = await shop(fake);
      await buyerAsks(h);
      assert.equal(fake.state.claims.length, 0);
      assert.match(eventsOf(h.rt)[0].blocked ?? "", /^option_(unknown|type_mismatch)$/);
      await h.rt.stop(false);
      running.splice(running.indexOf(h.rt), 1);
    }
  });

  test("候选变化只使旧的 send_item 决定失效（不递增版本），对象仍在候选中也不 claim", async () => {
    for (const changed of [OPTIONS.slice(0, 1), OPTIONS.slice(0, 2)]) {
      const fake = fakeBackend({ decide: pick("goods_card") });
      const h = await shop(fake);
      fake.state.hold = true;
      h.mock.injectSendOptions("buyer-1", OPTIONS);
      h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "看看商品" });
      await waitFor(() => fake.state.bodies.length === 1, "submit");
      const revision = fake.state.bodies[0].context_revision;
      h.mock.injectSendOptions("buyer-1", changed);
      fake.state.hold = false;
      await waitFor(() => eventsOf(h.rt).some((e) => e.snapshot?.state === "ready"), "decision");
      await settle(h.rt);
      assert.equal(fake.state.claims.length, 0);
      assert.equal(eventsOf(h.rt)[0].blocked, "send_options_changed");
      assert.equal(h.rt.journal.conversation("buyer-1").revision, revision);
      await h.rt.stop(false);
      running.splice(running.indexOf(h.rt), 1);
    }
  });

  test("候选在判断期间变化：已就绪的文字回复照常发送", async () => {
    const fake = fakeBackend({ decide: () => ({ action: "reply", text: "虚构回复" }) });
    const h = await shop(fake);
    fake.state.hold = true;
    h.mock.injectSendOptions("buyer-1", OPTIONS.slice(0, 1));
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "在吗" });
    await waitFor(() => fake.state.bodies.length === 1, "submit");
    h.mock.injectSendOptions("buyer-1", OPTIONS);
    fake.state.hold = false;
    await waitFor(() => fake.state.receipts.length >= 1, "receipt");
    assert.equal(fake.state.receipts[0].status, "sent");
    assert.deepEqual(h.mock.platformSends.map((r) => r.text), ["虚构回复"]);
    assert.equal(eventsOf(h.rt)[0].blocked ?? null, null);
  });
});

describe("附加发送：执行与回执", () => {
  test("等待对话框期间来了新消息：不点击，回执 not_sent", async () => {
    const fake = fakeBackend({ decide: pick("instruction") });
    const h = await shop(fake);
    h.mock.beforeItemClick = () => {
      h.mock.beforeItemClick = null;
      h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "算了不用了" });
    };
    h.mock.injectSendOptions("buyer-1", OPTIONS);
    h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "怎么安装？" });
    await waitFor(() => fake.state.receipts.length >= 1, "receipt");
    await settle(h.rt);
    const first = eventsOf(h.rt).find((e) => e.attempt)!;
    assert.equal(first.attempt?.phase, "not_sent");
    assert.equal(fake.state.receipts.find((r) => r.attempt_id === first.attempt?.attempt_id)?.status, "not_sent");
    assert.ok(!h.mock.platformItemSends.some((s) => s.attempt_id === first.attempt?.attempt_id));
  });

  test("准备阶段越过确认截止：不点击，回执 not_sent", async () => {
    const fake = fakeBackend({ decide: pick("video"), claimSeconds: 3.2 });
    const h = await shop(fake, { timing: { minSendWindow: 0.5, claimSafety: 0.1 } });
    h.mock.beforeItemClick = () => new Promise((r) => setTimeout(r, 1500));
    await buyerAsks(h);
    await waitFor(() => fake.state.receipts.length >= 1, "receipt");
    assert.equal(h.mock.platformItemSends.length, 0);
    assert.equal(fake.state.receipts[0].status, "not_sent");
  });

  test("同时新增两条同类消息无法唯一对应：unknown，不重发", async () => {
    const fake = fakeBackend({ decide: pick("goods_card") });
    const h = await shop(fake);
    h.mock.itemBehavior = "ambiguous";
    await buyerAsks(h);
    assert.equal(h.mock.platformItemSends.length, 1);
    assert.equal(fake.state.receipts[0].status, "unknown");
    await h.rt.refresh();
    await settle(h.rt);
    assert.equal(fake.state.claims.length, 1);
    assert.equal(h.mock.platformItemSends.length, 1);
  });

  test("点击后无结果：超时按 unknown，不重发", async () => {
    const fake = fakeBackend({ decide: pick("video") });
    const h = await shop(fake);
    h.mock.itemBehavior = "timeout_after_click";
    await buyerAsks(h);
    await waitFor(() => fake.state.receipts.length >= 1, "receipt");
    assert.equal(fake.state.receipts[0].status, "unknown");
    assert.equal(h.mock.platformItemSends.length, 1);
  });
});

test("附加发送：准备弹窗后达到本地 20 秒截止，不点击、不冻结买家", async () => {
  let mono = 0;
  const fake = fakeBackend({ decide: pick("instruction") });
  const h = await shop(fake, { monotonicNow: () => mono });
  h.mock.beforeItemClick = () => { mono = 20_000; };
  await buyerAsks(h);
  assert.equal(h.mock.platformItemSends.length, 0);
  assert.equal(eventsOf(h.rt)[0].attempt?.detail, "reply_deadline_exceeded");
  assert.equal(eventsOf(h.rt)[0].attempt?.receipt?.status, "not_sent");
  assert.equal(h.rt.journal.conversation("buyer-1").takeover, false);
});

describe("准备阶段提速与预热", () => {
  test("自动模式且能力已确认：不单独先读订单，订单与候选合用 2 秒准备预算", async () => {
    const h = await shop(fakeBackend({ decide: () => ({ action: "none", text: "" }) }));
    const orders: number[] = [], options: number[] = [];
    h.mock.ordersSettled = async (_id, ms) => { orders.push(ms); };
    h.mock.sendOptionsSettled = async (_id, ms) => { options.push(ms ?? -1); };
    await buyerAsks(h);
    assert.deepEqual(orders, []);
    assert.equal(options.length, 1);
    assert.ok(options[0] <= 2000 && options[0] >= 1800, `options budget ${options[0]}`);
  });

  test("未确认附加发送时只读订单，等待同样不超过 2 秒准备预算", async () => {
    for (const h of [await shop(fakeBackend({ capabilities: false, decide: () => ({ action: "none", text: "" }) })), await shop(fakeBackend({ decide: () => ({ action: "none", text: "" }) }), { mode: "manual" })]) {
      const orders: number[] = [];
      h.mock.ordersSettled = async (_id, ms) => { orders.push(ms); };
      await buyerAsks(h);
      assert.equal(orders.length, 1);
      assert.ok(orders[0] <= 2000 && orders[0] >= 1800, `orders budget ${orders[0]}`);
      assert.deepEqual(h.mock.sendOptionsSettledCalls, []);
    }
  });

  test("该买家的处理全部结束后才预热；发送时还没有预热", async () => {
    const h = await shop(fakeBackend({ decide: pick("instruction") }));
    const sendItem = h.mock.sendItem.bind(h.mock);
    let warmedAtSend = -1;
    h.mock.sendItem = async (req) => { warmedAtSend = h.mock.warmCalls.length; return sendItem(req); };
    await buyerAsks(h);
    assert.equal(h.mock.platformItemSends.length, 1);
    assert.equal(warmedAtSend, 0);
    await waitFor(() => h.mock.warmCalls.length === 1, "warm");
    assert.deepEqual(h.mock.warmCalls, ["buyer-1"]);
  });

  test("人工模式、未确认能力或人工接管时不预热", async () => {
    const manual = await shop(fakeBackend({ decide: () => ({ action: "none", text: "" }) }), { mode: "manual" });
    const old = await shop(fakeBackend({ capabilities: false, decide: () => ({ action: "none", text: "" }) }));
    const taken = await shop(fakeBackend({ decide: () => ({ action: "none", text: "" }) }));
    taken.rt.journal.setTakeover("buyer-1", true);
    for (const h of [manual, old, taken]) await buyerAsks(h);
    assert.deepEqual([manual.mock.warmCalls, old.mock.warmCalls, taken.mock.warmCalls], [[], [], []]);
  });
});

describe("附加发送 unknown 的聊天记录核对", () => {
  test("新出现的客服消息解析不出（视频/说明书只记为非文字消息）：标无法核对，不当作没发出", async () => {
    const h = await shop(fakeBackend({ decide: pick("video") }));
    h.mock.sendItem = async (req) => {
      h.mock.platformItemSends.push(req);
      h.mock.addAgentHistory(req.conversation_id, "非文字消息（类型 14）", "unsupported");
      return { status: "unknown", reason: "receipt_not_observed" };
    };
    await buyerAsks(h);
    await waitFor(() => !!eventsOf(h.rt)[0]?.check, "check");
    const ev = eventsOf(h.rt)[0];
    assert.deepEqual([ev.check?.result, ev.check?.detail], ["unavailable", "unparsed_agent_messages=1"]);
    assert.equal(h.mock.platformItemSends.length, 1);
  });

  test("发送后记录已刷新且没有任何新客服消息：最后一次核对才标没看到", async () => {
    const h = await shop(fakeBackend({ decide: pick("video") }));
    h.mock.sendItem = async (req) => {
      h.mock.platformItemSends.push(req);
      // 发送后 60 秒还有一条消息：同一页能证明覆盖了发送前后。
      h.mock.addHistoryMessage({ conversation_id: req.conversation_id, platform_message_id: "later-1", role: "system", kind: "text", content: "虚构系统提示", created_at: Date.now() / 1000 + 60 });
      return { status: "unknown", reason: "pdd_item_request_not_observed" };
    };
    await buyerAsks(h);
    await waitFor(() => !!eventsOf(h.rt)[0]?.check, "check");
    assert.equal(eventsOf(h.rt)[0].check?.result, "not_seen");
    assert.equal(h.mock.platformItemSends.length, 1);
  });
});
