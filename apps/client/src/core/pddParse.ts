import type { PlatformMessage } from "./adapter.js";
import type { Card, Kind, Role } from "./protocol.js";
import { isIdentifier } from "./protocol.js";
import { redactText } from "./pddOrders.js";
import { productKey } from "./productLearning.js";

// 拼多多商家后台客服页面响应解析。字段依据：用户测试店铺登录后，
// 页面自身请求的响应结构诊断（只记录字段名/类型与类别标签，未记录任何值）。

export type PddIdentity = { mall_id: string; mall_name: string };

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function idString(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^[0-9]{1,32}$/.test(v)) return v;
  return null;
}

/** GET /chats/userinfo/realtime：{ mall_id, mall: { mall_id, mall_name } } */
export function parseRealtimeUserInfo(body: unknown): PddIdentity | null {
  const b = obj(body);
  const mall = obj(b?.mall);
  const top = idString(b?.mall_id);
  const inner = idString(mall?.mall_id);
  if (!top || !inner || top !== inner || typeof mall?.mall_name !== "string") return null;
  return { mall_id: top, mall_name: mall.mall_name };
}

/** POST /janus/api/customService/queryCustomServiceInfo：{ success, result: { mallInfoResult: { mallId, mallName } } } */
export function parseCustomServiceInfo(body: unknown): PddIdentity | null {
  const b = obj(body);
  const info = obj(obj(b?.result)?.mallInfoResult);
  const id = idString(info?.mallId);
  if (b?.success !== true || !id || typeof info?.mallName !== "string") return null;
  return { mall_id: id, mall_name: info.mallName };
}

const ROLE: Record<string, Role> = { user: "buyer", mall_cs: "agent" };

/** type=0 也可能承载表情/图片等网址或模板消息；只有不带模板/附加信息、且不是单纯网址的才算文字。 */
/**
 * 平台在买家进店时自动生成的来源卡片。已见两种：
 * - type 31（平台系统提示），info 带 item_content/mall_content；
 * - 模板 user_source，info 带 title/goods_info（页面显示“当前用户来自 商品详情页”）。
 * 虽然 from 是买家，但不是买家所发：按契约以 role=system、kind=card 提交，内容只给可读描述、不带链接。
 * 买家主动发的商品卡片（user_goods_card）不在此列。
 */
export function sourceCard(m: Record<string, unknown>): string | null {
  const info = obj(m.info);
  if (!info) return null;
  const has = (k: string) => info[k] !== undefined && info[k] !== null;
  if (m.type === 31 && (has("item_content") || has("mall_content"))) {
    return "平台系统提示卡片";
  }
  if (m.template_name === "user_source" && (has("title") || has("goods_info"))) {
    return has("goods_info") ? "平台来源卡片：买家从商品进入" : "平台来源卡片";
  }
  return null;
}

/** 卡片文字：只收纯文本，含网址的丢弃，按契约限长。 */
function cardText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t || /https?:\/\/|www\./i.test(t)) return undefined;
  return t.slice(0, max);
}

/** 商品卡片（买家发的 user_goods_card、客服发的 goods_info_card）：info.goodsName/goodsPrice。 */
export function goodsCard(m: Record<string, unknown>): Card | null {
  const template = typeof m.template_name === "string" ? m.template_name : "";
  const info = obj(m.info);
  if (!/goods(_info)?_card/.test(template) || !info) return null;
  const title = cardText(info.goodsName, 500);
  const price = typeof info.goodsPrice === "string" ? cardText(info.goodsPrice, 200) : undefined;
  return { type: "goods", ...(title ? { title } : {}), ...(price ? { fields: [{ label: "价格", value: price }] } : {}) };
}

export const REMARK_CARD_TITLE = "请确认消费者订单备注";

/**
 * 买家在订单页提交备注后平台生成的确认卡片（type 48，模板 order_remarks_apply_card）：
 * biz_context.remarks 是备注原文。只读内容；卡片上的“确认备注/拒绝备注”按钮会改写订单，从不点击。
 */
export function remarkCard(m: Record<string, unknown>): Card | null {
  if (m.type !== 48 || m.template_name !== "order_remarks_apply_card") return null;
  const raw = obj(m.biz_context)?.remarks;
  // 买家可能在备注里写手机号、地址：与订单备注一样先隐去再提交。
  const remarks = cardText(typeof raw === "string" ? redactText(raw) : undefined, 200);
  return { type: "order", title: REMARK_CARD_TITLE, ...(remarks ? { fields: [{ label: "备注内容", value: remarks }] } : {}) };
}

/** 订单类卡片（备注确认、售后申请）的可读 content。 */
function orderCardText(card: Card): string {
  if (card.title === REMARK_CARD_TITLE) return `${REMARK_CARD_TITLE}：备注内容 ${card.fields?.[0]?.value ?? "（未读到）"}`;
  const fields = (card.fields ?? []).map((f) => `${f.label} ${f.value}`).join("；");
  return `${card.title ?? "订单卡片"}${fields ? `：${fields}` : ""}`;
}

/** 图片消息（type=1）：info.image_url 为平台图片地址，content 通常是同一地址。只取 https 地址。 */
export function imageRef(m: Record<string, unknown>): string | null {
  if (m.type !== 1) return null;
  const info = obj(m.info);
  for (const v of [info?.image_url, info?.original, m.content]) {
    if (typeof v === "string" && /^https:\/\/\S+$/i.test(v.trim())) return v.trim();
  }
  return null;
}

/** 平台按文字展示的 type 0 模板：买家点了店铺常见问题、店铺自动答复、商家通知（如退货地址说明），content 即正文。 */
const TEXT_TEMPLATES = new Set(["mall_faq_question", "mall_answer_with_text", "merchant_note"]);

export const AFTER_SALE_CARD_TITLE = "消费者申请售后";
const AFTER_SALE_FIELDS = ["申请类型", "申请原因", "退款金额", "申请说明"];

/**
 * 买家提交售后申请后平台生成的卡片（type 64，模板 apply_for_consultation_card_new）：info.data.apply_info 为 {label,value}。
 * 按买家的订单卡片提交，只收申请类型/原因/金额/说明与商品名；联系方式与凭证不收，说明先隐去手机号、地址。卡片上的“去处理”从不点击。
 */
export function afterSaleCard(m: Record<string, unknown>): Card | null {
  if (m.type !== 64 || m.template_name !== "apply_for_consultation_card_new") return null;
  const data = obj(obj(m.info)?.data);
  const fields: { label: string; value: string }[] = [];
  for (const raw of Array.isArray(data?.apply_info) ? data.apply_info : []) {
    const f = obj(raw);
    const label = typeof f?.label === "string" ? f.label.trim() : "";
    if (!AFTER_SALE_FIELDS.includes(label) || fields.some((x) => x.label === label)) continue;
    const value = cardText(typeof f?.value === "string" ? redactText(f.value) : undefined, 200);
    if (value) fields.push({ label, value });
  }
  const goods = cardText(obj(data?.goods_info)?.goods_name, 200);
  if (goods) fields.push({ label: "商品", value: goods });
  const description = cardText(data?.title, 4000) ?? cardText(m.content, 4000);
  return { type: "order", title: AFTER_SALE_CARD_TITLE, ...(description ? { description } : {}), ...(fields.length ? { fields } : {}) };
}

/**
 * 平台发给商家的提示（买家看不到，按契约 role=system、kind=card、type=system）：
 * - type 8：售后/纠纷预警（aftersales_hosting_warning_card、dispute_warning），info.title 与 info.text_list；
 * - type 24：平台系统消息（如撤回提示），取 content；
 * - type 51：平台相似商品推荐卡片。
 * 后两种暂无抓包样本，只取可读文字，取不到时给固定描述。
 */
export function noticeCard(m: Record<string, unknown>): Card | null {
  const info = obj(m.info);
  if (m.type === 8) {
    const lines = (Array.isArray(info?.text_list) ? info.text_list : []).flat().map((t) => cardText(obj(t)?.text, 4000)).filter((t): t is string => !!t);
    const description = lines.join(" ").slice(0, 4000);
    return { type: "system", title: cardText(info?.title, 500) ?? cardText(m.content, 500) ?? "平台售后提示", ...(description ? { description } : {}) };
  }
  if (m.type === 24) return { type: "system", title: cardText(m.content, 500) ?? "平台系统消息" };
  if (m.type === 51) return { type: "system", title: "平台相似商品推荐卡片" };
  return null;
}

/** 店铺自动发出的常见问题菜单（type 56，模板 rich_text_faq_list）：info.content[] 的说明文字与可点问题，按客服文字提交。 */
export function faqListText(m: Record<string, unknown>): string | null {
  if (m.type !== 56) return null;
  const parts = Array.isArray(obj(m.info)?.content) ? (obj(m.info)!.content as unknown[]) : [];
  const texts: string[] = [], menu: string[] = [];
  for (const raw of parts) {
    const p = obj(raw);
    const t = cardText(p?.text, 500);
    if (t) (p?.type === "menu_item" ? menu : texts).push(t);
  }
  if (!texts.length && !menu.length) return null;
  return `[常见问题列表] ${texts.join(" ")}${menu.length ? `${texts.length ? " " : ""}可点问题：${menu.join(" / ")}` : ""}`.slice(0, 2000);
}

function kindOf(m: Record<string, unknown>): { kind: Kind; placeholder: string | null } {
  const template = typeof m.template_name === "string" ? m.template_name : "";
  if (m.type === 1) return { kind: "image", placeholder: "[图片]" };
  if (/goods(_info)?_card/.test(template)) return { kind: "card", placeholder: "商品卡片" };
  if (m.type === 14) return { kind: "unsupported", placeholder: "[视频]" };
  if (m.type === 0) {
    const content = typeof m.content === "string" ? m.content.trim() : "";
    const textTemplate = !template || /_text_msg$/.test(template) || TEXT_TEMPLATES.has(template);
    if (textTemplate && m.info === undefined && content && !/^https?:\/\/\S+$/i.test(content)) return { kind: "text", placeholder: null };
    if (/^https?:\/\/\S+$/i.test(content)) return { kind: "unsupported", placeholder: "链接/图片（类型 0）" };
  }
  return { kind: "unsupported", placeholder: `非文字消息（类型 ${String(m.type)}）` };
}

/** POST /plateau/chat/send_message 请求体：{ data: { message: { to: { role, uid }, content, type } } }，只取收件人与文字。 */
export function parseSendRequest(body: unknown): { to_uid: string; content: string } | null {
  const b = obj(body);
  const message = obj(obj(b?.data)?.message) ?? obj(b?.message);
  const to = obj(message?.to);
  const uid = to?.role === "user" ? idString(to.uid) : null;
  if (!uid || typeof message?.content !== "string") return null;
  return { to_uid: uid, content: message.content };
}

/** send_message 响应：{ success, result: { msg_id, ... } }。只有 success=true 且有消息编号才算平台确认。 */
export function parseSendResponse(body: unknown): { confirmed: true; msg_id: string } | { confirmed: false; reason: string } {
  const b = obj(body);
  if (!b) return { confirmed: false, reason: "platform_response_unparsed" };
  if (b.success !== true) return { confirmed: false, reason: "platform_send_error" };
  const id = idString(obj(b.result)?.msg_id);
  return id ? { confirmed: true, msg_id: id } : { confirmed: false, reason: "platform_ack_without_message_id" };
}

/**
 * 页面发出 send_message 时的放行判断。
 * - 没有进行中的自动发送：pass（人工在平台窗口手动发送）。
 * - 有进行中的自动发送：收件人与文字完全一致才 match；其余（含无法解析）一律 block，请求不会到达平台。
 */
export function decideOutgoing(pending: { to_uid: string; text: string } | null, request: { to_uid: string; content: string } | null): "pass" | "match" | "block" {
  if (!pending) return "pass";
  if (request && request.to_uid === pending.to_uid && request.content === pending.text) return "match";
  return "block";
}

/** 对话列表项 data-random 形如 “<买家编号>-<序号>-<后缀>”。 */
export function buyerFromListKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^([0-9]{1,32})-/.exec(value);
  return m ? m[1] : null;
}

export type ParsedList = { buyer_uid: string; messages: PlatformMessage[]; has_more: boolean; skipped: number };

/**
 * POST /plateau/chat/list 响应：{ success, result: { has_more, messages: [{ from:{role,uid}, to:{role,uid}, type, content, ts, msg_id, template_name }] } }
 * buyerUid 取自页面请求体 data.list.with.id（role=user）。
 */
export function parseChatList(requestBody: unknown, responseBody: unknown, shopId?: string): ParsedList | null {
  const withObj = obj(obj(obj(obj(requestBody)?.data)?.list)?.with);
  const buyer = withObj?.role === "user" ? idString(withObj.id) : null;
  const b = obj(responseBody);
  const result = obj(b?.result);
  if (!buyer || b?.success !== true || !result || !Array.isArray(result.messages) || typeof result.has_more !== "boolean") return null;
  const messages: PlatformMessage[] = [];
  let skipped = 0;
  for (const raw of result.messages) {
    const m = obj(raw);
    const from = obj(m?.from);
    const to = obj(m?.to);
    const msgId = idString(m?.msg_id);
    const ts = Number(m?.ts);
    const fromRole = typeof from?.role === "string" ? from.role : "";
    const role: Role = ROLE[fromRole] ?? "system";
    // 只接受属于该买家对话的消息：买家发出，或发给该买家。
    const belongs = (fromRole === "user" && idString(from?.uid) === buyer) || (to?.role === "user" && idString(to?.uid) === buyer);
    if (!m || !msgId || !Number.isFinite(ts) || ts <= 0 || !belongs) {
      skipped += 1;
      continue;
    }
    const notice = noticeCard(m);
    const source = notice?.title ?? sourceCard(m);
    const remark = source ? null : remarkCard(m) ?? afterSaleCard(m);
    const faq = faqListText(m);
    const { kind, placeholder } = source ? { kind: "card" as const, placeholder: source } : remark ? { kind: "card" as const, placeholder: orderCardText(remark) } :
      faq ? { kind: "text" as const, placeholder: faq } : kindOf(m);
    const goods = source || remark ? null : goodsCard(m);
    const card: Card | null = notice ?? (source ? { type: m.type === 31 ? "system" : "source", title: source } : remark ?? goods);
    if (card && shopId && (goods || card.type === "source")) {
      const info = obj(m.info), nested = obj(info?.goods_info);
      const ids = [info?.goodsID, info?.goodsId, nested?.goods_id].filter(v => v !== undefined && v !== null);
      const keys = ids.map(v => { try { return productKey(shopId, v); } catch { return null; } });
      if (keys.length && keys.every(v => v !== null) && new Set(keys).size === 1) card.product_key = keys[0]!;
    }
    const content = goods?.title ? `商品卡片：${goods.title}` : placeholder ?? (typeof m.content === "string" ? m.content : "");
    const thumb = goods ? obj(m.info)?.goodsThumbUrl : null;
    const image = kind === "image" ? imageRef(m) : typeof thumb === "string" && /^https:\/\/\S+$/i.test(thumb.trim()) ? thumb.trim() : null;
    messages.push({ conversation_id: buyer, platform_message_id: isIdentifier(msgId) ? msgId : null, role: source ? "system" : role, kind, content, created_at: ts, ...(card ? { card } : {}), ...(image ? { image_ref: image } : {}) });
  }
  messages.sort((a, b2) => a.created_at - b2.created_at);
  return { buyer_uid: buyer, messages, has_more: result.has_more, skipped };
}
