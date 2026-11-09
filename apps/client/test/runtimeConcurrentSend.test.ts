import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { eventsOf, makeShop, settle, startBackend, waitFor } from "./helpers.js";

let backend: Awaited<ReturnType<typeof startBackend>>;
let h: Awaited<ReturnType<typeof makeShop>>;
let release: (() => void) | null = null;
beforeEach(async () => {
  backend = await startBackend();
  await backend.settings("shop-a", true);
  // 被挂起的第一条发送要一直占住平台页面直到放行：默认 800ms 超时在慢机器上会先放开队列，第二条在切换观察前就申请许可。
  h = await makeShop({ backend, timing: { sendTimeoutMs: 15000 } });
});
afterEach(async () => {
  release?.(); release = null;
  await h?.rt.stop(); await backend?.stop();
  if (h?.dir) fs.rmSync(h.dir, { recursive: true, force: true });
});

test("同店两名买家同时咨询：串行操作平台页面，两条都发送且不触发平台busy", async () => {
  const send = h.mock.send.bind(h.mock);
  let busy = false, conflicts = 0;
  h.mock.send = async request => {
    if (busy) { conflicts++; return { status: "not_sent", reason: "pdd_send_busy" }; }
    busy = true;
    try { await new Promise(r => setTimeout(r, 200)); return await send(request); }
    finally { busy = false; }
  };
  for (const id of ["buyer-a", "buyer-b"]) h.mock.injectBuyerMessage({ conversation_id: id, content: "营业时间？" });
  await waitFor(() => eventsOf(h.rt).length === 2 && eventsOf(h.rt).every(e => e.attempt?.receipt?.upload === "uploaded"), "both receipts");
  assert.equal(conflicts, 0);
  assert.equal(h.mock.platformSends.length, 2);
  assert.ok(eventsOf(h.rt).every(e => e.attempt?.phase === "sent"));
  assert.deepEqual(new Set(h.mock.platformSends.map(s => s.conversation_id)), new Set(["buyer-a", "buyer-b"]));
});

test("在平台等待队列里改为观察：未获许可的后续买家不再申请或发送", async () => {
  const send = h.mock.send.bind(h.mock);
  h.mock.send = async request => {
    await new Promise<void>(resolve => { release = resolve; });
    return send(request);
  };
  h.mock.injectBuyerMessage({ conversation_id: "buyer-a", content: "营业时间？" });
  await waitFor(() => release !== null, "first send waiting");
  h.mock.injectBuyerMessage({ conversation_id: "buyer-b", content: "营业时间？" });
  await waitFor(() => eventsOf(h.rt).some(e => e.conversation_id === "buyer-b" && e.snapshot?.state === "ready"), "second queued");
  h.rt.setMode("observe");
  release!(); release = null;
  await settle(h.rt);
  const queued = eventsOf(h.rt).find(e => e.conversation_id === "buyer-b")!;
  assert.equal(queued.attempt, null);
  assert.equal(queued.blocked, "mode_observe");
  assert.equal(h.mock.platformSends.length, 0);
});
