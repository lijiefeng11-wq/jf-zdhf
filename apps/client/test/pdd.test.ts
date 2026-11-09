import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AdapterEvent } from "../src/core/adapter.js";
import { buyerFromListKey, decideOutgoing, parseChatList, parseCustomServiceInfo, parseRealtimeUserInfo, parseSendRequest, parseSendResponse } from "../src/core/pddParse.js";
import { LIVE_WINDOW_SECONDS, PddSessionTracker } from "../src/core/pddSession.js";
import { isAllowedImageUrl, sniffImage } from "../src/core/security.js";

// 全部为虚构数据，只复现字段结构。
const MALL = "100000001";
const BUYER = "2000000000001";
const NOW = 1790000000;

const realtime = (mallId: number | string = Number(MALL)) => ({ mall_id: mallId, mall: { mall_id: mallId, mall_name: "虚构测试店" }, cs_id: "cs-x" });
const csInfo = (mallId: string = MALL) => ({ success: true, result: { mallInfoResult: { mallId: Number(mallId), mallName: "虚构测试店" } } });
const listRequest = (buyer = BUYER) => ({ data: { cmd: "list", list: { with: { role: "user", id: buyer }, start_msg_id: null, start_index: 0, size: 20 } }, client: "WEB" });

type Msg = { id: string; from: "user" | "mall_cs"; ts: number | string; type?: number; content?: string; template_name?: string; info?: Record<string, unknown>; biz_context?: Record<string, unknown> };
function listResponse(msgs: Msg[], hasMore = false, buyer = BUYER) {
  return {
    success: true,
    result: {
      has_more: hasMore,
      messages: msgs.map((m) => ({
        from: m.from === "user" ? { role: "user", uid: buyer } : { role: "mall_cs", uid: "cs-uid-x", mall_id: MALL },
        to: m.from === "user" ? { role: "mall_cs", uid: "cs-uid-x", mall_id: MALL } : { role: "user", uid: buyer },
        type: m.type ?? 0,
        content: m.content ?? "虚构文字",
        ts: m.ts,
        msg_id: m.id,
        ...(m.template_name ? { template_name: m.template_name } : {}),
        ...(m.info ? { info: m.info } : {}),
        ...(m.biz_context ? { biz_context: m.biz_context } : {}),
      })),
    },
  };
}

describe("拼多多响应解析", () => {
  test("身份：两处店铺编号一致才返回；结构不符返回 null", () => {
    assert.deepEqual(parseRealtimeUserInfo(realtime()), { mall_id: MALL, mall_name: "虚构测试店" });
    assert.equal(parseRealtimeUserInfo({ mall_id: 1, mall: { mall_id: 2, mall_name: "x" } }), null);
    assert.equal(parseRealtimeUserInfo({ mall_id: "abc", mall: { mall_id: "abc", mall_name: "x" } }), null);
    assert.equal(parseRealtimeUserInfo(null), null);
    assert.deepEqual(parseCustomServiceInfo(csInfo()), { mall_id: MALL, mall_name: "虚构测试店" });
    assert.equal(parseCustomServiceInfo({ success: false, result: { mallInfoResult: { mallId: 1, mallName: "x" } } }), null);
  });

  test("对话：角色/类型映射，非文字只存占位，按时间排序", () => {
    const parsed = parseChatList(
      listRequest(),
      listResponse([
        { id: "3000000000003", from: "user", ts: NOW - 10, type: 41, template_name: "user_goods_card", content: "原始卡片数据" },
        { id: "3000000000001", from: "user", ts: String(NOW - 30), content: "在吗" },
        { id: "3000000000002", from: "mall_cs", ts: NOW - 20, content: "您好" },
        { id: "3000000000004", from: "user", ts: NOW - 5, type: 9, template_name: "user_source" },
      ]),
    );
    assert.ok(parsed);
    assert.equal(parsed.buyer_uid, BUYER);
    assert.equal(parsed.has_more, false);
    assert.deepEqual(
      parsed.messages.map((m) => [m.platform_message_id, m.role, m.kind, m.content, m.created_at]),
      [
        ["3000000000001", "buyer", "text", "在吗", NOW - 30],
        ["3000000000002", "agent", "text", "您好", NOW - 20],
        ["3000000000003", "buyer", "card", "商品卡片", NOW - 10],
        ["3000000000004", "buyer", "unsupported", "非文字消息（类型 9）", NOW - 5],
      ],
    );
  });

  test("对话：type=0 但内容只是网址或带模板的，不当作文字", () => {
    const parsed = parseChatList(
      listRequest(),
      listResponse([
        { id: "3000000000001", from: "user", ts: NOW - 3, content: "https://img.example.invalid/a/b.png" },
        { id: "3000000000002", from: "user", ts: NOW - 2, template_name: "user_source", content: "虚构模板" },
        { id: "3000000000003", from: "user", ts: NOW - 1, content: "看看这个 https://example.invalid/x" },
        { id: "3000000000004", from: "mall_cs", ts: NOW, template_name: "mall_robot_text_msg", content: "虚构欢迎语" },
      ]),
    );
    assert.deepEqual(parsed?.messages.map((m) => [m.kind, m.content]), [
      ["unsupported", "链接/图片（类型 0）"],
      ["unsupported", "非文字消息（类型 0）"],
      ["text", "看看这个 https://example.invalid/x"],
      ["text", "虚构欢迎语"],
    ]);
  });

  test("对话：平台来源卡片按 system/card 提交，只给描述不带链接", () => {
    const parsed = parseChatList(
      listRequest(),
      listResponse([
        { id: "3000000000001", from: "user", ts: NOW - 3, type: 31, content: "https://example.invalid/goods?id=1", info: { item_content: { id: 1 }, version: 1 } },
        { id: "3000000000002", from: "user", ts: NOW - 2, type: 31, content: "虚构店铺来源", info: { mall_content: { id: 2 }, version: 1 } },
        { id: "3000000000003", from: "user", ts: NOW - 1, type: 31, content: "无来源信息" },
        { id: "3000000000005", from: "user", ts: NOW - 1, type: 41, template_name: "user_source", content: "虚构来源", info: { title: "虚构标题", goods_info: { id: 3 } } },
        { id: "3000000000004", from: "user", ts: NOW, content: "你好" },
      ]),
    );
    assert.deepEqual(parsed?.messages.map((m) => [m.role, m.kind, m.content]), [
      ["system", "card", "平台系统提示卡片"],
      ["system", "card", "平台系统提示卡片"],
      ["buyer", "unsupported", "非文字消息（类型 31）"],
      ["system", "card", "平台来源卡片：买家从商品进入"],
      ["buyer", "text", "你好"],
    ]);
  });

  test("对话：商品卡片带结构化标题与价格，含网址的文字丢弃；来源卡片带类型", () => {
    const parsed = parseChatList(
      listRequest(),
      listResponse([
        { id: "3000000000001", from: "user", ts: NOW - 4, template_name: "user_goods_card", content: "https://example.invalid/g.html", info: { goodsName: "虚构遮阳挡", goodsPrice: "¥19.9", goodsThumbUrl: "https://example.invalid/t.jpg" } },
        { id: "3000000000002", from: "mall_cs", ts: NOW - 3, template_name: "goods_info_card", info: { goodsName: "https://example.invalid/x", goodsPrice: 1990 } },
        { id: "3000000000003", from: "user", ts: NOW - 2, type: 31, info: { item_content: { id: 1 } } },
        { id: "3000000000004", from: "user", ts: NOW - 1, type: 41, template_name: "user_source", info: { title: "虚构标题" } },
      ]),
    );
    assert.equal(parsed?.messages[0].image_ref, "https://example.invalid/t.jpg");
    assert.equal(parsed?.messages[1].image_ref, undefined);
    assert.deepEqual(parsed?.messages.map((m) => [m.kind, m.content, m.card]), [
      ["card", "商品卡片：虚构遮阳挡", { type: "goods", title: "虚构遮阳挡", fields: [{ label: "价格", value: "¥19.9" }] }],
      ["card", "商品卡片", { type: "goods" }],
      ["card", "平台系统提示卡片", { type: "system", title: "平台系统提示卡片" }],
      ["card", "平台来源卡片", { type: "source", title: "平台来源卡片" }],
    ]);
  });

  test("对话：订单备注确认卡片（type 48）读出备注内容，按买家订单卡片提交", () => {
    const info = { template_list: [{ template: "title", element: { text: "请确认消费者订单备注" } }, { template: "double_text", element: { left: "备注内容:", right: "虚构车型" } }] };
    const parsed = parseChatList(
      listRequest(),
      listResponse([
        { id: "3000000000001", from: "user", ts: NOW - 2, type: 48, template_name: "order_remarks_apply_card", content: "[请确认消费者订单备注]", info, biz_context: { orderSn: "000000-000000000000001", remarks: " 23年 虚构车型 " } },
        { id: "3000000000002", from: "user", ts: NOW - 1, type: 48, template_name: "order_remarks_apply_card", content: "[请确认消费者订单备注]", info, biz_context: { remarks: "https://example.invalid/x" } },
        { id: "3000000000003", from: "user", ts: NOW, type: 48, template_name: "other_card", content: "[其他]", info },
        { id: "3000000000004", from: "user", ts: NOW, type: 48, template_name: "order_remarks_apply_card", content: "[请确认消费者订单备注]", info, biz_context: { remarks: "虚构车型 电话13800000000 地址：虚构市虚构路1号" } },
      ]),
    );
    assert.deepEqual(parsed?.messages.map((m) => [m.role, m.kind, m.content, m.card]), [
      ["buyer", "card", "请确认消费者订单备注：备注内容 23年 虚构车型", { type: "order", title: "请确认消费者订单备注", fields: [{ label: "备注内容", value: "23年 虚构车型" }] }],
      ["buyer", "card", "请确认消费者订单备注：备注内容 （未读到）", { type: "order", title: "请确认消费者订单备注" }],
      ["buyer", "unsupported", "非文字消息（类型 48）", undefined],
      ["buyer", "card", "请确认消费者订单备注：备注内容 虚构车型 电话[已隐去] 地址：[已隐去]", { type: "order", title: "请确认消费者订单备注", fields: [{ label: "备注内容", value: "虚构车型 电话[已隐去] 地址：[已隐去]" }] }],
    ]);
  });

  test("对话：图片消息（type=1）为 image，只取 https 图片地址", () => {
    const parsed = parseChatList(
      listRequest(),
      listResponse([
        { id: "3000000000001", from: "user", ts: NOW - 2, type: 1, content: "https://img.example.invalid/a.jpeg", info: { image_url: "https://img.example.invalid/a.jpeg", width: 10, height: 10 } },
        { id: "3000000000002", from: "user", ts: NOW - 1, type: 1, content: "http://img.example.invalid/b.jpeg" },
      ]),
    );
    assert.deepEqual(parsed?.messages.map((m) => [m.kind, m.content, m.image_ref]), [
      ["image", "[图片]", "https://img.example.invalid/a.jpeg"],
      ["image", "[图片]", undefined],
    ]);
  });

  test("图片：只允许平台图片域名；按文件头识别类型", () => {
    assert.equal(isAllowedImageUrl("https://img.pddpic.com/a.jpg"), true);
    assert.equal(isAllowedImageUrl("https://x.yangkeduo.com/a.jpg"), true);
    assert.equal(isAllowedImageUrl("http://img.pddpic.com/a.jpg"), false);
    assert.equal(isAllowedImageUrl("https://pddpic.com.evil.invalid/a.jpg"), false);
    assert.equal(isAllowedImageUrl("https://u:p@img.pddpic.com/a.jpg"), false);
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
    assert.equal(sniffImage(Buffer.from("RIFF0000WEBPVP8 ", "latin1")), "image/webp");
    assert.equal(sniffImage(Buffer.from("GIF89a", "latin1")), null);
  });

  test("对话：不属于该买家或缺编号/时间的消息被跳过并计数；请求体不是买家对话则整体拒绝", () => {
    const resp = listResponse([{ id: "3000000000001", from: "user", ts: NOW }]);
    const other = listResponse([{ id: "3000000000009", from: "user", ts: NOW }], false, "2000000000999").result.messages[0];
    resp.result.messages.push(other, { ...resp.result.messages[0], msg_id: "" as string }, { ...resp.result.messages[0], msg_id: "3000000000010", ts: "x" as unknown as number });
    const parsed = parseChatList(listRequest(), resp);
    assert.equal(parsed?.messages.length, 1);
    assert.equal(parsed?.skipped, 3);
    assert.equal(parseChatList({ data: { list: { with: { role: "mall_cs", id: BUYER } } } }, resp), null);
    assert.equal(parseChatList(listRequest(), { success: false }), null);
  });
});

describe("拼多多发送核对", () => {
  const sendBody = (uid: string, content: string) => ({ data: { cmd: "send_message", message: { to: { role: "user", uid }, from: { role: "mall_cs" }, content, msg_id: null, type: 0 } } });

  test("解析发送请求的收件人与文字", () => {
    assert.deepEqual(parseSendRequest(sendBody(BUYER, "您好")), { to_uid: BUYER, content: "您好" });
    assert.equal(parseSendRequest({ data: { message: { to: { role: "mall_cs", uid: BUYER }, content: "x" } } }), null);
    assert.equal(parseSendRequest(null), null);
  });

  test("有进行中的自动发送：收件人与文字完全一致才放行，其余拦截；没有时人工发送放行", () => {
    const pending = { to_uid: BUYER, text: "您好" };
    assert.equal(decideOutgoing(pending, parseSendRequest(sendBody(BUYER, "您好"))), "match");
    assert.equal(decideOutgoing(pending, parseSendRequest(sendBody("2000000000999", "您好"))), "block");
    assert.equal(decideOutgoing(pending, parseSendRequest(sendBody(BUYER, "您好！"))), "block");
    assert.equal(decideOutgoing(pending, null), "block");
    assert.equal(decideOutgoing(null, parseSendRequest(sendBody(BUYER, "人工"))), "pass");
  });

  test("发送响应：success 且有消息编号才确认", () => {
    assert.deepEqual(parseSendResponse({ success: true, result: { msg_id: 3000000000099, ts: NOW } }), { confirmed: true, msg_id: "3000000000099" });
    assert.deepEqual(parseSendResponse({ success: true, result: {} }), { confirmed: false, reason: "platform_ack_without_message_id" });
    assert.deepEqual(parseSendResponse({ success: false, error_code: 1 }), { confirmed: false, reason: "platform_send_error" });
    assert.deepEqual(parseSendResponse(null), { confirmed: false, reason: "platform_response_unparsed" });
  });

  test("对话列表项键解析出买家编号", () => {
    assert.equal(buyerFromListKey(`${BUYER}-0-unknown`), BUYER);
    assert.equal(buyerFromListKey("abc-0-x"), null);
    assert.equal(buyerFromListKey(BUYER), null);
  });
});

describe("拼多多会话跟踪", () => {
  function setup() {
    let now = NOW;
    const events: AdapterEvent[] = [];
    const t = new PddSessionTracker((e) => events.push(e), () => now);
    return { t, events, setNow: (v: number) => (now = v), msgs: () => events.filter((e) => e.type === "message") as Extract<AdapterEvent, { type: "message" }>[] };
  }

  test("身份核验后才开始会话；未核验前的对话响应被忽略", () => {
    const { t, events, msgs } = setup();
    assert.equal(t.status(true).logged_in, false);
    t.chatList(parseChatList(listRequest(), listResponse([{ id: "3000000000001", from: "user", ts: NOW }]))!);
    assert.equal(msgs().length, 0);
    t.identityFromRealtime(parseRealtimeUserInfo(realtime())!);
    const st = t.status(true);
    assert.equal(st.logged_in, true);
    assert.deepEqual(st.identity, { platform_shop_id: MALL, display_name: "虚构测试店" });
    assert.equal(events.filter((e) => e.type === "session_started").length, 1);
    t.identityFromCsInfo(parseCustomServiceInfo(csInfo())!);
    assert.equal(events.filter((e) => e.type === "session_started").length, 1, "同一身份不重复开会话");
  });

  test("两个接口店铺编号冲突：结束会话，身份未核验", () => {
    const { t, events } = setup();
    t.identityFromRealtime(parseRealtimeUserInfo(realtime())!);
    t.identityFromCsInfo(parseCustomServiceInfo(csInfo("100000002"))!);
    assert.equal(t.status(true).logged_in, false);
    assert.equal(t.status(true).identity, null);
    assert.ok(events.some((e) => e.type === "session_ended" && e.reason === "platform_identity_conflict"));
  });

  test("最新连续段：有重叠才合并；不重叠的更新一批另起一段；更早的不重叠一批不影响", () => {
    const { t } = setup();
    t.identityFromRealtime(parseRealtimeUserInfo(realtime())!);
    const batch = (ids: number[]) => listResponse(ids.map((i) => ({ id: String(3000000000000 + i), from: "user" as const, ts: NOW - 1000 + i })), true);
    const seg = () => t.history(BUYER).latest_segment?.map((id) => Number(id) - 3000000000000).sort((a, b) => a - b);
    t.chatList(parseChatList(listRequest(), batch([1, 2, 3]))!);
    assert.deepEqual(seg(), [1, 2, 3]);
    t.chatList(parseChatList(listRequest(), batch([3, 4, 5]))!);
    assert.deepEqual(seg(), [1, 2, 3, 4, 5]);
    t.chatList(parseChatList(listRequest(), batch([20, 21]))!);
    assert.deepEqual(seg(), [20, 21], "中间 6..19 没加载过，不能接上旧段");
    t.chatList(parseChatList(listRequest(), batch([10, 11]))!);
    assert.deepEqual(seg(), [20, 21], "更早且不重叠的一批不并入最新段");
    assert.equal(t.history(BUYER).complete, false);
  });

  test("最新连续段：不相连的两批最新时间同一秒，分不清先后则清空，不据此接续", () => {
    const { t } = setup();
    t.identityFromRealtime(parseRealtimeUserInfo(realtime())!);
    const at = (id: number, ts: number) => ({ id: String(3000000000000 + id), from: "user" as const, ts });
    t.chatList(parseChatList(listRequest(), listResponse([at(20, NOW - 10), at(21, NOW - 5)], true))!);
    t.chatList(parseChatList(listRequest(), listResponse([at(1, NOW - 50), at(2, NOW - 5)], true))!);
    assert.deepEqual(t.history(BUYER).latest_segment, []);
    t.chatList(parseChatList(listRequest(), listResponse([at(30, NOW - 1)], true))!);
    assert.deepEqual(t.history(BUYER).latest_segment, [String(3000000000030)]);
  });

  test("只有会话开始后、时间窗内首次出现的买家消息算新消息；其余按历史同步", () => {
    const { t, msgs, setNow } = setup();
    t.identityFromRealtime(parseRealtimeUserInfo(realtime())!);
    setNow(NOW + 30);
    t.chatList(
      parseChatList(
        listRequest(),
        listResponse([
          { id: "3000000000001", from: "user", ts: NOW - 600 },
          { id: "3000000000002", from: "mall_cs", ts: NOW + 5 },
          { id: "3000000000003", from: "user", ts: NOW + 20 },
        ]),
      )!,
    );
    assert.deepEqual(msgs().map((e) => [e.message.platform_message_id, e.live]), [["3000000000001", false], ["3000000000002", false], ["3000000000003", true]]);
    // 页面重复加载同一对话：已见过的不再上报。
    t.chatList(parseChatList(listRequest(), listResponse([{ id: "3000000000003", from: "user", ts: NOW + 20 }]))!);
    assert.equal(msgs().length, 3);
    // 超出时间窗才被加载出来的买家消息：按历史处理。
    setNow(NOW + 40 + LIVE_WINDOW_SECONDS + 1);
    t.chatList(parseChatList(listRequest(), listResponse([{ id: "3000000000004", from: "user", ts: NOW + 40 }]))!);
    assert.equal(msgs().at(-1)?.live, false);
  });

  test("历史：has_more 时不完整；平台到底后完整；未加载的对话读取失败", () => {
    const { t } = setup();
    t.identityFromRealtime(parseRealtimeUserInfo(realtime())!);
    assert.throws(() => t.history(BUYER), /pdd_history_not_loaded/);
    t.chatList(parseChatList(listRequest(), listResponse([{ id: "3000000000005", from: "user", ts: NOW }], true))!);
    assert.deepEqual([t.history(BUYER).complete, t.history(BUYER).gap_reason], [false, "pdd_history_has_more"]);
    t.chatList(parseChatList(listRequest(), listResponse([{ id: "3000000000001", from: "user", ts: NOW - 100 }], false))!);
    const h = t.history(BUYER);
    assert.equal(h.complete, true);
    assert.deepEqual(h.messages.map((m) => m.platform_message_id), ["3000000000001", "3000000000005"]);
  });

  test("跳到登录页/窗口关闭：会话结束并清空缓存", () => {
    const { t, events } = setup();
    t.identityFromRealtime(parseRealtimeUserInfo(realtime())!);
    t.chatList(parseChatList(listRequest(), listResponse([{ id: "3000000000001", from: "user", ts: NOW }]))!);
    t.end("platform_logged_out");
    assert.equal(t.status(true).logged_in, false);
    assert.ok(events.some((e) => e.type === "session_ended" && e.reason === "platform_logged_out"));
    assert.throws(() => t.history(BUYER));
    // 重新登录后需再次核验身份。
    t.identityFromRealtime(parseRealtimeUserInfo(realtime())!);
    assert.equal(events.filter((e) => e.type === "session_started").length, 2);
  });
});

describe("拼多多会话跟踪：逐页加载记录（unknown 核对的覆盖证据）", () => {
  test("每次加载记一页：本机时间、消息编号、最新消息时间、丢弃条数；最多 10 页；会话结束清空", () => {
    let now = NOW;
    const t = new PddSessionTracker(() => undefined, () => now);
    t.identityFromRealtime(parseRealtimeUserInfo(realtime())!);
    t.chatList(parseChatList(listRequest(), listResponse([{ id: "3000000000001", from: "user", ts: NOW - 10 }, { id: "3000000000002", from: "user", ts: 0 }]))!);
    now = NOW + 5;
    t.chatList(parseChatList(listRequest(), listResponse([{ id: "3000000000003", from: "user", ts: NOW + 3 }]))!);
    const loads = t.historyLoads(BUYER);
    assert.deepEqual(loads, [
      { at: NOW * 1000, ids: ["3000000000001"], newest: NOW - 10, dropped: 1 },
      { at: (NOW + 5) * 1000, ids: ["3000000000003"], newest: NOW + 3, dropped: 0 },
    ]);
    for (let i = 0; i < 12; i++) t.chatList(parseChatList(listRequest(), listResponse([{ id: `30000000001${i}`, from: "user", ts: NOW }]))!);
    assert.equal(t.historyLoads(BUYER).length, 10);
    t.end("platform_logged_out");
    assert.deepEqual(t.historyLoads(BUYER), []);
  });
});
