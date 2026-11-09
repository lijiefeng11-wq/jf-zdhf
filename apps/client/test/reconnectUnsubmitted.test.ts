import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { eventsOf, makeShop, settle, startBackend, waitFor } from "./helpers.js";

let backend: Awaited<ReturnType<typeof startBackend>>;
let h: Awaited<ReturnType<typeof makeShop>>;
let offline: boolean, hold: boolean, mono: number;

beforeEach(async () => {
  offline = false; hold = false; mono = 0;
  backend = await startBackend();
  await backend.settings("shop-a", true);
  h = await makeShop({ backend, monotonicNow: () => mono, updateHold: () => hold,
    fetchImpl: async (input, init) => {
      if (offline) throw new TypeError("fictional_backend_offline");
      return fetch(input, init);
    },
  });
});
afterEach(async () => {
  offline = false;
  await h?.rt.stop(false);
  await backend?.stop();
  if (h?.dir) fs.rmSync(h.dir, { recursive: true, force: true });
});

async function duringOutage(count = 1) {
  offline = true;
  await waitFor(() => h.rt.backendState.state === "error", "offline");
  const messages = Array.from({ length: count }, (_, i) => h.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: `营业时间？ ${i}` }));
  const latest = messages.at(-1)!.platform_message_id!;
  await waitFor(() => h.rt.journal.conversation("buyer-1").notes[latest] === "backend_unavailable", "stored while offline");
  await settle(h.rt);
  assert.equal(eventsOf(h.rt).length, 0);
  return messages;
}
async function recover() {
  offline = false;
  await Promise.all([h.rt.refresh(), h.rt.refresh()]);
  await waitFor(() => h.rt.backendState.state === "ok" && h.rt.lease.state === "held", "recovered");
  await settle(h.rt);
}
async function newMessageSendsOnce() {
  h.mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "营业时间？" });
  await waitFor(() => h.mock.platformSends.length === 1, "new message sends");
  await settle(h.rt);
}

test("失联期间连发全部保留；恢复后只处理最新一条，并发心跳不重复", async () => {
  const messages = await duringOutage(3);
  await recover();
  await waitFor(() => h.mock.platformSends.length === 1, "resumed send");
  await settle(h.rt);
  const events = eventsOf(h.rt);
  assert.equal(events.length, 1);
  assert.equal(events[0].message_id, messages.at(-1)!.platform_message_id);
  assert.equal(JSON.parse(events[0].body).context.messages.filter((m: { role: string }) => m.role === "buyer").length, 3);
  await Promise.all([h.rt.refresh(), h.rt.refresh(), h.rt.refresh()]);
  await settle(h.rt);
  assert.equal(eventsOf(h.rt).length, 1);
  assert.equal(h.mock.platformSends.length, 1);
});

test("恢复不重置原60秒预算，已过9秒只剩51秒", async () => {
  await duringOutage(); mono = 9000;
  await recover();
  await waitFor(() => h.mock.platformSends.length === 1, "send in original window");
  assert.equal(eventsOf(h.rt)[0].budget_ms, 51000);
});

test("失联耗尽60秒后不复活；新的买家消息仍正常处理", async () => {
  const messages = await duringOutage(); mono = 61000;
  await recover();
  assert.equal(eventsOf(h.rt).length, 0);
  assert.equal(h.rt.journal.conversation("buyer-1").notes[messages[0].platform_message_id!], "reply_deadline_exceeded");
  assert.equal(h.mock.platformSends.length, 0);
  await newMessageSendsOnce();
});

test("自动→观察→自动不会复活先前积压；只处理后续新消息", async () => {
  await duringOutage();
  h.rt.setMode("observe"); h.rt.setMode("auto");
  await recover();
  assert.equal(eventsOf(h.rt).length, 0);
  assert.equal(h.mock.platformSends.length, 0);
  await newMessageSendsOnce();
});

test("平台退出重登后不处理旧会话积压", async () => {
  await duringOutage(); const oldSession = h.rt.sessionId;
  h.mock.expire(); offline = false;
  await h.mock.login(); await recover();
  assert.notEqual(h.rt.sessionId, oldSession);
  assert.equal(eventsOf(h.rt).length, 0);
  assert.equal(h.mock.platformSends.length, 0);
  await newMessageSendsOnce();
});

test("人工接管再释放不重放接管前的积压", async () => {
  await duringOutage();
  h.rt.setTakeover("buyer-1", true); h.rt.setTakeover("buyer-1", false);
  await recover();
  assert.equal(eventsOf(h.rt).length, 0);
  assert.equal(h.mock.platformSends.length, 0);
  await newMessageSendsOnce();
});

test("安装保持期间恢复连接不会执行积压，解除保持后也不重放", async () => {
  await duringOutage(); hold = true;
  await recover(); hold = false;
  await h.rt.refresh(); await settle(h.rt);
  assert.equal(eventsOf(h.rt).length, 0);
  assert.equal(h.mock.platformSends.length, 0);
  await newMessageSendsOnce();
});

test("恢复后发送结果unknown不会因后续心跳或重复消息再发", async () => {
  const messages = await duringOutage(); h.mock.sendBehavior = "timeout_after_call";
  await recover();
  await waitFor(() => eventsOf(h.rt)[0]?.attempt?.phase === "unknown", "unknown");
  h.mock.redeliver(messages[0]);
  await Promise.all([h.rt.refresh(), h.rt.refresh()]); await settle(h.rt);
  assert.equal(eventsOf(h.rt).length, 1);
  assert.equal(h.mock.platformSends.length, 1);
});
