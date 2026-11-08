import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ShopRuntime } from "../src/core/runtime.js";
import { shopView } from "../src/core/view.js";
import { HOURS_REPLY, TOKEN_A, TOKEN_B, TestBackend, eventsOf, faultyFetch, makeShop, settle, startBackend, waitFor } from "./helpers.js";

// 与真实的仓库后台（Python）联调；全部是虚构店铺与虚构消息。

let backend: TestBackend;
const running: ShopRuntime[] = [];

async function shop(opts: Omit<Parameters<typeof makeShop>[0], "backend"> = {}) {
  const h = await makeShop({ backend, ...opts });
  running.push(h.rt);
  return h;
}

beforeEach(async () => {
  backend = await startBackend();
  await backend.settings("shop-a", true);
  await backend.settings("shop-b", true);
});

afterEach(async () => {
  for (const rt of running.splice(0)) await rt.stop(false);
  await backend.stop();
});

async function decided(rt: ShopRuntime) {
  await waitFor(() => eventsOf(rt).some((e) => e.snapshot?.state === "ready"), "decision");
  await settle(rt);
}

describe("完整链路", () => {
  test("模拟登录→收消息→后台规则判断→模拟平台确认→后台显示回执", async () => {
    const { rt, mock } = await shop();
    assert.equal(rt.backendState.state, "ok");
    assert.equal(rt.lease.state, "held");
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间是什么时候？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "receipt uploaded");
    const ev = eventsOf(rt)[0];
    assert.equal(ev.attempt?.phase, "sent");
    assert.equal(mock.platformSends.length, 1);
    assert.equal(mock.platformSends[0].text, HOURS_REPLY);
    const [server] = await backend.events("shop-a");
    assert.equal(server.delivery.status, "sent");
    assert.equal(server.delivery.platform_message_id, ev.attempt?.platform_message_id);
    // 平台回显的客服消息只改变上下文版本，不再触发判断。
    await waitFor(() => rt.journal.conversation("buyer-1").messages.length === 2, "echo");
    assert.equal(eventsOf(rt).length, 1);
    const view = shopView(rt);
    assert.equal(view.conversations[0].messages[0].status?.label, "已获平台确认");
  });

  test("仅观察模式：拿到建议回复但不发送", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const ev = eventsOf(rt)[0];
    assert.equal(ev.snapshot?.decision?.action, "reply");
    assert.equal(ev.blocked, "mode_observe");
    assert.equal(ev.attempt, null);
    assert.equal(mock.platformSends.length, 0);
    assert.equal(shopView(rt).conversations[0].messages[0].status?.label, "建议回复");
  });

  test("未命中规则：建议交人工，不发送，也不声称平台已转接", async () => {
    const { rt, mock } = await shop();
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "我要退款" });
    await decided(rt);
    assert.equal(eventsOf(rt)[0].snapshot?.decision?.action, "handoff");
    assert.equal(mock.platformSends.length, 0);
    const status = shopView(rt).conversations[0].messages[0].status;
    assert.equal(status?.label, "建议交人工");
    assert.match(status?.reason ?? "", /平台未执行转接/);
  });
});

describe("店铺隔离与发送归属", () => {
  test("两店数据、凭据、会话互相隔离", async () => {
    const a = await shop({ shop: "shop-a" });
    const b = await shop({ shop: "shop-b" });
    assert.notEqual(a.dir, b.dir);
    a.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    b.mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "营业时间？" });
    await waitFor(() => [a.rt, b.rt].every((rt) => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded"), "both sent");
    assert.deepEqual([...a.rt.journal.conversations.keys()], ["buyer-1"]);
    assert.deepEqual([...b.rt.journal.conversations.keys()], ["buyer-2"]);
    assert.equal((await backend.events("shop-a")).length, 1);
    assert.equal((await backend.events("shop-b"))[0].conversation_id, "buyer-2");
    assert.notEqual(a.rt.sessionId, b.rt.sessionId);
  });

  test("串店凭据被拒绝：A 店配置使用 B 店口令", async () => {
    const { rt, mock } = await shop({ shop: "shop-a", token: TOKEN_B, login: false });
    assert.equal(rt.backendState.state, "error");
    assert.equal(rt.backendState.detail, "token_shop_mismatch");
    await mock.login();
    const m = mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await settle(rt);
    assert.equal(eventsOf(rt).length, 0);
    assert.equal(rt.journal.conversation("buyer-1").notes[m.platform_message_id!], "backend_unavailable");
  });

  test("平台实际登录的店铺与配置不符时不提交、不发送", async () => {
    const { rt, mock } = await shop({ login: false });
    mock.loginAs = "pdd-someone-else";
    await mock.login();
    const m = mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await settle(rt);
    assert.equal(eventsOf(rt).length, 0);
    assert.equal(rt.journal.conversation("buyer-1").notes[m.platform_message_id!], "platform_shop_mismatch");
    assert.equal(shopView(rt).platform.identity_ok, false);
  });

  test("另一实例争抢同店发送归属：后者 lease_busy，不提交", async () => {
    const first = await shop();
    const second = await shop();
    assert.equal(first.rt.lease.state, "held");
    assert.equal(second.rt.lease.state, "busy");
    const m = second.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await settle(second.rt);
    assert.equal(eventsOf(second.rt).length, 0);
    assert.equal(second.rt.journal.conversation("buyer-1").notes[m.platform_message_id!], "lease_busy");
    assert.equal(second.mock.platformSends.length, 0);
  });

  test("登录失效后旧任务失效；重登换新 session_id，旧任务不能发送", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const oldSession = rt.sessionId;
    mock.expire();
    assert.equal(rt.sessionId, null);
    const ev = eventsOf(rt)[0];
    rt.setMode("auto");
    assert.equal(rt.sendBlocker(ev), "platform_logged_out");
    await mock.login();
    await waitFor(() => rt.lease.state === "held", "relogin lease");
    assert.notEqual(rt.sessionId, oldSession);
    assert.equal(rt.sendBlocker(ev), "session_changed");
    assert.equal(mock.platformSends.length, 0);
  });
});

describe("去重与重投", () => {
  test("同一消息重复到达只处理一次", async () => {
    const { rt, mock } = await shop();
    const m = mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    mock.redeliver(m);
    mock.redeliver(m);
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "sent");
    await settle(rt);
    assert.equal(rt.duplicates, 2);
    assert.equal(eventsOf(rt).length, 1);
    assert.equal(mock.platformSends.length, 1);
  });

  test("提交响应丢失：用相同 event_id 与请求体重投，后台不重复建任务", async () => {
    let dropped = 0;
    const fetchImpl = faultyFetch((url, method) => (method === "POST" && url.endsWith("/api/v1/events") && dropped++ === 0 ? "drop_response" : null));
    const { rt, mock } = await shop({ fetchImpl });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "sent");
    assert.equal(dropped, 2);
    assert.equal((await backend.events("shop-a")).length, 1);
    assert.equal(mock.platformSends.length, 1);
  });

  test("重连回补的历史消息不触发自动回复", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const before = eventsOf(rt).length;
    mock.replayHistory();
    // 平台侧另有一条本地未见过的旧消息随回补到达。
    (mock as any).history.get("buyer-1").unshift({ conversation_id: "buyer-1", platform_message_id: "mock-old-1", role: "buyer", kind: "text", content: "营业时间几点", created_at: 1 });
    mock.replayHistory();
    await settle(rt);
    assert.equal(eventsOf(rt).length, before);
    assert.equal(rt.journal.conversation("buyer-1").notes["mock-old-1"], "history_sync");
    assert.equal(mock.platformSends.length, 0);
  });

  test("取历史时先存下的新消息，随后实时推送到达：按新消息提交", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    const a = mock.seedBuyerHistory("buyer-1", "在吗");
    const b = mock.seedBuyerHistory("buyer-1", "营业时间？");
    mock.redeliver(a);
    await waitFor(() => rt.journal.conversation("buyer-1").notes[a.platform_message_id as string] === "superseded_before_submit", "a superseded");
    assert.equal(eventsOf(rt).length, 0);
    assert.equal(rt.journal.conversation("buyer-1").messages.find((m) => m.id === b.platform_message_id)?.live, false);
    mock.redeliver(b);
    await waitFor(() => !!rt.journal.eventForMessage("buyer-1", b.platform_message_id as string), "promoted event");
    assert.equal(rt.journal.conversation("buyer-1").notes[b.platform_message_id as string], "promoted_live");
    assert.equal(rt.duplicates, 0);
  });

  test("买家消息后一两秒才到的平台自动卡片不挤掉这条消息", async () => {
    const { rt, mock } = await shop();
    const a = mock.seedBuyerHistory("buyer-1", "营业时间？");
    const card = (id: string, type: "source" | "system", content: string) =>
      ({ conversation_id: "buyer-1", platform_message_id: id, role: "system", kind: "card", content, created_at: a.created_at + 1, card: { type, title: content } });
    (mock as any).history.get("buyer-1").push(card("mock-src-1", "source", "平台来源卡片：买家从商品进入"), card("mock-sys-1", "system", "平台系统提示卡片"));
    mock.redeliver(a);
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "sent despite trailing cards");
    assert.equal(rt.journal.conversation("buyer-1").notes[a.platform_message_id as string], undefined);
    assert.equal(mock.platformSends[0].text, HOURS_REPLY);
  });

  test("提交后才到的平台自动卡片不使判断失效", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    const a = mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    (mock as any).emit({ type: "message", live: true, message: { conversation_id: "buyer-1", platform_message_id: "mock-src-2", role: "system", kind: "card", content: "平台来源卡片：买家从商品进入", created_at: a.created_at + 1, card: { type: "source", title: "平台来源卡片：买家从商品进入" } } });
    await waitFor(() => rt.journal.conversation("buyer-1").messages.length === 2, "card stored");
    rt.setMode("auto");
    assert.notEqual(rt.sendBlocker(eventsOf(rt)[0]), "superseded");
    // 买家的新消息仍会使旧判断失效。
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "在吗" });
    await waitFor(() => rt.journal.conversation("buyer-1").messages.length === 3, "buyer follow-up stored");
    assert.equal(rt.sendBlocker(eventsOf(rt)[0]), "superseded");
  });

  test("平台来源卡片与历史中的买家卡片都不在本地阻止", async () => {
    const { rt, mock } = await shop();
    (mock as any).history.set("buyer-1", [{ conversation_id: "buyer-1", platform_message_id: "mock-src-1", role: "system", kind: "card", content: "平台来源卡片：买家从商品进入", created_at: Math.floor(Date.now() / 1000) - 5 }]);
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.snapshot?.state === "ready", "decided with source card");
    await settle(rt);
    const first = eventsOf(rt)[0];
    assert.equal(first.text_only, true);
    assert.notEqual(first.blocked, "unsupported_content");
    // 能按卡片上下文作答的后台会判为 reply 并发送；更早版本的后台仍转人工。
    const sent = first.snapshot?.decision?.action === "reply" ? 1 : 0;
    if (sent) assert.equal(first.attempt?.phase, "sent");
    assert.equal(mock.platformSends.length, sent);

    mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "商品", kind: "card" });
    mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "营业时间？" });
    await waitFor(() => eventsOf(rt).length === 2 && eventsOf(rt)[1].snapshot?.state === "ready", "buyer card decided");
    await settle(rt);
    const second = eventsOf(rt)[1];
    assert.equal(second.text_only, true);
    assert.notEqual(second.blocked, "unsupported_content");
    // 是否回复由后台决定（更早版本的后台仍转人工）。
    const sent2 = second.snapshot?.decision?.action === "reply" ? 1 : 0;
    assert.equal(mock.platformSends.length, sent + sent2);
  });

  test("缺少可靠消息编号：只保存，转人工，不提交", async () => {
    const { rt, mock } = await shop();
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？", stableId: false });
    await settle(rt);
    assert.equal(eventsOf(rt).length, 0);
    const conv = rt.journal.conversation("buyer-1");
    assert.equal(conv.notes[conv.messages[0].id], "no_stable_id");
  });
});

describe("图片", () => {
  const capture = () => {
    const bodies: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/v1/events") && init?.method === "POST" && typeof init.body === "string") bodies.push(init.body);
      return fetch(input, init);
    }) as unknown as Parameters<typeof makeShop>[0]["fetchImpl"];
    return { bodies, fetchImpl };
  };
  const REF = "https://img.pddpic.com/fake/a.jpg";
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

  test("最新图片：提交时带原图，本地日志只存大小与哈希", async () => {
    const { bodies, fetchImpl } = capture();
    const { rt, mock, dir } = await shop({ fetchImpl });
    mock.images.set(REF, { ok: true, mime: "image/jpeg", bytes: JPEG });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "[图片]", kind: "image", image_ref: REF });
    await waitFor(() => bodies.length > 0, "submitted");
    await settle(rt);
    const sent = JSON.parse(bodies[0]).context.messages.at(-1);
    assert.deepEqual(sent.attachments, [{ type: "image", mime: "image/jpeg", data_url: `data:image/jpeg;base64,${JPEG.toString("base64")}` }]);
    assert.equal(sent.content, "[图片]");
    const ev = eventsOf(rt)[0];
    assert.equal(ev.has_images, true);
    const stored = JSON.parse(ev.body).context.messages.at(-1).attachments[0];
    assert.equal(stored.size, JPEG.length);
    assert.match(stored.sha256, /^[0-9a-f]{64}$/);
    assert.equal(stored.data_url, undefined);
    assert.ok(!fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").includes("data:image"));
  });

  test("商品卡片带缩略图：卡片与图片一起提交；取不到图时卡片文字不变", async () => {
    const { bodies, fetchImpl } = capture();
    const { rt, mock } = await shop({ fetchImpl });
    mock.images.set(REF, { ok: true, mime: "image/jpeg", bytes: JPEG });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "商品卡片：虚构商品", kind: "card", image_ref: REF });
    mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "商品卡片：虚构商品", kind: "card", image_ref: "https://img.pddpic.com/fake/missing.jpg" });
    await waitFor(() => bodies.length >= 2, "submitted");
    await settle(rt);
    const byConv = Object.fromEntries(bodies.map((b) => [JSON.parse(b).conversation_id, JSON.parse(b).context.messages.at(-1)]));
    assert.equal(byConv["buyer-1"].attachments.length, 1);
    assert.equal(byConv["buyer-1"].content, "商品卡片：虚构商品");
    assert.equal(byConv["buyer-2"].attachments, undefined);
    assert.equal(byConv["buyer-2"].content, "商品卡片：虚构商品");
  });

  test("最新图片取不到：不带图片，内容写明未取到", async () => {
    const { bodies, fetchImpl } = capture();
    const { rt, mock } = await shop({ fetchImpl });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "[图片]", kind: "image", image_ref: REF });
    await waitFor(() => bodies.length > 0, "submitted");
    await settle(rt);
    const sent = JSON.parse(bodies[0]).context.messages.at(-1);
    assert.equal(sent.attachments, undefined);
    assert.equal(sent.content, "[图片，前台未取到]");
    assert.equal(eventsOf(rt)[0].has_images, undefined);
  });
});

describe("阻止旧发送", () => {
  test("历史缺失：如实上报，仍按当前消息回复一次并上传回执", async () => {
    const { rt, mock } = await shop();
    mock.historyGaps.add("buyer-1");
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "partial-history receipt");
    const ev = eventsOf(rt)[0];
    assert.equal(ev.history_complete, false);
    assert.equal(JSON.parse(ev.body).context.history_complete, false);
    assert.equal(ev.snapshot?.decision?.action, "reply");
    assert.equal(mock.platformSends.length, 1);
    assert.equal(mock.platformSends[0].text, HOURS_REPLY);
    assert.equal((await backend.events("shop-a"))[0].delivery.status, "sent");
  });

  test("页面只加载最近一段：与本地已确认完整的记录接得上，仍算完整", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "在吗" });
    await waitFor(() => eventsOf(rt).length === 1, "first event");
    await settle(rt);
    assert.equal(eventsOf(rt)[0].history_complete, true);
    const first = rt.journal.conversation("buyer-1").messages[0].id;
    assert.equal(rt.journal.conversation("buyer-1").complete_through, first);
    mock.historyWindows.set("buyer-1", 2);
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt).length === 2, "second event");
    await settle(rt);
    assert.equal(eventsOf(rt)[1].history_complete, true);
    assert.notEqual(rt.journal.conversation("buyer-1").complete_through, first);
  });

  test("页面只加载最近一段且接不上本地记录：按不完整处理", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "在吗" });
    await waitFor(() => eventsOf(rt).length === 1, "first event");
    await settle(rt);
    mock.historyWindows.set("buyer-1", 1);
    mock.seedBuyerHistory("buyer-1", "中间一条（本地没收到）");
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt).length === 2, "second event");
    await settle(rt);
    assert.equal(eventsOf(rt)[1].history_complete, false);
  });

  test("确认点只在更早的已缓存消息里、不在最新连续段中：不完整，确认点不前移", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "在吗" });
    await waitFor(() => eventsOf(rt).length === 1, "first event");
    await settle(rt);
    const mark = rt.journal.conversation("buyer-1").complete_through;
    mock.historyWindows.set("buyer-1", 1);
    const original = mock.fetchHistory.bind(mock);
    mock.fetchHistory = async (id: string) => {
      const h = await original(id);
      return { ...h, messages: [...rt.journal.conversation(id).messages.slice(0, 1).map((m) => ({ conversation_id: id, platform_message_id: m.id, role: m.role, kind: m.kind, content: m.content, created_at: m.created_at })), ...h.messages] };
    };
    mock.seedBuyerHistory("buyer-1", "中间一条（本地没收到）");
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt).length === 2, "second event");
    await settle(rt);
    assert.equal(eventsOf(rt)[1].history_complete, false);
    assert.equal(rt.journal.conversation("buyer-1").complete_through, mark);
  });

  test("从未确认过完整的对话：页面只加载最近一段时不完整", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.historyWindows.set("buyer-1", 5);
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "在吗" });
    await waitFor(() => eventsOf(rt).length === 1, "first event");
    await settle(rt);
    assert.equal(eventsOf(rt)[0].history_complete, false);
    assert.equal(rt.journal.conversation("buyer-1").complete_through, null);
  });

  test("最新消息无法识别：本地不发送", async () => {
    const { rt, mock } = await shop();
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "非文字消息（类型 99）", kind: "unsupported" });
    await decided(rt);
    await settle(rt);
    assert.equal(eventsOf(rt)[0].text_only, false);
    assert.equal(eventsOf(rt)[0].attempt, null);
    assert.equal(mock.platformSends.length, 0);
  });

  test("判断过期后不得发送", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    rt.setMode("auto");
    const ev = eventsOf(rt)[0];
    // 模式切换已使旧版本失效；这里单独核验过期规则。
    ev.context_revision = rt.journal.conversation("buyer-1").revision;
    ev.snapshot!.decision!.expires_at = Date.now() / 1000 + 1;
    assert.equal(rt.sendBlocker(ev), "decision_expired");
  });

  test("收到更新消息后旧判断失效", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const old = eventsOf(rt)[0];
    rt.setMode("auto");
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "还有别的问题" });
    assert.equal(rt.sendBlocker(old), "superseded");
    await settle(rt);
    assert.equal(old.attempt, null);
  });

  test("人工接管：立即阻止发送并使旧上下文版本失效", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const ev = eventsOf(rt)[0];
    const rev = rt.journal.conversation("buyer-1").revision;
    rt.setTakeover("buyer-1", true);
    assert.equal(rt.journal.conversation("buyer-1").revision, rev + 1);
    rt.setMode("auto");
    assert.equal(rt.sendBlocker(ev), "manual_takeover");
    rt.setMode("manual");
    assert.equal(rt.sendBlocker(ev), "mode_manual");
  });

  test("人工在平台直接回复后，旧判断失效", async () => {
    const { rt, mock } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const ev = eventsOf(rt)[0];
    rt.setMode("auto");
    ev.context_revision = rt.journal.conversation("buyer-1").revision;
    mock.injectAgentReply("buyer-1", "人工：您好");
    assert.equal(rt.sendBlocker(ev), "superseded");
  });
});

describe("发送结果与恢复", () => {
  test("平台调用前失败 = not_sent", async () => {
    const { rt, mock } = await shop();
    mock.sendBehavior = "fail_before_call";
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "receipt");
    assert.equal(eventsOf(rt)[0].attempt?.phase, "not_sent");
    assert.equal((await backend.events("shop-a"))[0].delivery.status, "not_sent");
  });

  test("平台调用后超时 = unknown；unknown 事件不重发", async () => {
    const { rt, mock } = await shop();
    mock.sendBehavior = "timeout_after_call";
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "receipt");
    const first = eventsOf(rt)[0];
    const firstAttempt = first.attempt?.attempt_id;
    assert.equal(first.attempt?.phase, "unknown");
    assert.equal((await backend.events("shop-a")).find((e) => e.event_id === first.event_id)?.delivery.status, "unknown");
    mock.sendBehavior = "confirm";
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间到底几点？" });
    await waitFor(() => eventsOf(rt).length === 2 && eventsOf(rt)[1].snapshot?.state === "ready", "second decision");
    await settle(rt);
    assert.equal(eventsOf(rt)[0].attempt?.attempt_id, firstAttempt);
    assert.equal(eventsOf(rt)[0].attempt?.phase, "unknown");
    // 旧后台按对话冻结（不发）；新后台只锁该事件（第二条可发）。旧事件都只调用过一次平台发送。
    const secondSent = eventsOf(rt)[1].attempt?.phase === "sent" ? 1 : 0;
    assert.equal(mock.platformSends.length, 1 + secondSent);
    assert.equal(shopView(rt).conversations[0].unknown, true);
  });

  test("unknown 不锁买家：同对话新消息本地不拦截；unknown 旧事件永不再申请许可或重发", async () => {
    const { rt, mock } = await shop();
    mock.sendBehavior = "ack_without_id";
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "unknown receipt");
    const old = eventsOf(rt)[0];
    const oldAttempt = old.attempt?.attempt_id;
    mock.sendBehavior = "confirm";
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间到底几点？" });
    await waitFor(() => eventsOf(rt)[1]?.snapshot?.state === "ready", "second decided");
    await settle(rt);
    const second = eventsOf(rt)[1];
    assert.notEqual(second.blocked, "unknown_pending");
    // 后台按新规则实现后会判 reply 并发送；旧后台仍以 unknown_delivery 转人工。
    if (second.snapshot?.decision?.action === "reply") assert.equal(second.attempt?.phase, "sent");
    else assert.equal(second.snapshot?.decision?.reason, "unknown_delivery");
    assert.equal(eventsOf(rt)[0].attempt?.attempt_id, oldAttempt);
    assert.equal(eventsOf(rt)[0].attempt?.phase, "unknown");
    assert.equal(mock.platformSends.length, second.attempt?.phase === "sent" ? 2 : 1);
  });

  test("平台只有传输确认没有消息编号 = unknown", async () => {
    const { rt, mock } = await shop();
    mock.sendBehavior = "ack_without_id";
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "receipt");
    assert.equal(eventsOf(rt)[0].attempt?.phase, "unknown");
  });

  test("回执上传失败：只补传回执，不重新发送", async () => {
    let failed = 0;
    const fetchImpl = faultyFetch((url, method) => (method === "POST" && url.endsWith("/receipt") && failed++ < 2 ? "fail_before" : null));
    const { rt, mock } = await shop({ fetchImpl });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.phase === "sent", "sent");
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "receipt retried", 10000);
    assert.equal(mock.platformSends.length, 1);
    assert.equal((await backend.events("shop-a"))[0].delivery.status, "sent");
  });

  test("发送中崩溃：重启后保持 unknown，补传回执，不重发", async () => {
    const first = await shop({ timing: { sendTimeoutMs: 3000 } });
    first.mock.sendBehavior = "timeout_after_call";
    first.mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(first.rt)[0]?.attempt?.phase === "sending", "sending");
    await first.rt.stop(false);
    running.splice(running.indexOf(first.rt), 1);

    const reopened = new ShopRuntime({ config: first.rt.config, token: TOKEN_A, adapter: first.mock, dataDir: first.dir, timing: { heartbeatMs: 300 } });
    running.push(reopened);
    const ev = eventsOf(reopened)[0];
    assert.equal(ev.attempt?.phase, "unknown");
    assert.equal(ev.attempt?.detail, "interrupted_during_send");
    await reopened.start();
    await waitFor(() => eventsOf(reopened)[0].attempt?.receipt?.upload === "uploaded", "unknown receipt");
    assert.equal((await backend.events("shop-a"))[0].delivery.status, "unknown");
    assert.equal(first.mock.platformSends.length, 1);
  });

  test("回执上传遇到 503：保持待上传并在许可期内快速重试，不当作被拒", async () => {
    let failed = 0;
    const fetchImpl = faultyFetch((url, method) => (method === "POST" && url.endsWith("/receipt") && failed++ < 2 ? "status_503" : null));
    // 心跳拉长到 60 秒，确保成功来自快速重试而不是定时补报。
    const { rt, mock } = await shop({ fetchImpl, timing: { heartbeatMs: 60000 } });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "receipt after 503", 5000);
    assert.equal(failed >= 2, true);
    assert.equal(mock.platformSends.length, 1);
    assert.equal((await backend.events("shop-a"))[0].delivery.status, "sent");
  });

  test("提交事件遇到 503：用相同 event_id 与请求体重试，不当作被拒", async () => {
    let failed = 0;
    const fetchImpl = faultyFetch((url, method) => (method === "POST" && url.endsWith("/api/v1/events") && failed++ < 1 ? "status_503" : null));
    const { rt, mock } = await shop({ fetchImpl, mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const ev = eventsOf(rt)[0];
    assert.equal(ev.stage, "submitted");
    const server = await backend.events("shop-a");
    assert.equal(server.length, 1);
    assert.equal(server[0].event_id, ev.event_id);
  });

  test("许可剩余时间不足以完成发送：放弃并上报 not_sent，不调用平台", async () => {
    const { rt, mock } = await shop({ timing: { minSendWindow: 60 } });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.attempt?.receipt?.upload === "uploaded", "receipt");
    const ev = eventsOf(rt)[0];
    assert.equal(ev.attempt?.phase, "aborted_before_send");
    assert.equal(ev.attempt?.detail, "claim_expiring");
    assert.equal(ev.attempt?.receipt?.status, "not_sent");
    assert.equal(mock.platformSends.length, 0);
  });

  test("结果与回执同一条记录落盘：重启后仍有待上传回执", async () => {
    const { rt, mock, dir } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const ev = eventsOf(rt)[0];
    rt.journal.finishAttempt(ev.event_id, "att-done-1", "sent", null, "pm-1", { status: "sent", platform_message_id: "pm-1", upload: "pending", error: null });
    await rt.stop(false);
    running.splice(running.indexOf(rt), 1);
    const reopened = new ShopRuntime({ config: rt.config, token: TOKEN_A, adapter: mock, dataDir: dir, timing: { heartbeatMs: 300 } });
    running.push(reopened);
    const again = eventsOf(reopened)[0];
    assert.equal(again.attempt?.phase, "sent");
    assert.deepEqual(again.attempt?.receipt, { status: "sent", platform_message_id: "pm-1", upload: "pending", error: null });
  });

  test("旧日志只有发送结果没有回执：重启后按结果补出待上传回执", async () => {
    const { rt, mock, dir } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const ev = eventsOf(rt)[0];
    rt.journal.setAttempt(ev.event_id, "att-old-1", "sent", null, "pm-2");
    await rt.stop(false);
    running.splice(running.indexOf(rt), 1);
    const reopened = new ShopRuntime({ config: rt.config, token: TOKEN_A, adapter: mock, dataDir: dir, timing: { heartbeatMs: 300 } });
    running.push(reopened);
    const again = eventsOf(reopened)[0];
    assert.equal(again.attempt?.receipt?.status, "sent");
    assert.equal(again.attempt?.receipt?.platform_message_id, "pm-2");
    assert.equal(again.attempt?.receipt?.upload, "pending");
  });

  test("申请许可后、调用平台前崩溃：重启后上报 not_sent", async () => {
    const { rt, mock, dir } = await shop({ mode: "observe" });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await decided(rt);
    const ev = eventsOf(rt)[0];
    rt.journal.setAttempt(ev.event_id, "att-crash-1", "claimed");
    await rt.stop(false);
    running.splice(running.indexOf(rt), 1);
    const reopened = new ShopRuntime({ config: rt.config, token: TOKEN_A, adapter: mock, dataDir: dir, timing: { heartbeatMs: 300 } });
    running.push(reopened);
    const again = eventsOf(reopened)[0];
    assert.equal(again.attempt?.phase, "aborted_before_send");
    assert.equal(again.attempt?.receipt?.status, "not_sent");
  });

  test("提交响应一直丢失：重启后用相同 event_id 与请求体补报，旧会话任务不发送", async () => {
    const fetchImpl = faultyFetch((url, method) => (method === "POST" && url.endsWith("/api/v1/events") ? "drop_response" : null));
    const { rt, mock, dir } = await shop({ fetchImpl, timing: { submitRetries: 1 } });
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "营业时间？" });
    await waitFor(() => eventsOf(rt)[0]?.stage === "submit_failed", "submit failed");
    const { event_id, body } = eventsOf(rt)[0];
    await rt.stop(false);
    running.splice(running.indexOf(rt), 1);

    const reopened = new ShopRuntime({ config: rt.config, token: TOKEN_A, adapter: mock, dataDir: dir, timing: { heartbeatMs: 300, pollMs: 80 } });
    running.push(reopened);
    assert.notEqual(reopened.instanceId, rt.instanceId);
    await reopened.start();
    await waitFor(() => eventsOf(reopened)[0].snapshot?.state === "ready", "resubmitted and decided");
    await settle(reopened);
    const ev = eventsOf(reopened)[0];
    assert.equal(ev.event_id, event_id);
    assert.equal(ev.body, body);
    assert.equal(ev.stage, "submitted");
    const server = await backend.events("shop-a");
    assert.equal(server.length, 1);
    assert.equal(server[0].event_id, event_id);
    assert.equal(ev.attempt, null);
    assert.equal(ev.blocked, "session_changed");
    assert.equal(mock.platformSends.length, 0);
  });
});

describe("订单", () => {
  const capture = () => {
    const bodies: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/v1/events") && init?.method === "POST" && typeof init.body === "string") bodies.push(init.body);
      return fetch(input, init);
    }) as unknown as Parameters<typeof makeShop>[0]["fetchImpl"];
    return { bodies, fetchImpl };
  };
  const ORDER = { key: "241024-000000000000009", summary: { status: "已发货", goods_title: "虚构商品", amount: "19.90", order_time: 1790000000, observed_at: 1790000100 } };

  test("提交时带订单摘要：只有对话内引用，没有平台订单号；后台接受", async () => {
    const { bodies, fetchImpl } = capture();
    const { rt, mock } = await shop({ fetchImpl });
    mock.injectOrders("buyer-1", [ORDER]);
    mock.injectBuyerMessage({ conversation_id: "buyer-1", content: "我的货到哪了" });
    await waitFor(() => bodies.length > 0, "submitted");
    await settle(rt);
    const orders = JSON.parse(bodies[0]).context.orders;
    assert.equal(orders.length, 1);
    assert.match(orders[0].order_ref, /^o-[0-9a-f]{16}$/);
    assert.equal(orders[0].goods_title, "虚构商品");
    assert.ok(!bodies[0].includes("241024"));
    assert.notEqual(eventsOf(rt)[0].stage, "rejected");
  });

  test("订单读取进行中：先等订单到再提交", async () => {
    const { bodies, fetchImpl } = capture();
    const { rt, mock } = await shop({ fetchImpl });
    mock.pendingOrders.add("buyer-2");
    setTimeout(() => mock.injectOrders("buyer-2", [ORDER]), 300);
    mock.injectBuyerMessage({ conversation_id: "buyer-2", content: "发货了吗" });
    await waitFor(() => bodies.length > 0, "submitted");
    await settle(rt);
    assert.equal(JSON.parse(bodies[0]).context.orders?.length, 1);
  });

  test("订单变化使对话版本递增；内容不变不递增", async () => {
    const { rt, mock } = await shop();
    mock.injectBuyerMessage({ conversation_id: "buyer-3", content: "你好" });
    await waitFor(() => eventsOf(rt).length > 0, "submitted");
    await settle(rt);
    const r0 = rt.journal.conversation("buyer-3").revision;
    mock.injectOrders("buyer-3", [ORDER]);
    mock.injectOrders("buyer-3", [ORDER]);
    assert.equal(rt.journal.conversation("buyer-3").revision, r0 + 1);
  });

  test("本地日志不存订单：请求体去掉订单、只在内存；重启后无完整请求体则不重投", async () => {
    const { bodies, fetchImpl } = capture();
    const { rt, mock, dir } = await shop({ fetchImpl });
    mock.injectOrders("buyer-4", [ORDER]);
    mock.injectBuyerMessage({ conversation_id: "buyer-4", content: "到哪了" });
    await waitFor(() => bodies.length > 0, "submitted");
    await settle(rt);
    const ev = eventsOf(rt)[0];
    assert.equal(ev.has_orders, true);
    assert.equal(JSON.parse(ev.body).context.orders, undefined);
    assert.equal(JSON.parse(bodies[0]).context.orders.length, 1);
    assert.ok(!fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").includes("虚构商品"));
  });

  test("平台店铺身份不符时不收订单；平台会话结束清空订单", async () => {
    const { bodies, fetchImpl } = capture();
    const { rt, mock } = await shop({ fetchImpl });
    mock.loginAs = "pdd-someone-else";
    mock.injectOrders("buyer-5", [ORDER]);
    mock.loginAs = null;
    mock.injectOrders("buyer-6", [ORDER]);
    mock.expire();
    await mock.login();
    await waitFor(() => rt.lease.state === "held", "relogin lease");
    mock.injectBuyerMessage({ conversation_id: "buyer-5", content: "在吗" });
    mock.injectBuyerMessage({ conversation_id: "buyer-6", content: "在吗" });
    await waitFor(() => bodies.length >= 2, "submitted");
    await settle(rt);
    for (const b of bodies) assert.equal(JSON.parse(b).context.orders, undefined);
  });
});
