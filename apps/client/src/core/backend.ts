import {
  EventSnapshot,
  Lease,
  MAX_BODY_BYTES,
  Me,
  ReceiptExtra,
  ReceiptStatus,
  normalizeBackendUrl,
  parseHealth,
  parseLease,
  parseMe,
  parseSnapshot,
} from "./protocol.js";
import { isHandoffTicket } from "./adminHandoff.js";
import { parseRegistration } from "./shopPairing.js";

/** 后台返回的明确错误（有 HTTP 状态与错误码）。 */
export class BackendError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`${status} ${code}`);
  }
}

/** 网络失败、超时或响应不可解析：请求结果不确定。 */
export class TransportError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export type FetchLike = typeof fetch;

export class BackendClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly token: string, private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 8000) {
    this.base = normalizeBackendUrl(baseUrl);
  }

  private async request(method: string, path: string, body?: string, auth = true, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new BackendError(413, "body_too_large_local");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(this.base + path, {
        method,
        headers,
        body,
        // 口令不能随重定向转发到其他地址。
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TransportError((err as Error)?.name === "TimeoutError" ? "timeout" : "network_error");
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw response.ok ? new TransportError("response_unreadable") : new BackendError(response.status, "http_" + response.status);
    }
    if (!response.ok) {
      const code = (parsed as { error?: { code?: unknown } })?.error?.code;
      throw new BackendError(response.status, typeof code === "string" ? code : "http_" + response.status);
    }
    return parsed;
  }

  async health() {
    return parseHealth(await this.request("GET", "/health", undefined, false));
  }

  async me(): Promise<Me> {
    return parseMe(await this.request("GET", "/api/v1/me"));
  }

  /** #63/#67：用后台快捷登录授权码换一次性后台登录票据（后台只接受本机请求）。票据不写日志。 */
  async adminHandoff(): Promise<{ ticket: string; expires_at: number }> {
    const r = (await this.request("POST", "/api/v1/admin/handoff", "{}")) as { ticket?: unknown; expires_at?: unknown } | null;
    // 已过期的票据（按本机时间）也按响应不合格处理，不拿去打开。
    if (!r || typeof r !== "object" || !isHandoffTicket(r.ticket) || typeof r.expires_at !== "number" || !Number.isFinite(r.expires_at) || r.expires_at <= Date.now() / 1000) throw new TransportError("handoff_response_invalid");
    return { ticket: r.ticket, expires_at: r.expires_at };
  }

  /**
   * 本机店铺自动登记（#75）：本客户端的 token 必须是本机授权码。请求体恰为四个字段；口令只在请求体里，不写日志。
   * 响应不合格按结果不确定处理（TransportError），调用方不重新生成凭据。
   */
  async registerShop(body: { shop_id: string; name: string; client_id: string; client_token: string }): Promise<{ created: boolean; name: string }> {
    const payload = JSON.stringify({ shop_id: body.shop_id, name: body.name, client_id: body.client_id, client_token: body.client_token });
    const r = parseRegistration(await this.request("POST", "/api/v1/admin/handoff/shops", payload), body);
    if (!r) throw new TransportError("registration_response_invalid");
    return r;
  }

  async heartbeat(instance_id: string, session_id: string, capabilities: string[] = []): Promise<Lease> {
    const body = capabilities.length ? { instance_id, session_id, capabilities } : { instance_id, session_id };
    return parseLease(await this.request("POST", "/api/v1/heartbeat", JSON.stringify(body)));
  }

  async productBatch(requestId: string, body: unknown): Promise<{ status: string }> {
    const r = await this.request("POST", `/api/v1/product-learning/${encodeURIComponent(requestId)}`, JSON.stringify(body), true, 90000) as { status?: unknown };
    if (!r || typeof r.status !== "string") throw new TransportError("product_response_invalid");
    return { status: r.status };
  }

  /** body 必须是本地已持久化的原始请求体；重投时逐字节相同。 */
  async submitEvent(body: string): Promise<EventSnapshot> {
    return parseSnapshot(await this.request("POST", "/api/v1/events", body));
  }

  async getEvent(eventId: string): Promise<EventSnapshot> {
    return parseSnapshot(await this.request("GET", `/api/v1/events/${encodeURIComponent(eventId)}`));
  }

  async claim(eventId: string, owner: { instance_id: string; session_id: string; generation: number }, attempt_id: string): Promise<EventSnapshot> {
    const body = JSON.stringify({ ...owner, attempt_id });
    return parseSnapshot(await this.request("POST", `/api/v1/events/${encodeURIComponent(eventId)}/claim`, body));
  }

  async timeoutTransfer(eventId: string, owner: { instance_id: string; session_id: string; generation: number }, remaining_budget_ms: number, attempt_id?: string): Promise<EventSnapshot> {
    const body = JSON.stringify({ ...owner, remaining_budget_ms, ...(attempt_id ? { attempt_id } : {}) });
    return parseSnapshot(await this.request("POST", `/api/v1/events/${encodeURIComponent(eventId)}/timeout_transfer`, body));
  }

  /** 契约 A.5：只放弃自己的未领取事件；重试必须原样使用同一四字段。 */
  async cancel(eventId: string, owner: { instance_id: string; session_id: string; generation: number }): Promise<EventSnapshot> {
    const body = JSON.stringify({ instance_id: owner.instance_id, session_id: owner.session_id, generation: owner.generation, reason: "reply_deadline_exceeded" });
    return parseSnapshot(await this.request("POST", `/api/v1/events/${encodeURIComponent(eventId)}/cancel`, body));
  }

  /** 会话操作（契约 1.3）另带 steps / reason / page_observed，且不带 platform_message_id。 */
  async receipt(eventId: string, attempt_id: string, status: ReceiptStatus, platform_message_id?: string, extra?: ReceiptExtra): Promise<EventSnapshot> {
    const payload: Record<string, unknown> = { attempt_id, status };
    if (status === "sent" && platform_message_id && !extra) payload.platform_message_id = platform_message_id;
    if (extra?.steps?.length) payload.steps = extra.steps;
    if (extra?.reason) payload.reason = extra.reason;
    if (extra?.page_observed) payload.page_observed = extra.page_observed;
    return parseSnapshot(await this.request("POST", `/api/v1/events/${encodeURIComponent(eventId)}/receipt`, JSON.stringify(payload)));
  }
}
