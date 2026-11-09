// 协议 1.0 的客户端侧类型与响应校验，字段以 contracts/protocol.md 为准。

export const PROTOCOL_MAJOR = "1";
export const MAX_CONTEXT_MESSAGES = 200;
export const MAX_CONTENT_CHARS = 8000;
export const MAX_BODY_BYTES = 262144;
/** 带图片的提交事件请求体上限（契约“图片与卡片”）。 */
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_MISSING = "[图片，前台未取到]";

export type Role = "buyer" | "agent" | "system";
export type Kind = "text" | "image" | "card" | "unsupported";
export type Action = "reply" | "handoff" | "none" | "send_item" | "mark" | "transfer";
export type DeliveryStatus = "unclaimed" | "claimed" | "sent" | "not_sent" | "unknown";
export type ReceiptStatus = "sent" | "not_sent" | "unknown";

export type CardType = "goods" | "order" | "source" | "system";
export type Card = { type: CardType; title?: string; description?: string; fields?: { label: string; value: string }[]; product_key?: string };
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";
export type Attachment = { type: "image"; mime: ImageMime; data_url: string };
export type OrderLogistics = {
  company?: string;
  tracking_number?: string;
  state?: string;
  traces: { time: number; info: string }[];
  observed_at: number;
};

/** 订单摘要（契约“订单、物流与备注”）；order_ref 由运行时按对话生成。 */
export type OrderSummary = {
  status?: string;
  goods_title?: string;
  sku?: string;
  quantity?: number;
  amount?: string;
  order_time?: number;
  shipping_time?: number;
  receive_time?: number;
  note?: string;
  after_sale?: string;
  logistics?: OrderLogistics;
  observed_at: number;
};

export type ContextOrder = OrderSummary & { order_ref: string; items?: OrderItem[] };

/** 契约“商品快照（1.2 草案）”：能力名与提交字段。 */
export const CAP_GOODS_SNAPSHOT = "goods_snapshot";
export type GoodsEvidence =
  | { source: "order"; order_ref: string; observed_at: number }
  | { source: "goods_card"; message_id: string; card_price?: string; observed_at: number };
export type GoodsSnapshot = { goods_ref: string; title: string; evidence: GoodsEvidence[]; product_key?: string };
export const CAP_PRODUCT_KNOWLEDGE = "product_knowledge";
export type ProductLearningRequest = { request_id: string; selection: { goods_id?: string; mall_id?: string }; expires_at: number };
/** 订单明细：goods_ref 只在该商品进入 context.goods 时出现。 */
export type OrderItem = { goods_ref?: string; goods_title: string; sku?: string; quantity?: number };

/** 契约“会话操作（1.3 草案）”：收藏标星能力名与只读会话状态。marked=null 表示本次没有可靠读到。 */
export const CAP_MARK_CONVERSATION = "mark_conversation";
export type MarkColor = "red" | "orange" | "blue" | "green";
export type ConvState = { marked: boolean | null; color: MarkColor | null; observed_at: number };
export const MARK_COLORS: readonly MarkColor[] = ["red", "orange", "blue", "green"];
/** 会话操作回执的原因（契约 1.3 封闭枚举），不携带平台原文。 */
export type ConvActionReason = "blocked_by_mark" | "platform_rejected" | "conv_state_unavailable" | "conv_state_changed" | "capability_withdrawn" | "deadline_exceeded" | "not_started";
/** 点击后的页面观察：只供显示，不参与回执聚合。 */
export type PageObserved = "marked" | "left_list" | "unchanged" | "unknown";
/** mark 只有一个步骤；只列已开始的步骤。 */
export type MarkStep = { step: "mark"; status: ReceiptStatus; color: MarkColor };
/** 转接（1.3）：能力名、目标与“转接前取消标星”策略。 */
export const CAP_TRANSFER_BY_ACCOUNT = "transfer_by_account";
/** transfer 只有一个步骤；unmarked=null 表示本次没有可靠读到取消标星结果。 */
export type TransferStep = { step: "transfer"; status: ReceiptStatus; reason?: ConvActionReason };
export type UnmarkTransferStep = { step: "unmark_and_transfer"; status: ReceiptStatus; unmarked: boolean | null; reason?: ConvActionReason };
/** 会话操作回执在 attempt_id / status 之外的字段；reply / send_item 不带。 */
export type ReceiptExtra = { steps?: (MarkStep | TransferStep | UnmarkTransferStep)[]; reason?: ConvActionReason; page_observed?: PageObserved };

/**
 * 本地阻止原因 → 契约回执原因。页面状态两类原样；能力撤回与确认截止各自归类；
 * 其余（会话、租约、上下文版本变化，页面忙，重启等）一律 not_started。
 */
export function convActionReason(detail: string | null | undefined): ConvActionReason {
  switch (detail) {
    case "transfer_blocked_by_mark":
      return "blocked_by_mark";
    case "conv_state_changed":
    case "conv_state_unavailable":
      return detail;
    case "capability_not_confirmed":
      return "capability_withdrawn";
    case "claim_expiring":
    case "decision_expired":
    case "reply_deadline_exceeded":
      return "deadline_exceeded";
    default:
      return "not_started";
  }
}

/** 契约“聊天页附加发送”：心跳能力名。 */
export const CAP_SEND_ITEM = "send_item";
export type SendItemType = "instruction" | "goods_card" | "video";
export type SendItem = { type: SendItemType; option_id: string };
export type InstructionOption = { option_id: string; goods_title: string; name: string; observed_at: number };
export type GoodsOption = { option_id: string; goods_title: string; observed_at: number };
export type VideoOption = { option_id: string; name: string; duration?: number; observed_at: number };
export type SendOptions = { instructions?: InstructionOption[]; goods?: GoodsOption[]; videos?: VideoOption[] };
export const SEND_OPTION_LIMITS = { instructions: 10, goods: 20, videos: 50 } as const;
/** 候选数组名 ↔ 决定里的 item.type。 */
export const SEND_OPTION_KIND: Record<SendItemType, keyof SendOptions> = { instruction: "instructions", goods_card: "goods", video: "videos" };
/** 契约 A：独立能力名；确认后新事件可带剩余预算、可取消未领取事件。 */
export const CAP_REPLY_DEADLINE = "reply_deadline";
export const CAP_TIMEOUT_TRANSFER = "reply_timeout_transfer";
export const MAX_REMAINING_BUDGET_MS = 20000;
/** 契约 A 的截止终态原因，也是 claim 409 的错误码。 */
export const DEADLINE_REASON = "reply_deadline_exceeded";
export type ContextMessage = { id: string; role: Role; kind: Kind; content: string; created_at: number; card?: Card; attachments?: Attachment[] };

export type EventRequest = {
  event_id: string;
  instance_id: string;
  session_id: string;
  generation: number;
  conversation_id: string;
  message_id: string;
  context_revision: number;
  received_at: number;
  /** 契约 A：仅在本租约确认 reply_deadline 后提交；冻结后不再改变。 */
  remaining_budget_ms?: number;
  timeout_transfer?: true;
  context: { history_complete: boolean; messages: ContextMessage[]; orders?: ContextOrder[]; goods?: GoodsSnapshot[]; send_options?: SendOptions; conv_state?: ConvState };
};

/**
 * send_item 不附文字，text 为空串；item 只在 send_item 时存在。
 * mark（契约 1.3）不附文字，mark.color 与 policy_version（正整数）只在 mark 时存在。
 * transfer（契约 1.3）不附文字；transfer 只在 transfer 时存在，policy_version 为本事件策略版本。
 */
export type Decision = { action: Action; text: string; reason: string; expires_at: number; item?: SendItem; mark?: { color: MarkColor }; transfer?: { account: string; unmark_policy: { allow: boolean; version: number } }; policy_version?: number };

export type Delivery = {
  status: DeliveryStatus;
  attempt_id: string | null;
  platform_message_id: string | null;
  claim_expires_at?: number;
  reason?: string;
  /** 管理员对 unknown 的人工核查结论；unknown 本身不改写。 */
  verification?: Verification | null;
};

export type Verification = { outcome: "sent" | "not_sent"; note: string; verified_at: number };

export type EventSnapshot = {
  event_id: string;
  shop_id: string;
  client_id: string;
  conversation_id: string;
  message_id: string;
  context_revision: number;
  session_id: string;
  generation: number;
  state: "pending" | "processing" | "ready";
  decision: Decision | null;
  delivery: Delivery;
  created_at: number;
  /** 契约 A：预算事件的后台截止（Unix 秒），仅用于诊断，不替代本地单调截止。 */
  event_deadline?: number;
  /** 契约 A：后台计时，可选诊断；不合法时整个忽略。 */
  timing?: BackendTiming;
};

export type BackendTiming = {
  queue_wait_ms?: number;
  decision_ms?: number;
  primary_ms?: number;
  backup_ms?: number;
  model_slot?: "primary" | "backup";
  fallback_used?: boolean;
  failure_class?: "deadline_exceeded" | "cancelled" | "model_unavailable" | "model_invalid_output" | "internal_error";
};

const TIMING_MS = ["queue_wait_ms", "decision_ms", "primary_ms", "backup_ms"] as const;
const FAILURE_CLASSES: readonly string[] = ["deadline_exceeded", "cancelled", "model_unavailable", "model_invalid_output", "internal_error"];

/** 契约 A.7：已知字段任一不合法（或 timing 不是对象）就忽略整个 timing；未知字段忽略。 */
export function parseTiming(value: unknown): BackendTiming | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const out: BackendTiming = {};
  for (const k of TIMING_MS) {
    if (v[k] === undefined) continue;
    if (!Number.isInteger(v[k]) || (v[k] as number) < 0) return undefined;
    out[k] = v[k] as number;
  }
  if (v.model_slot !== undefined) {
    if (v.model_slot !== "primary" && v.model_slot !== "backup") return undefined;
    out.model_slot = v.model_slot;
  }
  if (v.fallback_used !== undefined) {
    if (typeof v.fallback_used !== "boolean") return undefined;
    out.fallback_used = v.fallback_used;
  }
  if (v.failure_class !== undefined) {
    if (typeof v.failure_class !== "string" || !FAILURE_CLASSES.includes(v.failure_class)) return undefined;
    out.failure_class = v.failure_class as BackendTiming["failure_class"];
  }
  return out;
}

/** 契约 A.4：因截止终止、尚无发送尝试的终态（含取消成功）。 */
export function isDeadlineTerminal(s: EventSnapshot | null | undefined): boolean {
  return !!s && s.state === "ready" && s.decision?.action === "handoff" && s.decision.reason === DEADLINE_REASON && s.delivery.status === "unclaimed" && s.delivery.attempt_id === null;
}

export type Me = { role: "client"; client_id: string; shop_id: string; protocol_version: string };
/** capabilities：服务端确认的能力交集；旧后台不返回，视为空。 */
export type Lease = { shop_id: string; client_id: string; instance_id: string; session_id: string; generation: number; expires_at: number; capabilities: string[]; product_learning?: ProductLearningRequest };

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export class ProtocolError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function need(condition: boolean, code: string): asserts condition {
  if (!condition) throw new ProtocolError(code);
}

function obj(value: unknown): Record<string, unknown> {
  need(typeof value === "object" && value !== null && !Array.isArray(value), "response_not_object");
  return value as Record<string, unknown>;
}

export function supportedVersion(version: unknown): boolean {
  return typeof version === "string" && version.split(".")[0] === PROTOCOL_MAJOR;
}

export function parseHealth(value: unknown): { protocol_version: string } {
  const v = obj(value);
  need(v.service === "claw-next" && v.status === "ok", "health_invalid");
  need(supportedVersion(v.protocol_version), "protocol_unsupported");
  return { protocol_version: v.protocol_version as string };
}

export function parseMe(value: unknown): Me {
  const v = obj(value);
  need(supportedVersion(v.protocol_version), "protocol_unsupported");
  need(v.role === "client", "role_not_client");
  need(isIdentifier(v.client_id) && isIdentifier(v.shop_id), "identity_invalid");
  return { role: "client", client_id: v.client_id as string, shop_id: v.shop_id as string, protocol_version: v.protocol_version as string };
}

export function parseLease(value: unknown): Lease {
  const v = obj(value);
  need(isIdentifier(v.shop_id) && isIdentifier(v.client_id) && isIdentifier(v.instance_id) && isIdentifier(v.session_id), "lease_invalid");
  need(Number.isInteger(v.generation) && (v.generation as number) > 0 && isFiniteNumber(v.expires_at), "lease_invalid");
  const caps = v.capabilities === undefined || v.capabilities === null ? [] : v.capabilities;
  need(Array.isArray(caps) && caps.every((c) => typeof c === "string"), "lease_invalid");
  let learning: ProductLearningRequest | undefined;
  if (v.product_learning !== undefined) {
    const p = obj(v.product_learning), selection = obj(p.selection);
    need(caps.includes(CAP_PRODUCT_KNOWLEDGE) && typeof p.request_id === "string" && /^[a-f0-9]{32}$/.test(p.request_id)
      && isFiniteNumber(p.expires_at) && Object.keys(selection).every(k => ["goods_id", "mall_id"].includes(k) && typeof selection[k] === "string" && /^[0-9]{1,32}$/.test(selection[k] as string)), "product_request_invalid");
    learning = p as unknown as ProductLearningRequest;
  }
  return { shop_id: v.shop_id as string, client_id: v.client_id as string, instance_id: v.instance_id as string, session_id: v.session_id as string, generation: v.generation as number, expires_at: v.expires_at as number, capabilities: caps as string[], ...(learning ? { product_learning: learning } : {}) };
}

const ITEM_TYPES: readonly string[] = ["instruction", "goods_card", "video"];

/**
 * transfer 的严格校验：transfer 与 unmark_policy 为普通对象；account 为已去首尾空白的完整账号名，1–40 字；
 * allow 为真布尔；unmark_policy.version 与 policy_version 为相等的正整数。不合格返回 null。
 */
function transferFields(value: unknown, policyVersion: unknown): { account: string; allow: boolean; version: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const t = value as Record<string, unknown>;
  if (Object.keys(t).some(k => k !== "account" && k !== "unmark_policy") || typeof t.account !== "string"
      || !t.account || t.account.length > 40 || t.account !== t.account.trim()) return null;
  const p = t.unmark_policy;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const u = p as Record<string, unknown>;
  if (Object.keys(u).some(k => k !== "allow" && k !== "version") || typeof u.allow !== "boolean") return null;
  if (typeof u.version !== "number" || !Number.isInteger(u.version) || u.version <= 0) return null;
  if (typeof policyVersion !== "number" || !Number.isInteger(policyVersion) || policyVersion <= 0 || policyVersion !== u.version) return null;
  return { account: t.account, allow: u.allow, version: u.version };
}

/** 不认识的 action（或格式不对的 send_item / mark / transfer）一律按 none 记录，绝不执行。 */
function parseDecision(value: unknown): Decision | null {
  if (value === null) return null;
  const v = obj(value);
  need(typeof v.reason === "string" && isFiniteNumber(v.expires_at), "decision_invalid");
  const base = { reason: v.reason as string, expires_at: v.expires_at as number };
  if (v.action === "reply" || v.action === "handoff" || v.action === "none") {
    need(typeof v.text === "string", "decision_invalid");
    return { action: v.action, text: v.text as string, ...base };
  }
  const item = v.item as Record<string, unknown> | null | undefined;
  if (v.action === "send_item" && item && typeof item === "object" && ITEM_TYPES.includes(item.type as string) && typeof item.option_id === "string" && item.option_id.length > 0 && item.option_id.length <= 64) {
    return { action: "send_item", text: "", ...base, item: { type: item.type as SendItemType, option_id: item.option_id } };
  }
  const mark = v.mark as Record<string, unknown> | null | undefined;
  if (v.action === "mark" && mark && typeof mark === "object" && !Array.isArray(mark) && MARK_COLORS.includes(mark.color as MarkColor) && Number.isInteger(v.policy_version) && (v.policy_version as number) > 0) {
    return { action: "mark", text: "", ...base, mark: { color: mark.color as MarkColor }, policy_version: v.policy_version as number };
  }
  if (v.action === "transfer") {
    const t = transferFields(v.transfer, v.policy_version);
    if (t) return { action: "transfer", text: "", ...base, transfer: { account: t.account, unmark_policy: { allow: t.allow, version: t.version } }, policy_version: t.version };
  }
  return { action: "none", text: "", reason: `unsupported_action:${typeof v.action === "string" ? v.action.slice(0, 32) : "invalid"}`, expires_at: base.expires_at };
}

function parseDelivery(value: unknown): Delivery {
  const v = obj(value);
  need(["unclaimed", "claimed", "sent", "not_sent", "unknown"].includes(v.status as string), "delivery_invalid");
  need(v.attempt_id === null || isIdentifier(v.attempt_id), "delivery_invalid");
  need(v.platform_message_id === null || v.platform_message_id === undefined || typeof v.platform_message_id === "string", "delivery_invalid");
  const d: Delivery = { status: v.status as DeliveryStatus, attempt_id: v.attempt_id as string | null, platform_message_id: (v.platform_message_id as string | null) ?? null };
  if (isFiniteNumber(v.claim_expires_at)) d.claim_expires_at = v.claim_expires_at;
  if (typeof v.reason === "string") d.reason = v.reason;
  if (v.verification !== undefined && v.verification !== null) {
    const ver = obj(v.verification);
    need(v.status === "unknown" && (ver.outcome === "sent" || ver.outcome === "not_sent") && typeof ver.note === "string" && isFiniteNumber(ver.verified_at), "delivery_invalid");
    d.verification = { outcome: ver.outcome, note: ver.note, verified_at: ver.verified_at };
  }
  return d;
}

export function parseSnapshot(value: unknown): EventSnapshot {
  const v = obj(value);
  for (const k of ["event_id", "shop_id", "client_id", "conversation_id", "message_id", "session_id"]) need(isIdentifier(v[k]), "snapshot_invalid");
  need(["pending", "processing", "ready"].includes(v.state as string), "snapshot_invalid");
  need(Number.isInteger(v.context_revision) && Number.isInteger(v.generation), "snapshot_invalid");
  const timing = parseTiming(v.timing);
  return {
    event_id: v.event_id as string,
    shop_id: v.shop_id as string,
    client_id: v.client_id as string,
    conversation_id: v.conversation_id as string,
    message_id: v.message_id as string,
    context_revision: v.context_revision as number,
    session_id: v.session_id as string,
    generation: v.generation as number,
    state: v.state as EventSnapshot["state"],
    decision: parseDecision(v.decision),
    delivery: parseDelivery(v.delivery),
    created_at: isFiniteNumber(v.created_at) ? v.created_at : 0,
    ...(isFiniteNumber(v.event_deadline) ? { event_deadline: v.event_deadline } : {}),
    ...(timing ? { timing } : {}),
  };
}

/** 后台地址：远程只允许 HTTPS，回环地址可用 HTTP；不允许携带账号、查询串或片段。 */
export function normalizeBackendUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProtocolError("backend_url_invalid");
  }
  need(!url.username && !url.password && !url.search && !url.hash, "backend_url_invalid");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  need(url.protocol === "https:" || (url.protocol === "http:" && loopback), "backend_url_requires_https");
  return url.origin + url.pathname.replace(/\/+$/, "");
}
