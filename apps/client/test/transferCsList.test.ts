import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Module from "node:module";
import { test } from "node:test";

// 用 Electron 替身驱动真实的网络监听：正式转接点“转移会话”后，平台客服名单请求的进展只记状态（虚构数据）。
const req = Module.createRequire(__filename);
const electronPath = req.resolve("electron");
req.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { BrowserWindow: class {}, session: { fromPartition: () => ({}) } } } as unknown as NodeModule;
const { PddPageAdapter } = req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

const LIST_URL = "https://mms.pinduoduo.com/latitude/assign/getAssignCsList";
type State = { state: string; id: string | null } | null;

function harness(body: string | Error) {
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach: () => undefined,
    sendCommand: async (m: string) => {
      if (m === "Network.getResponseBody" && body instanceof Error) throw body;
      return { body: m === "Network.getResponseBody" ? body : "", base64Encoded: false };
    },
  });
  const adapter = new PddPageAdapter("fixture", "虚构店铺") as unknown as { attachNetwork(w: unknown): void; csList: State };
  adapter.attachNetwork({ isDestroyed: () => false, webContents: { debugger: dbg, on: () => undefined } });
  const emit = (method: string, params: Record<string, unknown>) => dbg.emit("message", {}, method, params);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { adapter, emit, settle };
}

for (const [name, body, expected] of [
  ["名单非空：ready", JSON.stringify({ result: { "cs-1": { username: "虚构客服" } } }), "ready"],
  ["名单为空：empty（平台不会弹框）", JSON.stringify({ result: {} }), "empty"],
  ["没有 result：empty", JSON.stringify({ success: false }), "empty"],
  ["响应不是 JSON：empty", "<html>", "empty"],
  ["读不到响应：failed", new Error("fictional"), "failed"],
] as const) {
  test(`客服名单请求 ${name}`, async () => {
    const h = harness(body);
    h.adapter.csList = { state: "waiting", id: null };
    h.emit("Network.requestWillBeSent", { requestId: "r1", request: { url: LIST_URL } });
    assert.deepEqual(h.adapter.csList, { state: "requested", id: "r1" });
    h.emit("Network.loadingFinished", { requestId: "r1" });
    await h.settle();
    assert.equal(h.adapter.csList?.state, expected);
  });
}

test("客服名单请求加载失败：failed", () => {
  const h = harness("{}");
  h.adapter.csList = { state: "waiting", id: null };
  h.emit("Network.requestWillBeSent", { requestId: "r1", request: { url: LIST_URL } });
  h.emit("Network.loadingFailed", { requestId: "r1" });
  assert.equal(h.adapter.csList?.state, "failed");
});

test("只认平台主机上的名单路径，且只在正式转接等待时记录", async () => {
  const h = harness(JSON.stringify({ result: { a: 1 } }));
  h.emit("Network.requestWillBeSent", { requestId: "r0", request: { url: LIST_URL } });
  assert.equal(h.adapter.csList, null);
  h.adapter.csList = { state: "waiting", id: null };
  for (const url of ["https://evil.example/latitude/assign/getAssignCsList", "https://mms.pinduoduo.com/latitude/assign/getCsList", "not a url"]) {
    h.emit("Network.requestWillBeSent", { requestId: "x", request: { url } });
  }
  assert.deepEqual(h.adapter.csList, { state: "waiting", id: null });
  h.emit("Network.requestWillBeSent", { requestId: "r1", request: { url: LIST_URL } });
  h.emit("Network.loadingFinished", { requestId: "other" });
  await h.settle();
  assert.deepEqual(h.adapter.csList, { state: "requested", id: "r1" });
});

test("转接已结束（状态清空）后迟到的响应不再写回", async () => {
  const h = harness(JSON.stringify({ result: { a: 1 } }));
  h.adapter.csList = { state: "waiting", id: null };
  h.emit("Network.requestWillBeSent", { requestId: "r1", request: { url: LIST_URL } });
  h.emit("Network.loadingFinished", { requestId: "r1" });
  h.adapter.csList = null;
  await h.settle();
  assert.equal(h.adapter.csList, null);
});
