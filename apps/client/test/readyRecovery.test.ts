import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import type { EventRecord } from "../src/core/journal.js";
import { messageStatus } from "../src/core/view.js";
import { eventsOf, makeShop, settle, startBackend, waitFor } from "./helpers.js";

let backend: Awaited<ReturnType<typeof startBackend>>;
let h: Awaited<ReturnType<typeof makeShop>>;
let release: (() => void) | null;
let offline: boolean, mono: number;
let claims: { eventId: string; attemptId: string }[];

beforeEach(async () => {
  release = null; offline = false; mono = 0; claims = [];
  backend = await startBackend();
  await backend.settings("shop-a", true);
  h = await makeShop({ backend, monotonicNow: () => mono,
    timing: { heartbeatMs: 60_000, sendTimeoutMs: 5000 },
    fetchImpl: async (input, init) => {
      if (offline && String(input).endsWith("/heartbeat")) throw new TypeError("synthetic_heartbeat_disconnect");
      return fetch(input, init);
    },
  });
  const claim = h.rt.backend.claim.bind(h.rt.backend);
  h.rt.backend.claim = async (eventId, owner, attemptId) => {
    claims.push({ eventId, attemptId });
    return claim(eventId, owner, attemptId);
  };
});
afterEach(async () => {
  offline = false;
  release?.(); release = null;
  await h?.rt.stop(); await backend?.stop();
  if (h?.dir) fs.rmSync(h.dir, { recursive: true, force: true });
});

async function blockedReady() {
  const send = h.mock.send.bind(h.mock);
  h.mock.send = async request => {
    if (request.conversation_id === "first") await new Promise<void>(resolve => { release = resolve; });
    return send(request);
  };
  h.mock.injectBuyerMessage({ conversation_id: "first", content: "营业时间？" });
  await waitFor(() => release !== null, "first send paused");
  h.mock.injectBuyerMessage({ conversation_id: "queued", content: "营业时间？" });
  await waitFor(() => eventsOf(h.rt).some(e => e.conversation_id === "queued" && e.snapshot?.state === "ready"), "queued ready");
  offline = true;
  await h.rt.refresh();
  assert.equal(h.rt.backendState.state, "error");
  release!(); release = null;
  await settle(h.rt);
  const ev = eventsOf(h.rt).find(e => e.conversation_id === "queued")!;
  assert.equal(ev.blocked, "backend_unavailable");
  assert.equal(ev.attempt, null);
  assert.equal(queuedSends(), 0);
  return ev;
}

function queuedSends() {
  return h.mock.platformSends.filter(s => s.conversation_id === "queued").length;
}

async function recover() {
  offline = false;
  await Promise.all([h.rt.refresh(), h.rt.refresh(), h.rt.refresh()]);
  assert.equal(h.rt.backendState.state, "ok");
  assert.equal(h.rt.lease.state, "held");
  await settle(h.rt);
}

async function assertSent(ev: EventRecord) {
  assert.equal(queuedSends(), 1);
  assert.equal(ev.attempt?.phase, "sent");
  assert.equal(ev.attempt?.receipt?.upload, "uploaded");
  assert.equal(claims.filter(c => c.eventId === ev.event_id).length, 1);
}

// 1. 与缺陷报告相同的队列/心跳交错，恢复的是首次发送而非重发。
test("ready 排队期间心跳传输失败：恢复后发送一次并上传回执", async () => {
  const ev = await blockedReady();
  await recover();
  await assertSent(ev);
});

// 2. 用单调时钟推进时间，直接观察点击前剩余预算，不靠真实等待。
test("ready 恢复普通回复窗口只剩一秒仍可开始发送，沿用首次观察时间和60秒总预算", async () => {
  const ev = await blockedReady();
  const message = h.rt.journal.conversation("queued").messages.find(m => m.id === ev.message_id)!;
  const firstSeen = message.first_seen_at;
  const send = h.mock.send.bind(h.mock);
  h.mock.send = async request => {
    assert.equal(mono, 44_000);
    assert.equal(request.recheck?.(), null);
    const result = await send(request);
    mono = 46_000;
    return result;
  };
  mono = 44_000;
  await recover();
  await assertSent(ev);
  assert.equal(message.first_seen_at, firstSeen);
  assert.equal(ev.budget_ms, 60_000);
});

// 3. 恢复入口也要推进截止处理，避免一直显示“后台未连接”。
test("ready 恢复前预算耗尽：不领取不发送，显示本条待人工", async () => {
  const ev = await blockedReady();
  mono = 60_000;
  await recover();
  const conv = h.rt.journal.conversation("queued");
  assert.equal(ev.attempt, null);
  assert.equal(queuedSends(), 0);
  assert.equal(claims.filter(c => c.eventId === ev.event_id).length, 0);
  assert.equal(ev.blocked, "reply_deadline_exceeded");
  assert.equal(conv.notes[ev.message_id], "reply_deadline_exceeded");
  assert.equal(conv.takeover, false);
  assert.equal(messageStatus(conv.messages.find(m => m.id === ev.message_id)!, ev, conv.notes[ev.message_id])?.label, "本条待人工");
});

// 4. 租约换代与平台重登独立验证，均不能改写旧事件归属。
for (const change of ["generation", "session"] as const) {
  test(`ready 恢复遇到 ${change} 变化：不领取旧事件`, async () => {
    const ev = await blockedReady();
    if (change === "generation") {
      const heartbeat = h.rt.backend.heartbeat.bind(h.rt.backend);
      h.rt.backend.heartbeat = async (...args) => ({ ...await heartbeat(...args), generation: ev.generation + 1 });
    } else {
      h.mock.expire(); await h.mock.login();
      assert.notEqual(h.rt.sessionId, ev.session_id);
    }
    await recover();
    assert.equal(ev.attempt, null);
    assert.equal(queuedSends(), 0);
    assert.equal(claims.filter(c => c.eventId === ev.event_id).length, 0);
  });
}

// 5. 模式切换与接管分别验证；解除后也不重放先前积压。
for (const change of ["observe", "takeover"] as const) {
  test(`ready 等待恢复期间 ${change}：解除后不复活`, async () => {
    const ev = await blockedReady();
    if (change === "observe") {
      h.rt.setMode("observe"); h.rt.setMode("auto");
    } else {
      h.rt.setTakeover("queued", true); h.rt.setTakeover("queued", false);
    }
    await recover();
    assert.equal(ev.attempt, null);
    assert.equal(queuedSends(), 0);
    assert.equal(claims.filter(c => c.eventId === ev.event_id).length, 0);
  });
}

// 6. 心跳重叠、再次失联、重复消息以及 unknown 均不能产生第二个 attempt。
test("并发恢复和后续心跳不重复领取；unknown 保留原 attempt 不重发", async () => {
  const ev = await blockedReady();
  h.mock.sendBehavior = "ack_without_id";
  await recover();
  assert.equal(queuedSends(), 1);
  assert.equal(ev.attempt?.phase, "unknown");
  await h.rt.settled();
  const attempt = JSON.stringify(ev.attempt);
  const attemptId = ev.attempt!.attempt_id;
  offline = true; await h.rt.refresh();
  await recover();
  const message = h.rt.journal.conversation("queued").messages.find(m => m.id === ev.message_id)!;
  h.mock.redeliver({ conversation_id: "queued", platform_message_id: message.id, role: "buyer", kind: "text", content: message.content, created_at: message.created_at });
  await Promise.all([h.rt.refresh(), h.rt.refresh(), h.rt.refresh()]);
  await settle(h.rt);
  assert.equal(queuedSends(), 1);
  assert.deepEqual(claims.filter(c => c.eventId === ev.event_id), [{ eventId: ev.event_id, attemptId }]);
  assert.equal(JSON.stringify(ev.attempt), attempt);
});
