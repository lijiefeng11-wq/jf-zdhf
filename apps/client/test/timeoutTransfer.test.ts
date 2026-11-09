import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { afterEach, test } from "node:test";
import { messageStatus } from "../src/core/view.js";
import type { TransferRequest } from "../src/core/adapter.js";
import { eventsOf, makeShop, settle, startBackend, waitFor, withoutCapability, type Harness, type TestBackend } from "./helpers.js";

const running: { h: Harness; backend: TestBackend }[] = [];
afterEach(async () => {
  for (const { h, backend } of running.splice(0)) {
    await h.rt.stop(); await backend.stop(); fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

async function fixture(opts: { target?: boolean; old?: boolean; model?: Record<string, unknown> } = {}) {
  const backend = await startBackend({ model: opts.model });
  await backend.settings("shop-a", true, undefined, opts.model ? "model" : "rules", opts.target === false ? {} : { model_timeout: { action: "transfer", account: "fictional-timeout-agent", allow_unmark: false } });
  let mono = 0;
  const h = await makeShop({ backend, login: false, declareTransfer: true, monotonicNow: () => mono,
    ...(opts.old ? { fetchImpl: withoutCapability("reply_timeout_transfer") } : {}), timing: { sendTimeoutMs: 5000, unknownCheckDelaysMs: [] } });
  running.push({ h, backend });
  const transfers: TransferRequest[] = [];
  (h.mock as any).transferConversation = async (r: TransferRequest) => {
    const blocked = r.recheck();
    if (blocked) return { status: "not_sent", reason: blocked };
    assert.equal(eventsOf(h.rt)[0].attempt?.phase, "sending");
    transfers.push(r);
    return { status: "confirmed", page_observed: "left_list" };
  };
  await h.mock.login(); await waitFor(() => h.rt.lease.state === "held", "lease");
  return { ...h, backend, transfers, advance: (ms: number) => { mono += ms; } };
}

for (const boundary of ["history", "history_failure", "submit", "claim", "before_click"] as const) {
  test(`真实后台：${boundary}跨45秒，原事件和原尝试执行已保存客服转接`, async () => {
    const h = await fixture();
    if (boundary.startsWith("history")) {
      const original = h.mock.fetchHistory.bind(h.mock);
      h.mock.fetchHistory = async id => {
        const result = await original(id); h.advance(45000);
        if (boundary === "history_failure") throw Error("synthetic history timeout");
        return result;
      };
    }
    if (boundary === "submit") {
      const original = h.rt.backend.submitEvent.bind(h.rt.backend);
      h.rt.backend.submitEvent = async body => { const result = await original(body); h.advance(45000); return result; };
    }
    if (boundary === "claim") {
      const original = h.rt.backend.claim.bind(h.rt.backend);
      h.rt.backend.claim = async (...args) => { const result = await original(...args); h.advance(45000); return result; };
    }
    if (boundary === "before_click") h.mock.send = async request => {
      h.advance(45000);
      return { status: "not_sent", reason: request.recheck!()! };
    };
    h.mock.injectBuyerMessage({ conversation_id: "fictional-buyer", content: "营业时间" });
    await settle(h.rt);
    const [ev] = eventsOf(h.rt);
    assert.equal(eventsOf(h.rt).length, 1);
    assert.equal(ev.timeout_transfer, true);
    assert.equal(JSON.parse(ev.body).timeout_transfer, true);
    assert.equal(ev.attempt?.phase, "sent");
    assert.equal(h.mock.platformSends.length, 0);
    assert.equal(h.transfers.length, 1);
    assert.equal(h.transfers[0].account, "fictional-timeout-agent");
    assert.equal(h.transfers[0].allow_unmark, false);
    assert.equal(h.transfers[0].attempt_id, ev.attempt?.attempt_id);
    assert(h.transfers[0].deadline <= Date.now() / 1000 + 15);
    if (boundary === "history_failure") assert.equal(ev.history_complete, false);
    const [stored] = await h.backend.events("shop-a");
    assert.equal(stored.delivery.status, "sent");
    assert.equal(stored.delivery.attempt_id, ev.attempt?.attempt_id);
    assert.equal(stored.decision.action, "transfer");
  });
}

test("真实后台：45秒前普通回复，开始后越过45秒仍按原回执完成", async () => {
  const h = await fixture();
  const send = h.mock.send.bind(h.mock);
  h.mock.send = async request => { h.advance(44000); assert.equal(request.recheck!(), null); h.advance(2000); return send({ ...request, recheck: () => null }); };
  h.mock.injectBuyerMessage({ conversation_id: "fictional-buyer", content: "营业时间" }); await settle(h.rt);
  assert.equal(h.transfers.length, 0);
  assert.equal(eventsOf(h.rt)[0].attempt?.phase, "sent");
});

test("真实后台：unknown跨45/60秒不补转、不重新领取", async () => {
  const h = await fixture();
  h.mock.send = async () => ({ status: "unknown", reason: "synthetic_ack_missing" });
  const message = h.mock.injectBuyerMessage({ conversation_id: "fictional-buyer", content: "营业时间" }); await settle(h.rt);
  const ev = eventsOf(h.rt)[0], attempt = ev.attempt?.attempt_id;
  h.advance(65000); h.mock.redeliver(message); await h.rt.refresh(); await settle(h.rt);
  assert.equal(h.transfers.length, 0); assert.equal(ev.attempt?.phase, "unknown"); assert.equal(ev.attempt.attempt_id, attempt);
  assert.equal((await h.backend.events("shop-a"))[0].delivery.status, "unknown");
});

test("真实后台：总60秒已到，不转接也不重新开启15秒", async () => {
  const h = await fixture();
  const submit = h.rt.backend.submitEvent.bind(h.rt.backend);
  h.rt.backend.submitEvent = async body => { const result = await submit(body); h.advance(60000); return result; };
  h.mock.injectBuyerMessage({ conversation_id: "fictional-buyer", content: "营业时间" }); await settle(h.rt);
  assert.equal(h.transfers.length, 0); assert.equal(h.mock.platformSends.length, 0); assert.equal(eventsOf(h.rt)[0].attempt, null);
});

test("真实后台：未配置超时接收客服明确提示平台未转接", async () => {
  const h = await fixture({ target: false });
  const submit = h.rt.backend.submitEvent.bind(h.rt.backend);
  h.rt.backend.submitEvent = async body => { const result = await submit(body); h.advance(45000); return result; };
  h.mock.injectBuyerMessage({ conversation_id: "fictional-buyer", content: "营业时间" }); await settle(h.rt);
  const ev = eventsOf(h.rt)[0], conv = h.rt.journal.conversation(ev.conversation_id);
  const status = messageStatus(conv.messages.find(m => m.id === ev.message_id)!, ev, conv.notes[ev.message_id]);
  assert.equal(h.transfers.length, 0); assert.match(status?.reason ?? "", /未配置.*平台未执行转接/);
});

for (const result of ["transfer_target_missing", "transfer_target_ambiguous", "transfer_target_offline", "unknown", "late_confirmation"]) {
  test(`真实后台：转接结果${result}如实归结且不重试`, async () => {
    const h = await fixture();
    const submit = h.rt.backend.submitEvent.bind(h.rt.backend);
    h.rt.backend.submitEvent = async body => { const snap = await submit(body); h.advance(45000); return snap; };
    let calls = 0;
    (h.mock as any).transferConversation = async () => {
      calls++;
      if (result === "late_confirmation") { h.advance(15000); return { status: "confirmed", page_observed: "left_list" }; }
      return result === "unknown" ? { status: "unknown", reason: "transfer_binding_unproven" } : { status: "not_sent", reason: result };
    };
    const message = h.mock.injectBuyerMessage({ conversation_id: "fictional-buyer", content: "营业时间" }); await settle(h.rt);
    const ev = eventsOf(h.rt)[0], expected = result === "unknown" || result === "late_confirmation" ? "unknown" : "not_sent";
    assert.equal(ev.attempt?.phase, expected);
    assert.equal((await h.backend.events("shop-a"))[0].delivery.status, expected);
    h.mock.redeliver(message); await h.rt.refresh(); await settle(h.rt); assert.equal(calls, 1);
  });
}

test("旧后台组合仍冻结20秒预算，不提交新字段", async () => {
  const h = await fixture({ old: true });
  h.mock.injectBuyerMessage({ conversation_id: "fictional-buyer", content: "营业时间" }); await settle(h.rt);
  const ev = eventsOf(h.rt)[0];
  assert.equal(ev.timeout_transfer, undefined); assert.equal(JSON.parse(ev.body).timeout_transfer, undefined);
  assert.equal(ev.budget_ms, 20000); assert.equal(h.mock.platformSends.length, 1);
});

test("真实后台：模型仍挂起时，本地45秒停止等待并执行转接", async () => {
  const provider = http.createServer((_req, _res) => undefined);
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const address = provider.address() as { port: number };
    const h = await fixture({ model: { primary: { base_url: `http://127.0.0.1:${address.port}/v1`, model: "synthetic", api_key: "", timeout_seconds: 60 }, backup: {} } });
    const submit = h.rt.backend.submitEvent.bind(h.rt.backend);
    h.rt.backend.submitEvent = async body => { const result = await submit(body); h.advance(45000); return result; };
    h.mock.injectBuyerMessage({ conversation_id: "fictional-buyer", content: "营业时间" }); await settle(h.rt);
    assert.equal(eventsOf(h.rt)[0].attempt?.phase, "sent"); assert.equal(h.transfers.length, 1); assert.equal(h.mock.platformSends.length, 0);
  } finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
});
