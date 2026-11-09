import type { EventRecord, StoredMessage, UnknownCheck } from "./journal.js";
import type { MarkColor } from "./protocol.js";
import type { ShopRuntime } from "./runtime.js";
import { loginExpiryText } from "./loginExpiry.js";

/** 标星颜色的界面名称；orange 店主称“黄色”。 */
export const MARK_COLOR_NAMES: Record<MarkColor, string> = { orange: "黄色", red: "红色", green: "绿色", blue: "蓝色" };

/** 原因代码 → 给非技术人员看的中文说明。 */
export const REASONS: Record<string, string> = {
  history_sync: "历史同步/重连回补，不自动处理",
  no_stable_id: "平台未提供可靠消息编号，需人工处理",
  backend_unavailable: "后台未连接",
  platform_logged_out: "平台未登录或登录已失效",
  platform_identity_unverified: "平台店铺身份未核验",
  platform_shop_mismatch: "平台登录的店铺与配置不符（疑似串店）",
  no_platform_session: "没有有效的平台会话",
  lease_busy: "另一台客户端正持有本店发送归属",
  lease_invalid: "发送归属无效或已过期",
  history_fetch_failed: "无法取得对话历史",
  superseded_before_submit: "已有更新消息，本条不单独处理",
  superseded: "已有更新消息或上下文已变化，旧判断失效",
  session_changed: "平台会话已更换，旧任务失效",
  instance_changed: "客户端已重启，旧任务失效",
  context_too_large: "上下文超过 200 条，需扩展协议，已停止自动处理",
  content_too_long: "单条消息超过 8000 字，已停止自动处理",
  body_too_large: "请求超过 256 KiB，需扩展协议，已停止自动处理",
  mode_observe: "仅观察模式，不发送",
  mode_manual: "人工接管中，不发送",
  manual_takeover: "此对话人工接管中",
  history_incomplete: "历史不完整",
  unsupported_content: "最新消息是无法识别的内容",
  decision_expired: "判断已过期",
  reply_deadline_exceeded: "超过回复时限，本条待人工处理；后续新消息继续处理",
  already_attempted: "此事件已有发送尝试",
  conversation_busy: "此对话正有发送进行中",
  claim_expiring: "发送许可即将过期",
  capability_not_confirmed: "后台未确认支持附加发送",
  reply_deadline_withdrawn: "后台已撤回回复时限能力，本条待人工处理；后续新消息继续处理",
  invalid_remaining_budget: "剩余预算格式不被后台接受",
  cancel_owner_mismatch: "取消请求的归属不匹配",
  cancel_not_allowed: "事件已不可取消",
  option_unknown: "要发送的内容不在本次候选中（或客户端已重启）",
  option_type_mismatch: "要发送的内容类型与候选不符",
  option_gone: "要发送的内容已不在当前页面",
  send_options_changed: "可发送内容已变化",
  send_options_not_retained: "客户端重启，发送候选未保留",
  confirmed_after_deadline: "超过确认截止才确认，结果不确定",
  promoted_live: "历史中已有的消息收到实时推送，按新消息处理",
  runtime_stopped: "客户端已停止",
  not_reply: "无需发送",
  interrupted_during_send: "发送过程中客户端中断，结果不确定",
  restarted_before_send: "重启前未调用平台发送",
  send_timeout: "平台发送超时，结果不确定",
  send_exception: "平台发送异常，结果不确定",
  platform_ack_without_message_id: "平台只返回了传输确认，没有消息编号",
  platform_message_id_invalid: "平台消息编号无效",
  mock_rejected_before_call: "模拟：发送前被拒绝，未调用平台",
  claim_response_lost: "发送许可响应丢失，未调用平台",
  claim_not_granted: "未取得发送许可",
  token_shop_mismatch: "客户端口令属于其他店铺，已拒绝",
  unauthorized: "口令无效",
  protocol_unsupported: "后台协议版本不受支持",
  network_error: "网络不可达",
  timeout: "请求超时",
  lease_expired: "发送归属已过期",
  lease_mismatch: "发送归属不匹配",
  stale_revision: "上下文版本过旧",
  message_duplicate: "该消息已由其他任务提交",
  event_conflict: "事件编号冲突",
  decision_internal_error: "后台判断出错",
  backend_restarted: "后台重启",
  shop_disabled: "店铺在后台未启用",
  no_matching_rule: "没有匹配的规则",
  after_sale_request: "买家申请售后，转人工处理",
  message_stale: "消息已超过 2 分钟",
  unknown_delivery: "此对话存在待核查发送",
  settings_changed: "后台设置已更改",
  unsupported_context: "上下文包含图片/卡片等非文本内容",
  empty_message: "消息为空",
  message_future: "消息时间异常（晚于当前时间）",
  superseded_by_newer: "已有更新消息",
  model_not_configured: "后台模型未配置",
  model_request_failed: "后台模型调用失败",
  model_invalid_output: "后台模型返回内容无效",
  model_empty_reply: "后台模型未给出回复",
  model_response_too_large: "后台模型返回过大",
  pdd_adapter_not_implemented: "拼多多收发尚未接入",
  pdd_send_not_implemented: "拼多多发送尚未接入，未调用平台",
  update_pending: "客户端正在安装更新，暂停发送",
  transfer_blocked_by_mark: "会话已收藏，保留收藏并请在平台核对转接",
  transfer_target_missing: "转接窗口中找不到配置的完整接收账号，未转接",
  transfer_target_ambiguous: "转接窗口中有多个同名接收账号，未转接",
  transfer_target_button_missing: "接收账号的转移按钮不可用，未转接",
  transfer_target_button_not_unique: "接收账号的转移按钮无法唯一确定，未转接",
  transfer_target_unstable: "接收账号行仍在移动，未转接",
  transfer_leftover_popup: "上一次转接窗口尚未关闭，未开始新的转接",
  transfer_dialog_missing: "未能加载转接窗口，未转接",
  transfer_no_assignable_cs: "平台没有可转接的客服（接收账号可能不在线），未转接",
  transfer_cs_list_failed: "平台客服名单加载失败，未转接",
  transfer_cs_list_timeout: "平台客服名单加载超时，未转接",
  transfer_open_not_triggered: "点“转移会话”后平台没有响应，未转接",
  transfer_conversation_mismatch: "当前打开的不是该买家的会话，未转接",
  transfer_script_failed: "读取转接窗口失败或超时，未转接",
  transfer_read_failed: "读取转接页面失败，未转接",
  transfer_read_timeout: "读取转接页面超时，未转接",
  transfer_expired: "转接执行期限已到，未转接",
  transfer_open_button_missing: "未找到转移会话入口，未转接",
  transfer_open_button_not_unique: "转移会话入口不唯一，未转接",
  transfer_binding_unproven: "已尝试转接，结果需在平台核对",
  unmark_not_supported: "当前不自动取消收藏，请先在平台核对",
  mark_invalid: "标星决定格式不对，未执行",
  conv_state_not_retained: "提交时的会话状态未保留（客户端重启），不标星",
  conv_state_not_unmarked: "提交时会话已收藏或状态未读到，不标星",
  conv_state_changed: "会话或星标状态已变化，未点击",
  conv_state_unavailable: "无法可靠读取星标或颜色浮层，未点击",
  mark_request_not_observed: "点击后没有看到页面发出标星请求",
  mark_request_blocked: "页面发出的标星请求与本次不符，拦截结果未确认",
  mark_response_not_ok: "平台响应不满足成功判据",
  mark_request_failed: "标星请求加载失败",
  mark_response_timeout: "确认截止前没有取到平台响应",
  mark_binding_unproven: "平台已按成功判据答复，但目前无法证明这条请求来自本次点击（本阶段一律待核查）",
  mark_request_ambiguous: "点击期间页面发出了不止一条标星/取消收藏请求，无法确认哪条来自本次",
  mark_request_before_click: "点击前页面已发出标星/取消收藏请求",
  manual_input_during_mark: "标星期间平台页面有人工操作",
  page_changed_during_mark: "标星期间平台页面已变化",
  platform_changed_during_mark: "标星期间平台登录或店铺已变化",
  // 平台页面操作与回执（发送、附加发送、点击）：只说明原因，结果由界面标签表示，unknown 永不重发。
  pdd_send_busy: "平台页面正在处理另一项发送",
  pdd_send_button_covered: "平台页面的发送按钮被遮挡",
  pdd_send_button_not_ready: "发送按钮暂不可点击，请检查页面遮挡或布局",
  pdd_send_control_unverified: "未能唯一识别发送按钮，本条未发送",
  pdd_playwright_click_uncertain: "已尝试发送，结果待核查，本条不会重发",
  pdd_send_button_hidden: "平台页面的发送按钮不可见",
  pdd_send_blocked_mismatch: "页面发出的发送请求与本次不符，拦截结果未确认",
  pdd_send_request_not_observed: "操作后没有看到页面发出发送请求",
  pdd_input_mismatch: "输入框里的文字与要发送的内容不一致",
  pdd_input_missing: "平台页面找不到聊天输入框",
  pdd_input_not_empty: "聊天输入框里已有文字，可能有人正在输入",
  pdd_page_changed: "平台页面已变化",
  pdd_conversation_changed: "平台当前打开的对话已切换",
  pdd_conversation_not_in_list: "会话列表里找不到这位买家",
  pdd_page_script_failed: "读取平台会话失败，未发送",
  pdd_page_script_timeout: "读取平台会话超时，未发送",
  pdd_conversation_not_opened: "没能打开这位买家的对话",
  pdd_goods_button_covered: "平台页面的商品按钮被遮挡",
  pdd_goods_button_hidden: "平台页面的商品按钮不可见",
  pdd_goods_button_missing: "平台页面找不到商品按钮",
  pdd_goods_list_changed: "商品列表已变化",
  pdd_goods_list_not_loaded: "商品列表没有加载出来",
  pdd_goods_not_in_list: "要发送的商品不在当前商品列表中",
  pdd_goods_row_identity_changed: "商品列表中的这一行已变成别的商品",
  pdd_goods_rows_changed: "商品列表的行已变化",
  pdd_goods_rows_mismatch: "商品列表与读取到的数据对不上",
  pdd_goods_rows_missing: "商品列表里没有可用的行",
  pdd_goods_thumb_missing: "找不到商品的缩略图",
  pdd_goods_thumb_not_unique: "商品缩略图不唯一，无法确定是哪一个",
  pdd_instruct_button_missing: "平台页面找不到说明书按钮",
  pdd_instruct_changed: "说明书列表已变化",
  pdd_instruct_dialog_already_open: "说明书窗口已经开着，可能有人在操作",
  pdd_instruct_dialog_name_mismatch: "说明书窗口里的名称与要发送的不符",
  pdd_instruct_not_loaded: "说明书列表没有加载出来",
  pdd_instruct_option_invalid: "要发送的说明书无效",
  pdd_instruct_send_button_hidden: "说明书窗口的发送按钮不可见",
  pdd_instruct_send_button_missing: "说明书窗口找不到发送按钮",
  pdd_item_blocked_mismatch: "页面发出的附加发送请求与本次不符，拦截结果未确认",
  pdd_item_request_not_observed: "点击后没有看到页面发出附加发送请求",
  pdd_item_type_unsupported: "不支持这种附加发送类型",
  pdd_video_button_covered: "平台页面的视频按钮被遮挡",
  pdd_video_button_hidden: "平台页面的视频按钮不可见",
  pdd_video_button_missing: "平台页面找不到视频按钮",
  pdd_video_entry_covered: "视频入口被遮挡",
  pdd_video_entry_hidden: "视频入口不可见",
  pdd_video_entry_missing: "找不到视频入口",
  pdd_video_file_url_missing: "视频缺少文件地址",
  pdd_video_library_not_loaded: "视频库没有加载出来",
  pdd_video_option_changed: "要发送的视频已变化",
  pdd_video_panel_closed: "视频面板已关闭",
  pdd_video_panel_not_opened: "视频面板没有打开",
  pdd_video_row_identity_mismatch: "视频列表中的这一行与要发送的不符",
  pdd_video_row_identity_missing: "视频列表中的这一行无法识别",
  pdd_video_rows_mismatch: "视频列表与读取到的数据对不上",
  platform_not_logged_in: "平台未登录",
  platform_request_failed: "平台请求加载失败",
  platform_response_unparsed: "无法解析平台的响应",
  platform_send_error: "平台返回发送出错",
  platform_send_failed: "平台接口返回失败",
  platform_window_closed: "平台窗口已关闭",
  receipt_ambiguous: "平台回执不唯一，无法确认对应哪一条",
  receipt_not_observed: "平台接口已答复，但没看到对应的消息记录",
  receipt_object_mismatch: "平台回执对应的内容与本次不符",
  image_fetch_failed: "图片读取失败",
  image_fetch_timeout: "图片读取超时",
  image_too_large: "图片太大",
  image_type_unsupported: "不支持的图片格式",
  command_timeout: "页面点击命令超时",
  command_exception: "页面点击命令出错",
  command_rejected: "页面拒绝了点击命令",
  invalid_point: "点击位置无效",
  contents_destroyed: "平台页面已关闭",
  preflight_failed: "点击前的检查没有通过",
  debugger_not_attached: "平台页面的调试通道未连接",
  recheck_failed: "点击前再次核对没有通过",
  before_press_failed: "按下前的最后核对没有通过",
  target_moved: "要点击的目标位置已变化",
  page_state_not_confirmed: "无法确认平台页面的状态",
  lease_response_mismatch: "后台返回的发送归属与请求不符",
};

export function reasonText(code: string | null | undefined): string {
  if (!code) return "";
  if (code.startsWith("unsupported_action:")) return "后台给出客户端不支持的操作，未执行";
  const base = code.startsWith("claim_rejected:") ? code.slice("claim_rejected:".length) : code;
  return REASONS[base] ?? REASONS[code] ?? code;
}

export type Tone = "muted" | "wait" | "suggest" | "handoff" | "ok" | "warn" | "error";
export type MessageStatus = { label: string; tone: Tone; reason: string };

/** 发送结果不确定：状态仍是“待核查”、永不重发；附上前台自动读聊天记录的结论，帮助人工判断是否补发。 */
export function unknownStatus(reason: string, check: UnknownCheck | undefined): MessageStatus {
  const base = reason ? `${reason}。` : "";
  if (check?.result === "seen") return { label: "待核查·记录里已看到", tone: "warn", reason: `${base}自动核对：发送后的聊天记录里已出现这条内容，大概率已发出。不会重发。` };
  if (check?.result === "not_seen") return { label: "待核查·记录里没看到", tone: "error", reason: `${base}自动核对：发送后聊天记录已刷新，但没有这条内容，请到平台确认后人工补发。不会自动重发。` };
  if (check?.result === "unavailable") return { label: "结果待核查", tone: "error", reason: `${base}自动核对：无法确认发送后的聊天记录是否完整覆盖，请到平台聊天记录核查。不会自动重发。` };
  // 尚未核对（核对进行中，或客户端重启后不再核对）：不声称正在核对。
  return { label: "结果待核查", tone: "error", reason: `${base}请到平台聊天记录确认。不会自动重发。` };
}

/** 标星决定的状态：结果只按回执与本地尝试记录显示；unknown 永不重试，请人工到平台查看星标。 */
function markStatus(ev: EventRecord, color: MarkColor | undefined): MessageStatus {
  const name = color ? MARK_COLOR_NAMES[color] : "";
  const check = "请到平台查看该会话星标。不会重试。";
  const a = ev.attempt;
  if (a) {
    switch (a.phase) {
      case "sent":
        return { label: "已标星", tone: "ok", reason: `${name}，平台已确认` };
      case "unknown":
        return { label: "标星结果待核查", tone: "error", reason: `${reasonText(a.detail)}。${check}` };
      case "not_sent":
      case "aborted_before_send":
      case "claim_failed":
        return { label: "未标星", tone: "warn", reason: reasonText(a.detail) };
      default:
        return { label: "标星中", tone: "wait", reason: "" };
    }
  }
  if (ev.snapshot?.delivery.status === "unknown") return { label: "标星结果待核查", tone: "error", reason: check };
  return { label: "建议标星", tone: "suggest", reason: ev.blocked ? `未执行：${reasonText(ev.blocked)}` : name };
}

function transferStatus(ev: EventRecord): MessageStatus {
  const attempt = ev.attempt;
  if (attempt?.phase === "sent") return { label: "转接成功", tone: "ok", reason: "会话已转交，处理完成" };
  if (attempt?.phase === "unknown" || ev.snapshot?.delivery.status === "unknown") return { label: "转接结果待核查", tone: "error", reason: "请到平台核对接收账号，不会重试。" };
  if (attempt && ["not_sent", "aborted_before_send", "claim_failed"].includes(attempt.phase)) return { label: "未转接", tone: "warn", reason: reasonText(attempt.detail) };
  if (attempt) return { label: "转接中", tone: "wait", reason: "" };
  return { label: "建议转人工", tone: "suggest", reason: ev.blocked ? `未执行：${reasonText(ev.blocked)}` : "" };
}

export function messageStatus(message: StoredMessage, ev: EventRecord | undefined, note: string | undefined): MessageStatus | null {
  if (message.role !== "buyer") return null;
  if (!ev) {
    if (note === "reply_deadline_exceeded") return { label: "本条待人工", tone: "handoff", reason: reasonText(note) };
    if (note === "history_sync") return { label: "历史消息", tone: "muted", reason: reasonText(note) };
    if (note) return { label: "未自动处理", tone: "warn", reason: reasonText(note) };
    return { label: "等待处理", tone: "wait", reason: "" };
  }
  if (ev.snapshot?.decision?.action === "mark") return markStatus(ev, ev.snapshot.decision.mark?.color);
  if (ev.snapshot?.decision?.action === "transfer") return transferStatus(ev);
  const a = ev.attempt;
  if (a) {
    if (["not_sent", "aborted_before_send", "claim_failed"].includes(a.phase) && a.detail === "reply_deadline_exceeded") return { label: "本条待人工", tone: "handoff", reason: reasonText(a.detail) };
    switch (a.phase) {
      case "sent":
        return { label: "已获平台确认", tone: "ok", reason: a.platform_message_id ? `平台消息 ${a.platform_message_id}` : "" };
      case "unknown":
        return unknownStatus(reasonText(a.detail), ev.check);
      case "not_sent":
      case "aborted_before_send":
      case "claim_failed":
        return { label: "未发送", tone: "warn", reason: reasonText(a.detail) };
      default:
        return { label: "发送中", tone: "wait", reason: "" };
    }
  }
  if (ev.blocked === "reply_deadline_exceeded" && ev.snapshot?.delivery.status !== "unknown") return { label: "本条待人工", tone: "handoff", reason: reasonText(ev.blocked) };
  if (ev.stage === "prepared") return { label: "提交后台中", tone: "wait", reason: "" };
  if (ev.stage === "submit_failed") return { label: "提交失败，待原样补报", tone: "warn", reason: reasonText(ev.error) };
  // 契约 A.2：冻结了预算的请求体在首次受理前遇到能力撤回，后台确定拒绝；不换编号、不删预算重投，本条待人工。
  if (ev.stage === "rejected" && ev.error === "capability_not_confirmed" && ev.budget_ms !== undefined) return { label: "本条待人工", tone: "handoff", reason: reasonText("reply_deadline_withdrawn") };
  if (ev.stage === "rejected") return { label: "后台拒绝", tone: "error", reason: reasonText(ev.error) };
  const s = ev.snapshot;
  if (!s || s.state !== "ready" || !s.decision) return { label: "等待判断", tone: "wait", reason: "" };
  if (s.delivery.status === "unknown") return unknownStatus(reasonText(s.delivery.reason), ev.check);
  switch (s.decision.action) {
    case "reply":
    case "send_item":
      return { label: s.decision.action === "reply" ? "建议回复" : "建议发送", tone: "suggest", reason: ev.blocked ? `未发送：${reasonText(ev.blocked)}` : "" };
    case "handoff":
      return { label: "建议交人工", tone: "handoff", reason: `${reasonText(s.decision.reason)}（仅为建议，平台未执行转接）` };
    case "none":
      return { label: "无需回复", tone: "muted", reason: reasonText(s.decision.reason) };
    case "mark":
      return markStatus(ev, s.decision.mark?.color);
    case "transfer":
      return transferStatus(ev);
  }
}

/** 界面显示的决定内容：回复文字、附加发送的候选名称或标星颜色。 */
function decisionText(rt: ShopRuntime, ev: EventRecord | undefined): string | null {
  const d = ev?.snapshot?.decision;
  if (!ev || !d) return ev ? rt.itemLabel(ev) : null;
  if (d.action === "reply") return d.text;
  if (d.action === "mark") return d.mark ? `标星：${MARK_COLOR_NAMES[d.mark.color]}` : "标星";
  if (d.action === "transfer") return "转人工";
  return rt.itemLabel(ev);
}

export function shopView(rt: ShopRuntime, now = Date.now() / 1000) {
  const platform = rt.adapter.status();
  const identityOk = !!platform.identity && platform.identity.platform_shop_id === rt.config.platform_shop_id;
  const conversations = [...rt.journal.conversations.values()].map((conv) => {
    const messages = conv.messages.map((m) => {
      const ev = rt.journal.eventForMessage(conv.conversation_id, m.id);
      return {
        id: m.id,
        stable: m.stable,
        role: m.role,
        kind: m.kind,
        content: m.content,
        created_at: m.created_at,
        live: m.live,
        status: messageStatus(m, ev, conv.notes[m.id]),
        decision_text: decisionText(rt, ev),
        event_id: ev?.event_id ?? null,
        context_revision: ev?.context_revision ?? null,
        history_complete: ev ? ev.history_complete : null,
      };
    });
    return {
      conversation_id: conv.conversation_id,
      revision: conv.revision,
      takeover: conv.takeover,
      unknown: rt.journal.hasUnknown(conv.conversation_id),
      last_at: conv.messages[conv.messages.length - 1]?.created_at ?? 0,
      messages,
    };
  });
  conversations.sort((a, b) => b.last_at - a.last_at);
  return {
    shop_id: rt.config.shop_id,
    display_name: rt.config.display_name,
    adapter: rt.config.adapter,
    simulated: rt.adapter.simulated,
    mode: rt.config.mode,
    instance_id: rt.instanceId,
    session_id: rt.sessionId,
    backend: { state: rt.backendState.state, detail: reasonText(rt.backendState.detail) || rt.backendState.detail, client_id: rt.backendState.me?.client_id ?? null },
    platform: { logged_in: platform.logged_in, identity: platform.identity, detail: platform.detail, identity_ok: identityOk, expected: rt.config.platform_shop_id, login_expiry: loginExpiryText(platform.login_expires_at, now * 1000) },
    lease: { state: rt.lease.state, generation: rt.lease.generation, seconds_left: Math.max(0, Math.round(rt.lease.valid_until - now)), detail: reasonText(rt.lease.detail) || rt.lease.detail },
    duplicates: rt.duplicates,
    conversations,
  };
}

export type ShopView = ReturnType<typeof shopView>;
