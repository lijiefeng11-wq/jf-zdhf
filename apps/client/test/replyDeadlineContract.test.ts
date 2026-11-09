import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { after, afterEach, describe, test } from "node:test";
import type { FetchLike } from "../src/core/backend.js";
import { parseSnapshot, parseTiming } from "../src/core/protocol.js";
import { REPLY_DEADLINE_REASON } from "../src/core/replyTiming.js";
import { messageStatus } from "../src/core/view.js";
import { FakeDeadlineBackend } from "./fakeDeadlineBackend.js";
import { eventsOf, makeShop, settle, startBackend, waitFor, withoutCapability, type Harness, type TestBackend } from "./helpers.js";

// 契约 A（contracts/protocol.md“契约 A”）前台部分。全部为虚构店铺与消息。

const statusOf = (h: Harness, conv: string, i = 0) => {
  const c = h.rt.journal.conversation(conv);
  const m = c.messages.filter((x) => x.role === "buyer")[i];
  return messageStatus(m, h.rt.journal.eventForMessage(conv, m.id), c.notes[m.id]);
};

test("timing 宽容解析：已知字段不合法则整个忽略，未知字段忽略，0 合法", () => {
  assert.deepEqual(parseTiming({ queue_wait_ms: 0, decision_ms: 12, model_slot: "backup", fallback_used: true, extra: "x" }), { queue_wait_ms: 0, decision_ms: 12, model_slot: "backup", fallback_used: true });
  for (const bad of [null, [], 5, { decision_ms: -1 }, { decision_ms: 1.5 }, { decision_ms: true }, { decision_ms: "3" }, { model_slot: "third" }, { fallback_used: 1 }, { failure_class: "timeout" }]) assert.equal(parseTiming(bad), undefined);
  const base = { event_id: "ev-1", shop_id: "shop-a", client_id: "client-a", conversation_id: "c-1", message_id: "m-1", context_revision: 1, session_id: "s-1", generation: 1, state: "ready", decision: { action: "handoff", text: "", reason: REPLY_DEADLINE_REASON, expires_at: 1 }, delivery: { status: "unclaimed", attempt_id: null, platform_message_id: null }, created_at: 1 };
  // 不合法的 timing 不导致整个快照被拒；授权字段仍严格校验。
  const snap = parseSnapshot({ ...base, timing: { decision_ms: -5 }, event_deadline: 9 });
  assert.equal(snap.timing, undefined); assert.equal(snap.event_deadline, 9);
  assert.throws(() => parseSnapshot({ ...base, timing: { decision_ms: 1 }, delivery: { status: "weird", attempt_id: null } }));
});

describe("新前台 / 旧后台：能力未确认", () => {
  let backend: TestBackend;
  const running: Harness[] = [];
  afterEach(async () => {
    for (const h of running.splice(0)) { await h.rt.stop(); fs.rmSync(h.dir, { recursive: true, force: true }); }
    await backend?.stop();
  });

  test("心跳声明 reply_deadline，但后台不确认时不提交预算、不调用取消，本地截止照常", async () => {
    backend = await startBackend(); await backend.settings("shop-a", true);
    const seen: { path: string; body: string | undefined }[] = [];
    // 不论 CLAW_NEXT_BACKEND_ROOT 指向哪个后台，都固定为“不确认 reply_deadline”的旧后台组合。
    const old = withoutCapability("reply_deadline");
    const spy: FetchLike = (async (input: any, init?: any) => { seen.push({ path: new URL(String(input)).pathname, body: init?.body }); return old(input, init); }) as FetchLike;
    let mono = 0;
    const h = await makeShop({ backend, fetchImpl: spy, monotonicNow: () => mono }); running.push(h);
    const hb = seen.find((r) => r.path === "/api/v1/heartbeat");
    assert.ok(JSON.parse(hb!.body!).capabilities.includes("reply_deadline"));
    assert.equal(h.rt.deadlineConfirmed(h.rt.lease.generation), false);
    h.mock.injectBuyerMessage({ conversation_id: "old-backend", content: "营业时间" }); await settle(h.rt);
    const submit = seen.find((r) => r.path === "/api/v1/events");
    assert.equal(JSON.parse(submit!.body!).remaining_budget_ms, undefined);
    assert.equal(h.mock.platformSends.length, 1);
    // 提交后本地到期：仍拒发（不 claim），且不调用取消。
    const submitEvent = h.rt.backend.submitEvent.bind(h.rt.backend);
    h.rt.backend.submitEvent = async (body) => { const r = await submitEvent(body); mono = 25_000; return r; };
    h.mock.injectBuyerMessage({ conversation_id: "old-backend-2", content: "营业时间" }); await settle(h.rt);
    const ev = h.rt.journal.eventForMessage("old-backend-2", h.rt.journal.conversation("old-backend-2").messages[0].id)!;
    assert.equal(ev.blocked, REPLY_DEADLINE_REASON); assert.equal(ev.attempt, null);
    assert.equal(seen.filter((r) => r.path.endsWith("/cancel")).length, 0);
    assert.equal(h.mock.platformSends.length, 1);
  });
});

/**
 * 实际 Python 后台的契约 A 联调：只有当 CLAW_NEXT_BACKEND_ROOT（或本仓库）指向的后台在心跳中确认 reply_deadline 时才运行，
 * 否则跳过（旧后台组合由上一组覆盖）。
 */
describe("新前台 / 实际 Python 新后台", () => {
  let backend: TestBackend;
  const running: Harness[] = [];
  const backends: TestBackend[] = [];
  const launch = async (opts?: Parameters<typeof startBackend>[0]) => { backend = await startBackend(opts); backends.push(backend); return backend; };
  // 用 after 而非 afterEach：用例内 t.skip() 时 afterEach 不会执行，后台子进程会留下。
  after(async () => {
    for (const h of running.splice(0)) { await h.rt.stop(); fs.rmSync(h.dir, { recursive: true, force: true }); }
    for (const b of backends.splice(0)) await b.stop();
  });
  const start = async (mono: () => number) => {
    await launch(); await backend.settings("shop-a", true);
    const seen: { method: string; path: string; body: string | undefined }[] = [];
    const spy: FetchLike = (async (input: any, init?: any) => { seen.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname, body: init?.body }); return withoutCapability("reply_timeout_transfer")(input, init); }) as FetchLike;
    const h = await makeShop({ backend, fetchImpl: spy, monotonicNow: mono }); running.push(h);
    return { h, seen, confirmed: h.rt.deadlineConfirmed(h.rt.lease.generation) };
  };

  test("合法预算正常发送；本地到期后真实取消、无 claim/receipt；同一买家后续消息照常", async (t) => {
    let mono = 0;
    const { h, seen, confirmed } = await start(() => mono);
    if (!confirmed) return t.skip("后台未确认 reply_deadline（旧后台），本组跳过");
    const history = h.mock.fetchHistory.bind(h.mock);
    h.mock.fetchHistory = async (id) => { const r = await history(id); mono += 1200.7; return r; };
    h.mock.injectBuyerMessage({ conversation_id: "py-ok", content: "营业时间" }); await settle(h.rt);
    const first = seen.filter((r) => r.path === "/api/v1/events")[0];
    assert.equal(JSON.parse(first.body!).remaining_budget_ms, 18799);
    assert.equal(h.mock.platformSends.length, 1);

    // 提交返回后本地到期：前台不 claim，用原四字段真实取消，后台给出截止终态。
    const submitEvent = h.rt.backend.submitEvent.bind(h.rt.backend);
    h.rt.backend.submitEvent = async (body) => { const r = await submitEvent(body); mono += 25_000; return r; };
    h.mock.injectBuyerMessage({ conversation_id: "py-cancel", content: "营业时间" });
    await waitFor(() => !!eventsOf(h.rt).find((e) => e.conversation_id === "py-cancel")?.cancel && eventsOf(h.rt).find((e) => e.conversation_id === "py-cancel")!.cancel!.phase !== "intent", "cancel result");
    await settle(h.rt);
    h.rt.backend.submitEvent = submitEvent;
    const ev = eventsOf(h.rt).find((e) => e.conversation_id === "py-cancel")!;
    const cancels = seen.filter((r) => r.path.endsWith("/cancel"));
    assert.equal(cancels.length, 1);
    assert.deepEqual(JSON.parse(cancels[0].body!), { instance_id: ev.instance_id, session_id: ev.session_id, generation: ev.generation, reason: REPLY_DEADLINE_REASON });
    assert.equal(ev.cancel?.phase, "done");
    assert.equal(ev.snapshot?.decision?.action, "handoff"); assert.equal(ev.snapshot?.decision?.reason, REPLY_DEADLINE_REASON);
    assert.equal(ev.snapshot?.delivery.status, "unclaimed"); assert.equal(ev.snapshot?.delivery.attempt_id, null); assert.equal(ev.attempt, null);
    const evPath = `/api/v1/events/${ev.event_id}`;
    assert.equal(seen.filter((r) => r.path === `${evPath}/claim` || r.path === `${evPath}/receipt`).length, 0);
    assert.equal(statusOf(h, "py-cancel")?.label, "本条待人工");
    assert.equal(h.rt.journal.conversation("py-cancel").takeover, false);
    // 后台记录同样是截止终态，没有发送尝试。
    const row = (await backend.events("shop-a")).find((e: any) => e.event_id === ev.event_id);
    assert.equal(row?.decision?.reason, REPLY_DEADLINE_REASON); assert.equal(row?.delivery?.attempt_id ?? null, null);

    // 同一买家的新消息照常处理。
    h.mock.injectBuyerMessage({ conversation_id: "py-cancel", content: "营业时间" }); await settle(h.rt);
    assert.equal(h.mock.platformSends.length, 2);
  });

  test("model 模式：带预算的事件经本机合成模型服务得出回复并发送", async (t) => {
    // 本机回环上的合成 OpenAI 兼容服务，只返回固定的虚构决定；不连接任何外部模型。
    const requests: { path: string | undefined; at: number }[] = [];
    const provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        requests.push({ path: req.url, at: Date.now() });
        const content = JSON.stringify({ action: "reply", text: "合成模型回复（虚构）", reason: "synthetic" });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (provider.address() as { port: number }).port;
      await launch({ model: { primary: { base_url: `http://127.0.0.1:${port}/v1`, model: "synthetic-model", timeout_seconds: 3 } } });
      await backend.settings("shop-a", true, [], "model");
      const seen: { path: string; body: string | undefined }[] = [];
      const spy: FetchLike = (async (input: any, init?: any) => { seen.push({ path: new URL(String(input)).pathname, body: init?.body }); return withoutCapability("reply_timeout_transfer")(input, init); }) as FetchLike;
      const logs: string[] = [];
      // 本地单调时钟固定为 0（本地 20 秒不会到期）；前台放弃轮询的时限必须长于后台 20 秒预算，
      // 否则后台在预算内（如 Windows 上 spawn 子进程较慢时）仍在判断，前台却已停止查询。
      const h = await makeShop({ backend, fetchImpl: spy, monotonicNow: () => 0, timing: { pollGiveUpMs: 30_000 }, log: (l) => logs.push(l) }); running.push(h);
      if (!h.rt.deadlineConfirmed(h.rt.lease.generation)) return t.skip("后台未确认 reply_deadline（旧后台），本组跳过");
      const started = Date.now();
      h.mock.injectBuyerMessage({ conversation_id: "py-model", content: "请问什么时候发货？" });
      const find = () => eventsOf(h.rt).find((e) => e.conversation_id === "py-model");
      // 显式等到后台给出终态（不超过预算 20 秒 + 余量），而不是只等 settled()。
      await waitFor(() => find()?.snapshot?.state === "ready", "model decision ready", 25_000).catch(() => undefined);
      await settle(h.rt);
      const ev = find();
      const row = ev ? (await backend.events("shop-a")).find((e: any) => e.event_id === ev.event_id) : undefined;
      // 失败时一并给出虚构数据的状态证据：前后台快照、合成模型请求数与时刻、后台计时、前台轮询日志。
      const diag = JSON.stringify({
        elapsed_ms: Date.now() - started,
        client: ev ? { stage: ev.stage, error: ev.error, state: ev.snapshot?.state, action: ev.snapshot?.decision?.action, reason: ev.snapshot?.decision?.reason, timing: ev.snapshot?.timing, blocked: ev.blocked, attempt: ev.attempt?.phase ?? null } : null,
        backend: row ? { state: row.state, decision: row.decision ? { action: row.decision.action, reason: row.decision.reason } : null, delivery: row.delivery?.status, timing: row.timing } : null,
        provider_requests: requests.map((r) => ({ path: r.path, after_ms: r.at - started })),
        poll_log: logs.filter((l) => l.includes("step=decide") || l.includes("step=submit") || l.startsWith("backend_timing")),
      });
      const submit = seen.find((r) => r.path === "/api/v1/events");
      assert.equal(JSON.parse(submit!.body!).remaining_budget_ms, 20000, diag);
      assert.ok(ev, diag);
      assert.equal(ev.snapshot?.decision?.action, "reply", diag); assert.equal(ev.snapshot?.decision?.text, "合成模型回复（虚构）", diag);
      assert.equal(requests.length, 1, diag);
      assert.equal(ev.attempt?.phase, "sent", diag); assert.equal(h.mock.platformSends.length, 1, diag);
      assert.equal(h.mock.platformSends[0].text, "合成模型回复（虚构）");
    } finally {
      await new Promise<void>((r) => provider.close(() => r()));
    }
  });
});

describe("新前台 / 新后台（虚构契约 A 后台）", () => {
  const running: Harness[] = [];
  afterEach(async () => {
    for (const h of running.splice(0)) { await h.rt.stop(false); fs.rmSync(h.dir, { recursive: true, force: true }); }
  });
  const shop = async (fake: FakeDeadlineBackend, mono: () => number, opts: { dir?: string; fetchImpl?: FetchLike; log?: (l: string) => void; now?: () => number } = {}) => {
    const h = await makeShop({ backend: { url: fake.url } as TestBackend, fetchImpl: opts.fetchImpl ?? fake.fetch, monotonicNow: mono, dir: opts.dir, log: opts.log, now: opts.now });
    running.push(h);
    await waitFor(() => h.rt.deadlineConfirmed(h.rt.lease.generation), "reply_deadline confirmed");
    return h;
  };

  test("能力确认后冻结剩余预算（向下取整），正常发送", async () => {
    const fake = new FakeDeadlineBackend();
    let mono = 0;
    const h = await shop(fake, () => mono);
    const history = h.mock.fetchHistory.bind(h.mock);
    h.mock.fetchHistory = async (id) => { const r = await history(id); mono = 3500.6; return r; };
    h.mock.injectBuyerMessage({ conversation_id: "budget", content: "营业时间" }); await settle(h.rt);
    const body = JSON.parse(fake.submitRequests()[0].body!);
    assert.equal(body.remaining_budget_ms, 16499);
    assert.equal(eventsOf(h.rt)[0].budget_ms, 16499);
    assert.equal(h.mock.platformSends.length, 1); assert.equal(eventsOf(h.rt)[0].attempt?.phase, "sent");
    assert.equal(fake.cancelRequests().length, 0);
  });

  test("响应丢失后原样重投同一请求体，预算不重新计算", async () => {
    const fake = new FakeDeadlineBackend();
    let mono = 0, drop = true;
    const fetchImpl: FetchLike = (async (input: any, init?: any) => {
      const res = await fake.fetch(input, init);
      if (drop && init?.method === "POST" && String(input).endsWith("/api/v1/events")) { drop = false; mono += 4000; throw new TypeError("fetch failed"); }
      return res;
    }) as FetchLike;
    const h = await shop(fake, () => mono, { fetchImpl });
    h.mock.injectBuyerMessage({ conversation_id: "resubmit", content: "营业时间" }); await settle(h.rt);
    const subs = fake.submitRequests();
    assert.equal(subs.length, 2); assert.equal(subs[0].body, subs[1].body);
    assert.equal(JSON.parse(subs[0].body!).remaining_budget_ms, 20000);
    assert.equal(fake.events.size, 1); assert.equal(h.mock.platformSends.length, 1);
  });

  test("本地向下取整为 0 时不提交，直接本条待人工", async () => {
    const fake = new FakeDeadlineBackend();
    let mono = 0;
    const h = await shop(fake, () => mono);
    const history = h.mock.fetchHistory.bind(h.mock);
    h.mock.fetchHistory = async (id) => { const r = await history(id); mono = 19_999.5; return r; };
    h.mock.injectBuyerMessage({ conversation_id: "zero", content: "营业时间" }); await settle(h.rt);
    assert.equal(fake.submitRequests().length, 0); assert.equal(eventsOf(h.rt).length, 0);
    assert.equal(statusOf(h, "zero")?.label, "本条待人工");
  });

  test("后台截止终态显示本条待人工、不 claim、不加接管锁；同一买家新消息照常处理", async () => {
    const fake = new FakeDeadlineBackend();
    fake.hold = true;
    const h = await shop(fake, () => 0);
    h.mock.injectBuyerMessage({ conversation_id: "server-deadline", content: "营业时间" });
    await waitFor(() => fake.events.size === 1, "event submitted");
    fake.forceExpire([...fake.events.keys()][0]);
    await settle(h.rt);
    const ev = eventsOf(h.rt)[0];
    assert.equal(ev.blocked, REPLY_DEADLINE_REASON); assert.equal(ev.attempt, null);
    assert.equal(statusOf(h, "server-deadline")?.label, "本条待人工");
    assert.equal(h.rt.journal.conversation("server-deadline").takeover, false);
    assert.equal(fake.requests.filter((r) => r.path.endsWith("/claim")).length, 0);
    fake.hold = false;
    h.mock.injectBuyerMessage({ conversation_id: "server-deadline", content: "营业时间" }); await settle(h.rt);
    assert.equal(h.mock.platformSends.length, 1);
  });

  test("claim 返回 409 reply_deadline_exceeded：不重试、不发送、本条待人工", async () => {
    const fake = new FakeDeadlineBackend();
    const fetchImpl: FetchLike = (async (input: any, init?: any) => {
      if (String(input).endsWith("/claim")) for (const id of fake.events.keys()) fake.forceExpire(id);
      return fake.fetch(input, init);
    }) as FetchLike;
    const h = await shop(fake, () => 0, { fetchImpl });
    h.mock.injectBuyerMessage({ conversation_id: "claim-409", content: "营业时间" }); await settle(h.rt);
    const ev = eventsOf(h.rt)[0];
    assert.equal(ev.attempt?.phase, "claim_failed"); assert.equal(ev.attempt?.detail, REPLY_DEADLINE_REASON); assert.equal(ev.attempt?.receipt, null);
    assert.equal(fake.requests.filter((r) => r.path.endsWith("/claim")).length, 1);
    assert.equal(h.mock.platformSends.length, 0);
    assert.equal(statusOf(h, "claim-409")?.label, "本条待人工");
    assert.equal(h.rt.journal.conversation("claim-409").takeover, false);
  });

  test("本地到期后用原四字段取消未领取事件；网络失败只原样有限重试", async () => {
    const fake = new FakeDeadlineBackend();
    fake.hold = true;
    let mono = 0, failCancel = 1;
    const fetchImpl: FetchLike = (async (input: any, init?: any) => {
      if (String(input).endsWith("/cancel") && failCancel-- > 0) throw new TypeError("fetch failed");
      return fake.fetch(input, init);
    }) as FetchLike;
    const h = await shop(fake, () => mono, { fetchImpl });
    h.mock.injectBuyerMessage({ conversation_id: "cancel", content: "营业时间" });
    await waitFor(() => fake.events.size === 1, "event submitted");
    mono = 20_000;
    await waitFor(() => eventsOf(h.rt)[0]?.cancel?.phase === "done", "cancel done");
    await settle(h.rt);
    const ev = eventsOf(h.rt)[0];
    const cancels = fake.cancelRequests();
    // 第一次在发出前失败（未到后台），重试一次成功；请求体只有四个字段且与原事件归属一致。
    assert.equal(cancels.length, 1);
    assert.deepEqual(JSON.parse(cancels[0].body!), { instance_id: ev.instance_id, session_id: ev.session_id, generation: ev.generation, reason: REPLY_DEADLINE_REASON });
    assert.equal(ev.snapshot?.decision?.reason, REPLY_DEADLINE_REASON); assert.equal(ev.attempt, null);
    assert.equal(fake.requests.filter((r) => r.path.endsWith("/claim")).length, 0);
    assert.equal(statusOf(h, "cancel")?.label, "本条待人工");
    assert.equal(h.rt.journal.conversation("cancel").takeover, false);
  });

  test("冻结预算后、首次受理前撤回能力：确定拒绝，不删预算重投；刷新后的新消息不带预算", async () => {
    const fake = new FakeDeadlineBackend();
    const h = await shop(fake, () => 0);
    const submit = h.rt.backend.submitEvent.bind(h.rt.backend);
    let revoked = false;
    h.rt.backend.submitEvent = async (body) => {
      if (!revoked) { revoked = true; fake.supported.clear(); fake.leaseCaps = []; }
      return submit(body);
    };
    h.mock.injectBuyerMessage({ conversation_id: "revoked", content: "营业时间" }); await settle(h.rt);
    assert.equal(fake.submitRequests().length, 1);
    const ev = eventsOf(h.rt)[0];
    assert.equal(ev.stage, "rejected"); assert.equal(ev.error, "capability_not_confirmed");
    assert.equal(statusOf(h, "revoked")?.label, "本条待人工");
    assert.equal(h.rt.journal.conversation("revoked").takeover, false);
    await h.rt.refresh();
    assert.equal(h.rt.deadlineConfirmed(h.rt.lease.generation), false);
    h.mock.injectBuyerMessage({ conversation_id: "revoked", content: "营业时间" }); await settle(h.rt);
    const subs = fake.submitRequests();
    assert.equal(subs.length, 2); assert.equal(JSON.parse(subs[1].body!).remaining_budget_ms, undefined);
    assert.equal(h.mock.platformSends.length, 1);
  });

  test("重启时只有取消意图：先查询快照，不以旧意图发起取消；新实例也不首次取消旧事件", async () => {
    const fake = new FakeDeadlineBackend();
    fake.hold = true;
    let mono = 0;
    // 取消请求永远不返回：模拟“意图已落盘、请求是否到达后台未知”时进程退出。
    const hang: FetchLike = (async (input: any, init?: any) => (String(input).endsWith("/cancel") ? new Promise<Response>(() => undefined) : fake.fetch(input, init))) as FetchLike;
    const first = await shop(fake, () => mono, { fetchImpl: hang });
    first.mock.injectBuyerMessage({ conversation_id: "restart", content: "营业时间" });
    await waitFor(() => fake.events.size === 1, "event submitted");
    mono = 20_000;
    await waitFor(() => eventsOf(first.rt)[0]?.cancel?.phase === "intent", "cancel intent");
    await first.rt.stop(false);
    running.splice(running.indexOf(first), 1);
    fake.expireLease();
    const before = fake.requests.length;
    // 新实例的墙钟晚 30 秒：恢复时该消息已超过本地截止，验证新实例也不首次取消旧归属事件。
    const second = await shop(fake, () => 0, { dir: first.dir, fetchImpl: fake.fetch, now: () => Date.now() / 1000 + 30 });
    await waitFor(() => eventsOf(second.rt)[0]?.cancel?.phase === "checked", "cancel checked");
    await settle(second.rt);
    assert.equal(eventsOf(second.rt)[0].blocked, REPLY_DEADLINE_REASON);
    const after = fake.requests.slice(before);
    assert.equal(after.filter((r) => r.path.endsWith("/cancel")).length, 0);
    assert.ok(after.some((r) => r.method === "GET" && r.path.startsWith("/api/v1/events/")));
    assert.equal(eventsOf(second.rt)[0].cancel?.detail, "not_terminal:pending:unclaimed");
    assert.equal(second.mock.platformSends.length, 0);
    fs.rmSync(first.dir, { recursive: true, force: true });
  });

  test("后台计时只记日志；不合法的 timing 整个忽略，快照照常使用", async () => {
    const fake = new FakeDeadlineBackend();
    const logs: string[] = [];
    fake.timing = { queue_wait_ms: 3, decision_ms: 40, primary_ms: 38, model_slot: "primary", fallback_used: false };
    const h = await shop(fake, () => 0, { log: (l) => logs.push(l) });
    h.mock.injectBuyerMessage({ conversation_id: "timing-ok", content: "营业时间" }); await settle(h.rt);
    const lines = logs.filter((l) => l.startsWith("backend_timing "));
    assert.equal(lines.length, 1); assert.ok(lines[0].includes('"decision_ms":40'));
    fake.timing = { decision_ms: -1, queue_wait_ms: 2 };
    h.mock.injectBuyerMessage({ conversation_id: "timing-bad", content: "营业时间" }); await settle(h.rt);
    assert.equal(logs.filter((l) => l.startsWith("backend_timing ")).length, 1);
    assert.equal(h.mock.platformSends.length, 2);
  });
});
