import fs from "node:fs";
import path from "node:path";
import type { Card, EventSnapshot, Kind, ReceiptExtra, ReceiptStatus, Role } from "./protocol.js";

export type StoredMessage = {
  id: string;
  /** false：平台没有给出可靠 ID，本地仅展示，不提交后台。 */
  stable: boolean;
  role: Role;
  kind: Kind;
  content: string;
  created_at: number;
  card?: Card;
  image_ref?: string;
  received_at: number;
  /** 首次确定消息身份的墙钟毫秒，仅用于重启恢复，缺失时不重新获得自动发送预算。 */
  first_seen_at?: number;
  /** 首次观察时确认的新预算模式；旧消息不得因后续心跳被升级。 */
  timeout_transfer?: true;
  /** false：历史同步/重连回补，不作为新消息处理。 */
  live: boolean;
  session_id: string | null;
};

export type AttemptPhase =
  | "claim_requested"
  | "claimed"
  | "claim_failed"
  | "aborted_before_send"
  | "sending"
  | "sent"
  | "not_sent"
  | "unknown";

export type ReceiptRecord = {
  status: ReceiptStatus;
  platform_message_id: string | null;
  upload: "pending" | "uploaded" | "rejected";
  error: string | null;
  /** 会话操作（契约 1.3）回执的步骤、原因与页面观察；只含步骤名、状态、颜色与原因分类，不含平台原文或编号。 */
  extra?: ReceiptExtra;
};

export type AttemptRecord = {
  attempt_id: string;
  phase: AttemptPhase;
  detail: string | null;
  platform_message_id: string | null;
  receipt: ReceiptRecord | null;
};

export type EventStage = "prepared" | "submitted" | "submit_failed" | "rejected";

/**
 * 发送结果不确定（unknown）后，前台自动读一遍该买家聊天记录的本地结论，只用于提示人工，不改变 unknown、不上报后台、不触发重发。
 * seen：发送后记录里出现了对应的客服消息；not_seen：发送后记录已刷新，但没有对应消息；unavailable：记录没有刷新或无法比对。
 */
export type UnknownCheck = { attempt_id: string; result: "seen" | "not_seen" | "unavailable"; detail: string; at: number };

/**
 * 契约 A.5 取消记录。intent 在发出 cancel 前落盘，只证明“计划发起”；done 为后台返回截止终态；
 * rejected 为后台明确拒绝；failed 为网络重试用尽；checked 为重启后按快照核对的结论（重启后不再 POST）。
 */
export type CancelRecord = { phase: "intent" | "done" | "rejected" | "failed" | "checked"; detail: string | null; at: number };

export type EventRecord = {
  event_id: string;
  conversation_id: string;
  message_id: string;
  instance_id: string;
  session_id: string;
  generation: number;
  context_revision: number;
  /** 原始请求体；重投时必须原样使用。带图片时这里只存图片的大小与哈希，带订单时不存订单，完整请求体仅在内存。 */
  body: string;
  has_images?: boolean;
  has_orders?: boolean;
  /** 请求体含商品快照（只在内存，含订单商品标题）；重启后不重投。 */
  has_goods?: boolean;
  /** 请求体含发送候选（只在内存）；重启后不重投。 */
  has_send_options?: boolean;
  history_complete: boolean;
  text_only: boolean;
  /** 契约 A：请求体里冻结的剩余预算（毫秒）；未确认能力时没有。 */
  budget_ms?: number;
  timeout_transfer?: true;
  stage: EventStage;
  error: string | null;
  snapshot: EventSnapshot | null;
  blocked: string | null;
  attempt: AttemptRecord | null;
  check?: UnknownCheck;
  cancel?: CancelRecord;
};

export type ConversationState = {
  conversation_id: string;
  revision: number;
  takeover: boolean;
  messages: StoredMessage[];
  notes: Record<string, string>;
  /** 从对话开头到这条消息，本地记录已被平台确认完整（平台无更多历史时取得）。 */
  complete_through: string | null;
};

export type JournalRec =
  | { t: "msg"; conversation_id: string; message: StoredMessage }
  | { t: "rev"; conversation_id: string; revision: number; reason: string }
  | { t: "takeover"; conversation_id: string; on: boolean }
  | { t: "note"; conversation_id: string; message_id: string; reason: string }
  | { t: "complete"; conversation_id: string; message_id: string }
  | { t: "event"; event: Omit<EventRecord, "stage" | "error" | "snapshot" | "blocked" | "attempt"> }
  | { t: "event_stage"; event_id: string; stage: EventStage; error: string | null }
  | { t: "snapshot"; event_id: string; snapshot: EventSnapshot }
  | { t: "blocked"; event_id: string; reason: string }
  | { t: "attempt"; event_id: string; attempt_id: string; phase: AttemptPhase; detail: string | null; platform_message_id: string | null; receipt?: ReceiptRecord }
  | { t: "receipt"; event_id: string; attempt_id: string; receipt: ReceiptRecord }
  | { t: "check"; event_id: string; check: UnknownCheck }
  | { t: "cancel"; event_id: string; cancel: CancelRecord };

export class JournalCorruptError extends Error {}

const tail = (id: string | null | undefined, n = 6) => (id ? "…" + id.slice(-n) : "-");

/** 与后台日志关联用的引用：sha256(紧凑 JSON 数组) 十六进制前 24 位；买家编号不以明文出现在日志里。 */
export type LogRefs = { event: (eventId: string) => string; conv: (conversationId: string) => string };

/** 日志用的一行摘要：只含类型、状态、原因码与关联引用，不含消息正文或请求体。重复的判断快照返回 null。 */
export function describeRecord(rec: JournalRec, previous: EventSnapshot | null, refs: LogRefs): string | null {
  switch (rec.t) {
    case "msg":
      return `message conv=${refs.conv(rec.conversation_id)} id=${tail(rec.message.id)} role=${rec.message.role} kind=${rec.message.kind} live=${rec.message.live} stable=${rec.message.stable}`;
    case "rev":
    case "complete":
      return null;
    case "takeover":
      return `takeover conv=${refs.conv(rec.conversation_id)} on=${rec.on}`;
    case "note":
      return `note conv=${refs.conv(rec.conversation_id)} msg=${tail(rec.message_id)} reason=${rec.reason}`;
    case "event":
      return `event created event_ref=${refs.event(rec.event.event_id)} conv=${refs.conv(rec.event.conversation_id)} msg=${tail(rec.event.message_id)} rev=${rec.event.context_revision} history_complete=${rec.event.history_complete} supported=${rec.event.text_only} images=${rec.event.has_images ? 1 : 0} orders=${rec.event.has_orders ? 1 : 0} goods=${rec.event.has_goods ? 1 : 0} options=${rec.event.has_send_options ? 1 : 0}${rec.event.budget_ms !== undefined ? ` budget_ms=${rec.event.budget_ms}` : ""}`;
    case "event_stage":
      return `event stage event_ref=${refs.event(rec.event_id)} stage=${rec.stage}${rec.error ? ` error=${rec.error}` : ""}`;
    case "snapshot": {
      const s = rec.snapshot;
      const key = (x: EventSnapshot | null) => (x ? `${x.state}|${x.decision?.action}|${x.decision?.reason}|${x.delivery.status}` : "");
      if (key(s) === key(previous)) return null;
      return `decision event_ref=${refs.event(rec.event_id)} state=${s.state} action=${s.decision?.action ?? "-"} reason=${s.decision?.reason ?? "-"} delivery=${s.delivery.status}`;
    }
    case "blocked":
      return `send blocked event_ref=${refs.event(rec.event_id)} reason=${rec.reason}`;
    case "attempt":
      return `send attempt event_ref=${refs.event(rec.event_id)} phase=${rec.phase}${rec.detail ? ` detail=${rec.detail}` : ""} platform_msg=${rec.platform_message_id ? "yes" : "no"}`;
    case "receipt":
      return `receipt event_ref=${refs.event(rec.event_id)} status=${rec.receipt.status} upload=${rec.receipt.upload}${rec.receipt.error ? ` error=${rec.receipt.error}` : ""}`;
    case "cancel":
      return `cancel event_ref=${refs.event(rec.event_id)} phase=${rec.cancel.phase}${rec.cancel.detail ? ` detail=${rec.cancel.detail}` : ""}`;
    case "check":
      return `unknown check event_ref=${refs.event(rec.event_id)} result=${rec.check.result} detail=${rec.check.detail}`;
  }
}

/**
 * 每店一个追加式日志。每条记录写入后 fsync，进程崩溃最多丢失尚未写完的最后一行；
 * 重启时回放得到全部消息、事件、发送尝试与回执状态。
 */
export class Journal {
  readonly conversations = new Map<string, ConversationState>();
  readonly events = new Map<string, EventRecord>();
  private readonly fd: number;
  private closed = false;
  /** 每写入一条记录后回调（previous 为该事件写入前的判断快照），用于诊断日志。 */
  onRecord: ((rec: JournalRec, previous: EventSnapshot | null) => void) | null = null;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "journal.jsonl");
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    let good = 0;
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      if (line === "") {
        if (!isLast) good += 1;
        continue;
      }
      let rec: JournalRec;
      try {
        rec = JSON.parse(line) as JournalRec;
      } catch {
        // 只有最后一行可能是崩溃时写了一半；中间损坏拒绝启动，避免丢失发送证据。
        if (isLast) break;
        throw new JournalCorruptError(`journal line ${i + 1} unreadable`);
      }
      this.apply(rec);
      good += Buffer.byteLength(line, "utf8") + (isLast ? 0 : 1);
    }
    if (good < Buffer.byteLength(raw, "utf8")) {
      // Windows 的追加句柄不能截断；先用普通写句柄修复尾行，再进入追加模式。
      const repairFd = fs.openSync(file, "r+");
      try {
        fs.ftruncateSync(repairFd, good);
        fs.fsyncSync(repairFd);
      } finally {
        fs.closeSync(repairFd);
      }
    }
    this.fd = fs.openSync(file, "a+", 0o600);
    if (good > 0 && Buffer.from(raw, "utf8")[good - 1] !== 0x0a) {
      fs.writeSync(this.fd, "\n");
      fs.fsyncSync(this.fd);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
  }

  private write(rec: JournalRec) {
    if (this.closed) throw new Error("journal_closed");
    fs.writeSync(this.fd, JSON.stringify(rec) + "\n");
    fs.fsyncSync(this.fd);
    const previous = rec.t === "snapshot" ? (this.events.get(rec.event_id)?.snapshot ?? null) : null;
    this.apply(rec);
    this.onRecord?.(rec, previous);
  }

  conversation(id: string): ConversationState {
    let conv = this.conversations.get(id);
    if (!conv) {
      conv = { conversation_id: id, revision: 0, takeover: false, messages: [], notes: {}, complete_through: null };
      this.conversations.set(id, conv);
    }
    return conv;
  }

  private apply(rec: JournalRec) {
    switch (rec.t) {
      case "msg": {
        const conv = this.conversation(rec.conversation_id);
        conv.messages.push(rec.message);
        conv.messages.sort((a, b) => a.created_at - b.created_at);
        break;
      }
      case "rev":
        this.conversation(rec.conversation_id).revision = rec.revision;
        break;
      case "takeover":
        this.conversation(rec.conversation_id).takeover = rec.on;
        break;
      case "note":
        this.conversation(rec.conversation_id).notes[rec.message_id] = rec.reason;
        break;
      case "complete":
        this.conversation(rec.conversation_id).complete_through = rec.message_id;
        break;
      case "event":
        this.events.set(rec.event.event_id, { ...rec.event, stage: "prepared", error: null, snapshot: null, blocked: null, attempt: null });
        break;
      case "event_stage": {
        const ev = this.events.get(rec.event_id);
        if (ev) Object.assign(ev, { stage: rec.stage, error: rec.error });
        break;
      }
      case "snapshot": {
        const ev = this.events.get(rec.event_id);
        if (ev) ev.snapshot = rec.snapshot;
        break;
      }
      case "blocked": {
        const ev = this.events.get(rec.event_id);
        if (ev) ev.blocked = rec.reason;
        break;
      }
      case "attempt": {
        const ev = this.events.get(rec.event_id);
        if (!ev) break;
        const receipt = rec.receipt ?? (ev.attempt?.attempt_id === rec.attempt_id ? ev.attempt.receipt : null);
        ev.attempt = { attempt_id: rec.attempt_id, phase: rec.phase, detail: rec.detail, platform_message_id: rec.platform_message_id, receipt };
        break;
      }
      case "receipt": {
        const ev = this.events.get(rec.event_id);
        if (ev?.attempt?.attempt_id === rec.attempt_id) ev.attempt.receipt = rec.receipt;
        break;
      }
      case "cancel": {
        const ev = this.events.get(rec.event_id);
        if (ev) ev.cancel = rec.cancel;
        break;
      }
      case "check": {
        const ev = this.events.get(rec.event_id);
        if (ev?.attempt?.attempt_id === rec.check.attempt_id) ev.check = rec.check;
        break;
      }
    }
  }

  hasMessage(conversationId: string, messageId: string): boolean {
    return this.conversations.get(conversationId)?.messages.some((m) => m.id === messageId) ?? false;
  }

  addMessage(conversationId: string, message: StoredMessage) {
    this.write({ t: "msg", conversation_id: conversationId, message });
  }

  /** 上下文发生任何变化都调用；版本严格递增并持久化。 */
  bumpRevision(conversationId: string, reason: string): number {
    const revision = this.conversation(conversationId).revision + 1;
    this.write({ t: "rev", conversation_id: conversationId, revision, reason });
    return revision;
  }

  markComplete(conversationId: string, messageId: string) {
    if (this.conversation(conversationId).complete_through === messageId) return;
    this.write({ t: "complete", conversation_id: conversationId, message_id: messageId });
  }

  setTakeover(conversationId: string, on: boolean) {
    this.write({ t: "takeover", conversation_id: conversationId, on });
  }

  note(conversationId: string, messageId: string, reason: string) {
    this.write({ t: "note", conversation_id: conversationId, message_id: messageId, reason });
  }

  addEvent(event: Omit<EventRecord, "stage" | "error" | "snapshot" | "blocked" | "attempt">) {
    this.write({ t: "event", event });
  }

  setStage(eventId: string, stage: EventStage, error: string | null = null) {
    this.write({ t: "event_stage", event_id: eventId, stage, error });
  }

  setSnapshot(eventId: string, snapshot: EventSnapshot) {
    this.write({ t: "snapshot", event_id: eventId, snapshot });
  }

  setBlocked(eventId: string, reason: string) {
    if (this.events.get(eventId)?.blocked === reason) return;
    this.write({ t: "blocked", event_id: eventId, reason });
  }

  setAttempt(eventId: string, attemptId: string, phase: AttemptPhase, detail: string | null = null, platformMessageId: string | null = null) {
    this.write({ t: "attempt", event_id: eventId, attempt_id: attemptId, phase, detail, platform_message_id: platformMessageId });
  }

  /** 尝试结果与待上传回执写在同一条记录里，崩溃时不会出现“有结果没回执”。 */
  finishAttempt(eventId: string, attemptId: string, phase: AttemptPhase, detail: string | null, platformMessageId: string | null, receipt: ReceiptRecord) {
    this.write({ t: "attempt", event_id: eventId, attempt_id: attemptId, phase, detail, platform_message_id: platformMessageId, receipt });
  }

  setReceipt(eventId: string, attemptId: string, receipt: ReceiptRecord) {
    this.write({ t: "receipt", event_id: eventId, attempt_id: attemptId, receipt });
  }

  setCancel(eventId: string, cancel: CancelRecord) {
    this.write({ t: "cancel", event_id: eventId, cancel });
  }

  setCheck(eventId: string, check: UnknownCheck) {
    this.write({ t: "check", event_id: eventId, check });
  }

  hasUnknown(conversationId: string): boolean {
    for (const ev of this.events.values()) {
      if (ev.conversation_id !== conversationId) continue;
      if (ev.snapshot?.delivery.verification) continue;
      if (ev.attempt?.phase === "unknown" || ev.snapshot?.delivery.status === "unknown") return true;
    }
    return false;
  }

  eventForMessage(conversationId: string, messageId: string): EventRecord | undefined {
    for (const ev of this.events.values()) if (ev.conversation_id === conversationId && ev.message_id === messageId) return ev;
    return undefined;
  }
}
