import { createHash, randomUUID } from "node:crypto";
import type { AdapterEvent, HistoryResult, MarkResult, TransferResult, PlatformAdapter, PlatformMessage, PlatformSendOption, SendResult } from "./adapter.js";
import type { OrderGoods, PlatformOrder } from "./pddOrders.js";
import { buildGoodsSnapshot } from "./goodsSnapshot.js";
import { productKey, type ProductDoc } from "./productLearning.js";
import { BackendClient, BackendError, FetchLike, TransportError } from "./backend.js";
import { AttemptPhase, ConversationState, EventRecord, Journal, LogRefs, ReceiptRecord, StoredMessage, UnknownCheck, describeRecord } from "./journal.js";
import {
  Attachment,
  CAP_GOODS_SNAPSHOT,
  CAP_PRODUCT_KNOWLEDGE,
  ProductLearningRequest,
  CAP_MARK_CONVERSATION,
  CAP_TRANSFER_BY_ACCOUNT,
  CAP_REPLY_DEADLINE,
  CAP_SEND_ITEM,
  ContextMessage,
  ContextOrder,
  ConvState,
  IMAGE_MISSING,
  MAX_EVENT_BYTES,
  MAX_IMAGE_BYTES,
  EventRequest,
  EventSnapshot,
  MAX_BODY_BYTES,
  MAX_CONTENT_CHARS,
  MAX_CONTEXT_MESSAGES,
  MAX_REMAINING_BUDGET_MS,
  MARK_COLORS,
  Me,
  PageObserved,
  ReceiptExtra,
  ReceiptStatus,
  SEND_OPTION_KIND,
  SEND_OPTION_LIMITS,
  SendOptions,
  convActionReason,
  isDeadlineTerminal,
  isFiniteNumber,
  isIdentifier,
} from "./protocol.js";

import { ReplyTiming, REPLY_DEADLINE_REASON } from "./replyTiming.js";

export type ShopMode = "observe" | "auto" | "manual";
export const SHOP_MODES: readonly ShopMode[] = ["observe", "auto", "manual"];
/** 客户端安装更新期间的阻止原因（见 RuntimeOptions.updateHold）。 */
export const UPDATE_HOLD_REASON = "update_pending";

export type ShopConfig = {
  shop_id: string;
  display_name: string;
  backend_url: string;
  /** 期望的平台店铺身份；登录后与平台实际身份交叉核验。 */
  platform_shop_id: string;
  adapter: "mock" | "pdd";
  mode: ShopMode;
};

export type Timing = {
  heartbeatMs: number;
  pollMs: number;
  pollMaxMs: number;
  pollGiveUpMs: number;
  submitRetries: number;
  sendTimeoutMs: number;
  requestTimeoutMs: number;
  /** 本地判定租约有效时保留的余量（秒）。 */
  leaseSafety: number;
  decisionSafety: number;
  claimSafety: number;
  /** 领取许可后，许可剩余时间至少要能容纳一次平台发送（秒）。 */
  minSendWindow: number;
  /** 许可到期前为上传回执预留的时间（秒）。 */
  receiptReserve: number;
  /** 回执上传失败后的快速重试间隔（毫秒）。 */
  receiptRetryMs: number[];
  /** 提交前等待该买家进行中的订单读取的上限（毫秒）。 */
  ordersWaitMs: number;
  /** 准备阶段（订单与可发送项）合计的目标上限（毫秒）；同时受 20 秒剩余预算约束。 */
  prepBudgetMs: number;
  /** 发送结果不确定后，自动读聊天记录核对的时间点（距发送开始，毫秒）；记录未刷新时到下一个时间点再看。 */
  unknownCheckDelaysMs: number[];
  /** 附加发送的确认截止距许可到期的余量（秒），契约规定为 2。 */
  itemReceiptReserve: number;
};

export const DEFAULT_TIMING: Timing = {
  heartbeatMs: 15000,
  pollMs: 500,
  pollMaxMs: 8000,
  pollGiveUpMs: 180000,
  submitRetries: 4,
  sendTimeoutMs: 15000,
  requestTimeoutMs: 8000,
  leaseSafety: 5,
  decisionSafety: 2,
  claimSafety: 1.5,
  minSendWindow: 4,
  receiptReserve: 1.5,
  receiptRetryMs: [300, 600, 1000, 1500, 2500],
  ordersWaitMs: 3000,
  prepBudgetMs: 2000,
  unknownCheckDelaysMs: [8000, 30000],
  itemReceiptReserve: 2,
};

/** 5xx、429、408 视为暂时失败，可原样重试；其余后台错误是确定结论。 */
export function isTransient(err: unknown): boolean {
  if (err instanceof TransportError) return true;
  return err instanceof BackendError && (err.status >= 500 || err.status === 429 || err.status === 408);
}

export type RuntimeOptions = {
  config: ShopConfig;
  token: string;
  adapter: PlatformAdapter;
  dataDir: string;
  instanceId?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** 毫秒；与用于协议时间的墙钟分开。 */
  monotonicNow?: () => number;
  timing?: Partial<Timing>;
  onChange?: () => void;
  /** 只记录状态码，不记录口令和消息正文。 */
  log?: (line: string) => void;
  /**
   * 契约 1.3：在心跳中声明 mark_conversation 并允许执行标星（还要求适配器能读状态、能执行标星）。
   * 默认关闭：实现合并不等于启用，正式启用须另行明确安排并经审查。
   */
  declareMark?: boolean;
  declareTransfer?: boolean;
  /**
   * 客户端“检查更新”安装期间的全局保持（#34），由主进程统一提供，对之后新建的运行时同样生效。
   * 为真时禁止新的准备提交、领取、附加发送与标星；已领取的尝试照常归结，unknown 不变。
   */
  updateHold?: () => boolean;
};

type BackendState = { state: "idle" | "connecting" | "ok" | "error"; detail: string; me: Me | null };

/** unknown 核对的比对对象：文字回复按全文（忽略空白差异）；附加内容按候选名称或商品标题出现在卡片/消息中。 */
type UnknownTarget = { kind: "text"; text: string } | { kind: "item"; option: PlatformSendOption };
/** 覆盖证据要求本页最新消息晚于发送开始的秒数，用来抵消本机与平台的时钟误差。 */
const UNKNOWN_COVER_MARGIN_S = 30;
type UnknownCheckJob = { ev: EventRecord; attemptId: string; startedMs: number; returnedMs: number; known: Set<string>; target: UnknownTarget | null };

const squash = (v: string) => v.replace(/\s+/g, "");

export function matchesTarget(m: PlatformMessage, target: UnknownTarget): boolean {
  if (target.kind === "text") return m.kind === "text" && squash(target.text).length > 0 && squash(m.content) === squash(target.text);
  const label = squash(target.option.type === "goods_card" ? target.option.goods_title : target.option.name);
  if (label.length < 2 || m.kind === "text") return false;
  const card = m.card ? [m.card.title ?? "", m.card.description ?? "", ...(m.card.fields ?? []).map((f) => f.value)].join("") : "";
  return squash(m.content + card).includes(label);
}
type LeaseState = { state: "none" | "held" | "busy" | "error"; generation: number; valid_until: number; detail: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 前后台日志关联：sha256(UTF-8(紧凑 JSON 数组)) 十六进制前 24 位。 */
export function logRef(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 24);
}

export class ShopRuntime {
  readonly config: ShopConfig;
  readonly instanceId: string;
  readonly journal: Journal;
  readonly adapter: PlatformAdapter;
  readonly backend: BackendClient;
  backendState: BackendState = { state: "idle", detail: "未连接", me: null };
  lease: LeaseState = { state: "none", generation: 0, valid_until: 0, detail: "平台未登录，未申请发送归属" };
  sessionId: string | null = null;
  duplicates = 0;
  private readonly timing: Timing;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly replyTiming: ReplyTiming;
  private readonly onChange: () => void;
  private stopped = false;
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly sendingConversations = new Set<string>();
  private deliveryTail: Promise<void> = Promise.resolve();
  /** unknown 自动核对的定时器；停止时清除。 */
  private readonly checkTimers = new Set<NodeJS.Timeout>();
  /** 本次运行中按原因累计的 unknown 次数，只用于日志统计。 */
  private readonly unknownCounts = new Map<string, number>();
  /** 每个买家对话进行中的新消息处理数（准备、提交、判定、发送）；归零后才可预热。 */
  private readonly inFlight = new Map<string, number>();
  /** 仅保留失联时尚未创建事件的新消息；不包含任何已尝试发送的事件。 */
  private readonly pendingPreparation = new Map<string, { messageId: string; sessionId: string }>();
  /** 仅保留本次运行中因后台失联而阻塞、尚未领取许可的 ready 事件。 */
  private readonly pendingReady = new Map<string, EventRecord>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly resume: EventRecord[] = [];
  private readonly uploading = new Set<string>();
  readonly refs: LogRefs = {
    event: (eventId) => logRef([this.config.shop_id, eventId]),
    conv: (conversationId) => logRef([this.config.shop_id, "conversation", conversationId]).slice(0, 12),
  };
  /** 每个买家最近读到的订单摘要，只在内存；进程重启后等页面重新加载。 */
  /** 每个对话的订单摘要与订单明细（明细只在 goods_snapshot 确认后随订单提交为 items）。 */
  private readonly orders = new Map<string, { json: string; list: ContextOrder[]; lines: Map<string, OrderGoods[]> }>();
  /** 带图片事件的完整请求体，只在内存；提交成功后释放。 */
  private readonly fullBodies = new Map<string, string>();
  /** 每个买家对话当前可发送的已有内容，只在内存。 */
  private readonly sendOptions = new Map<string, { json: string; list: PlatformSendOption[] }>();
  /** 事件提交时的候选映射 option_id → 平台对象，只在内存；重启后该事件的 send_item 不执行。 */
  private readonly eventOptions = new Map<string, Map<string, PlatformSendOption>>();
  /** 候选版本：每次某对话候选集合或映射变化时取新的全局序号；事件记下生成候选时的版本（契约“聊天页附加发送·绑定”）。 */
  private optionsSeq = 0;
  private readonly optionsAt = new Map<string, number>();
  private readonly eventOptionsAt = new Map<string, number | undefined>();
  /** 事件提交时的 conv_state，只在内存；重启后该事件的 mark 不执行。 */
  private readonly eventConvState = new Map<string, ConvState>();
  private readonly declareMark: boolean;
  private readonly declareTransfer: boolean;
  /** 客户端“检查更新”安装期间的全局保持（见 RuntimeOptions.updateHold）。 */
  private readonly updateHold: () => boolean;
  /** 最近一次成功心跳确认的能力，随租约（instance+session+generation）变化重置。 */
  private capabilities = new Set<string>();
  /** 正在发出取消请求的事件（契约 A.5），避免并发重复发起。 */
  private readonly cancelling = new Set<string>();
  /** 重启时只有取消意图、没有结论的事件：先查询快照核对，不再以旧意图发起取消。 */
  private readonly cancelChecks: EventRecord[] = [];
  /** 已记录后台计时的事件，只在内存。 */
  private readonly timingLogged = new Set<string>();
  private productLearning: Promise<void> | null = null;
  private readonly productRequests = new Set<string>();

  constructor(options: RuntimeOptions) {
    this.config = { ...options.config };
    this.instanceId = options.instanceId ?? `inst-${randomUUID()}`;
    this.adapter = options.adapter;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.now = options.now ?? (() => Date.now() / 1000);
    this.replyTiming = new ReplyTiming(options.monotonicNow ?? (() => performance.now()), () => this.now() * 1000);
    this.log = options.log ?? (() => undefined);
    this.onChange = options.onChange ?? (() => undefined);
    this.declareMark = options.declareMark === true;
    this.declareTransfer = options.declareTransfer === true;
    this.updateHold = options.updateHold ?? (() => false);
    this.backend = new BackendClient(options.config.backend_url, options.token, options.fetchImpl, this.timing.requestTimeoutMs);
    this.journal = new Journal(options.dataDir);
    this.journal.onRecord = (rec, previous) => {
      const line = describeRecord(rec, previous, this.refs);
      if (line) this.log(line);
    };
    for (const conv of this.journal.conversations.values()) for (const message of conv.messages) this.replyTiming.observe(message);
    this.recover();
  }

  get mode() {
    return this.config.mode;
  }

  private changed() {
    try {
      this.onChange();
    } catch {
      // 界面刷新失败不影响收发状态机。
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    promise.finally(() => this.active.delete(promise)).catch(() => undefined);
    return promise;
  }

  /** 等待当前所有后台流程结束（测试与关闭时使用）。 */
  async settled() {
    while (this.active.size) await Promise.allSettled([...this.active]);
  }

  // ---------- 启动、恢复与停止 ----------

  /**
   * 重启恢复：已开始平台发送但没有结果的尝试一律 unknown；
   * 能证明未调用平台的尝试上报 not_sent；未确认提交的事件稍后原样补报。
   */
  private recover() {
    for (const ev of this.journal.events.values()) {
      const a = ev.attempt;
      if (a?.phase === "sending") {
        this.journal.finishAttempt(ev.event_id, a.attempt_id, "unknown", "interrupted_during_send", null, pendingReceipt("unknown", null, receiptExtra(ev, "unknown", "interrupted_during_send")));
      } else if (a && (a.phase === "claim_requested" || a.phase === "claimed")) {
        this.journal.finishAttempt(ev.event_id, a.attempt_id, "aborted_before_send", "restarted_before_send", null, pendingReceipt("not_sent", null, receiptExtra(ev, "not_sent", "restarted_before_send")));
      } else if (a && !a.receipt) {
        // 旧版日志可能只有结果、没有回执：按结果补出待上传回执。
        const status: ReceiptStatus | null =
          a.phase === "sent" ? "sent" : a.phase === "unknown" ? "unknown" : a.phase === "not_sent" || a.phase === "aborted_before_send" ? "not_sent" : a.phase === "claim_failed" && a.detail === "claim_response_lost" ? "not_sent" : null;
        if (status) this.journal.setReceipt(ev.event_id, a.attempt_id, pendingReceipt(status, status === "sent" ? a.platform_message_id : null, receiptExtra(ev, status, a.detail)));
      }
      if (ev.stage === "prepared" || ev.stage === "submit_failed" || (ev.stage === "submitted" && ev.snapshot?.state !== "ready")) this.resume.push(ev);
      if (ev.cancel?.phase === "intent") this.cancelChecks.push(ev);
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.adapter.onEvent((e) => this.onAdapterEvent(e));
    if (this.adapter.status().logged_in) this.newSession();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.timing.heartbeatMs);
  }

  /** wait=false 时立即停止并关闭日志，不等待进行中的平台请求（等同进程退出）。 */
  async stop(wait = true) {
    this.stopped = true;
    this.pendingPreparation.clear();
    this.pendingReady.clear();
    for (const t of this.checkTimers) clearTimeout(t);
    this.checkTimers.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (wait) await this.settled();
    this.adapter.dispose();
    this.journal.close();
  }

  private async tick() {
    if (this.stopped) return;
    if (this.backendState.state !== "ok") await this.connectBackend();
    if (this.backendState.state === "ok") {
      if (this.sessionId) await this.heartbeat();
      if (this.resume.length) {
        for (const ev of this.resume.splice(0)) this.track(this.submitAndPoll(ev));
      }
      if (this.cancelChecks.length) {
        for (const ev of this.cancelChecks.splice(0)) this.track(this.checkCancel(ev));
      }
    }
    this.flushReceipts();
    this.changed();
  }

  private async connectBackend() {
    this.backendState = { state: "connecting", detail: "正在连接后台", me: null };
    try {
      await this.backend.health();
      const me = await this.backend.me();
      if (me.shop_id !== this.config.shop_id) {
        this.backendState = { state: "error", detail: "token_shop_mismatch", me };
        this.log(`backend identity mismatch shop=${this.config.shop_id}`);
        return;
      }
      this.backendState = { state: "ok", detail: "已连接", me };
    } catch (err) {
      this.backendState = { state: "error", detail: errorCode(err), me: null };
    }
  }

  private async heartbeat() {
    const session = this.sessionId;
    if (!session || this.stopped) return;
    const started = this.now();
    try {
      const lease = await this.backend.heartbeat(this.instanceId, session, [...(this.adapter.sendItem ? [CAP_SEND_ITEM] : []), CAP_REPLY_DEADLINE, CAP_GOODS_SNAPSHOT, ...(this.adapter.collectProducts ? [CAP_PRODUCT_KNOWLEDGE] : []), ...(this.markDeclared() ? [CAP_MARK_CONVERSATION] : []), ...(this.transferDeclared() ? [CAP_TRANSFER_BY_ACCOUNT] : [])]);
      if (lease.instance_id !== this.instanceId || lease.session_id !== session || lease.shop_id !== this.config.shop_id) {
        this.lease = { state: "error", generation: 0, valid_until: 0, detail: "lease_response_mismatch" };
        return;
      }
      if (this.sessionId !== session) return;
      if (this.lease.generation && this.lease.generation !== lease.generation) this.log(`lease generation changed ${this.lease.generation}->${lease.generation}`);
      // 以本地发起时刻计 60 秒，避免两端时钟差导致租约被高估。
      this.lease = { state: "held", generation: lease.generation, valid_until: Math.min(lease.expires_at, started + 60), detail: "已取得发送归属" };
      const caps = new Set(lease.capabilities);
      if (caps.has(CAP_SEND_ITEM) !== this.capabilities.has(CAP_SEND_ITEM)) this.log(`capability send_item=${caps.has(CAP_SEND_ITEM)}`);
      if (caps.has(CAP_REPLY_DEADLINE) !== this.capabilities.has(CAP_REPLY_DEADLINE)) this.log(`capability reply_deadline=${caps.has(CAP_REPLY_DEADLINE)}`);
      if (caps.has(CAP_GOODS_SNAPSHOT) !== this.capabilities.has(CAP_GOODS_SNAPSHOT)) this.log(`capability goods_snapshot=${caps.has(CAP_GOODS_SNAPSHOT)}`);
      if (caps.has(CAP_MARK_CONVERSATION) !== this.capabilities.has(CAP_MARK_CONVERSATION)) this.log(`capability mark_conversation=${caps.has(CAP_MARK_CONVERSATION)}`);
      this.capabilities = caps;
      this.resumePreparation();
      this.resumeReady();
      const request = lease.product_learning;
      if (request && caps.has(CAP_PRODUCT_KNOWLEDGE) && !this.productLearning && !this.productRequests.has(request.request_id)) {
        this.productRequests.add(request.request_id);
        this.productLearning = this.learnProducts(request, session, lease.generation).finally(() => { this.productLearning = null; });
      }
      if (this.config.mode === "auto" && this.sendItemConfirmed()) void this.adapter.prepareSendOptions?.().catch(() => undefined);
    } catch (err) {
      const code = errorCode(err);
      if (err instanceof BackendError && err.code === "lease_busy") {
        this.pendingPreparation.clear();
        this.pendingReady.clear();
        this.capabilities = new Set();
        this.lease = { state: "busy", generation: 0, valid_until: 0, detail: "lease_busy" };
      } else if (err instanceof BackendError && err.status === 401) {
        this.capabilities = new Set();
        this.backendState = { state: "error", detail: "unauthorized", me: null };
        this.lease = { state: "error", generation: 0, valid_until: 0, detail: code };
      } else {
        // 失联时保留已有到期时间，到期后自然失效。
        this.lease = { ...this.lease, state: this.lease.state === "held" ? "held" : "error", detail: code };
        if (err instanceof TransportError) this.backendState = { ...this.backendState, state: "error", detail: code };
      }
    }
    this.changed();
  }

  private leaseValid(generation?: number) {
    return this.lease.state === "held" && this.lease.valid_until - this.now() > this.timing.leaseSafety && (generation === undefined || generation === this.lease.generation);
  }

  // ---------- 平台事件 ----------

  /** 本租约已确认、且本适配器能执行附加发送。 */
  sendItemConfirmed() {
    return !!this.adapter.sendItem && this.capabilities.has(CAP_SEND_ITEM);
  }

  private async learnProducts(request: ProductLearningRequest, session: string, generation: number) {
    let seq = 0, total: number | null = null;
    const owner = { instance_id: this.instanceId, session_id: session, generation };
    const check = () => {
      if (this.stopped || this.updateHold() || this.sessionId !== session || this.lease.generation !== generation
          || this.lease.state !== "held" || this.lease.valid_until <= this.now() || this.platformCheck()
          || !this.capabilities.has(CAP_PRODUCT_KNOWLEDGE)) throw Error("product_source_changed");
      if (request.expires_at <= this.now()) throw Error("product_collection_timeout");
    };
    const send = async (products: ProductDoc[], finished: boolean, complete: boolean, error: string | null = null) => {
      const result = await this.backend.productBatch(request.request_id, { ...owner, seq, products, total,
        finished, catalog_complete: complete, error });
      if (result.status === "failed") throw Error("product_upload_failed");
      seq++;
    };
    try {
      check();
      if (!this.adapter.collectProducts) throw Error("product_page_unavailable");
      const result = await this.adapter.collectProducts(request.selection, async (products, count) => {
        check(); total = count; await send(products, false, false); check();
      }, check);
      check(); total = result.total;
      await send([], true, result.complete);
      this.log("product learning completed");
    } catch (error) {
      const known = ["product_source_changed", "product_collection_timeout", "product_list_invalid", "product_page_unavailable"];
      const code = error instanceof Error && known.includes(error.message) ? error.message : "product_upload_failed";
      // A failed/uncertain batch is never submitted again. Only cancel this read task.
      try { await send([], true, false, code); } catch { /* Current owner/task may already have changed. */ }
      this.log("product learning stopped");
    }
  }

  /** 契约“商品快照（1.2 草案）”：最近一次成功心跳为本租约确认了 goods_snapshot。 */
  goodsSnapshotConfirmed() {
    return this.lease.state === "held" && this.capabilities.has(CAP_GOODS_SNAPSHOT);
  }

  /** 契约“会话操作（1.3 草案）”：本租约确认了 mark_conversation，事件须带 conv_state。 */
  markConfirmed() {
    return this.lease.state === "held" && this.capabilities.has(CAP_MARK_CONVERSATION);
  }

  /** 本客户端声明 mark_conversation：已明确开启，且适配器能读收藏状态、能执行标星。 */
  private markDeclared() {
    return this.declareMark && !!this.adapter.readConvState && !!this.adapter.markConversation;
  }

  private transferDeclared() {
    return this.declareTransfer && !!this.adapter.transferConversation;
  }

  transferExecutable() {
    return this.transferDeclared() && this.lease.state === "held" && this.capabilities.has(CAP_TRANSFER_BY_ACCOUNT);
  }

  /** 可以执行标星：本客户端声明了能力，且本租约确认了它。 */
  markExecutable() {
    return this.markDeclared() && this.markConfirmed();
  }

  /** 契约 A.2：最近一次成功心跳为这一租约（instance+session+generation）确认了 reply_deadline。 */
  deadlineConfirmed(generation: number) {
    return this.lease.state === "held" && this.lease.generation === generation && this.capabilities.has(CAP_REPLY_DEADLINE);
  }

  private newSession() {
    this.pendingPreparation.clear();
    this.pendingReady.clear();
    this.capabilities = new Set();
    this.sendOptions.clear();
    this.sessionId = `ses-${randomUUID()}`;
    this.lease = { state: "none", generation: 0, valid_until: 0, detail: "等待取得发送归属" };
  }

  private onAdapterEvent(event: AdapterEvent) {
    if (this.stopped) return;
    switch (event.type) {
      case "session_started":
        this.orders.clear();
        this.newSession();
        this.track(this.heartbeat());
        break;
      case "session_ended":
        this.pendingPreparation.clear();
        this.pendingReady.clear();
        this.orders.clear();
        this.sendOptions.clear();
        this.capabilities = new Set();
        this.sessionId = null;
        this.lease = { state: "none", generation: 0, valid_until: 0, detail: "平台会话已结束" };
        break;
      case "message":
        this.ingest(event.message, event.live);
        break;
      case "orders":
        this.setOrders(event.conversation_id, event.orders);
        break;
      case "send_options":
        this.setSendOptions(event.conversation_id, event.options);
        break;
      case "status":
        if (this.platformCheck()) {
          this.pendingPreparation.clear();
          this.pendingReady.clear();
        }
        break;
    }
    this.changed();
  }

  /** 订单摘要变化使该对话的旧决定失效（契约“版本”）；订单号只用于生成对话内稳定引用。 */
  private setOrders(conversationId: string, orders: PlatformOrder[]) {
    if (!isIdentifier(conversationId) || this.platformCheck()) return;
    const refOf = (key: string) => "o-" + logRef([this.config.shop_id, "order", conversationId, key]).slice(0, 16);
    const list: ContextOrder[] = orders.map((o) => ({ order_ref: refOf(o.key), ...o.summary }));
    const lines = new Map(orders.filter((o) => o.goods?.length).map((o) => [refOf(o.key), o.goods!]));
    // 明细变化同样使旧决定失效（契约“商品快照”：快照变化使 context_revision 递增）。
    const json = JSON.stringify([list, [...lines]]);
    if (this.orders.get(conversationId)?.json === json) return;
    this.orders.set(conversationId, { json, list, lines });
    this.log(`orders conv=${this.refs.conv(conversationId)} count=${list.length}`);
    if (this.journal.conversations.get(conversationId)?.messages.length) this.journal.bumpRevision(conversationId, "orders");
  }

  /**
   * 商品快照：由本次请求里的订单（含本机明细）与消息生成 context.goods，并给有明细的订单加 items。
   * goods_ref 用店铺、对话与商品身份做摘要，同一对话内稳定；不改动内存里的订单摘要。
   */
  private attachGoods(conversationId: string, request: EventRequest) {
    const stored = this.orders.get(conversationId);
    const orders = request.context.orders ?? [];
    const snap = buildGoodsSnapshot(
      { orders: orders.map((o) => ({ order_ref: o.order_ref, observed_at: o.observed_at, goods: stored?.lines.get(o.order_ref) ?? [] })), messages: request.context.messages },
      (identity) => "g-" + logRef([this.config.shop_id, "goods", conversationId, identity]).slice(0, 16),
      this.capabilities.has(CAP_PRODUCT_KNOWLEDGE) ? (id) => productKey(this.config.shop_id, id) : undefined,
    );
    if (snap.goods.length) request.context.goods = snap.goods;
    if (orders.length && snap.items.size) request.context.orders = orders.map((o) => (snap.items.has(o.order_ref) ? { ...o, items: snap.items.get(o.order_ref) } : o));
  }

  /**
   * 候选集合或其私有映射变化只使该对话已生成的 send_item 决定失效（契约“聊天页附加发送·绑定”）：
   * 记新的候选版本，不递增 context_revision，文字回复等其他决定照常有效。
   */
  private setSendOptions(conversationId: string, options: PlatformSendOption[]) {
    if (!isIdentifier(conversationId) || this.platformCheck()) return;
    const json = JSON.stringify(options);
    if (this.sendOptions.get(conversationId)?.json === json) return;
    this.sendOptions.set(conversationId, { json, list: options });
    this.log(`send options conv=${this.refs.conv(conversationId)} count=${options.length}`);
    this.optionsAt.set(conversationId, ++this.optionsSeq);
  }

  /** 按契约字段白名单与上限生成本事件候选；option_id 绑定店铺、对话与版本，不含平台编号。 */
  private buildSendOptions(conversationId: string, revision: number): { options: SendOptions; map: Map<string, PlatformSendOption> } | null {
    const list = this.sendOptions.get(conversationId)?.list;
    if (!this.sendItemConfirmed() || !list?.length) return null;
    const label = (v: string) => v.trim().slice(0, 200);
    const options: Required<SendOptions> = { instructions: [], goods: [], videos: [] };
    const map = new Map<string, PlatformSendOption>();
    for (const o of list) {
      const kind = SEND_OPTION_KIND[o.type];
      if (options[kind].length >= SEND_OPTION_LIMITS[kind] || !isFiniteNumber(o.observed_at)) continue;
      const option_id = o.type[0] + "-" + logRef([this.config.shop_id, "option", conversationId, String(revision), o.type, o.key]).slice(0, 16);
      if (map.has(option_id)) continue;
      const observed_at = o.observed_at;
      if (o.type === "instruction") {
        if (!label(o.goods_title) || !label(o.name)) continue;
        options.instructions.push({ option_id, goods_title: label(o.goods_title), name: label(o.name), observed_at });
      } else if (o.type === "goods_card") {
        if (!label(o.goods_title)) continue;
        options.goods.push({ option_id, goods_title: label(o.goods_title), observed_at });
      } else {
        if (!label(o.name)) continue;
        options.videos.push({ option_id, name: label(o.name), ...(Number.isInteger(o.duration) && (o.duration as number) > 0 ? { duration: o.duration } : {}), observed_at });
      }
      map.set(option_id, o);
    }
    const out: SendOptions = {};
    if (options.instructions.length) out.instructions = options.instructions;
    if (options.goods.length) out.goods = options.goods;
    if (options.videos.length) out.videos = options.videos;
    return map.size ? { options: out, map } : null;
  }

  /** 收到的消息同步写入本地日志后才进入后续流程。 */
  private ingest(m: PlatformMessage, live: boolean) {
    if (!isIdentifier(m.conversation_id)) {
      this.log("message dropped: invalid conversation id");
      return;
    }
    const stable = isIdentifier(m.platform_message_id);
    if (stable && this.journal.hasMessage(m.conversation_id, m.platform_message_id as string)) {
      if (live && m.role === "buyer" && this.promote(m.conversation_id, m.platform_message_id as string)) return;
      this.duplicates += 1;
      return;
    }
    const id = stable ? (m.platform_message_id as string) : `local-${randomUUID()}`;
    const stored: StoredMessage = { id, stable, role: m.role, kind: m.kind, content: m.content, created_at: m.created_at, ...(m.card ? { card: m.card } : {}), ...(m.image_ref ? { image_ref: m.image_ref } : {}), received_at: this.now(), first_seen_at: this.now() * 1000, live, session_id: this.sessionId };
    this.replyTiming.observe(stored, true);
    const known = this.journal.conversation(m.conversation_id).messages.findLast((x) => x.card?.product_key)?.card?.product_key;
    this.journal.addMessage(m.conversation_id, stored);
    // 平台自动卡片不使已提交的判断失效：买家的问题不变，下一轮提交时照常带上它；
    // 但卡片带来不同的商品时，商品上下文已变，旧判断仍须失效。
    const sameProduct = !stored.card?.product_key || stored.card.product_key === known;
    if (!(platformCard(stored) && sameProduct)) this.journal.bumpRevision(m.conversation_id, live ? `message:${m.role}` : "history_sync");
    if (!stable) return this.journal.note(m.conversation_id, id, "no_stable_id");
    if (!live) return this.journal.note(m.conversation_id, id, "history_sync");
    if (m.role !== "buyer") return;
    this.track(this.submitNew(m.conversation_id, id));
  }

  /**
   * 处理上一条消息时取历史，可能先拿到了较新的买家消息 B（存为历史）；B 的实时推送随后到达时，
   * 若 B 仍是最新、只存为历史且从未提交，则按新消息处理，避免 A、B 都不提交。
   */
  private promote(conversationId: string, messageId: string): boolean {
    const conv = this.journal.conversation(conversationId);
    const stored = conv.messages.find((x) => x.id === messageId);
    if (!stored || stored.live || stored.role !== "buyer") return false;
    if (turnEnd(conv.messages)?.id !== messageId || this.journal.eventForMessage(conversationId, messageId)) return false;
    this.journal.bumpRevision(conversationId, "message:buyer");
    this.journal.note(conversationId, messageId, "promoted_live");
    this.track(this.submitNew(conversationId, messageId));
    return true;
  }

  /** 需要先满足的提交条件；不满足时消息只保存，不进入自动处理。 */
  private submitBlocker(): string | null {
    if (this.stopped) return "runtime_stopped";
    if (this.updateHold()) return UPDATE_HOLD_REASON;
    if (this.backendState.state !== "ok") return "backend_unavailable";
    const platform = this.platformCheck();
    if (platform) return platform;
    if (!this.sessionId) return "no_platform_session";
    if (!this.leaseValid()) return this.lease.state === "busy" ? "lease_busy" : "lease_invalid";
    return null;
  }

  /** 恢复连接后继续未开始的准备，沿用原消息的期限、身份与去重记录。 */
  private resumePreparation() {
    if (!this.pendingPreparation.size) return;
    if (this.stopped || this.config.mode !== "auto" || this.updateHold() || this.platformCheck()) {
      this.pendingPreparation.clear();
      return;
    }
    if (this.submitBlocker()) return;
    for (const [conversationId, pending] of this.pendingPreparation) {
      if (this.inFlight.has(conversationId)) continue;
      this.pendingPreparation.delete(conversationId);
      const conv = this.journal.conversation(conversationId);
      if (pending.sessionId !== this.sessionId || conv.takeover || turnEnd(conv.messages)?.id !== pending.messageId) continue;
      if (this.journal.eventForMessage(conversationId, pending.messageId) || this.expired(conversationId, pending.messageId)) continue;
      this.track(this.submitNew(conversationId, pending.messageId));
    }
  }

  /** 成功心跳后重新核验首次发送；先移出队列，避免并发心跳重复排队。 */
  private resumeReady() {
    if (this.stopped || this.backendState.state !== "ok") return;
    for (const [eventId, ev] of this.pendingReady) {
      this.pendingReady.delete(eventId);
      if (ev.attempt || ev.cancel || ev.stage !== "submitted" || ev.snapshot?.state !== "ready"
          || ev.snapshot.delivery.status !== "unclaimed" || ev.snapshot.delivery.attempt_id !== null) continue;
      this.track(this.considerSend(ev));
    }
  }

  private platformCheck(): string | null {
    const st = this.adapter.status();
    if (!st.logged_in) return "platform_logged_out";
    if (!st.identity) return "platform_identity_unverified";
    if (st.identity.platform_shop_id !== this.config.platform_shop_id) return "platform_shop_mismatch";
    return null;
  }

  private message(conversationId: string, messageId: string) {
    return this.journal.conversation(conversationId).messages.find((m) => m.id === messageId);
  }

  private remaining(conversationId: string, messageId: string) {
    const message = this.message(conversationId, messageId);
    return message ? this.replyTiming.remaining(message) : 0;
  }

  private expired(conversationId: string, messageId: string, ev?: EventRecord): boolean {
    if (this.remaining(conversationId, messageId) > 0) return false;
    this.noteDeadline(conversationId, messageId);
    if (ev) {
      this.journal.setBlocked(ev.event_id, REPLY_DEADLINE_REASON);
      this.maybeCancel(ev);
    }
    this.changed();
    return true;
  }

  private noteDeadline(conversationId: string, messageId: string) {
    if (this.journal.conversation(conversationId).notes[messageId] !== REPLY_DEADLINE_REASON) this.journal.note(conversationId, messageId, REPLY_DEADLINE_REASON);
  }

  private summary(conversationId: string, messageId: string, receiptCycleEnded = false) {
    const ev = this.journal.eventForMessage(conversationId, messageId);
    if (!receiptCycleEnded && ev?.attempt?.receipt?.upload === "pending") return;
    const message = this.message(conversationId, messageId);
    if (!message || message.role !== "buyer") return;
    const abandoned = this.journal.conversation(conversationId).notes[messageId] === REPLY_DEADLINE_REASON || ev?.blocked === REPLY_DEADLINE_REASON || ev?.attempt?.detail === REPLY_DEADLINE_REASON;
    const summary = this.replyTiming.summary(message, abandoned);
    if (summary) this.log(`timing_summary ${JSON.stringify({ message_ref: logRef([this.config.shop_id, conversationId, messageId]), ...(ev ? { event_ref: this.refs.event(ev.event_id) } : {}), ...summary, abandon_reason: abandoned ? REPLY_DEADLINE_REASON : null })}`);
  }

  private async submitNew(conversationId: string, messageId: string) {
    this.inFlight.set(conversationId, (this.inFlight.get(conversationId) ?? 0) + 1);
    try { await this.prepareMessage(conversationId, messageId); }
    finally {
      this.summary(conversationId, messageId);
      const left = (this.inFlight.get(conversationId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(conversationId, left);
      else {
        this.inFlight.delete(conversationId);
        this.warm(conversationId);
      }
    }
  }

  /**
   * 预热：该买家没有进行中的处理时，让页面在后台补齐下一条消息要用的候选（说明书、过期的推荐商品），
   * 把慢的界面操作移出准备阶段。只在自动模式且附加发送能力已确认时进行；适配器负责与发送、准备串行并可被抢占。
   * 预热读到的变化照常使该对话版本递增，此时没有在途决定，不影响已提交的事件。
   */
  private warm(conversationId: string) {
    if (this.stopped || this.updateHold() || this.config.mode !== "auto" || !this.sendItemConfirmed() || !this.adapter.warmConversation) return;
    if (this.journal.conversation(conversationId).takeover || this.platformCheck()) return;
    void this.adapter.warmConversation(conversationId).catch(() => undefined);
  }

  private async prepareMessage(conversationId: string, messageId: string) {
    if (this.expired(conversationId, messageId)) return;
    const measured = <T>(step: string, fn: () => Promise<T>) => this.replyTiming.measure(this.message(conversationId, messageId)!, step, fn);
    const blocked = this.submitBlocker();
    if (blocked) {
      if (this.config.mode === "auto" && this.sessionId && !this.platformCheck() && !this.journal.conversation(conversationId).takeover &&
        (blocked === "backend_unavailable" || blocked === "lease_invalid")) {
        this.pendingPreparation.set(conversationId, { messageId, sessionId: this.sessionId });
      }
      return this.journal.note(conversationId, messageId, blocked);
    }
    const session = this.sessionId as string;
    const generation = this.lease.generation;
    let history;
    const prepStart = Date.now();
    try {
      history = await measured("history", () => withTimeout(this.adapter.fetchHistory(conversationId), this.remaining(conversationId, messageId)));
    } catch {
      if (!this.expired(conversationId, messageId)) this.journal.note(conversationId, messageId, "history_fetch_failed");
      return;
    }
    let added = false;
    for (const hm of history.messages) {
      if (hm.conversation_id !== conversationId || !isIdentifier(hm.platform_message_id) || this.journal.hasMessage(conversationId, hm.platform_message_id)) continue;
      this.journal.addMessage(conversationId, { id: hm.platform_message_id, stable: true, role: hm.role, kind: hm.kind, content: hm.content, created_at: hm.created_at, ...(hm.card ? { card: hm.card } : {}), ...(hm.image_ref ? { image_ref: hm.image_ref } : {}), received_at: this.now(), first_seen_at: this.now() * 1000, live: false, session_id: session });
      this.replyTiming.observe(this.message(conversationId, hm.platform_message_id)!, true);
      this.journal.note(conversationId, hm.platform_message_id, "history_sync");
      added = true;
    }
    if (added) this.journal.bumpRevision(conversationId, "history_merged");
    const historyDone = Date.now();
    if (this.expired(conversationId, messageId)) return;
    // 订单与可发送项共用一个准备截止（默认 2 秒），也不超过 20 秒剩余预算。读不完的内容省略，不当作“没有”。
    const prepDeadline = Date.now() + this.timing.prepBudgetMs;
    const prepLeft = () => Math.max(0, Math.min(prepDeadline - Date.now(), this.remaining(conversationId, messageId)));
    // 收集可发送项时适配器会切到推荐商品页签再切回订单页签并等订单读完；此时单独先读一次订单是重复读取。
    const withOptions = this.config.mode === "auto" && this.sendItemConfirmed() && !!this.adapter.sendOptionsSettled;
    if (!withOptions) await measured("orders", async () => { await this.adapter.ordersSettled?.(conversationId, Math.min(this.timing.ordersWaitMs, prepLeft())); });
    if (this.expired(conversationId, messageId)) return;
    const ordersDone = Date.now();
    if (withOptions) await measured("options", async () => { await this.adapter.sendOptionsSettled!(conversationId, prepLeft()); });
    if (this.expired(conversationId, messageId)) return;
    this.log(`timing conv=${this.refs.conv(conversationId)} step=prepare history_ms=${historyDone - prepStart} orders_ms=${ordersDone - historyDone} options_ms=${Date.now() - ordersDone} budget_ms=${this.timing.prepBudgetMs}${withOptions ? " orders_in_options=true" : ""}`);
    const conv = this.journal.conversation(conversationId);
    const last = turnEnd(conv.messages);
    if (!last || last.id !== messageId) return this.journal.note(conversationId, messageId, "superseded_before_submit");
    if (this.sessionId !== session) return this.journal.note(conversationId, messageId, "session_changed");
    if (conv.messages.length > MAX_CONTEXT_MESSAGES) return this.journal.note(conversationId, messageId, "context_too_large");
    if (conv.messages.some((m) => m.content.length > MAX_CONTENT_CHARS)) return this.journal.note(conversationId, messageId, "content_too_long");
    // 契约要求买家这条在最后、时间不倒退：晚到的平台自动卡片（进店来源等）移到它前面，时间记为它的时间。
    // 这些卡片不带新商品（见 turnEnd），合并时间不影响商品证据的先后。
    const at = conv.messages.indexOf(last);
    const ordered = [...conv.messages.slice(0, at), ...conv.messages.slice(at + 1).map((m) => ({ ...m, created_at: last.created_at })), last];
    const messages: ContextMessage[] = ordered.map((m) => ({ id: m.id, role: m.role, kind: m.kind, content: m.content, created_at: m.created_at, ...(m.card ? { card: m.card } : {}) }));
    if (!this.capabilities.has(CAP_PRODUCT_KNOWLEDGE)) {
      for (const message of messages) if (message.card?.product_key) {
        const { product_key: _key, ...card } = message.card;
        message.card = card;
      }
    }
    // 契约“图片与卡片（1.0 补充）”：历史中的图片/卡片不再单独阻止；只有最新消息无法识别时本地不发送。
    const textOnly = last.kind !== "unsupported";
    const historyComplete = (history.complete || (history.latest_segment !== undefined && this.continuesConfirmed(conv, history.latest_segment))) && conv.messages.every((m) => m.stable);
    if (historyComplete && history.messages.length) {
      const pool = history.complete ? history.messages : history.messages.filter((m) => m.platform_message_id && history.latest_segment?.includes(m.platform_message_id));
      const newest = (pool.length ? pool : history.messages).reduce((a, b) => (b.created_at >= a.created_at ? b : a));
      if (isIdentifier(newest.platform_message_id)) this.journal.markComplete(conversationId, newest.platform_message_id);
    }
    const request: EventRequest = {
      event_id: `ev-${randomUUID()}`,
      instance_id: this.instanceId,
      session_id: session,
      generation,
      conversation_id: conversationId,
      message_id: messageId,
      context_revision: conv.revision,
      received_at: last.received_at,
      context: { history_complete: historyComplete, messages, ...(this.orders.get(conversationId)?.list.length ? { orders: this.orders.get(conversationId)!.list } : {}) },
    };
    // 契约“商品快照（1.2 草案）”：能力确认后才带 goods 与订单明细 items；来源只取本次提交的消息与订单。
    if (this.goodsSnapshotConfirmed()) this.attachGoods(conversationId, request);
    const optionsAt = this.optionsAt.get(conversationId);
    const candidates = this.buildSendOptions(conversationId, conv.revision);
    if (candidates) request.context.send_options = candidates.options;
    // 契约“会话操作（1.3 草案）”：能力确认后必带 conv_state；读不到如实报 marked=null，不捏造 false、不丢弃事件。
    if (this.markConfirmed()) {
      const read = await measured("conv_state", () =>
        withTimeout(this.adapter.readConvState?.(conversationId, prepLeft()) ?? Promise.resolve(null), prepLeft()).catch(() => null),
      );
      if (this.expired(conversationId, messageId)) return;
      const marked = read?.marked ?? null;
      request.context.conv_state = { marked, color: marked === true ? (read?.color ?? null) : null, observed_at: this.now() };
    }
    const images = await measured("images", () => this.latestImages(last));
    if (this.expired(conversationId, messageId)) return;
    if (this.sessionId !== session) return this.journal.note(conversationId, messageId, "session_changed");
    // 契约 A.3：本租约确认能力后，在首次持久化请求体前冻结剩余预算（向下取整，0–20000）；之后重投不再计算。
    let budget: number | undefined;
    if (this.deadlineConfirmed(generation)) {
      budget = Math.min(MAX_REMAINING_BUDGET_MS, Math.floor(this.remaining(conversationId, messageId)));
      // 本地算出 0 说明已过期：不提交，直接记“本条待人工”。
      if (!(budget > 0)) {
        this.noteDeadline(conversationId, messageId);
        this.changed();
        return;
      }
      request.remaining_budget_ms = budget;
    }
    const tail = messages[messages.length - 1];
    if (images.attachments.length) tail.attachments = images.attachments;
    else if (last.image_ref && last.kind === "image") tail.content = IMAGE_MISSING;
    const body = JSON.stringify(request);
    if (images.attachments.length) tail.attachments = images.digests as unknown as Attachment[];
    const hasOrders = !!request.context.orders;
    const hasGoods = !!request.context.goods;
    const hasOptions = !!request.context.send_options;
    delete request.context.orders;
    delete request.context.goods;
    delete request.context.send_options;
    const memoryOnly = images.attachments.length > 0 || hasOrders || hasGoods || hasOptions;
    const stored = memoryOnly ? JSON.stringify(request) : body;
    if (Buffer.byteLength(stored, "utf8") > MAX_BODY_BYTES || Buffer.byteLength(body, "utf8") > MAX_EVENT_BYTES) return this.journal.note(conversationId, messageId, "body_too_large");
    // 准备期间进入了“更新中”：不再提交新事件。
    if (this.updateHold()) return this.journal.note(conversationId, messageId, UPDATE_HOLD_REASON);
    if (memoryOnly) this.fullBodies.set(request.event_id, body);
    if (candidates) {
      this.eventOptions.set(request.event_id, candidates.map);
      this.eventOptionsAt.set(request.event_id, optionsAt);
    }
    if (request.context.conv_state) this.eventConvState.set(request.event_id, request.context.conv_state);
    this.journal.addEvent({
      event_id: request.event_id,
      conversation_id: conversationId,
      message_id: messageId,
      instance_id: this.instanceId,
      session_id: session,
      generation,
      context_revision: conv.revision,
      body: stored,
      ...(images.attachments.length ? { has_images: true } : {}),
      ...(hasOrders ? { has_orders: true } : {}),
      ...(hasGoods ? { has_goods: true } : {}),
      ...(hasOptions ? { has_send_options: true } : {}),
      history_complete: historyComplete,
      text_only: textOnly,
      ...(budget !== undefined ? { budget_ms: budget } : {}),
    });
    this.changed();
    await this.submitAndPoll(this.journal.events.get(request.event_id) as EventRecord);
  }

  /**
   * 页面只加载了最近一段时，若这段里包含本地“已确认完整”的那条消息，则本地记录与这段首尾相接，整体仍完整。
   * 不比较时间（平台时间只到秒，可能并列）；接不上一律按不完整处理。
   */
  private continuesConfirmed(conv: ConversationState, segment: string[]): boolean {
    const mark = conv.complete_through;
    return mark !== null && segment.includes(mark);
  }

  /** 最新消息是图片（或带图卡片）时，经适配器在平台会话中取原图；取不到返回空，由调用方写占位。 */
  private async latestImages(last: StoredMessage): Promise<{ attachments: Attachment[]; digests: { type: "image"; mime: string; size: number; sha256: string }[] }> {
    const none = { attachments: [], digests: [] };
    if (!last.image_ref || !this.adapter.fetchImage) return none;
    const r = await this.adapter.fetchImage(last.image_ref).catch(() => ({ ok: false as const, reason: "image_fetch_failed" }));
    if (!r.ok) {
      this.log(`image not attached reason=${r.reason}`);
      return none;
    }
    if (r.bytes.length > MAX_IMAGE_BYTES) {
      this.log(`image not attached reason=image_too_large size=${r.bytes.length}`);
      return none;
    }
    const sha256 = createHash("sha256").update(r.bytes).digest("hex");
    this.log(`image attached mime=${r.mime} size=${r.bytes.length} sha256=${sha256.slice(0, 12)}`);
    return {
      attachments: [{ type: "image", mime: r.mime, data_url: `data:${r.mime};base64,${r.bytes.toString("base64")}` }],
      digests: [{ type: "image", mime: r.mime, size: r.bytes.length, sha256 }],
    };
  }

  /** 记录一步的耗时与成败；错误只记错误码。 */
  private async timed<T>(eventId: string, step: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const ev = this.journal.events.get(eventId);
      const message = ev && this.message(ev.conversation_id, ev.message_id);
      const r = await (message ? this.replyTiming.measure(message, step, fn) : fn());
      this.log(`timing event_ref=${this.refs.event(eventId)} step=${step} ms=${Date.now() - started} ok=true`);
      return r;
    } catch (err) {
      this.log(`timing event_ref=${this.refs.event(eventId)} step=${step} ms=${Date.now() - started} ok=false error=${errorCode(err)}`);
      throw err;
    }
  }

  // ---------- 提交与轮询 ----------

  private async submitAndPoll(ev: EventRecord) {
    try { await this.submitAndPollInner(ev); }
    finally { this.summary(ev.conversation_id, ev.message_id); }
  }

  private async submitAndPollInner(ev: EventRecord) {
    if (!ev.attempt && this.expired(ev.conversation_id, ev.message_id, ev)) return;
    if (ev.stage !== "submitted") {
      let attempt = 0;
      for (;;) {
        if (this.stopped || this.expired(ev.conversation_id, ev.message_id, ev)) return;
        const body = this.fullBodies.get(ev.event_id) ?? (ev.has_images || ev.has_orders || ev.has_goods || ev.has_send_options ? null : ev.body);
        if (body === null) {
          this.journal.setStage(ev.event_id, "rejected", ev.has_images ? "image_not_retained" : ev.has_orders ? "orders_not_retained" : ev.has_goods ? "goods_not_retained" : "send_options_not_retained");
          this.changed();
          return;
        }
        try {
          const snap = await this.timed(ev.event_id, "submit", () => this.backend.submitEvent(body));
          this.fullBodies.delete(ev.event_id);
          this.journal.setStage(ev.event_id, "submitted");
          this.saveSnapshot(ev, snap);
          break;
        } catch (err) {
          if (!isTransient(err)) {
            this.journal.setStage(ev.event_id, "rejected", errorCode(err));
            this.changed();
            return;
          }
          if (attempt++ >= this.timing.submitRetries) {
            this.journal.setStage(ev.event_id, "submit_failed", errorCode(err));
            this.resume.push(ev);
            this.changed();
            return;
          }
          await sleep(Math.min(this.timing.pollMs * 2 ** attempt, this.timing.pollMaxMs));
        }
      }
      this.changed();
    }
    const message = this.message(ev.conversation_id, ev.message_id);
    if (message) await this.replyTiming.measure(message, "wait_backend", () => this.poll(ev));
    else await this.poll(ev);
    if (ev.snapshot?.state === "ready" && ev.blocked !== REPLY_DEADLINE_REASON) await this.considerSend(ev);
  }

  private async poll(ev: EventRecord) {
    const started = Date.now();
    let delay = this.timing.pollMs;
    const deadline = Date.now() + this.timing.pollGiveUpMs;
    while (ev.snapshot?.state !== "ready") {
      if (this.stopped || (!ev.attempt && this.expired(ev.conversation_id, ev.message_id, ev))) return;
      if (Date.now() > deadline) {
        this.log(`timing event_ref=${this.refs.event(ev.event_id)} step=decide ms=${Date.now() - started} ok=false error=poll_gave_up`);
        return;
      }
      await sleep(ev.attempt ? delay : Math.min(delay, this.remaining(ev.conversation_id, ev.message_id)));
      if (!ev.attempt && this.expired(ev.conversation_id, ev.message_id, ev)) return;
      try {
        const snap = await this.backend.getEvent(ev.event_id);
        this.saveSnapshot(ev, snap);
        delay = this.timing.pollMs;
      } catch (err) {
        if (err instanceof BackendError && err.status !== 409 && !isTransient(err)) {
          this.journal.setStage(ev.event_id, ev.stage, err.code);
          return;
        }
        delay = Math.min(delay * 2, this.timing.pollMaxMs);
      }
    }
    if (Date.now() - started > 0) this.log(`timing event_ref=${this.refs.event(ev.event_id)} step=decide ms=${Date.now() - started} ok=true`);
    this.changed();
  }

  /**
   * 保存后台快照。契约 A.4：截止终态（含取消成功）显示“本条待人工”，不加买家接管锁；
   * 后台计时只记日志（与前台等待后台的耗时分列，不参与发送授权）。
   */
  private saveSnapshot(ev: EventRecord, snap: EventSnapshot) {
    this.journal.setSnapshot(ev.event_id, snap);
    if (snap.state === "ready" && snap.timing && !this.timingLogged.has(ev.event_id)) {
      this.timingLogged.add(ev.event_id);
      this.log(`backend_timing event_ref=${this.refs.event(ev.event_id)} ${JSON.stringify(snap.timing)}`);
    }
    if (isDeadlineTerminal(snap) && !ev.attempt) {
      this.journal.setBlocked(ev.event_id, REPLY_DEADLINE_REASON);
      this.noteDeadline(ev.conversation_id, ev.message_id);
    }
  }

  // ---------- 取消未领取事件（契约 A.5） ----------

  /**
   * 本地截止到期后，尽力让后台放弃本客户端自己的未领取事件。只在自动模式、能力已确认、仍持有原租约、
   * 本地与后台都没有发送尝试时发起；发出前落盘意图记录。后台预算到期不依赖取消成功，失败也不影响本地拒发。
   */
  private maybeCancel(ev: EventRecord) {
    if (this.stopped || this.config.mode !== "auto" || ev.cancel || ev.attempt || ev.stage !== "submitted" || this.cancelling.has(ev.event_id)) return;
    const s = ev.snapshot;
    if (!s || s.delivery.status !== "unclaimed" || s.delivery.attempt_id !== null) return;
    if (s.state === "ready" && s.decision?.action !== "reply" && s.decision?.action !== "send_item" && s.decision?.action !== "mark" && s.decision?.action !== "transfer") return;
    if (ev.instance_id !== this.instanceId || ev.session_id !== this.sessionId || !this.deadlineConfirmed(ev.generation) || !this.leaseValid(ev.generation)) return;
    this.cancelling.add(ev.event_id);
    this.journal.setCancel(ev.event_id, { phase: "intent", detail: null, at: this.now() });
    this.track(this.cancel(ev).finally(() => this.cancelling.delete(ev.event_id)));
  }

  private async cancel(ev: EventRecord) {
    // 重试只用原事件的归属四字段，不改写身份。
    const owner = { instance_id: ev.instance_id, session_id: ev.session_id, generation: ev.generation };
    for (let attempt = 0; ; attempt++) {
      // 停止时保留意图记录，重启后先查询快照。
      if (this.stopped) return;
      try {
        const snap = await this.timed(ev.event_id, "cancel", () => this.backend.cancel(ev.event_id, owner));
        this.saveSnapshot(ev, snap);
        const done = isDeadlineTerminal(snap);
        this.journal.setCancel(ev.event_id, { phase: done ? "done" : "rejected", detail: done ? null : "unexpected_snapshot", at: this.now() });
        break;
      } catch (err) {
        if (!isTransient(err)) {
          this.journal.setCancel(ev.event_id, { phase: "rejected", detail: errorCode(err), at: this.now() });
          break;
        }
        if (attempt >= this.timing.submitRetries) {
          this.journal.setCancel(ev.event_id, { phase: "failed", detail: errorCode(err), at: this.now() });
          break;
        }
        await sleep(Math.min(this.timing.pollMs * 2 ** (attempt + 1), this.timing.pollMaxMs));
      }
    }
    this.changed();
  }

  /** 重启后只有取消意图的事件：只查询快照记录结论，不以旧意图发起取消（契约 A.5 重启规则）。 */
  private async checkCancel(ev: EventRecord) {
    try {
      const snap = await this.backend.getEvent(ev.event_id);
      this.saveSnapshot(ev, snap);
      this.journal.setCancel(ev.event_id, { phase: "checked", detail: isDeadlineTerminal(snap) ? "deadline_terminal" : `not_terminal:${snap.state}:${snap.delivery.status}`, at: this.now() });
    } catch (err) {
      if (isTransient(err)) this.cancelChecks.push(ev);
      else this.journal.setCancel(ev.event_id, { phase: "checked", detail: errorCode(err), at: this.now() });
    }
    this.changed();
  }

  // ---------- 发送 ----------

  /** 发送前核验；返回阻止原因，null 表示可以继续。 */
  sendBlocker(ev: EventRecord, afterClaim = false): string | null {
    if (this.stopped) return "runtime_stopped";
    if (this.updateHold()) return UPDATE_HOLD_REASON;
    if (this.config.mode === "observe") return "mode_observe";
    if (this.config.mode === "manual") return "mode_manual";
    const conv = this.journal.conversation(ev.conversation_id);
    if (conv.takeover) return "manual_takeover";
    if (this.backendState.state !== "ok") return "backend_unavailable";
    const platform = this.platformCheck();
    if (platform) return platform;
    if (ev.session_id !== this.sessionId) return "session_changed";
    if (ev.instance_id !== this.instanceId) return "instance_changed";
    if (!this.leaseValid(ev.generation)) return "lease_invalid";
    if (conv.revision !== ev.context_revision) return "superseded";
    if (turnEnd(conv.messages)?.id !== ev.message_id) return "superseded";
    if (!ev.text_only) return "unsupported_content";
    const decision = ev.snapshot?.decision;
    if (!decision || ev.snapshot?.state !== "ready") return "not_ready";
    if (decision.action === "send_item") {
      const blocked = this.itemBlocker(ev);
      if (blocked) return blocked;
    } else if (decision.action === "mark") {
      const blocked = this.markBlocker(ev);
      if (blocked) return blocked;
    } else if (decision.action === "transfer") {
      const blocked = this.transferBlocker(ev);
      if (blocked) return blocked;
    } else if (decision.action !== "reply" || !decision.text.trim()) return "not_reply";
    if (decision.expires_at - this.now() < this.timing.decisionSafety) return "decision_expired";
    if (!afterClaim && ev.attempt) return "already_attempted";
    if (this.remaining(ev.conversation_id, ev.message_id) <= 0) return REPLY_DEADLINE_REASON;
    return null;
  }

  /** send_item 额外核验：本租约仍确认能力，option_id 属于本事件候选且类型一致，对象仍在当前页面候选中。 */
  private itemBlocker(ev: EventRecord): string | null {
    const item = ev.snapshot?.decision?.item;
    if (!item) return "not_reply";
    if (!this.sendItemConfirmed()) return "capability_not_confirmed";
    const option = this.eventOptions.get(ev.event_id)?.get(item.option_id);
    if (!option) return "option_unknown";
    if (option.type !== item.type) return "option_type_mismatch";
    if (this.optionsAt.get(ev.conversation_id) !== this.eventOptionsAt.get(ev.event_id)) return "send_options_changed";
    const current = this.sendOptions.get(ev.conversation_id)?.list ?? [];
    if (!current.some((o) => o.type === option.type && o.key === option.key)) return "option_gone";
    return null;
  }

  /**
   * 契约“标星执行与成功判据·适用范围”：颜色合法；本客户端声明且本租约确认能力；本事件提交的 conv_state 为未收藏
   * （只在内存；已收藏、marked=null 或重启后都不执行）。不满足就不 claim，只在本地记为阻止。
   */
  private markBlocker(ev: EventRecord): string | null {
    const color = ev.snapshot?.decision?.mark?.color;
    if (!color || !MARK_COLORS.includes(color)) return "mark_invalid";
    if (!this.markExecutable()) return "capability_not_confirmed";
    const state = this.eventConvState.get(ev.event_id);
    if (!state) return "conv_state_not_retained";
    if (state.marked !== false) return "conv_state_not_unmarked";
    return null;
  }

  private transferBlocker(ev: EventRecord): string | null {
    const d = ev.snapshot?.decision?.transfer;
    if (!d) return "transfer_invalid";
    if (!this.transferExecutable()) return "capability_not_confirmed";
    return null;
  }

  /** 界面展示用：send_item 决定对应的候选名称（只在内存，重启后只显示类型）。 */
  itemLabel(ev: EventRecord): string | null {
    const item = ev.snapshot?.decision?.action === "send_item" ? ev.snapshot.decision.item : undefined;
    if (!item) return null;
    const o = this.eventOptions.get(ev.event_id)?.get(item.option_id);
    const kind = item.type === "instruction" ? "说明书" : item.type === "goods_card" ? "商品卡片" : "视频";
    if (!o) return kind;
    return `${kind}：${o.type === "goods_card" ? o.goods_title : o.name}`;
  }

  private async considerSend(ev: EventRecord) {
    const previous = this.deliveryTail;
    let release!: () => void;
    this.deliveryTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { await this.considerSendNow(ev); }
    finally { release(); }
  }

  /** 同一店铺只有一个平台页面；排队结束后才重新核验并申请许可。 */
  private async considerSendNow(ev: EventRecord) {
    const action = ev.snapshot?.decision?.action;
    if (action !== "reply" && action !== "send_item" && action !== "mark" && action !== "transfer") return;
    const blocked = this.sendingConversations.has(ev.conversation_id) ? "conversation_busy" : this.sendBlocker(ev);
    if (blocked) {
      this.journal.setBlocked(ev.event_id, blocked);
      if (blocked === "backend_unavailable" && !ev.attempt) this.pendingReady.set(ev.event_id, ev);
      if (blocked === REPLY_DEADLINE_REASON) {
        this.noteDeadline(ev.conversation_id, ev.message_id);
        this.maybeCancel(ev);
      }
      this.changed();
      return;
    }
    this.sendingConversations.add(ev.conversation_id);
    try {
      await this.deliver(ev);
    } finally {
      this.sendingConversations.delete(ev.conversation_id);
      this.changed();
    }
  }

  private async deliver(ev: EventRecord) {
    const attemptId = `att-${randomUUID()}`;
    // 申请许可前先记录尝试，便于崩溃后判断是否可能已调用平台。
    this.journal.setAttempt(ev.event_id, attemptId, "claim_requested");
    if (this.expired(ev.conversation_id, ev.message_id, ev)) {
      this.journal.setAttempt(ev.event_id, attemptId, "claim_failed", REPLY_DEADLINE_REASON);
      return;
    }
    const owner = { instance_id: ev.instance_id, session_id: ev.session_id, generation: ev.generation };
    let snap: EventSnapshot;
    try {
      snap = await this.timed(ev.event_id, "claim", () => this.backend.claim(ev.event_id, owner, attemptId));
    } catch (err) {
      if (err instanceof BackendError) {
        this.journal.setAttempt(ev.event_id, attemptId, "claim_failed", err.code);
        this.journal.setBlocked(ev.event_id, `claim_rejected:${err.code}`);
        return;
      }
      // 许可响应丢失：先读取后台记录，确认许可属于本次尝试且仍有效才继续首次发送。
      try {
        snap = await this.backend.getEvent(ev.event_id);
        this.saveSnapshot(ev, snap);
      } catch {
        this.finish(ev, attemptId, "claim_failed", "claim_response_lost", "not_sent");
        return;
      }
    }
    this.saveSnapshot(ev, snap);
    const d = snap.delivery;
    if (d.attempt_id !== attemptId || d.status !== "claimed") {
      this.journal.setAttempt(ev.event_id, attemptId, "claim_failed", "claim_not_granted");
      return;
    }
    this.journal.setAttempt(ev.event_id, attemptId, "claimed");
    // 平台发送与回执上传都要在许可有效期内完成；附加发送的确认截止为许可到期前 2 秒。
    const isItem = snap.decision?.action === "send_item";
    // 标星的确认截止同附加发送：许可到期前 2 秒（契约 1.3“前台执行”第 5 条）。
    const isMark = snap.decision?.action === "mark";
    const isTransfer = snap.decision?.action === "transfer";
    const sendWindow = (d.claim_expires_at ?? 0) - this.now() - (isItem || isMark || isTransfer ? this.timing.itemReceiptReserve : this.timing.receiptReserve);
    const blocked = this.sendBlocker(ev, true) ?? (sendWindow < Math.max(this.timing.minSendWindow, this.timing.claimSafety) ? "claim_expiring" : null);
    if (blocked) {
      this.journal.setBlocked(ev.event_id, blocked);
      this.finish(ev, attemptId, "aborted_before_send", blocked, "not_sent");
      return;
    }
    const text = snap.decision?.text ?? "";
    // 平台请求开始前落盘；此后任何中断都只能是 unknown。
    this.journal.setAttempt(ev.event_id, attemptId, "sending");
    if (isMark) return this.deliverMark(ev, attemptId, d.claim_expires_at ?? 0, sendWindow);
    if (isTransfer) return this.deliverTransfer(ev, attemptId, d.claim_expires_at ?? 0, sendWindow);
    const sendStartedMs = Date.now();
    const knownAgentIds = new Set(this.journal.conversation(ev.conversation_id).messages.filter((m) => m.role === "agent").map((m) => m.id));
    this.changed();
    let result: SendResult;
    try {
      // 交给平台适配器的截止时刻按本机时钟计算。
      const deadline = Date.now() / 1000 + Math.min(this.timing.sendTimeoutMs / 1000, sendWindow);
      const call = isItem ? this.callSendItem(ev, attemptId, deadline) : this.adapter.send({ conversation_id: ev.conversation_id, text, attempt_id: attemptId, deadline, recheck: () => this.sendBlocker(ev, true) });
      // 附加发送由适配器自己在截止时放弃点击（not_sent）；外层多等 1 秒，避免把“未点击”误判为超时 unknown。
      const limitMs = Math.min(this.timing.sendTimeoutMs, sendWindow * 1000) + (isItem ? 1000 : 0);
      result = await this.timed(ev.event_id, isItem ? "platform_send_item" : "platform_send", () => withTimeout(call, limitMs));
    } catch (err) {
      result = { status: "unknown", reason: (err as Error)?.message === "send_timeout" ? "send_timeout" : "send_exception" };
    }
    if (result.status === "confirmed" && !isIdentifier(result.platform_message_id)) result = { status: "unknown", reason: "platform_message_id_invalid" };
    if (isItem && result.status === "confirmed" && (d.claim_expires_at ?? 0) - this.now() < this.timing.itemReceiptReserve) result = { status: "unknown", reason: "confirmed_after_deadline" };
    if (result.status === "confirmed") this.finish(ev, attemptId, "sent", null, "sent", result.platform_message_id);
    else this.finish(ev, attemptId, result.status, result.reason, result.status);
    // 核对只认发送调用返回之后刷新的聊天记录：返回时刻一定晚于真正点击，之前（含打开对话时）的加载不能证明“发送后没有”。
    if (result.status === "unknown") this.onUnknown(ev, attemptId, result.reason, isItem, sendStartedMs, Date.now(), knownAgentIds);
  }

  // ---------- unknown 自动核对（只提示人工，不重发） ----------

  /**
   * 标星（契约 1.3）：点击、请求核对与成功判据由适配器执行；运行时只给出确认截止与点击前再核验。
   * 回执为 mark 单步骤（未开始点击的 not_sent 不列步骤、只带原因），不带平台消息编号；
   * unknown 不核对聊天记录、不重试、不补做。
   */
  private async deliverMark(ev: EventRecord, attemptId: string, claimExpiresAt: number, sendWindow: number) {
    const color = ev.snapshot?.decision?.mark?.color;
    let result: MarkResult;
    try {
      const deadline = Date.now() / 1000 + Math.min(this.timing.sendTimeoutMs / 1000, sendWindow);
      const recheck = () => this.sendBlocker(ev, true) ?? (Date.now() / 1000 >= deadline ? "claim_expiring" : null);
      const call: Promise<MarkResult> =
        this.adapter.markConversation && color ? this.adapter.markConversation({ conversation_id: ev.conversation_id, color, attempt_id: attemptId, deadline, recheck }) : Promise.resolve({ status: "not_sent", reason: "capability_not_confirmed" });
      // 适配器在截止时自己放弃点击（not_sent）；外层多等 1 秒，避免把“未点击”误判为超时 unknown。
      const limitMs = Math.min(this.timing.sendTimeoutMs, sendWindow * 1000) + 1000;
      result = await this.timed(ev.event_id, "platform_mark", () => withTimeout(call, limitMs));
    } catch (err) {
      result = { status: "unknown", reason: (err as Error)?.message === "send_timeout" ? "send_timeout" : "send_exception" };
    }
    if (result.status === "confirmed" && claimExpiresAt - this.now() < this.timing.itemReceiptReserve) result = { status: "unknown", reason: "confirmed_after_deadline", page_observed: result.page_observed };
    // 确认后再核对平台登录店铺与会话：归属已变化时成功不能归于本次（契约“来源绑定”页面或登录变化）。
    if (result.status === "confirmed" && (this.platformCheck() || ev.session_id !== this.sessionId)) result = { status: "unknown", reason: "platform_changed_during_mark", page_observed: result.page_observed };
    const observed = result.status === "not_sent" ? undefined : result.page_observed;
    if (result.status === "confirmed") this.finish(ev, attemptId, "sent", null, "sent", null, observed);
    else this.finish(ev, attemptId, result.status, result.reason, result.status, null, observed);
    if (result.status === "unknown") this.countUnknown("mark", result.reason);
  }

  private async deliverTransfer(ev: EventRecord, attemptId: string, claimExpiresAt: number, sendWindow: number) {
    const target = ev.snapshot?.decision?.transfer;
    let result: TransferResult;
    const deadline = Date.now() / 1000 + Math.min(this.timing.sendTimeoutMs / 1000, sendWindow);
    try {
      const recheck = () => this.sendBlocker(ev, true) ?? (Date.now() / 1000 >= deadline ? "claim_expiring" : null);
      const call = this.adapter.transferConversation && target ? this.adapter.transferConversation({
        conversation_id: ev.conversation_id, account: target.account, allow_unmark: target.unmark_policy.allow,
        attempt_id: attemptId, deadline, recheck,
        before_unmark: () => {
          if (!target.unmark_policy.allow || recheck()) throw Error("unmark_not_authorized");
          this.journal.setAttempt(ev.event_id, attemptId, "sending", "unmark_and_transfer");
        },
      }) : Promise.resolve({ status: "not_sent" as const, reason: "capability_not_confirmed" });
      result = await this.timed(ev.event_id, "platform_transfer", () => withTimeout(call, Math.min(this.timing.sendTimeoutMs, sendWindow * 1000) + 1000));
    } catch {
      result = { status: "unknown", reason: "transfer_exception_or_timeout" };
    }
    if (ev.attempt?.detail === "unmark_and_transfer" && !(result.status === "confirmed" && result.unmarked === true)) {
      result = { status: "unknown", reason: "transfer_binding_unproven", page_observed: result.status === "not_sent" ? "unknown" : result.page_observed };
    }
    if (result.status === "confirmed" && (claimExpiresAt - this.now() < this.timing.itemReceiptReserve || this.platformCheck() || ev.session_id !== this.sessionId)) {
      result = { status: "unknown", reason: "transfer_confirmation_invalid" };
    }
    const observed = result.status === "not_sent" ? undefined : result.page_observed;
    if (result.status === "confirmed") this.finish(ev, attemptId, "sent", null, "sent", null, observed);
    else this.finish(ev, attemptId, result.status, result.reason, result.status, null, observed);
    if (result.status === "unknown") this.countUnknown("transfer", result.reason);
  }

  private countUnknown(kind: string, reason: string) {
    const key = `${kind}:${reason}`;
    this.unknownCounts.set(key, (this.unknownCounts.get(key) ?? 0) + 1);
    const total = [...this.unknownCounts.values()].reduce((a, b) => a + b, 0);
    this.log(`unknown_stats ${JSON.stringify({ total, by_reason: Object.fromEntries(this.unknownCounts) })}`);
  }

  private onUnknown(ev: EventRecord, attemptId: string, reason: string, isItem: boolean, startedMs: number, returnedMs: number, knownAgentIds: Set<string>) {
    this.countUnknown(isItem ? "item" : "text", reason);
    const item = isItem ? ev.snapshot?.decision?.item : undefined;
    const option = item ? this.eventOptions.get(ev.event_id)?.get(item.option_id) : undefined;
    const target = isItem ? (option ? { kind: "item" as const, option } : null) : { kind: "text" as const, text: ev.snapshot?.decision?.text ?? "" };
    this.scheduleCheck({ ev, attemptId, startedMs, returnedMs, known: knownAgentIds, target }, 0);
  }

  private scheduleCheck(c: UnknownCheckJob, step: number) {
    const delays = this.timing.unknownCheckDelaysMs;
    if (this.stopped || step >= delays.length) return;
    const timer = setTimeout(() => {
      this.checkTimers.delete(timer);
      void this.checkUnknown(c, step).catch(() => undefined);
    }, Math.max(0, c.startedMs + delays[step] - Date.now()));
    this.checkTimers.add(timer);
  }

  private async checkUnknown(c: UnknownCheckJob, step: number) {
    const { ev, attemptId, startedMs, returnedMs, known, target } = c;
    if (this.stopped || ev.attempt?.attempt_id !== attemptId || ev.attempt.phase !== "unknown" || ev.check) return;
    const last = step + 1 >= this.timing.unknownCheckDelaysMs.length;
    const settle = (result: UnknownCheck["result"], detail: string) => {
      this.journal.setCheck(ev.event_id, { attempt_id: attemptId, result, detail, at: this.now() });
      this.changed();
    };
    const retry = (detail: string) => (last ? settle("unavailable", detail) : this.scheduleCheck(c, step + 1));
    if (!target) return settle("unavailable", "option_not_retained");
    if (!this.adapter.historyLoadedAt) return settle("unavailable", "history_time_unavailable");
    // 与发送返回同一毫秒的加载分不清先后，按未刷新处理。
    if (this.adapter.historyLoadedAt(ev.conversation_id) <= returnedMs) return retry("history_not_refreshed");
    let history: HistoryResult;
    try {
      history = await withTimeout(this.adapter.fetchHistory(ev.conversation_id), 3000);
    } catch {
      return retry("history_read_failed");
    }
    // 只看发送开始前本地没见过的客服消息；平台时间允许 60 秒误差。
    const fresh = history.messages.filter((m) => m.conversation_id === ev.conversation_id && m.role === "agent" && !(m.platform_message_id && known.has(m.platform_message_id)) && m.created_at * 1000 >= startedMs - 60_000);
    const same = fresh.filter((m) => matchesTarget(m, target));
    if (same.length) return settle("seen", `matches=${same.length}`);
    // 新出现的客服消息有解析不了的（视频、说明书等只记为“非文字消息”），比对不上不能当作没发出。
    const unparsed = fresh.filter((m) => m.kind === "unsupported").length;
    if (unparsed) return last ? settle("unavailable", `unparsed_agent_messages=${unparsed}`) : this.scheduleCheck(c, step + 1);
    // “没看到”只在最后一次核对时下结论，前面的核对再等一次刷新。
    if (!last) return this.scheduleCheck(c, step + 1);
    // 负向结论必须有单次加载的覆盖证据：发送返回后加载、本页无丢弃、含触发本次回复的买家消息，
    // 且本页最新消息晚于发送开始 UNKNOWN_COVER_MARGIN_S 秒——平台一页是连续的，因此这一页覆盖了发送前后。
    // 加载时间、累计的 complete 标记或最新段都不足以证明；证据不足只提示人工核查，不引导补发。
    const proof = (this.adapter.historyLoads?.(ev.conversation_id) ?? []).some(
      (l) => l.at > returnedMs && l.dropped === 0 && l.ids.includes(ev.message_id) && l.newest >= startedMs / 1000 + UNKNOWN_COVER_MARGIN_S,
    );
    if (!proof) return settle("unavailable", "coverage_unproven");
    settle("not_seen", `new_agent_messages=${fresh.length}`);
  }

  /** 点击前的再核验由适配器在真正点击那一刻调用（契约第 3 步）。 */
  private callSendItem(ev: EventRecord, attemptId: string, deadline: number): Promise<SendResult> {
    const item = ev.snapshot?.decision?.item;
    const option = item ? this.eventOptions.get(ev.event_id)?.get(item.option_id) : undefined;
    if (!this.adapter.sendItem || !option) return Promise.resolve({ status: "not_sent", reason: "option_unknown" });
    const recheck = () => this.sendBlocker(ev, true) ?? (Date.now() / 1000 >= deadline ? "claim_expiring" : null);
    return this.adapter.sendItem({ conversation_id: ev.conversation_id, option, attempt_id: attemptId, deadline, recheck });
  }

  /** 结果与待上传回执同一条记录落盘，随后立即上传。 */
  private finish(ev: EventRecord, attemptId: string, phase: AttemptPhase, detail: string | null, status: ReceiptStatus, platformMessageId: string | null = null, observed?: PageObserved) {
    this.journal.finishAttempt(ev.event_id, attemptId, phase, detail, platformMessageId, pendingReceipt(status, platformMessageId, receiptExtra(ev, status, detail, observed)));
    this.track(this.uploadReceipt(ev));
  }

  /**
   * 回执上传失败只重传回执，不会重新发送买家消息。
   * 暂时失败按 receiptRetryMs 快速重试（许可只有 10 秒）；之后仍未成功则留待定时补报。
   */
  private async uploadReceipt(ev: EventRecord) {
    if (this.uploading.has(ev.event_id)) return;
    this.uploading.add(ev.event_id);
    try {
      for (let i = 0; ; i++) {
        const a = ev.attempt;
        const r = a?.receipt;
        if (!a || !r || r.upload !== "pending" || this.stopped) return;
        try {
          const snap = await this.timed(ev.event_id, "receipt", () => this.backend.receipt(ev.event_id, a.attempt_id, r.status, r.platform_message_id ?? undefined, r.extra));
          this.saveSnapshot(ev, snap);
          this.journal.setReceipt(ev.event_id, a.attempt_id, { ...r, upload: "uploaded", error: null });
          return;
        } catch (err) {
          if (!isTransient(err)) {
            this.journal.setReceipt(ev.event_id, a.attempt_id, { ...r, upload: "rejected", error: errorCode(err) });
            return;
          }
          if (r.error !== errorCode(err)) this.journal.setReceipt(ev.event_id, a.attempt_id, { ...r, error: errorCode(err) });
          if (i >= this.timing.receiptRetryMs.length) return;
          await sleep(this.timing.receiptRetryMs[i]);
        }
      }
    } finally {
      this.uploading.delete(ev.event_id);
      this.summary(ev.conversation_id, ev.message_id, true);
      this.changed();
    }
  }

  private flushReceipts() {
    if (this.stopped) return;
    for (const ev of this.journal.events.values()) if (ev.attempt?.receipt?.upload === "pending") this.track(this.uploadReceipt(ev));
  }

  // ---------- 用户操作 ----------

  /** 切换模式。转为非自动时，所有对话的旧上下文版本失效。 */
  setMode(mode: ShopMode) {
    if (this.config.mode === mode) return;
    this.pendingPreparation.clear();
    this.pendingReady.clear();
    this.config.mode = mode;
    if (mode !== "auto") for (const conv of this.journal.conversations.values()) if (conv.revision > 0) this.journal.bumpRevision(conv.conversation_id, `mode:${mode}`);
    this.changed();
  }

  setTakeover(conversationId: string, on: boolean) {
    if (!this.journal.conversations.has(conversationId)) return;
    if (this.journal.conversation(conversationId).takeover === on) return;
    if (on) {
      this.pendingPreparation.delete(conversationId);
      for (const [eventId, ev] of this.pendingReady) if (ev.conversation_id === conversationId) this.pendingReady.delete(eventId);
    }
    this.journal.setTakeover(conversationId, on);
    this.journal.bumpRevision(conversationId, on ? "manual_takeover" : "manual_release");
    this.changed();
  }

  /** 可以安装更新：没有进行中的发送 / 领取 / 标星，所有尝试都已有结果，且没有未上传完的回执。 */
  idleForUpdate(): boolean {
    if (this.sendingConversations.size) return false;
    for (const ev of this.journal.events.values()) {
      const a = ev.attempt;
      if (!a) continue;
      if (a.phase === "claim_requested" || a.phase === "claimed" || a.phase === "sending") return false;
      if (a.receipt?.upload === "pending") return false;
    }
    return true;
  }

  /** 定时器触发前立即执行一次心跳/补报（测试与界面“重新连接”使用）。 */
  async refresh() {
    await this.tick();
  }
}

/** 平台在买家进店时自动推送的来源卡片/系统提示卡片：不是买家所发，不算新的一轮。 */
function platformCard(m: StoredMessage): boolean {
  return m.role === "system" && m.kind === "card" && (m.card?.type === "source" || m.card?.type === "system");
}

/** 对话当前这一轮的最后一条：跳过排在末尾的平台自动卡片（它们常比买家消息晚一两秒到）。
 *  末尾卡片带来不同的商品时不跳过：商品上下文已变，这一轮不再以那条买家消息为准。 */
export function turnEnd(messages: readonly StoredMessage[]): StoredMessage | undefined {
  let i = messages.length - 1;
  while (i > 0 && platformCard(messages[i])) i -= 1;
  const known = messages.slice(0, i + 1).findLast((m) => m.card?.product_key)?.card?.product_key;
  if (messages.slice(i + 1).some((m) => m.card?.product_key && m.card.product_key !== known)) return messages[messages.length - 1];
  return messages[i];
}

function pendingReceipt(status: ReceiptStatus, platformMessageId: string | null = null, extra?: ReceiptExtra): ReceiptRecord {
  return { status, platform_message_id: platformMessageId, upload: "pending", error: null, ...(extra ? { extra } : {}) };
}

/**
 * 契约 1.3 mark 回执：已开始点击（sent / unknown）列出唯一步骤 mark（带决定颜色）；
 * 确定未点击（not_sent）不列步骤，只带归类后的原因。其他动作不带这些字段。
 */
export function receiptExtra(ev: EventRecord, status: ReceiptStatus, detail: string | null, observed?: PageObserved): ReceiptExtra | undefined {
  const d = ev.snapshot?.decision;
  if (d?.action === "transfer" && d.transfer) {
    if (ev.attempt?.detail === "unmark_and_transfer") return {
      steps: [{ step: "transfer", status: "not_sent", reason: "blocked_by_mark" },
        { step: "unmark_and_transfer", status: status === "sent" ? "sent" : "unknown", unmarked: status === "sent" ? true : null }],
      ...(observed ? { page_observed: observed } : {}),
    };
    if (status === "not_sent") return { reason: convActionReason(detail) };
    return { steps: [{ step: "transfer", status }], ...(observed ? { page_observed: observed } : {}) };
  }
  if (d?.action !== "mark" || !d.mark) return undefined;
  if (status === "not_sent") return { reason: convActionReason(detail) };
  return { steps: [{ step: "mark", status, color: d.mark.color }], ...(observed ? { page_observed: observed } : {}) };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("send_timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function errorCode(err: unknown): string {
  if (err instanceof BackendError) return err.code;
  if (err instanceof TransportError) return err.code;
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") return (err as { code: string }).code;
  return "internal_error";
}
