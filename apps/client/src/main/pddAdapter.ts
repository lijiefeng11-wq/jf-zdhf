import { clickSendWithPlaywright } from "./playwrightSend.js";
import type { TransferRequest, TransferResult } from "../core/adapter.js";
import { session } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AdapterEvent, HistoryLoad, HistoryResult, ImageFetchResult, MarkRequest, MarkResult, PlatformAdapter, PlatformNav, PlatformNavAction, PlatformStatus, SendItemRequest, SendRequest, SendResult } from "../core/adapter.js";
import { buyerFromListKey, decideOutgoing, parseChatList, parseCustomServiceInfo, parseRealtimeUserInfo, parseSendRequest, parseSendResponse } from "../core/pddParse.js";
import { PddOrderBook } from "../core/pddOrders.js";
import { PddSessionTracker } from "../core/pddSession.js";
import { PageHealth } from "../core/pageHealth.js";
import { GOODS_CARD_SEND_PATH, INSTRUCT_PATH, INSTRUCT_SEND_PATH, instructMatches, instructRequestAllowed, instructResponseOk, instructTarget, PddSendOptionBook, RECOMMEND_GOODS_PATH, goodsRequestAllowed, goodsResponseOk, parseRecommendGoods, planGoodsClick, verifyGoodsTarget, type GoodsRow, VIDEO_LIST_PATH, libraryResponseOk, verifyVideoTarget, judgeItemReceipt, libraryRequestAllowed, parseSyncMessages, parseVideoRows, planVideoClick, type SeenMessage, type VideoRow } from "../core/pddSendItems.js";
import { isAllowedImageUrl, isAllowedPlatformUrl, partitionFor, sniffImage } from "../core/security.js";
import { LOGIN_COOKIE_NAME, LOGIN_COOKIE_URL, loginExpiryOf } from "../core/loginExpiry.js";
import { MAX_IMAGE_BYTES, type PageObserved } from "../core/protocol.js";
import { judgeMark, MARK_COLOR_VALUE, MARK_QUIET_MS, markRequestVerdict, markResponseOk, newMarkWatch, observeInput, type MarkWatch } from "../core/pddMark.js";
import type { PlatformPage } from "./platformWorkspace.js";
import { dispatchPageClick, type PageClickResult } from "./pddClick.js";
import { collectStoreProducts, productReadScript } from "./productCollector.js";
import type { ProductDoc } from "../core/productLearning.js";
import { PddMessageWatcher } from "./pddMessageWatcher.js";
import { popupSweepScript, type PopupSweepMode, type PopupSweepResult } from "./pddPopups.js";
import { MARKED_LIST_PATH, MARK_REQUEST_PATH, markedListProbe, markRequestProbe, markResponseProbe, type MarkProbeRecord, UNMARK_REQUEST_PATH } from "./markProbe.js";
import { type AssignCandidates, assignNameProbe, assignTokens, type AssignTokens, bindingOf, closeRequestProbe, combineBinding, extractAssignEntries, mergeAssignCandidates, mergeAssignTokens, moveRequestProbe, type TransferBinding, transferProbePath, type TransferProbePath, type TransferProbeRecord, transferResponseProbe } from "./transferProbe.js";

const LOGIN_URL = "https://mms.pinduoduo.com/chat-merchant/index.html";

const SCHEMA_PATHS = [
  /^\/janus\/api\/new\/userinfo$/,
  /^\/earth\/api\/mallInfo\/commonMallInfo$/,
  /^\/janus\/api\/customService\/queryCustomServiceInfo$/,
  /^\/chats\//,
  /^\/plateau\/(chat|sync|message|file)\//,
  // 聊天页其他发送操作（说明书、商品卡片、图片/视频库）：只记字段结构，用于起草接口约定。
  /^\/latitude\/(goodsInstruct|goods|user\/file)\//,
  /^\/tornado\/instruct\//,
];

/** 订单、物流相关接口：只在诊断模式下记录字段结构，用于确认页面从哪里加载订单列表与快递信息。 */
const ORDER_HINT = /order|logistic|express|track|waybill|shipping|delivery/i;

function probePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== "mms.pinduoduo.com") return null;
    return SCHEMA_PATHS.some((r) => r.test(url.pathname)) || ORDER_HINT.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

/** 会话操作（转移、收藏、标星等）候选接口：仅诊断模式记录字段结构，不参与任何收发处理。 */
const ACTION_HINT = /transfer|assign|move|star|mark|collect|favou?r|follow|tag|label/i;

/**
 * 诊断记录可保留的单个词（路径段、界面类名须整段等于其中一个词，或符合下方固定组合规则）。其余一律匿名，
 * 不按“是否含数字”或“能否拆成已知词”判断：全字母或常用词拼成的买家/账号标识同样不得写入诊断文件。
 */
const PROBE_WORDS = new Set(
  (
    "api new common query get set list info detail update add remove delete del save batch check status config setting settings " +
    "user users userinfo mall shop custom service chat chats conv conversation session message messages msg send sync file files " +
    "library image video goods instruct order orders logistic logistics express track trace waybill shipping delivery " +
    "transfer assign move star mark collect collection favor favorite favourite follow tag tags label labels remark note top pin " +
    "read unread block group agent agents staff online offline janus plateau latitude tornado earth merchant index html js json " +
    "login auth token report log stat stats data page home search recommend card coupon refund after sale sales aftersale record " +
    "history count notice notify push ws websocket heartbeat ping by to from of and or with for all cancel " +
    "el ant dialog modal popover drawer title header footer body content wrapper wrap container panel right left side bar item items " +
    "box active selected select current cur on off disabled hover icon btn button tool tools toolbar menu tab tabs reply input " +
    "textarea editor avatar nickname name op ops operate operation action actions more close confirm ok primary default small mini " +
    "large text link inner outer main view tip tips tooltip badge dot second first last mask overlay popup layer scroll row col cell " +
    "table form radio checkbox switch option options dropdown trigger arrow up down img pic red yellow green blue gray grey orange " +
    "purple color camera is has " +
    "id ids uid uids ts time timestamp code success result error errors err total size type value values key keys extra ext " +
    "req resp request response target source busy available max min limit num number nick avatar mobile phone desc reason " +
    "start end begin expire expired create created modify modified enable enabled flag level priority sort seq version"
  ).split(" "),
);
const PROBE_WORDS_JSON = JSON.stringify([...PROBE_WORDS]);
/** 代码中已使用的平台固定类名（组合形式），诊断时可原样保留。 */
const SAFE_CLASSES_JSON = JSON.stringify([
  "chat-list", "chat-item", "chat-item-box", "msg-list", "reply-box", "reply-input", "reply-header", "right-panel", "bar-box",
  "bar-item", "bar-select", "order-panel-header", "order-panel-header-second", "order-panel-second-bar", "video-list-box",
  "send-video-btn", "chat-icon-camera",
]);

let staticSegments: Set<string> | null = null;

/** 已确认的静态接口路径中出现的段（含驼峰/下划线组合段），只认这些完整段。 */
function knownSegments(): Set<string> {
  staticSegments ??= new Set(
    [
      "/janus/api/new/userinfo",
      "/earth/api/mallInfo/commonMallInfo",
      "/janus/api/customService/queryCustomServiceInfo",
      "/chat-merchant/index.html",
      "/chats/shippingDetail",
      SEND_PATH,
      SYNC_PATH,
      LIBRARY_SEND_PATH,
      GOODS_CARD_SEND_PATH,
      INSTRUCT_PATH,
      INSTRUCT_SEND_PATH,
      RECOMMEND_GOODS_PATH,
      VIDEO_LIST_PATH,
    ].flatMap((p) => p.split("/").filter(Boolean)),
  );
  return staticSegments;
}

/**
 * 路径段只保留两类：已确认静态接口中的完整段，或单个小写已知词（如 transfer、star）。
 * 由已知词拼接的段（如 redGreen、online_staff）可能是买家/客服标识，与编号、编码段一样替换为 :id。
 */
export function maskPath(pathname: string): string {
  return pathname
    .split("/")
    .map((s) => (s === "" || knownSegments().has(s) || PROBE_WORDS.has(s) || /^v\d{1,2}$/.test(s) ? s : ":id"))
    .join("/");
}

export function actionProbePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== "mms.pinduoduo.com" || !ACTION_HINT.test(url.pathname)) return null;
    return maskPath(url.pathname);
  } catch {
    return null;
  }
}

const ENUM_KEYS = new Set(["role", "type", "status", "cmd", "is_aut", "manual_reply", "source_id", "template_name"]);
const SHAPE_KEYS = new Set(["ts", "msg_id", "uid", "mall_id", "pre_msg_id"]);

/** 只收集类别标签字段的取值，以及时间戳/编号的“位数形态”（不含具体值）。 */
export function enumsOf(text: string | null): Record<string, string[]> {
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  const out: Record<string, Set<string>> = {};
  const add = (k: string, v: string) => (out[k] ??= new Set()).add(v);
  const walk = (v: unknown, parent: string, depth: number) => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, parent, depth + 1));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const name = parent === "from" || parent === "to" ? `${parent}.${k}` : k;
      if (ENUM_KEYS.has(k) && (typeof x === "string" || typeof x === "number") && String(x).length <= 32) add(name, String(x));
      else if (SHAPE_KEYS.has(k) && (typeof x === "string" || typeof x === "number")) add(`${k}:shape`, `${typeof x}:${String(x).replace(/[0-9]/g, "9").replace(/[a-z]/gi, "a")}`);
      else walk(x, k, depth + 1);
    }
  };
  walk(value, "", 0);
  return Object.fromEntries(Object.entries(out).map(([k, s]) => [k, [...s].slice(0, 30)]));
}

/** 把 JSON 文本转成“字段名 → 类型”的结构描述；不保留任何值。 */
export function schemaOf(text: string | null): unknown {
  if (text === null) return "non_text";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "non_json";
  }
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null) return "null";
    if (Array.isArray(v)) return v.length ? [walk(v[0], depth + 1)] : [];
    if (typeof v === "object") {
      if (depth > 7) return "obj";
      const out: Record<string, unknown> = {};
      const keys = Object.keys(v as object);
      // 以数字/长编号作键的对象（按 ID 索引）只保留一个样例结构，键名替换为占位符。
      if (keys.length && keys.every((k) => /^[0-9a-f-]{6,}$/i.test(k))) return { "<id>": walk((v as Record<string, unknown>)[keys[0]], depth + 1) };
      for (const k of keys.slice(0, 80)) out[k] = walk((v as Record<string, unknown>)[k], depth + 1);
      return out;
    }
    return typeof v === "string" ? "str" : typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : typeof v;
  };
  return walk(value, 0);
}

/**
 * 会话操作接口可原样输出的完整字段名（逐字比对，不按分词组合判断：由常用词拼成的串也可能是账号标识）。
 */
const ACTION_FIELDS = new Set(
  (
    "success result data code msg message error error_code error_msg errorCode errorMsg list total status type target " +
    "target_id targetId target_uid targetUid uid cs_uid csUid mall_id mallId id ids online busy available reason " +
    "star star_type starType is_star isStar color mark mark_type markType is_mark isMark collect is_collect isCollect " +
    "collected favorite is_favorite isFavorite transfer transfer_type transferType server_time serverTime ts timestamp " +
    // 转移对话框客服列表：只为确认第一列“账号名”（接收人身份）与昵称各对应哪个字段，仍只记字段名不记值。
    "csid cs_id csId nickname nick_name nickName username user_name userName name"
  ).split(" "),
);
const ACTION_SCHEMA_DEPTH = 8;
/** 诊断转移上下文的有效期：转移结果与关闭会话的请求在此之内到达才关联到本次诊断转移。 */
const TRANSFER_PROBE_CTX_MS = 120_000;
const ACTION_SCHEMA_NODES = 2000;

/**
 * 会话操作候选接口的字段结构：只保留 ACTION_FIELDS 中的完整字段名；其余键（可能是买家/客服标识）合并为一个 "<key>" 样例，
 * 另记匿名键个数 "<keys>"。不保留任何值。层数与节点数有上限，超出时以 "deep"/"truncated" 结束；任何异常返回 "error"。
 */
export function actionSchemaOf(text: string | null): unknown {
  if (text === null) return "non_text";
  try {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return "non_json";
    }
    let nodes = 0;
    const walk = (v: unknown, depth: number): unknown => {
      if (depth > ACTION_SCHEMA_DEPTH) return "deep";
      if (++nodes > ACTION_SCHEMA_NODES) return "truncated";
      if (v === null) return "null";
      if (Array.isArray(v)) return v.length ? [walk(v[0], depth + 1)] : [];
      if (typeof v === "object") {
        const out: Record<string, unknown> = {};
        let unknown = 0;
        for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 80)) {
          if (ACTION_FIELDS.has(k)) out[k] = walk(x, depth + 1);
          else if (unknown++ === 0) out["<key>"] = walk(x, depth + 1);
        }
        if (unknown) out["<keys>"] = unknown;
        return out;
      }
      return typeof v === "string" ? "str" : typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : typeof v;
    };
    return walk(value, 0);
  } catch {
    return "error";
  }
}

/**
 * 星标与转移按钮的浮层关联（只记个数与是否，不记 id 或文字）：与 starOptionsScript / popoverButtonsScript 的归属规则一致，
 * 用于核实真实页面上 aria-describedby 是否存在、能否对应到 el-popover、该浮层当前是否可见。
 */
// 不直接 export const：CommonJS 编译会把模板里的 ${LINK_PROBE} 改写成 exports.LINK_PROBE，拼接检查的作用域里没有 exports。
const LINK_PROBE = `(() => {
  const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const t = (e) => (e.innerText ?? "").trim();
  const ids = (el, stop, up) => {
    const out = new Set();
    const add = (e) => (e.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean).forEach((id) => out.add(id));
    [el, ...el.querySelectorAll("[aria-describedby]")].forEach(add);
    for (let e = el.parentElement, i = 0; e && e !== stop && i < up; e = e.parentElement, i++) add(e);
    return [...out];
  };
  const judge = (list) => {
    const pops = list.map((id) => document.getElementById(id)).filter((p) => p && p.matches("div.el-popover"));
    return { has_aria: list.length > 0, resolves: pops.length, visible: pops.filter(vis).length };
  };
  const stars = [...document.querySelectorAll('[title="收藏该用户"]')].filter(vis);
  const star = stars.length === 1 ? judge(ids(stars[0], null, 4)) : null;
  const dlg = [...document.querySelectorAll("div.el-dialog")].filter(vis).find((d) => t(d.querySelector(".el-dialog__title") ?? d) === "转移会话");
  const rows = dlg ? [...dlg.querySelectorAll("tr.el-table__row")].filter(vis) : [];
  const rowLinks = rows.map((tr) => {
    const btns = [...tr.querySelectorAll("*")].filter((e) => vis(e) && t(e) === "转移" && ![...e.children].some((c) => t(c) === "转移"));
    return btns.length === 1 ? judge(ids(btns[0], tr.parentElement, 20)) : null;
  });
  return {
    star_count: stars.length,
    star,
    transfer_dialog: !!dlg,
    transfer_rows: rows.length,
    rows_with_button: rowLinks.filter(Boolean).length,
    rows_with_aria: rowLinks.filter((r) => r && r.has_aria).length,
    rows_resolving: rowLinks.filter((r) => r && r.resolves === 1).length,
    rows_popover_visible: rowLinks.filter((r) => r && r.visible > 0).length,
  };
})()`;
export { LINK_PROBE };

/**
 * 页面结构诊断（在隔离环境执行，页面脚本不可见）：只收集元素标签、类名、data-* 属性名、
 * 可编辑区域，以及不超过 6 个字的按钮文字（界面标签，如“发送”）。不收集昵称、消息正文等内容。
 */
const DOM_PROBE = `(() => {
  const KEY = /chat|conv|session|unread|badge|dot|count|msg|input|editor|send|reply|list|item|active|select|current/i;
  const sig = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).join(".") : "");
  const chain = (el) => { const out = []; for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) out.unshift(sig(e)); return out.join(" > "); };
  const classes = {};
  const editables = [];
  const buttons = [];
  for (const el of document.querySelectorAll("*")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (KEY.test(cls)) {
      const s = chain(el);
      const rec = (classes[s] ??= { count: 0, data: new Set() });
      rec.count++;
      for (const a of el.getAttributeNames()) if (a.startsWith("data-")) rec.data.add(a + ":" + String(el.getAttribute(a)).replace(/[0-9]/g, "9").replace(/[^9]/g, "a").slice(0, 16));
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /text|search/.test(el.type))) editables.push({ chain: chain(el), placeholder: el.getAttribute("placeholder") });
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || /btn|button|send/i.test(cls)) {
      const t = (el.textContent || "").trim();
      if (t.length <= 6) buttons.push({ chain: chain(el), text: t });
    }
  }
  const top = Object.entries(classes).filter(([, r]) => r.count >= 1).slice(0, 400).map(([chain, r]) => ({ chain, count: r.count, data: [...r.data].slice(0, 10) }));
  return { url: location.pathname + location.hash.replace(/[0-9]{5,}/g, "<id>"), classes: top, editables, buttons: buttons.slice(0, 80), links: (() => { try { return ${LINK_PROBE}; } catch (e) { return { error: String(e && e.name), message: String(e && e.message).slice(0, 160) }; } })() };
})()`;
export { DOM_PROBE };

/**
 * 界面操作记录（隔离环境，页面脚本不可见）：人工每点一次可点击元素，记下它的界面标签（title/aria-label/
 * 不超过 8 字的文字）、图标类名与结构链，以及点击后新出现的弹窗标题。消息区、输入框内的点击不记录；
 * 会话列表内只记录不含文字的图标控件（标签只取 title/aria-label 中完整的操作词），选会话、点昵称不记录。
 * 类名只保留由已知词（PROBE_WORDS）组成的前 4 个，避免带出动态标识。不点击任何东西。另在开启时列出当前页面所有可点击控件，作为“按钮地图”。
 */
export const UI_RECORDER = `(() => {
  if (window.__clawUi) return true;
  const SKIP = "ul.msg-list, textarea, [contenteditable=true]";
  const LIST = "li.chat-item, .chat-list";
  const ICONISH = "i, svg, img, button, [role=button], [title], [aria-label], [class*=icon], [class*=star], [class*=collect], [class*=fav], [class*=mark], [class*=tag]";
  const short = (s) => { const t = (s || "").replace(/\\s+/g, " ").trim(); return t && t.length <= 8 && !/[0-9０-９¥￥@]/.test(t) ? t : null; };
  const actionWord = (s) => { const t = short(s); return t && /^(取消|已|标为|设为)?(收藏|标星|星标|标记|转移|转移会话|转接|置顶|关注|已读|未读|删除|移除|屏蔽)$/.test(t) ? t : null; };
  const btnish = (el) => el.matches("button, [role=button], [class*=btn], [class*=tab], [class*=menu]");
  const WORDS = new Set(${PROBE_WORDS_JSON});
  const SAFE = new Set(${SAFE_CLASSES_JSON});
  const known = (c) => {
    if (WORDS.has(c) || SAFE.has(c)) return true;
    const m = /^(el|ant|icon|btn|chat-icon)-([a-z]+)(?:__([a-z]+))?$/.exec(c);
    return !!m && WORDS.has(m[2]) && (!m[3] || WORDS.has(m[3]));
  };
  const cls = (el) => (typeof el.className === "string" ? el.className : el.getAttribute("class") || "").trim().split(/\\s+/).filter((c) => c && c.length <= 32 && known(c)).slice(0, 4);
  const sig = (el) => [el.tagName.toLowerCase(), ...cls(el)].join(".");
  const chain = (el) => { const out = []; for (let e = el, i = 0; e && e !== document.body && i < 5; e = e.parentElement, i++) out.unshift(sig(e)); return out.join(" > "); };
  const clickable = (el) => el.closest("button, a, [role=button], [title], [class*=btn], [class*=icon], [class*=tool], [class*=menu], [class*=tab], [class*=item]");
  const describe = (el) => {
    const icon = el.querySelector("i[class], svg[class], img[class]");
    return {
      label: short(el.getAttribute("title")) ?? short(el.getAttribute("aria-label")) ?? short(el.getAttribute("data-tip")) ?? (btnish(el) ? short(el.textContent) : null),
      icon: icon ? sig(icon) : null,
      chain: chain(el),
    };
  };
  const listIcon = (t) => {
    const el = t.closest(ICONISH);
    if (!el || !el.closest(LIST) || (el.textContent || "").trim()) return null;
    let label = null;
    for (let e = el, i = 0; !label && e && i < 3 && e.closest(LIST) && !(e.textContent || "").trim(); e = e.parentElement, i++) label = actionWord(e.getAttribute("title")) ?? actionWord(e.getAttribute("aria-label"));
    const icon = el.matches("i, svg, img") ? el : el.querySelector("i, svg, img");
    return { label, icon: icon ? sig(icon) : null, chain: chain(el), area: "chat_list" };
  };
  // 会话列表里点出的浮层可能以买家昵称为标题：此时标题只保留操作类词语。
  const dialogs = (fromList) => [...document.querySelectorAll("[class*=dialog], [class*=modal], [class*=popover], [class*=drawer], [role=dialog]")]
    .filter((d) => d.getBoundingClientRect().width > 0)
    .map((d) => (fromList ? actionWord : short)(d.querySelector("[class*=title], [class*=header], h1, h2, h3")?.textContent) ?? sig(d));
  const ui = (window.__clawUi = { queue: [] });
  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t || t.closest(SKIP)) return;
    const info = t.closest(LIST) ? listIcon(t) : describe(clickable(t) ?? t);
    if (!info) return;
    const fromList = info.area === "chat_list";
    const before = new Set(dialogs(fromList));
    const rec = { at: Date.now(), ...info, trusted: ev.isTrusted, opened: [] };
    ui.queue.push(rec);
    setTimeout(() => { rec.opened = dialogs(fromList).filter((d) => !before.has(d)).slice(0, 5); }, 800);
  }, true);
  return true;
})()`;

export const UI_MAP = `(() => {
  const SKIP = "ul.msg-list";
  const LIST = "li.chat-item, .chat-list";
  const short = (s) => { const t = (s || "").replace(/\\s+/g, " ").trim(); return t && t.length <= 8 && !/[0-9０-９¥￥@]/.test(t) ? t : null; };
  const actionWord = (s) => { const t = short(s); return t && /^(取消|已|标为|设为)?(收藏|标星|星标|标记|转移|转移会话|转接|置顶|关注|已读|未读|删除|移除|屏蔽)$/.test(t) ? t : null; };
  const btnish = (el) => el.matches("button, [role=button], [class*=btn], [class*=tab], [class*=menu]");
  const WORDS = new Set(${PROBE_WORDS_JSON});
  const SAFE = new Set(${SAFE_CLASSES_JSON});
  const known = (c) => {
    if (WORDS.has(c) || SAFE.has(c)) return true;
    const m = /^(el|ant|icon|btn|chat-icon)-([a-z]+)(?:__([a-z]+))?$/.exec(c);
    return !!m && WORDS.has(m[2]) && (!m[3] || WORDS.has(m[3]));
  };
  const cls = (el) => (typeof el.className === "string" ? el.className : el.getAttribute("class") || "").trim().split(/\\s+/).filter((c) => c && c.length <= 32 && known(c)).slice(0, 4);
  const sig = (el) => [el.tagName.toLowerCase(), ...cls(el)].join(".");
  const chain = (el) => { const out = []; for (let e = el, i = 0; e && e !== document.body && i < 5; e = e.parentElement, i++) out.unshift(sig(e)); return out.join(" > "); };
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll("button, a, [role=button], [title], [class*=btn], [class*=icon], [class*=tool]")) {
    if (el.closest(SKIP)) continue;
    const inList = !!el.closest(LIST);
    if (inList && (el.textContent || "").trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const icon = el.querySelector("i[class], svg[class], img[class]");
    const label = inList ? (actionWord(el.getAttribute("title")) ?? actionWord(el.getAttribute("aria-label"))) : (short(el.getAttribute("title")) ?? short(el.getAttribute("aria-label")) ?? (btnish(el) ? short(el.textContent) : null));
    const rec = { label, icon: icon ? sig(icon) : null, chain: chain(el), area: inList ? "chat_list" : el.closest(".reply-box") ? "reply_box" : el.closest("[class*=side], [class*=right]") ? "side" : "other" };
    const key = rec.chain + "|" + rec.label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  const tabText = (el) => { const t = (el.textContent || "").replace(/[0-9０-９()（）]/g, "").replace(/\\s+/g, " ").trim(); return t && t.length <= 8 && !/[¥￥@]/.test(t) ? t : null; };
  for (const el of document.querySelectorAll("div.right-panel div.bar-box li, ul.order-panel-header > li, ul.order-panel-header-second > li")) {
    out.push({ label: tabText(el), icon: null, chain: chain(el), area: "order_tabs", active: /(^|\\s)(active|selected|on|cur|current)(\\s|$)/.test(String(el.className)) });
  }
  return out.slice(0, 340);
})()`;

const UI_DRAIN = `(() => { const ui = window.__clawUi; if (!ui) return null; const done = ui.queue.filter((r) => Date.now() - r.at > 3000); ui.queue = ui.queue.filter((r) => Date.now() - r.at <= 3000); return done; })()`;

type UiClick = { at: number; label: string | null; icon: string | null; chain: string; area?: string; trusted: boolean; opened: string[] };

const SEND_PATH = "/plateau/chat/send_message";
const WORLD = 1001;
const ITEM = "li.chat-item .chat-item-box[data-random]";

/** 订单区两级只读标签：右侧“最新订单”，其下“个人订单”。返回 clicked | already | not_active | no_tab。 */
function orderTabsScript(uid: string): string {
  return `(async () => {
    const active = document.querySelector(${JSON.stringify(ITEM)} + ".active") ?? document.querySelector("li.chat-item.active .chat-item-box[data-random]");
    if (!active || !(active.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "not_active";
    const text = (el) => (el.textContent || "").replace(/[0-9０-９()（）\\s]/g, "");
    const find = (sel, label) => [...document.querySelectorAll(sel)].find((el) => text(el) === label);
    const press = (el) => {
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      for (const t of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, opts));
    };
    let clicked = false;
    const top = find("div.right-panel div.bar-box li.bar-item", "最新订单");
    if (!top) return "no_tab";
    if (!top.classList.contains("bar-select")) {
      press(top);
      clicked = true;
      await new Promise((r) => setTimeout(r, 400));
    }
    const mine = find("ul.order-panel-header > li.order-panel-second-bar", "个人订单");
    if (!mine) return clicked ? "clicked" : "no_tab";
    if (!mine.classList.contains("bar-select")) {
      press(mine);
      clicked = true;
    }
    return clicked ? "clicked" : "already";
  })()`;
}
const TEXTAREA = "div.reply-box div.reply-input textarea";
const CAMERA = "div.reply-box div.reply-header i.chat-icon.chat-icon-camera";
const VIDEO_ROWS = "ul.video-list-box > li";
const VIDEO_BTN = "button.send-video-btn";
const LIBRARY_SEND_PATH = "/plateau/message/library_file/send";
const SYNC_PATH = "/plateau/sync/message";
/** 已实现页面执行与回执确认的附加类型；其余类型的候选暂不上报。 */
const SENDABLE_ITEMS = new Set(["video", "goods_card", "instruction"]);
const INSTRUCT_BTN = "div.order-item-list div.order-item div.order-btn span.order-btn-item";
const INSTRUCT_DIALOG = "div.el-dialog.goods-desc-modal-part-dialog";

/** 当前对话订单区可见的“发送说明书”按钮个数；已有说明书对话框打开时返回原因。 */
function instructButtonsScript(uid: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    if ([...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].some((d) => d.getClientRects().length > 0)) return "pdd_instruct_dialog_already_open";
    return [...document.querySelectorAll(${JSON.stringify(INSTRUCT_BTN)})].filter((b) => b.getClientRects().length > 0 && (b.textContent || "").trim() === "发送说明书").length;
  })()`;
}

/** 当前对话订单区每个可见“发送说明书”按钮所在订单项的内容指纹（去空白、截 300 字）；取不到或页面上重复的为 null。 */
function instructButtonKeysScript(uid: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    if ([...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].some((d) => d.getClientRects().length > 0)) return "pdd_instruct_dialog_already_open";
    const btns = [...document.querySelectorAll(${JSON.stringify(INSTRUCT_BTN)})].filter((b) => b.getClientRects().length > 0 && (b.textContent || "").trim() === "发送说明书");
    const keys = btns.map((b) => { const item = b.closest("div.order-item"); return item ? "k:" + (item.textContent || "").replace(/\\s+/g, "").slice(0, 300) : null; });
    return keys.map((k) => (k && keys.filter((x) => x === k).length === 1 ? k : null));
  })()`;
}

/** 点开第 index 个“发送说明书”按钮（只打开对话框，页面随之加载该商品的说明书）。 */
function instructOpenScript(uid: string, index: number): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    const btn = [...document.querySelectorAll(${JSON.stringify(INSTRUCT_BTN)})].filter((b) => b.getClientRects().length > 0 && (b.textContent || "").trim() === "发送说明书")[${index}];
    if (!btn) return "pdd_instruct_button_missing";
    btn.scrollIntoView({ block: "nearest" });
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    for (const t of ["mousedown", "mouseup", "click"]) btn.dispatchEvent(new MouseEvent(t, opts));
    return "clicked";
  })()`;
}

/** 唯一可见的说明书对话框须显示该说明书名称，返回其“发送说明书”按钮中心点或原因。 */
function instructDialogScript(uid: string, name: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    const dialogs = [...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].filter((d) => d.getClientRects().length > 0);
    if (dialogs.length !== 1) return dialogs.length ? "pdd_instruct_dialog_not_unique" : "pdd_instruct_dialog_missing";
    if (!(dialogs[0].textContent || "").includes(${JSON.stringify(name)})) return "pdd_instruct_dialog_name_mismatch";
    const btns = [...dialogs[0].querySelectorAll("div.bottom-btn button.el-button--primary")].filter((b) => (b.textContent || "").trim() === "发送说明书");
    if (btns.length !== 1) return "pdd_instruct_send_button_missing";
    const r = btns[0].getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return "pdd_instruct_send_button_hidden";
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    if (top?.closest("button") !== btns[0]) return "pdd_instruct_send_button_covered:" + (top ? [top.tagName.toLowerCase(), ...[...top.classList].slice(0, 3)].join(".") : "none");
    return { x, y };
  })()`;
}

/** 关闭可见的说明书对话框（点右上角 ×）。 */
const INSTRUCT_CLOSE = `(() => {
  const dialogs = [...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].filter((d) => d.getClientRects().length > 0);
  for (const d of dialogs) d.querySelector("button.el-dialog__headerbtn")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0 }));
  return dialogs.length ? "closed" : "none";
})()`;
const GOODS_ROW = "div.goodsRecommendItem";
/** 推荐商品列表变化慢，且发送商品卡片时会重新加载并核对；提交前每买家 5 分钟切一次页签即可，减少订单重读与界面打扰。 */
const GOODS_TAB_REFRESH_MS = 300_000;
const GOODS_BTN = "span.goods-btns-item.goods-btns-blue";
/** 准备阶段推荐商品最多等这么久（毫秒），并给切回订单页签、读订单留出 PREP_ORDERS_RESERVE_MS。 */
const PREP_GOODS_WAIT_MS = 1200;
const PREP_ORDERS_RESERVE_MS = 600;
/** 准备阶段剩余时间不足这么多（毫秒）就不在准备中打开说明书对话框，留给预热。 */
const PREP_INSTRUCT_MIN_MS = 1000;
/** 预热各步的上限（毫秒）；预热随时可被发送与准备抢占。 */
const WARM_GOODS_WAIT_MS = 1500;
const WARM_ORDERS_WAIT_MS = 3000;
const WARM_INSTRUCT_MS = 6000;

/** 预热前确认没人在用这个页面：该买家对话为当前对话、页面没有焦点、输入框为空、没有打开的说明书对话框。 */
function warmIdleScript(uid: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "not_active";
    if (document.hasFocus()) return "page_focused";
    const ta = document.querySelector(${JSON.stringify(TEXTAREA)});
    if (ta && ta.value.trim()) return "input_not_empty";
    if ([...document.querySelectorAll(${JSON.stringify(INSTRUCT_DIALOG)})].some((d) => d.getClientRects().length > 0)) return "dialog_open";
    return "idle";
  })()`;
}

/** 等 p 完成，或预热被抢占时立即返回。 */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return Promise.race([p, new Promise<undefined>((r) => signal.addEventListener("abort", () => r(undefined), { once: true }))]);
}

/** 切到右侧“商品推荐”页签（名称含“商品”且唯一）；仅在该买家对话为当前对话时。返回 clicked | already | not_active | no_tab | ambiguous。 */
function goodsTabScript(uid: string): string {
  return `(() => {
    const active = document.querySelector(${JSON.stringify(ITEM)} + ".active") ?? document.querySelector("li.chat-item.active .chat-item-box[data-random]");
    if (!active || !(active.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "not_active";
    const hits = [...document.querySelectorAll("div.right-panel div.bar-box li.bar-item")].filter((t) => (t.textContent || "").includes("商品"));
    if (hits.length !== 1) return hits.length ? "ambiguous" : "no_tab";
    if (hits[0].classList.contains("bar-select")) return "already";
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    for (const t of ["mousedown", "mouseup", "click"]) hits[0].dispatchEvent(new MouseEvent(t, opts));
    return "clicked";
  })()`;
}

/** “商品推荐”页签各行的地址属性与是否带“发送商品”按钮。 */
const GOODS_ROWS = `(() => {
  const rows = [...document.querySelectorAll(${JSON.stringify(GOODS_ROW)})].filter((el) => el.getClientRects().length > 0);
  if (!rows.length) return "pdd_goods_rows_missing";
  return {
    srcs: rows.map((r) => [...r.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.value).filter((v) => v.startsWith("https://")))),
    hasBtn: rows.map((r) => [...r.querySelectorAll(${JSON.stringify(GOODS_BTN)})].some((b) => (b.textContent || "").trim() === "发送商品")),
  };
})()`;

/** 第 index 行（须仍带该商品缩略图）的“发送商品”按钮中心点。 */
function goodsButtonScript(uid: string, index: number, thumb: string): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    const row = [...document.querySelectorAll(${JSON.stringify(GOODS_ROW)})].filter((el) => el.getClientRects().length > 0)[${index}];
    if (!row) return "pdd_goods_rows_changed";
    if (![...row.querySelectorAll("*")].some((e) => [...e.attributes].some((a) => a.value === ${JSON.stringify(thumb)}))) return "pdd_goods_row_identity_changed";
    const btn = [...row.querySelectorAll(${JSON.stringify(GOODS_BTN)})].find((b) => (b.textContent || "").trim() === "发送商品");
    if (!btn) return "pdd_goods_button_missing";
    btn.scrollIntoView({ block: "nearest" });
    const r = btn.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return "pdd_goods_button_hidden";
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(GOODS_BTN)}) !== btn) return "pdd_goods_button_covered";
    return { x, y };
  })()`;
}

/** 视频弹窗是否已展开并列出视频；未展开时返回相机图标中心点。 */
const VIDEO_PANEL = `(() => {
  const rows = [...document.querySelectorAll(${JSON.stringify(VIDEO_ROWS)})].filter((li) => li.getClientRects().length > 0);
  if (rows.length) return "open";
  const cam = document.querySelector(${JSON.stringify(CAMERA)});
  if (!cam) return "pdd_video_entry_missing";
  const r = cam.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return "pdd_video_entry_hidden";
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(CAMERA)}) !== cam) return "pdd_video_entry_covered";
  return { x, y };
})()`;

/** 当前对话视频弹窗各行的文字，以及第 index 行发送按钮的中心点。 */
function videoRowsScript(uid: string, index: number): string {
  return `(() => {
    const act = document.querySelector(${JSON.stringify(ITEM.replace("[data-random]", ".active[data-random]"))});
    if (!act || !(act.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")})) return "pdd_conversation_changed";
    const rows = [...document.querySelectorAll(${JSON.stringify(VIDEO_ROWS)})].filter((li) => li.getClientRects().length > 0);
    if (!rows.length) return "pdd_video_panel_closed";
    const texts = rows.map((li) => li.querySelector("div.video-item-info")?.textContent || "");
    const srcs = rows.map((li) => [...li.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.value).filter((v) => v.startsWith("https://"))));
    const row = rows[${index}];
    const btn = row?.querySelector(${JSON.stringify(VIDEO_BTN)});
    if (!btn || btn.disabled) return "pdd_video_button_missing";
    btn.scrollIntoView({ block: "nearest" });
    const r = btn.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return "pdd_video_button_hidden";
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(VIDEO_BTN)}) !== btn) return "pdd_video_button_covered";
    return { texts, srcs, x, y };
  })()`;
}
const SEND_BTN = "div.reply-box div.reply-footer div.send-btn";

/** 列表与当前对话状态；__clawSeen 是隔离环境里的标记，页面脚本看不到。 */
const SCAN = `(() => {
  const items = [...document.querySelectorAll(${JSON.stringify(ITEM)})].map((e) => ({ key: e.getAttribute("data-random"), unread: e.classList.contains("un-watch"), active: e.classList.contains("active") }));
  const msgs = document.querySelectorAll("ul.msg-list > li.onemsg");
  const last = msgs[msgs.length - 1];
  const fresh = !!last && !last.__clawSeen;
  if (last) last.__clawSeen = true;
  return { items, freshBuyer: fresh && !!last.querySelector(".buyer-item") };
})()`;

type Scan = { items: { key: string; unread: boolean; active: boolean }[]; freshBuyer: boolean };

export type StarColor = "red" | "orange" | "blue" | "green";
type StarOption = { color: StarColor | "other"; checked: boolean; x: number; y: number };
type StarState = { star: { x: number; y: number; active: boolean }; options: StarOption[] };
type StarSnapshot = { keys: unknown[]; active: boolean; options: StarOption[] };

/**
 * 打开的会话项 key 按买家去重后恰好一个买家时返回它，否则 null。
 * 同一买家可同时出现在“待回复”和“全部”列表并都带 active，算同一个；混入缺失或坏 key 不算唯一。
 */
export function onlyBuyer(keys: unknown[]): string | null {
  const buyers = new Set(keys.map((k) => buyerFromListKey(k)));
  const [only] = buyers;
  return buyers.size === 1 && only ? only : null;
}

/** 对话工具栏的“收藏该用户”星标：返回中心坐标与是否已收藏（active）。 */
const STAR_ICON = `(() => {
  const els = [...document.querySelectorAll('[title="收藏该用户"]')].filter((e) => e.getClientRects().length > 0);
  if (els.length !== 1) return els.length ? "star_not_unique" : "star_missing";
  const icon = els[0].matches("i") ? els[0] : els[0].querySelector("i") ?? els[0];
  const r = icon.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), active: icon.classList.contains("active") || els[0].classList.contains("active") };
})()`;

/** 同一次页面快照：所有带 active 的会话项 key 与工具栏星标是否已收藏；星标缺失或不唯一返回原因。 */
const CONV_STAR_SNAPSHOT = `(() => {
  const keys = [...document.querySelectorAll(${JSON.stringify(ITEM)})].filter((e) => e.classList.contains("active")).map((e) => e.getAttribute("data-random"));
  const els = [...document.querySelectorAll('[title="收藏该用户"]')].filter((e) => e.getClientRects().length > 0);
  if (els.length !== 1) return els.length ? "star_not_unique" : "star_missing";
  const icon = els[0].matches("i") ? els[0] : els[0].querySelector("i") ?? els[0];
  return { keys, active: icon.classList.contains("active") || els[0].classList.contains("active") };
})()`;
export { CONV_STAR_SNAPSHOT };

/**
 * 星标悬停后弹出的颜色列表，按色点背景色识别颜色，带 chat-icon-check 的为当前颜色。
 * 浮层归属只认触发控件关联：星标元素（或其 4 层内祖先/后代）的 aria-describedby 指向的 el-popover id，
 * 且该浮层可见、唯一、含至少三种已知颜色；位置相近、颜色相同的无关菜单不算。证明不了归属就不执行。
 * 传入 check 时改为点击前核对：该坐标处的元素须属于这个浮层中颜色为 check.color 的列表项，且该颜色项在浮层中唯一、未勾选，返回 "ok" 或原因。
 * check.buyer 存在时（标星执行）还在同一次页面快照里核对：打开的会话按买家去重恰好是该买家（conversation_mismatch），
 * 星标未收藏（already_marked）。诊断测试不传 buyer。
 * 不传 check 时返回同一页面快照：所有打开（active）的会话项 key（由调用方按买家去重）、星标是否已收藏、各颜色项。
 */
export function starOptionsScript(check?: { x: number; y: number; color: StarColor; buyer?: string }): string {
  return `(() => {
    const stars = [...document.querySelectorAll('[title="收藏该用户"]')].filter((e) => e.getClientRects().length > 0);
    if (stars.length !== 1) return stars.length ? "star_not_unique" : "star_missing";
    const linked = new Set();
    const addIds = (e) => (e.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean).forEach((id) => linked.add(id));
    [stars[0], ...stars[0].querySelectorAll("[aria-describedby]")].forEach(addIds);
    for (let e = stars[0].parentElement, i = 0; e && i < 4; e = e.parentElement, i++) addIds(e);
    const colorOf = (li) => {
      for (const el of [li, ...li.querySelectorAll("*")]) {
        const m = /rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?\\)/.exec(getComputedStyle(el).backgroundColor);
        if (!m || m[4] === "0") continue;
        const [r, g, b] = [+m[1], +m[2], +m[3]];
        if (r > 200 && g > 200 && b > 200) continue;
        if (r > 200 && g < 130 && b < 130) return "red";
        if (r > 200 && g >= 130 && b < 120) return "orange";
        if (b > 170 && r < 160) return "blue";
        if (g > 140 && r < 160 && b < 160) return "green";
      }
      return "other";
    };
    const known = (p) => new Set([...p.querySelectorAll("ul > li")].map(colorOf).filter((c) => c !== "other")).size;
    const pops = [...document.querySelectorAll("div.el-popover")].filter((p) => p.id && linked.has(p.id) && p.getClientRects().length > 0 && getComputedStyle(p).visibility !== "hidden" && known(p) >= 3);
    if (pops.length !== 1) return pops.length ? "popover_not_unique" : linked.size ? "popover_missing" : "popover_unlinked";
    const acts = [...document.querySelectorAll(${JSON.stringify(ITEM)})].filter((e) => e.classList.contains("active"));
    const icon = stars[0].matches("i") ? stars[0] : stars[0].querySelector("i") ?? stars[0];
    const starActive = icon.classList.contains("active") || stars[0].classList.contains("active");
    const checkedOf = (li) => { const c = li.querySelector("i.chat-icon-check"); return !!c && c.getClientRects().length > 0 && getComputedStyle(c).visibility !== "hidden"; };
    const check = ${JSON.stringify(check ?? null)};
    if (check) {
      const hit = document.elementFromPoint(check.x, check.y);
      const li = hit && hit.closest("li");
      if (!li || !pops[0].contains(li)) return "target_not_in_star_popover";
      if (colorOf(li) !== check.color) return "target_color_mismatch";
      if ([...pops[0].querySelectorAll("ul > li")].filter((x) => colorOf(x) === check.color).length !== 1) return "target_not_unique";
      if (checkedOf(li)) return "target_checked";
      if (check.buyer !== undefined) {
        const buyers = new Set(acts.map((e) => { const m = /^([0-9]{1,32})-/.exec(e.getAttribute("data-random") || ""); return m ? m[1] : null; }));
        if (buyers.size !== 1 || !buyers.has(check.buyer)) return "conversation_mismatch";
        if (starActive) return "already_marked";
      }
      return "ok";
    }
    const options = [...pops[0].querySelectorAll("ul > li")].map((li) => {
      const r = li.getBoundingClientRect();
      const check = li.querySelector("i.chat-icon-check");
      return { color: colorOf(li), checked: !!check && check.getClientRects().length > 0 && getComputedStyle(check).visibility !== "hidden", x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    return { keys: acts.map((e) => e.getAttribute("data-random")), active: starActive, options };
  })()`;
}

type Point = { x: number; y: number };
type TransferRow = { cells: string[]; button: Point | null };
type TransferHooks = {
  check: () => string | null;
  click: (pt: Point, action: boolean, beforePress?: () => void) => Promise<PageClickResult>;
  unmark: (pt: Point) => Promise<PageClickResult>;
};

/** 页面内可见、文字恰为 text 的最深层元素中心坐标，排除位于 exclude 内的元素。不唯一或缺失时返回原因。 */
function textTargetScript(text: string, exclude: string): string {
  return `(() => {
    const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
    const hits = [...document.body.querySelectorAll("*")].filter((e) => vis(e) && !e.closest(${JSON.stringify(exclude)}) && (e.innerText ?? "").trim() === ${JSON.stringify(text)} && ![...e.children].some((c) => (c.innerText ?? "").trim() === ${JSON.stringify(text)}));
    if (hits.length !== 1) return hits.length ? "not_unique" : "missing";
    const r = hits[0].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

/** 可见的“转移会话”对话框中的客服行：各列文字与该行“转移”按钮坐标。 */
const TRANSFER_ROWS = `(() => {
  const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const dlg = [...document.querySelectorAll("div.el-dialog")].filter(vis).find((d) => (d.querySelector(".el-dialog__title")?.innerText ?? "").trim() === "转移会话");
  if (!dlg) return "dialog_missing";
  return [...dlg.querySelectorAll("tr.el-table__row")].filter(vis).map((tr) => {
    const cells = [...tr.querySelectorAll("td")].map((td) => (td.innerText ?? "").trim().slice(0, 40));
    const btn = [...tr.querySelectorAll("*")].filter((e) => vis(e) && (e.innerText ?? "").trim() === "转移" && ![...e.children].some((c) => (c.innerText ?? "").trim() === "转移"));
    const r = btn.length === 1 ? btn[0].getBoundingClientRect() : null;
    return { cells, button: r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null };
  });
})()`;

/** Formal targets keep full account names; oversize, duplicate or incomplete rows are rejected. */
const FORMAL_TRANSFER_ROWS = TRANSFER_ROWS.replace('.trim().slice(0, 40)', '.trim()');

/** “转移会话”对话框里第一列“账号名”恰为 target 的唯一行及其唯一“转移”按钮（页面内脚本片段，供下面两个脚本共用）。 */
function transferTargetSnippet(target: string): string {
  return `
    const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
    const t = (e) => (e.innerText ?? "").trim();
    const dlg = [...document.querySelectorAll("div.el-dialog")].filter(vis).find((d) => t(d.querySelector(".el-dialog__title") ?? d) === "转移会话");
    if (!dlg) return "dialog_missing";
    const trs = [...dlg.querySelectorAll("tr.el-table__row")].filter((tr) => t(tr.querySelector("td") ?? tr) === ${JSON.stringify(target)});
    if (trs.length !== 1) return trs.length ? "target_not_unique" : "target_missing";
    const btns = [...trs[0].querySelectorAll("*")].filter((e) => vis(e) && t(e) === "转移" && ![...e.children].some((c) => t(c) === "转移"));
    if (btns.length !== 1) return "target_button_not_unique";
    const btn = btns[0];`;
}

/** 目标行的“转移”按钮：滚动到可见区域后取中心坐标，并核对该点确实落在这个按钮上（行在表格滚动区外、被遮挡都不点）。 */
function transferTargetScript(target: string, buyer?: string): string {
  return `(() => {${transferTargetSnippet(target)}
    const buyer = ${JSON.stringify(buyer ?? null)};
    if (buyer !== null) {
      const keys = [...document.querySelectorAll(${JSON.stringify(ITEM)})].filter(e => e.classList.contains("active")).map(e => e.getAttribute("data-random") || "");
      const buyers = new Set(keys.map(k => /^([0-9]{1,32})-/.exec(k)?.[1] ?? null));
      if (buyers.size !== 1 || !buyers.has(buyer)) return "conversation_mismatch";
    }
    btn.scrollIntoView({ block: "nearest" });
    const r = btn.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(btn === hit || btn.contains(hit))) return "target_button_covered";
    return { x, y };
  })()`;
}

/** 目标行“转移”按钮当前中心坐标（不滚动、不核对遮挡）：点行后确认气泡可能盖住按钮，这里只核对行仍唯一且没挪位置。 */
function transferTargetRectScript(target: string, buyer?: string): string {
  return `(() => {${transferTargetSnippet(target)}
    const buyer = ${JSON.stringify(buyer ?? null)};
    if (buyer !== null) {
      const keys = [...document.querySelectorAll(${JSON.stringify(ITEM)})].filter(e => e.classList.contains("active")).map(e => e.getAttribute("data-random") || "");
      const buyers = new Set(keys.map(k => /^([0-9]{1,32})-/.exec(k)?.[1] ?? null));
      if (buyers.size !== 1 || !buyers.has(buyer)) return "conversation_mismatch";
    }
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

/** 页面上残留的可见“转移会话”对话框与转移确认气泡（含“无原因直接转移”）个数：上一次诊断没收干净时不再开新的。 */
const TRANSFER_LEFTOVERS = `(() => {
  const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const t = (e) => (e.innerText ?? "").trim();
  const dialogs = [...document.querySelectorAll("div.el-dialog")].filter(vis).filter((d) => t(d.querySelector(".el-dialog__title") ?? d) === "转移会话").length;
  const popovers = [...document.querySelectorAll("div.el-popover")].filter(vis).filter((p) => t(p).includes("无原因直接转移")).length;
  return { dialogs, popovers };
})()`;

/**
 * 目标行“转移”按钮弹出的确认气泡中的可点击项（最深层的短文字元素）文字与坐标。
 * 气泡归属只认该按钮（或其在行内的祖先/后代）aria-describedby 指向的 el-popover id；别的行的气泡、位置相近都不算。
 * 传入 check 时改为点击前核对：该坐标命中的元素须在这个关联气泡里、且属于其中唯一一个文字为 check.text 的控件，返回 "ok" 或原因。
 */
function popoverButtonsScript(target: string, check?: { x: number; y: number; text: string; buyer?: string }): string {
  return `(() => {${transferTargetSnippet(target)}
    const linked = new Set();
    const addIds = (e) => (e.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean).forEach((id) => linked.add(id));
    [btn, ...btn.querySelectorAll("[aria-describedby]")].forEach(addIds);
    for (let e = btn.parentElement; e && e !== trs[0].parentElement; e = e.parentElement) addIds(e);
    if (!linked.size) return "popover_unlinked";
    const pops = [...document.querySelectorAll("div.el-popover")].filter((p) => p.id && linked.has(p.id) && vis(p));
    if (pops.length !== 1) return pops.length ? "popover_not_unique" : "popover_missing";
    const leaves = [...pops[0].querySelectorAll("*")].filter((e) => vis(e) && t(e) && t(e).length <= 8 && ![...e.children].some((c) => t(c) === t(e)));
    const check = ${JSON.stringify(check ?? null)};
    if (check) {
      // 传入 buyer 时，当前打开的对话须恰为该买家：与控件归属、命中在同一次页面快照里核对。
      if (check.buyer !== undefined) {
        const acts = [...document.querySelectorAll(${JSON.stringify(ITEM)})].filter((e) => e.classList.contains("active"));
        const buyers = new Set(acts.map((e) => { const m = /^([0-9]{1,32})-/.exec(e.getAttribute("data-random") || ""); return m ? m[1] : null; }));
        if (buyers.size !== 1 || !buyers.has(check.buyer)) return "conversation_mismatch";
      }
      const own = leaves.filter((e) => t(e) === check.text);
      if (own.length !== 1) return "confirm_not_unique";
      const hit = document.elementFromPoint(check.x, check.y);
      return hit && pops[0].contains(hit) && (own[0] === hit || own[0].contains(hit)) ? "ok" : "confirm_covered";
    }
    return leaves.map((b) => { const r = b.getBoundingClientRect(); return { text: t(b), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
  })()`;
}

/** 平台“转移失败”对话框：返回说明文字（只在本进程内判断类别，不写日志）与两个按钮坐标（唯一时）；没有该对话框返回 null。 */
const TRANSFER_FAIL_DIALOG = `(() => {
  const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const t = (e) => (e.innerText ?? "").trim();
  const leaf = (root, s) => [...root.querySelectorAll("*")].filter((e) => vis(e) && t(e) === s && ![...e.children].some((c) => t(c) === s));
  const title = leaf(document.body, "转移失败");
  if (!title.length) return null;
  let box = title[0];
  for (let i = 0; i < 8 && box.parentElement && !/取消收藏并转移|不可转移|失败./.test(t(box).replace("转移失败", "")); i++) box = box.parentElement;
  const at = (s) => { const b = leaf(box, s); if (b.length !== 1) return null; const r = b[0].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  return { text: t(box).replace(/\\s+/g, " ").slice(0, 80), unfav: at("取消收藏并转移"), keep: at("暂不转移收藏会话") };
})()`;

/** 正式转接只认唯一新出现的收藏拒绝框；买家、两个固定按钮及点击命中在同一快照核对。 */
export function transferUnmarkScript(buyer: string, check?: Point, keepFavorite = false): string {
  return `(() => {
    const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
    const t = (e) => (e.innerText ?? "").trim();
    const leaf = (root, text) => [...root.querySelectorAll("*")].filter(e => vis(e) && t(e) === text && ![...e.children].some(c => t(c) === text));
    const titles = leaf(document.body, "转移失败");
    if (!titles.length) return null;
    if (titles.length !== 1) return "failure_not_unique";
    const keys = [...document.querySelectorAll(${JSON.stringify(ITEM)})].filter(e => vis(e) && e.classList.contains("active")).map(e => e.getAttribute("data-random") || "");
    const buyers = new Set(keys.map(k => /^([0-9]{1,32})-/.exec(k)?.[1] ?? null));
    if (buyers.size !== 1 || !buyers.has(${JSON.stringify(buyer)})) return "conversation_mismatch";
    let box = titles[0].parentElement;
    for (let i = 0; i < 8 && box && box !== document.body; i++, box = box.parentElement) {
      const unfav = leaf(box, "取消收藏并转移"), keep = leaf(box, "暂不转移收藏会话");
      if (!unfav.length || !keep.length) continue;
      if (unfav.length !== 1 || keep.length !== 1 || !t(box).includes("已收藏")) return "failure_invalid";
      const button = ${keepFavorite ? 'keep[0]' : 'unfav[0]'};
      if (button.closest('button[disabled], [aria-disabled="true"]')) return "unmark_disabled";
      const r = button.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const point = ${JSON.stringify(check ?? null)} ?? { x, y };
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || !(button === hit || button.contains(hit))) return "unmark_covered";
      const at = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
      return ${check ? '"ok"' : '{ text: "已收藏", unfav: at(unfav[0]), keep: at(keep[0]) }'};
    }
    return "failure_unrecognized";
  })()`;
}

/** 只点本次转移弹窗自己的空白遮罩；核对和点击在同一次同步快照内，弹窗消失后不会点穿到聊天区。 */
export function transferDialogBlankScript(buyer: string, expiresAt: number): string {
  return `(() => {
    if (Date.now() > ${expiresAt}) return "expired";
    const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
    const dialogs = [...document.querySelectorAll("div.el-dialog")].filter(d => vis(d) && (d.querySelector(".el-dialog__title")?.innerText ?? "").trim() === "转移会话");
    if (dialogs.length !== 1) return dialogs.length ? "dialog_not_unique" : "missing";
    const keys = [...document.querySelectorAll(${JSON.stringify(ITEM)})].filter(e => vis(e) && e.classList.contains("active")).map(e => e.getAttribute("data-random") || "");
    const buyers = new Set(keys.map(k => /^([0-9]{1,32})-/.exec(k)?.[1] ?? null));
    if (buyers.size !== 1 || !buyers.has(${JSON.stringify(buyer)})) return "conversation_mismatch";
    const backdrop = dialogs[0].closest("div.el-dialog__wrapper");
    if (!backdrop || !vis(backdrop)) return "missing";
    const r = backdrop.getBoundingClientRect(), d = dialogs[0].getBoundingClientRect();
    const left = Math.max(0, r.left), top = Math.max(0, r.top);
    const right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    for (const [x, y] of [[left + 4, top + 4], [right - 4, top + 4], [left + 4, bottom - 4], [right - 4, bottom - 4]]) {
      if (x < left || x >= right || y < top || y >= bottom || (x >= d.left && x < d.right && y >= d.top && y < d.bottom)) continue;
      if (document.elementFromPoint(x, y) !== backdrop) continue;
      if (Date.now() > ${expiresAt}) return "expired";
      backdrop.click();
      return "dispatched";
    }
    return "covered";
  })()`;
}

/** 确认气泡里各可点击项按固定类别计数（不记录文字原文：转移原因可能是店铺自填内容）。 */
export function popoverButtonKinds(buttons: { text: string }[]): { cancel: number; direct: number; send: number; other: number } {
  const n = (s: string) => buttons.filter((b) => b.text === s).length;
  const cancel = n("取消"), direct = n("无原因直接转移"), send = n("发送");
  return { cancel, direct, send, other: buttons.length - cancel - direct - send };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 自动清理平台引导弹窗的间隔。 */
export const POPUP_SWEEP_INTERVAL_MS = 2000;

/** 打开会话的等待上限：按剩余预算等待，但不超过该值，保留发送与回执余量。 */
export const OPEN_CONVERSATION_WAIT_MAX_MS = 4000;
/** 未读会话未加载后的短退避：2s、4s、8s… 上限 30s，不再整段停顿 5 分钟。 */
export const OPEN_RETRY_BASE_MS = 2000;
export const OPEN_RETRY_MAX_MS = 30_000;

/** 第 attempt 次未加载成功后的重试间隔（attempt 从 1 开始）。 */
export function nextOpenRetryDelay(attempt: number): number {
  const n = Math.max(1, Math.min(Math.trunc(attempt) || 1, 16));
  return Math.min(OPEN_RETRY_MAX_MS, OPEN_RETRY_BASE_MS * 2 ** (n - 1));
}

/** 清理脚本须在提交后这么久内开始执行，每次点击前也核对；过了就不点击（页面忙时排队迟到的旧脚本不改变页面）。 */
export const POPUP_SWEEP_START_MS = 1500;
/** 清理脚本这么久仍未结束（页面卡住）：重新加载平台页面；旧文档销毁且已过点击时限后才解除与发送的互斥。 */
export const POPUP_SWEEP_STUCK_MS = 10_000;
/** 人工“清理弹窗”最多连清几轮（引导常一层接一层出现）。 */
const POPUP_MANUAL_ROUNDS = 5;

/** 被动解析的接口（仅 mms.pinduoduo.com）。 */
const PARSE_PATHS = new Set(["/chats/userinfo/realtime", "/janus/api/customService/queryCustomServiceInfo", "/plateau/chat/list"]);

function jsonOrNull(text: unknown): unknown {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 拼多多适配器：每店独立分区的平台窗口 + 被动读取页面自身请求的响应。
 * 不主动请求平台接口，不伪造风控参数，不解析二进制长连接。
 * 新消息：自动点开未读对话 / 当前对话出现新买家消息时刷新页面，让页面自己加载对话记录。
 * 发送：在页面输入框填入文字并点页面的发送按钮；页面发出的 send_message 在离开本机前经过核对，
 * 收件人或文字不一致即拦截；以页面发送响应中的平台消息编号确认。
 */
export class PddPageAdapter implements PlatformAdapter {
  readonly kind = "pdd" as const;
  readonly simulated = false;
  private window: PlatformPage | null = null;
  /** 当前平台页面的健康状态；每次新建页面重新开始。 */
  private health = new PageHealth();
  private healthKey = "";
  private readonly listeners: ((e: AdapterEvent) => void)[] = [];
  private readonly tracker = new PddSessionTracker((e) => this.emit(e));
  private probing = false;
  private outgoing: { to_uid: string; text: string; matched: string | null; blocked: number; recheck?: () => string | null; clicked?: () => boolean; resolve: (r: SendResult) => void } | null = null;
  private sendingValue = false;
  private clickText = clickSendWithPlaywright;
  private messageWatcher: PddMessageWatcher | null = null;
  private watchEpoch = 0;
  private pendingFreshBuyer = false;
  private get sending() { return this.sendingValue; }
  private set sending(value: boolean) {
    this.sendingValue = value;
    if (!value) this.messageWatcher?.scheduler.resume();
  }
  private lastActiveUid: string | null = null;
  /** 观察到的打开对话变化次数（扫描或现场读取发现与上次不同即加一），用于识别 A→B→A 这类中途切换。 */
  private clicked: { uid: string; at: number } | null = null;
  private readonly ordersRefreshAt = new Map<string, number>();
  private readonly sendOptions = new PddSendOptionBook((buyer, options) => {
    console.log(`[${this.shopId}] platform send options instructions=${options.filter((o) => o.type === "instruction").length} goods=${options.filter((o) => o.type === "goods_card").length} videos=${options.filter((o) => o.type === "video").length}`);
    this.emit({ type: "send_options", conversation_id: buyer, options: options.filter((o) => SENDABLE_ITEMS.has(o.type)) });
  });
  /** 标星进行中的守护记录与点击窗口（仅内存，见 pddMark.ts）。 */
  private markWatch: MarkWatch | null = null;
  /** 本次组合按钮已派发，等待其同页、同买家的第一条取消收藏请求。 */
  private transferUnmarkWatch: MarkWatch | null = null;
  /** 标星进行中：页面与登录归属是否仍是开始时那一个；失效返回原因。 */
  private markCheck: (() => string | null) | null = null;
  /** 诊断转移（transferTest）的上下文：seq 为本进程内递增的诊断批次序号；账号名只在内存里比较，不写盘。 */
  private transferProbeCtx: { seq: number; target: string; epoch: number; startedAt: number; attemptAt: number | null } | null = null;
  private transferDiagSeq = 0;
  /**
   * 诊断模式下各客服列表类接口（/latitude/assign/*，按路径区分来源）最近一次结果：候选与键值，只在内存里与转移请求的 csid 比较，不写盘。
   * at 为该响应对应请求的发出时间（迟到的响应不重新计时）；candidates/tokens 为 null 表示该来源最近一次无法解析或读取失败。
   */
  private assignSources = new Map<string, { ord: number; epoch: number; at: number; seq: number; candidates: AssignCandidates | null; tokens: AssignTokens | null }>();
  /** 来源路径 → 本进程内匿名序号（日志只写序号，便于核对同一来源，不写路径）。 */
  private assignSourceOrds = new Map<string, number>();
  /** 标星进行中的页面：只认这个页面监听到的标星请求。 */
  private markPage: PlatformPage | null = null;
  /** 页面最近一次发出标星 / 取消收藏请求的本机时间（毫秒），用于点击前静默。 */
  private lastMarkRequestAt = 0;
  /** 附加发送进行中：收集该买家的新消息与页面发送请求结果（仅内存）。 */
  private itemWatch: { buyer: string; path: string; url: string | null; goodsId: string | null; bookId: string | null; seen: SeenMessage[]; clicked: boolean; requests: number; blocked: number; apiOk: boolean | null } | null = null;
  /** 各买家最近一次“商品推荐”列表（页面自己的请求），按接口分组顺序展开。 */
  private readonly goodsRows = new Map<string, { rows: GoodsRow[]; at: number }>();
  private readonly goodsTabAt = new Map<string, number>();
  private readonly instructTriedAt = new Map<string, number>();
  /**
   * 每买家一轮说明书收集的进度（只在内存）：已成功打开的按钮所在订单项的内容指纹，以及本轮已打开的次数。
   * 预算耗尽或被抢占时保留，下次（通常是预热）只跳过指纹完全相同、且在页面上唯一的按钮——按钮重排、插入、删除后仍能对上；
   * 指纹缺失、重复或内容变化的按钮一律重新打开，不按旧位置跳过。一轮最多打开 3 次，全部新鲜、试满或超过 10 分钟就开始新一轮。
   */
  private readonly instructRound = new Map<string, { done: Set<string>; opens: number; startedAt: number }>();
  /** 最近一次页面自己的说明书查询（点订单上“发送说明书”触发）。 */
  private lastInstruct: { request: unknown; response: unknown; at: number } | null = null;
  /** 最近一次完整视频库列表（第一页、无搜索），按页面顺序。 */
  private videoRows: VideoRow[] | null = null;
  private optionsPrepared = false;
  /** 上次展开视频弹窗的结果：每 15 秒重试，结果不变时不重复记日志（没打开对话时入口本就不在）。 */
  private prepareResult: string | null = null;
  /** 进行中的预热；发送与准备开始前先让它在下一步之间停下（不以“忙”拒绝发送）。 */
  private warmRun: { ctrl: AbortController; done: Promise<void> } | null = null;
  /**
   * 进行中的弹窗清理。清理只在没有发送、准备、预热时开始；发送与准备开始前先等它结束，
   * 所以点击坐标规划期间页面不会因清理而变化。清理关掉了浮层时页面代次加一，未执行的点击按页面已变化放弃。
   * 占用页面的规则：等待（await）只是等，不算占用。多个等待者可能同时被唤醒，所以每个入口都要在最后一次 await
   * 返回后的同一同步段里复核“没有清理 / 预热 / 发送”并立即置 sending（或启动清理），中间不得再 await；
   * 复核不通过就继续等（do … while）。清理的启动（sweepPopupsOnce）同步设置 popupSweep。
   */
  private popupSweep: Promise<PopupSweepResult | null> | null = null;
  private readonly popupSeen = new Set<string>();
  private openFailures = new Map<string, { count: number; until: number }>();
  private reloadAt = 0;
  private offChatSince = 0;
  /** 最近一次通知界面的平台页面导航状态（noteNav 去重用）。 */
  private navKey = "";
  private lastSummary = "";
  private recentRequests: { at: number; req: string }[] = [];
  private readonly orders = new PddOrderBook((buyer, orders) => {
    console.log(`[${this.shopId}] platform orders count=${orders.length}`);
    this.emit({ type: "orders", conversation_id: buyer, orders });
  });

  /**
   * probeFile：只读诊断（CLAW_NEXT_PDD_PROBE=1），记录请求方法/域名/路径/状态码与指定接口的字段结构，
   * 不记录查询参数、请求/响应内容和 Cookie。
   */
  constructor(private readonly shopId: string, _title: string, private readonly probeFile: string | null = null, private readonly createPage?: () => PlatformPage) {}

  private attachNetwork(win: PlatformPage) {
    const schemaFile = this.probeFile?.replace(/requests\.jsonl$/, "schema.jsonl") ?? null;
    const write = (rec: Record<string, unknown>) => {
      if (schemaFile) fs.appendFile(schemaFile, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", { mode: 0o600 }, () => undefined);
    };
    const markedFile = this.probeFile?.replace(/requests\.jsonl$/, "marked.jsonl") ?? null;
    const writeMarked = (rec: MarkProbeRecord | null) => {
      if (markedFile && rec) fs.appendFile(markedFile, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", { mode: 0o600 }, () => undefined);
    };
    const transferFile = this.probeFile?.replace(/requests\.jsonl$/, "transfer-probe.jsonl") ?? null;
    // 转移取证：转移、关闭会话、客服列表三类请求按 CDP requestId 配对（只在诊断模式下记录）。请求发出时冻结页面代次、
    // 诊断批次与尝试时间；日志只写本进程内的匿名请求序号 req_seq（不写 CDP requestId）。
    type TransferReq = { kind: TransferProbePath; source: string | null; postData: string | null; seq: number; at: number; epoch: number; diag: { seq: number; target: string; attemptAt: number | null } | null };
    const transferReqs = new Map<string, TransferReq>();
    let transferReqSeq = 0;
    const bindingNow = (r: TransferReq): TransferBinding => bindingOf({ epoch: r.epoch, diag: r.diag?.seq ?? null }, { epoch: this.watchEpoch, diag: this.transferProbeCtx?.seq ?? null });
    const writeTransfer = (r: TransferReq, binding: TransferBinding, rec: TransferProbeRecord) => {
      if (!transferFile) return;
      const bound = binding === "bound" && r.diag !== null;
      const extra = { req_seq: r.seq, binding, diag_seq: r.diag?.seq ?? null, ms_after_attempt: bound && r.diag!.attemptAt !== null ? r.at - r.diag!.attemptAt : null };
      fs.appendFile(transferFile, JSON.stringify({ at: new Date().toISOString(), ...rec, ...extra }) + "\n", { mode: 0o600 }, () => undefined);
    };
    const dbg = win.webContents.debugger;
    // 标星守护期间，页面收到的每条输入事件都须与前台自己的输入命令配对，否则视为人工介入（契约“来源绑定”）。
    win.webContents.on("input-event", (_e, input) => {
      const w = this.markWatch;
      if (w) observeInput(w, input?.type);
    });
    // 监听只装一次；渲染进程崩溃会使调试通道断开，恢复时由 enableNetwork 重新附加并开启拦截。
    const pending = new Map<string, { path: string; postData: string | null; buyer: string | null; epoch: number; optionsEpoch: number; markEpoch: number | null }>();
    const markWatched = (p: string) => p === MARK_REQUEST_PATH || p === UNMARK_REQUEST_PATH || p === MARKED_LIST_PATH;
    const discovered = new Map<string, string>();
    const seen = new Set<string>();
    const writeOnce = (kind: string, p: string, schema: unknown) => {
      const key = kind + p + JSON.stringify(schema);
      if (seen.has(key)) return;
      seen.add(key);
      write({ kind, path: p, schema });
    };
    dbg.on("message", (_e, method, params: any, sessionId?: string) => {
      if (sessionId) return;
      if (method === "Network.requestWillBeSent") {
        if (transferFile) {
          try {
            const tk = transferProbePath(params.request?.url);
            if (tk) {
              const postData = typeof params.request.postData === "string" ? params.request.postData : null;
              const epoch = this.watchEpoch;
              const ctx = this.transferProbeCtx;
              const live = ctx !== null && ctx.epoch === epoch && Date.now() - ctx.startedAt < TRANSFER_PROBE_CTX_MS;
              const source = tk === "assign" ? new URL(params.request.url).pathname : null;
              const r: TransferReq = { kind: tk, source, postData, seq: ++transferReqSeq, at: Date.now(), epoch, diag: live ? { seq: ctx.seq, target: ctx.target, attemptAt: ctx.attemptAt } : null };
              transferReqs.set(params.requestId, r);
              if (tk !== "assign") {
                const assign = this.assignFor(epoch);
                const tokens = this.assignTokensFor(epoch);
                const sources = this.liveAssignSources(epoch).length;
                void this.freshActive(epoch)
                  .catch(() => null)
                  .then((uid) => {
                    // 现场读取完成后再核对一次：页面或诊断批次变了，就不关联诊断目标。
                    const binding = bindingNow(r);
                    const target = binding === "bound" ? r.diag!.target : null;
                    writeTransfer(r, binding, tk === "move" ? { ...moveRequestProbe(postData, uid, target, assign, tokens), assign_sources: sources } : closeRequestProbe(postData, uid));
                  })
                  .catch(() => undefined);
              }
            }
          } catch {
            // 诊断记录失败不得影响消息回调。
          }
        }
        const p = probePath(params.request?.url);
        const action = !p && schemaFile ? actionProbePath(params.request?.url) : null;
        if (action) {
          discovered.set(params.requestId, action);
          try {
            if (typeof params.request.postData === "string") writeOnce("action_request", action, actionSchemaOf(params.request.postData));
          } catch {
            // 诊断记录失败不得影响消息回调。
          }
          return;
        }
        if (!p) return;
        const postData = typeof params.request.postData === "string" ? params.request.postData : null;
        const markEpoch = schemaFile && markWatched(p) ? this.watchEpoch : null;
        pending.set(params.requestId, { path: p, postData, buyer: this.orders.started(p, jsonOrNull(postData)), epoch: this.orders.epoch, optionsEpoch: this.sendOptions.epoch, markEpoch });
        if (postData && schemaFile) write({ kind: "request", path: p, schema: schemaOf(postData) });
        if (markEpoch !== null && p !== MARKED_LIST_PATH) {
          void this.freshActive(markEpoch)
            .catch(() => null)
            .then((uid) => writeMarked(markRequestProbe(p, postData, uid)))
            .catch(() => undefined);
        }
      } else if (method === "Network.loadingFinished") {
        const tr = transferReqs.get(params.requestId);
        if (tr) {
          transferReqs.delete(params.requestId);
          const before = bindingNow(tr);
          dbg
            .sendCommand("Network.getResponseBody", { requestId: params.requestId })
            .then((r: any) => {
              const body = r.base64Encoded ? null : (r.body as string);
              const binding = combineBinding(before, bindingNow(tr));
              if (tr.kind !== "assign") return writeTransfer(tr, binding, transferResponseProbe(tr.kind, body));
              const candidates = extractAssignEntries(body);
              const tokens = assignTokens(body);
              // 按来源记下最新结果：同一来源的空列表、无法解析的响应同样覆盖旧结果（旧的肯定结论随之失效）；页面已变或更旧的响应不采用。
              const { cached, ord } = this.recordAssignSource(tr, candidates, tokens);
              const target = binding === "bound" && tr.diag ? tr.diag.target : null;
              writeTransfer(tr, binding, { kind: "assign_response", parsed: candidates !== null, candidates: candidates?.entries.length ?? 0, candidates_complete: candidates ? candidates.complete : null, cached, source_ord: ord, ...assignNameProbe(candidates, target) });
            })
            .catch(() => {
              const src = tr.kind === "assign" ? this.recordAssignSource(tr, null, null) : null;
              writeTransfer(tr, combineBinding(before, bindingNow(tr)), { kind: `${tr.kind}_response`, body_unavailable: true, ...(src ? { cached: src.cached, source_ord: src.ord } : {}) });
            });
        }
        const action = discovered.get(params.requestId);
        if (action) {
          discovered.delete(params.requestId);
          dbg
            .sendCommand("Network.getResponseBody", { requestId: params.requestId })
            .then((r: any) => writeOnce("action_response", action, actionSchemaOf(r.base64Encoded ? null : (r.body as string))))
            .catch(() => undefined);
          return;
        }
        const req = pending.get(params.requestId);
        if (!req) return;
        pending.delete(params.requestId);
        // 标星响应：读取前先核对一次页面与登录归属（读取后在 onMarkResponse 里再核对）。
        const markLost = req.path === MARK_REQUEST_PATH ? (this.markCheck?.() ?? null) : null;
        dbg
          .sendCommand("Network.getResponseBody", { requestId: params.requestId })
          .finally(() => this.orders.finished(req.buyer))
          .then((r: any) => {
            const body = r.base64Encoded ? null : (r.body as string);
            if (req.path === MARK_REQUEST_PATH) this.onMarkResponse(params.requestId, body, false, markLost);
            if (req.path === SEND_PATH) this.onSendResponse(params.requestId, body);
            if (req.path === LIBRARY_SEND_PATH || req.path === GOODS_CARD_SEND_PATH || req.path === INSTRUCT_SEND_PATH || req.path === SYNC_PATH) this.onItemResponse(req.path, body);
            if (!PddOrderBook.watches(req.path) || req.epoch === this.orders.epoch) this.handleResponse(req.path, req.postData, body);
            if (req.path === VIDEO_LIST_PATH && req.optionsEpoch === this.sendOptions.epoch) {
              this.videoRows = parseVideoRows(jsonOrNull(req.postData), jsonOrNull(body)) ?? this.videoRows;
            }
            if (req.path === INSTRUCT_PATH && req.optionsEpoch === this.sendOptions.epoch) this.lastInstruct = { request: jsonOrNull(req.postData), response: jsonOrNull(body), at: Date.now() };
            if (req.path === RECOMMEND_GOODS_PATH && req.optionsEpoch === this.sendOptions.epoch) {
              const goods = parseRecommendGoods(jsonOrNull(req.postData), jsonOrNull(body));
              if (goods) this.goodsRows.set(goods.buyer, { rows: goods.rows, at: Date.now() });
            }
            if (PddSendOptionBook.watches(req.path) && req.optionsEpoch === this.sendOptions.epoch) this.sendOptions.response(req.path, jsonOrNull(req.postData), jsonOrNull(body), Math.floor(Date.now() / 1000));
            if (!schemaFile) return;
            if (req.markEpoch !== null && req.path !== MARKED_LIST_PATH) writeMarked(markResponseProbe(req.path, req.postData, body));
            if (req.markEpoch !== null && req.path === MARKED_LIST_PATH) {
              void this.freshActive(req.markEpoch)
                .catch(() => null)
                .then((uid) => writeMarked(markedListProbe(req.path, body, uid)))
                .catch(() => undefined);
            }
            const schema = schemaOf(body);
            const key = req.path + JSON.stringify(schema);
            if (seen.has(key)) return;
            seen.add(key);
            write({ kind: "response", path: req.path, schema });
          })
          .catch(() => {
            // 取不到响应体：放行的标星请求按加载失败处理（已有结论时不覆盖）。
            if (req.path === MARK_REQUEST_PATH) this.onMarkResponse(params.requestId, null, true, markLost);
          });
      } else if (method === "Network.loadingFailed") {
        const trFailed = transferReqs.get(params.requestId);
        if (trFailed) {
          transferReqs.delete(params.requestId);
          const src = trFailed.kind === "assign" ? this.recordAssignSource(trFailed, null, null) : null;
          writeTransfer(trFailed, bindingNow(trFailed), { kind: `${trFailed.kind}_response`, load_failed: true, ...(src ? { cached: src.cached, source_ord: src.ord } : {}) });
        }
        discovered.delete(params.requestId);
        const failed = pending.get(params.requestId);
        this.orders.finished(failed?.buyer ?? null);
        pending.delete(params.requestId);
        if ((failed?.path === LIBRARY_SEND_PATH || failed?.path === GOODS_CARD_SEND_PATH || failed?.path === INSTRUCT_SEND_PATH) && this.itemWatch?.clicked) this.itemWatch.apiOk = false;
        this.onMarkResponse(params.requestId, null, true);
        const out = this.outgoing;
        if (out && out.matched === params.requestId) out.resolve({ status: "unknown", reason: "platform_request_failed" });
      } else if (method === "Fetch.requestPaused") {
        const paused = probePath(params.request?.url);
        if (paused === LIBRARY_SEND_PATH || paused === GOODS_CARD_SEND_PATH || paused === INSTRUCT_SEND_PATH) this.onItemSendPaused(dbg, params, paused);
        else if (paused === MARK_REQUEST_PATH || paused === UNMARK_REQUEST_PATH) this.onMarkPaused(dbg, params, paused === MARK_REQUEST_PATH ? "mark" : "unmark", win);
        else this.onSendPaused(dbg, params);
      }
    });
    this.enableNetwork(win);
  }

  /** 附加调试通道（未附加时）并开启网络观察与发送拦截。返回调试通道是否已附加。 */
  private enableNetwork(win: PlatformPage): boolean {
    if (win.isDestroyed()) return false;
    const dbg = win.webContents.debugger;
    if (dbg.isAttached()) return true;
    try {
      dbg.attach("1.3");
    } catch {
      return false;
    }
    void dbg.sendCommand("Network.enable").catch(() => undefined);
    void dbg
      .sendCommand("Fetch.enable", {
        patterns: [SEND_PATH, LIBRARY_SEND_PATH, GOODS_CARD_SEND_PATH, INSTRUCT_SEND_PATH, MARK_REQUEST_PATH, UNMARK_REQUEST_PATH].map((p) => ({ urlPattern: "*://mms.pinduoduo.com" + p + "*", requestStage: "Request" })),
      })
      .catch(() => undefined);
    return true;
  }

  /** 页面发出的每个 send_message 都在此核对；有进行中的自动发送时，不一致即拦截，请求不会到达平台。 */
  private onSendPaused(dbg: Electron.Debugger, params: any) {
    const out = this.outgoing;
    let invalid = false;
    try { invalid = !!out && !!(out.matched || out.recheck?.() || (out.clicked && !out.clicked())); }
    catch { invalid = true; }
    const decision = invalid ? "block" : decideOutgoing(out, parseSendRequest(jsonOrNull(params.request?.postData)));
    console.log(`[${this.shopId}] platform send_message ${decision}`);
    if (decision === "block") {
      if (out) out.blocked += 1;
      void dbg.sendCommand("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      return;
    }
    if (decision === "match" && out) out.matched = params.networkId ?? params.requestId;
    void dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => undefined);
  }

  /** 附加发送期间页面发出的视频/商品卡片发送请求：仅放行本次点击发往目标买家、对象一致的第一条，其余在本机拦截。 */
  private onItemSendPaused(dbg: Electron.Debugger, params: any, p: string) {
    const watch = this.itemWatch;
    if (!watch) {
      void dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => undefined);
      return;
    }
    const body = jsonOrNull(params.request?.postData);
    const ok = p !== watch.path ? false : p === LIBRARY_SEND_PATH ? libraryRequestAllowed(watch, body) : p === GOODS_CARD_SEND_PATH ? goodsRequestAllowed(watch, body) : instructRequestAllowed(watch, body);
    console.log(`[${this.shopId}] platform ${p === LIBRARY_SEND_PATH ? "library_file/send" : p === GOODS_CARD_SEND_PATH ? "mallGoodsCard" : "goodsInstruct/sendToUser"} ${ok ? "match" : "block"}`);
    if (!ok) {
      watch.blocked += 1;
      void dbg.sendCommand("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      return;
    }
    watch.requests += 1;
    void dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => undefined);
  }

  /**
   * 页面发出的标星 / 取消收藏请求（契约“请求核对”）。没有进行中的标星、或不在点击窗口内时照常放行
   * （店主手动操作不受影响）；窗口内只放行与本次一致的第一条 mark 请求，其余在发出前拦截，不会到达平台。
   */
  private onMarkPaused(dbg: Electron.Debugger, params: any, kind: "mark" | "unmark", source: PlatformPage) {
    this.lastMarkRequestAt = Date.now();
    const w = this.markWatch;
    if (!w || !w.open || w.closed) {
      // 点击前（守护期间）出现的请求照常放行，但本次放弃点击（契约“来源绑定·点击前静默”）。
      if (w && !w.closed) {
        const body = jsonOrNull(params.request?.postData);
        const data = body && typeof body === "object" && "data" in body ? body.data : null;
        const expectedUnmark = kind === "unmark" && this.transferUnmarkWatch === w && source === this.markPage
          && w.epoch === this.watchEpoch && data && typeof data === "object" && "uid" in data && data.uid === w.buyer;
        if (expectedUnmark) this.transferUnmarkWatch = null;
        else w.before += 1;
      }
      void dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => undefined);
      return;
    }
    // 实际放行前先复核原操作的页面与登录店铺归属（来源页面须是本次标星的页面）；失效即锁存并拦截，结论保持 unknown。
    const lost = source !== this.markPage ? "page_changed_during_mark" : (this.markCheck?.() ?? null);
    if (lost) w.invalid ??= lost;
    const verdict = w.invalid ? ({ allow: false } as const) : markRequestVerdict(w, kind, this.watchEpoch, params.networkId, params.request?.postData);
    console.log(`[${this.shopId}] platform ${kind}_conversation ${verdict.allow ? "match" : "block"}`);
    if (!verdict.allow) {
      w.blocked += 1;
      void dbg.sendCommand("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      return;
    }
    w.allowed = { networkId: verdict.networkId, requestId: verdict.requestId };
    void dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(() => undefined);
  }

  /**
   * 放行的那条标星请求自己的响应（按浏览器请求编号配对，不按到达顺序）；窗口关闭后到达的不算，先到的结论为准。
   * 读取前（lostBefore）与读取后各核对一次页面与登录归属，任一失效即记为失效，结论只能是 unknown。
   */
  private onMarkResponse(networkId: string, body: string | null, failed = false, lostBefore: string | null = null) {
    const w = this.markWatch;
    if (!w || w.closed || !w.allowed || w.allowed.networkId !== networkId || w.outcome) return;
    const lost = lostBefore ?? this.markCheck?.() ?? null;
    if (lost) w.invalid ??= lost;
    w.outcome = failed ? "failed" : markResponseOk(w.allowed.requestId, body) ? "ok" : "bad";
    console.log(`[${this.shopId}] platform mark_conversation response outcome=${w.outcome}`);
  }

  private onItemResponse(p: string, body: string | null) {
    const watch = this.itemWatch;
    if (!watch) return;
    const json = jsonOrNull(body) as { success?: unknown; error_code?: unknown } | null;
    if (p === LIBRARY_SEND_PATH) {
      if (watch.clicked) watch.apiOk = libraryResponseOk(json);
      console.log(`[${this.shopId}] platform library_file/send response success=${String(json?.success)} error_code=${typeof json?.error_code === "number" ? json.error_code : typeof json?.error_code}`);
    } else if (p === INSTRUCT_SEND_PATH) {
      if (watch.clicked) watch.apiOk = instructResponseOk(json);
      console.log(`[${this.shopId}] platform goodsInstruct/sendToUser response success=${String(json?.success)} error_code=${typeof json?.error_code === "number" ? json.error_code : typeof json?.error_code}`);
    } else if (p === GOODS_CARD_SEND_PATH) {
      if (watch.clicked) watch.apiOk = goodsResponseOk(json);
      console.log(`[${this.shopId}] platform mallGoodsCard response success=${String(json?.success)} result=${String((json as { result?: unknown } | null)?.result)} error_code=${typeof json?.error_code === "number" ? json.error_code : typeof json?.error_code}`);
    } else {
      watch.seen.push(...parseSyncMessages(json).filter((m) => m.buyer === watch.buyer));
    }
  }

  private onSendResponse(requestId: string, body: string | null) {
    const out = this.outgoing;
    if (!out || out.matched !== requestId) return;
    const r = parseSendResponse(jsonOrNull(body));
    out.resolve(r.confirmed ? { status: "confirmed", platform_message_id: r.msg_id } : { status: "unknown", reason: r.reason });
  }

  private run<T>(code: string): Promise<T> {
    const win = this.window;
    if (!win || win.isDestroyed()) return Promise.reject(new Error("platform_window_closed"));
    return win.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>;
  }

  private clickConversation(uid: string, notAfter = Date.now() + 5000): Promise<boolean> {
    return this.run<boolean>(`(() => {
      if (Date.now() >= ${JSON.stringify(notAfter)}) return false;
      const match = (e) => (e.getAttribute("data-random") || "").startsWith(${JSON.stringify(uid + "-")});
      const el = [...document.querySelectorAll("div.all-chat-list " + ${JSON.stringify(ITEM)})].find(match) ?? [...document.querySelectorAll(${JSON.stringify(ITEM)})].find(match);
      if (!el) return false;
      if (el.classList.contains("active")) return true;
      const target = el.querySelector(".chat-detail") ?? el;
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.dispatchEvent(new MouseEvent("click", opts));
      return true;
    })()`);
  }

  /** 抢占预热：通知它停下并等它收尾（关闭已打开的对话框、释放页面）。 */
  private async yieldWarm(): Promise<void> {
    await this.popupIdle();
    const run = this.warmRun;
    if (!run) return;
    run.ctrl.abort();
    await run.done;
    await this.popupIdle();
  }

  /** 等进行中的弹窗清理结束。 */
  private async popupIdle(): Promise<void> {
    while (this.popupSweep) await this.popupSweep;
  }

  /**
   * 在当前页面执行一次弹窗清理；记录点过的按钮，跳过的浮层同一签名只记一次（只有结构与短标题）。
   * 互斥一直保持到脚本真正结束，或页面文档已销毁（导航、渲染进程退出、页面关闭）且已过脚本的点击时限——
   * 不按超时解除，所以未结束的清理不会与发送交错。脚本迟迟不结束时重新加载页面，由导航结束它。
   */
  private sweepPopupsOnce(win: PlatformPage, mode: PopupSweepMode): Promise<PopupSweepResult | null> {
    const wc = win.webContents;
    if (win.isDestroyed() || wc.isLoadingMainFrame()) return Promise.resolve(null);
    const deadline = Date.now() + POPUP_SWEEP_START_MS;
    // 文档已销毁或脚本被放弃（执行失败）：等过了点击时限再解除——脚本若因消息乱序落到新文档，开始时也已过时限、不会点击。
    const afterDeadline = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline + 200 - Date.now())));
    let gone = () => {};
    const pageGone = new Promise<null>((resolve) => (gone = () => void afterDeadline().then(resolve)));
    const events = ["did-navigate", "render-process-gone", "destroyed"] as const;
    for (const e of events) wc.on(e as "destroyed", gone);
    const stuck = setTimeout(() => {
      if (this.window !== win || win.isDestroyed()) return;
      console.log(`[${this.shopId}] platform popup sweep stuck: reload page`);
      this.reload("popup_sweep_stuck", true);
    }, POPUP_SWEEP_STUCK_MS);
    let script: Promise<unknown>;
    try {
      script = wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: popupSweepScript(mode, deadline) }]);
    } catch {
      script = Promise.resolve(null);
    }
    const run = Promise.race([script as Promise<PopupSweepResult>, pageGone])
      .catch(afterDeadline)
      .then((r) => {
        clearTimeout(stuck);
        for (const e of events) wc.removeListener(e as "destroyed", gone);
        if (!r || !Array.isArray(r.dismissed) || !Array.isArray(r.seen)) return null;
        if (r.expired) console.log(`[${this.shopId}] platform popup sweep expired: page busy, nothing clicked after deadline`);
        if (r.dismissed.length) this.watchEpoch++;
        for (const d of r.dismissed) console.log(`[${this.shopId}] platform popup dismissed mode=${mode} label=${d.label} layer=${d.layer}`);
        for (const v of r.seen) {
          const key = `${v.why}|${v.layer}|${v.title ?? ""}`;
          if (this.popupSeen.has(key) || this.popupSeen.size >= 50) continue;
          this.popupSeen.add(key);
          console.log(`[${this.shopId}] platform popup kept why=${v.why} layer=${v.layer} title=${v.title ?? "-"}`);
        }
        return r;
      });
    const tracked: Promise<PopupSweepResult | null> = run.finally(() => {
      if (this.popupSweep === tracked) this.popupSweep = null;
    });
    this.popupSweep = tracked;
    return tracked;
  }

  /** 定时自动清理：只在已登录的聊天页、没有发送/准备/预热、页面未在加载时进行。 */
  private autoPopups(win: PlatformPage) {
    if (this.window !== win || win.isDestroyed() || this.popupSweep || this.sending || this.outgoing || this.warmRun) return;
    if (!this.tracker.status(true).logged_in || win.webContents.isLoadingMainFrame() || !win.webContents.getURL().startsWith(LOGIN_URL)) return;
    void this.sweepPopupsOnce(win, "auto");
  }

  /**
   * 人工“清理弹窗”：连清最多 5 轮（每轮间隔 0.4 秒），另外处理浮层里的“关闭 / 取消”与任意浮层的关闭图标。
   * 发送进行中返回 pdd_send_busy；发送在两轮之间开始时就此停止。
   */
  async dismissPopups(): Promise<{ dismissed: number } | { blocked: string }> {
    const win = this.window;
    if (!win || win.isDestroyed()) return { blocked: "platform_window_closed" };
    if (this.sending || this.outgoing) return { blocked: "pdd_send_busy" };
    let dismissed = 0;
    for (let round = 0; round < POPUP_MANUAL_ROUNDS; round++) {
      do await this.popupIdle(); while (this.popupSweep);
      if (this.window !== win || win.isDestroyed() || this.sending || this.outgoing || this.warmRun) break;
      const r = await this.sweepPopupsOnce(win, "manual");
      if (!r?.dismissed.length) break;
      dismissed += r.dismissed.length;
      await sleep(400);
    }
    return { dismissed };
  }

  private reload(why: string, force = false) {
    const win = this.window;
    if (!win || win.isDestroyed() || (!force && Date.now() - this.reloadAt < 15_000)) return;
    this.reloadAt = Date.now();
    this.lastActiveUid = null;
    console.log(`[${this.shopId}] platform reload: ${why}`);
    win.webContents.reload();
  }

  /** 让页面加载有新消息的对话：点开未读对话；当前对话出现新买家消息则刷新页面。 */
  private async watch() {
    // 预热不挡新消息：有未读对话或当前对话出现新买家消息时先抢占预热，再照常处理。
    if (this.warmRun) {
      const pre = await this.run<Scan>(SCAN).catch(() => null);
      if (!pre || !(pre.freshBuyer || pre.items.some((i) => i.unread && !i.active))) return;
      if (pre.freshBuyer) this.pendingFreshBuyer = true;
      await this.yieldWarm();
    }
    if (this.sending || !this.tracker.status(true).logged_in) return;
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const epoch = this.watchEpoch;
    // 离开聊天页就看不到新消息：停留超过 30 秒自动回到聊天页。
    if (!win.webContents.getURL().startsWith(LOGIN_URL)) {
      this.offChatSince ||= Date.now();
      if (Date.now() - this.offChatSince > 30_000) {
        this.offChatSince = 0;
        this.lastActiveUid = null;
        console.log(`[${this.shopId}] platform return to chat page`);
        void win.loadURL(LOGIN_URL).catch(() => undefined);
      }
      return;
    }
    this.offChatSince = 0;
    let scan: Scan;
    try {
      scan = await this.run<Scan>(SCAN);
    } catch {
      return;
    }
    if (this.window !== win || win.isDestroyed() || epoch !== this.watchEpoch) return;
    if (this.sending) {
      this.pendingFreshBuyer ||= scan.freshBuyer;
      this.messageWatcher?.scheduler.request();
      return;
    }
    scan.freshBuyer ||= this.pendingFreshBuyer;
    this.pendingFreshBuyer = false;
    const summary = `items=${scan.items.length} unread=${scan.items.filter((i) => i.unread).length} active=${scan.items.some((i) => i.active)} freshBuyer=${scan.freshBuyer}`;
    if (summary !== this.lastSummary) console.log(`[${this.shopId}] platform watch ${(this.lastSummary = summary)}`);
    const active = scan.items.find((i) => i.active);
    const activeUid = active ? buyerFromListKey(active.key) : null;
    const sameActive = activeUid !== null && activeUid === this.lastActiveUid;
    this.lastActiveUid = activeUid;
    const now = Date.now();
    if (this.clicked && now - this.clicked.at > 4000) {
      const { uid } = this.clicked;
      const loaded = this.tracker.lastLoadedAt(uid) * 1000 >= this.clicked.at;
      const isActive = activeUid === uid;
      console.log(`[${this.shopId}] platform auto-open loaded=${loaded} active=${isActive}`);
      this.clicked = null;
      if (loaded) this.openFailures.delete(uid);
      else {
        const f = this.openFailures.get(uid) ?? { count: 0, until: 0 };
        f.count += 1;
        // 有上限的短退避：该会话只是延后重试，消息仍保持未处理，不再整段停顿 5 分钟。
        const delay = nextOpenRetryDelay(f.count);
        f.until = now + delay;
        if (f.count === 1) this.reload("conversation_not_loaded_after_open");
        console.log(`[${this.shopId}] platform auto-open retry attempt=${f.count} delay_ms=${delay}`);
        this.openFailures.set(uid, f);
      }
    }
    if (sameActive && scan.freshBuyer) return this.reload("new_buyer_message_in_open_conversation");
    if (this.clicked) return;
    const unread = scan.items.find((i) => {
      const uid = i.unread && !i.active ? buyerFromListKey(i.key) : null;
      return uid !== null && (this.openFailures.get(uid)?.until ?? 0) < now;
    });
    if (!unread) return;
    const uid = buyerFromListKey(unread.key) as string;
    if (await this.clickConversation(uid).catch(() => false)) this.clicked = { uid, at: now };
  }

  private handleResponse(p: string, postData: string | null, body: string | null) {
    if (PddOrderBook.watches(p)) return this.orders.response(p, jsonOrNull(postData), jsonOrNull(body), Math.floor(Date.now() / 1000));
    if (!PARSE_PATHS.has(p)) return;
    const json = jsonOrNull(body);
    if (p === "/chats/userinfo/realtime") {
      const id = parseRealtimeUserInfo(json);
      if (id) this.tracker.identityFromRealtime(id);
    } else if (p === "/janus/api/customService/queryCustomServiceInfo") {
      const id = parseCustomServiceInfo(json);
      if (id) this.tracker.identityFromCsInfo(id);
    } else {
      const list = parseChatList(jsonOrNull(postData), json, this.shopId);
      console.log(`[${this.shopId}] platform chat/list ${list ? `messages=${list.messages.length} skipped=${list.skipped} has_more=${list.has_more}` : "unparsed"}`);
      if (list) {
        const watch = this.itemWatch;
        if (watch && watch.buyer === list.buyer_uid) {
          const raw = (json as { result?: { messages?: Record<string, unknown>[] } })?.result?.messages ?? [];
          for (const m of raw) if (typeof m?.msg_id === "string" || typeof m?.msg_id === "number") watch.seen.push({ msg_id: String(m.msg_id), buyer: list.buyer_uid, raw: m });
        }
        this.sendOptions.touch(list.buyer_uid);
        this.tracker.chatList(list);
      }
    }
  }

  private startProbe() {
    if (!this.probeFile || this.probing) return;
    this.probing = true;
    fs.mkdirSync(path.dirname(this.probeFile), { recursive: true, mode: 0o700 });
    const file = this.probeFile;
    session.fromPartition(partitionFor(this.shopId)).webRequest.onCompleted((d) => {
      if (!["mainFrame", "subFrame", "xhr", "webSocket", "other"].includes(d.resourceType)) return;
      let url: URL;
      try {
        url = new URL(d.url);
      } catch {
        return;
      }
      const masked = maskPath(url.pathname);
      const line = { at: new Date().toISOString(), type: d.resourceType, method: d.method, host: url.hostname, path: masked, status: d.statusCode };
      if (d.resourceType === "xhr" || d.resourceType === "other") {
        this.recentRequests.push({ at: Date.now(), req: `${d.method} ${url.hostname}${masked}` });
        if (this.recentRequests.length > 200) this.recentRequests.splice(0, this.recentRequests.length - 200);
      }
      fs.appendFile(file, JSON.stringify(line) + "\n", { mode: 0o600 }, () => undefined);
    });
  }

  /** 诊断模式：记录人工点了哪个按钮、随后弹出了什么、页面发出了哪些接口请求（只记方法与路径）。 */
  private startUiRecorder(win: PlatformPage, probeFile: string) {
    const actionsFile = probeFile.replace(/requests\.jsonl$/, "ui-actions.jsonl");
    const mapFile = probeFile.replace(/requests\.jsonl$/, "ui-map.json");
    let ticks = 0;
    const timer = setInterval(() => {
      if (win.isDestroyed()) return;
      const exec = <T>(code: string) => win.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>;
      void exec<boolean>(UI_RECORDER)
        .then(() => exec<UiClick[] | null>(UI_DRAIN))
        .then((done) => {
          for (const c of done ?? []) {
            const requests = [...new Set(this.recentRequests.filter((r) => r.at >= c.at - 200 && r.at <= c.at + 3000).map((r) => r.req))].slice(0, 20);
            const line = { at: new Date(c.at).toISOString(), label: c.label, icon: c.icon, chain: c.chain, area: c.area ?? null, trusted: c.trusted, opened: c.opened, requests };
            console.log(`[${this.shopId}] ui-click label=${c.label ?? "-"} opened=${c.opened.join("|") || "-"} requests=${requests.length}`);
            fs.appendFile(actionsFile, JSON.stringify(line) + "\n", { mode: 0o600 }, () => undefined);
          }
        })
        .catch(() => undefined);
      if (ticks++ % 15 === 0) {
        void exec<unknown[]>(UI_MAP)
          .then((controls) => fs.writeFile(mapFile, JSON.stringify({ at: new Date().toISOString(), controls }, null, 1), { mode: 0o600 }, () => undefined))
          .catch(() => undefined);
      }
    }, 2000);
    win.on("closed", () => clearInterval(timer));
  }

  status(): PlatformStatus {
    const base = this.tracker.status(this.window !== null);
    if (!this.window) return base;
    const page = this.health.view();
    // 页面异常时以页面状态为准，避免显示“等待登录”掩盖崩溃或无响应。
    const abnormal = page.gave_up || (page.state !== "ok" && page.state !== "loading");
    return { ...base, detail: abnormal ? page.detail : base.detail, page, nav: this.navState(this.window), login_expires_at: this.loginExpiresAt };
  }

  /** 平台登录凭据的过期时间（Unix 秒）；只读过期时间，从不读取、记录或上报 Cookie 的值。 */
  private loginExpiresAt: number | null = null;
  private loginExpiryWatched = false;
  /** dispose 时撤销：Cookie 变化监听与兜底定时器（重连会新建适配器，不撤销会让旧适配器一直被引用并重复读取）。 */
  private loginExpiryStop: (() => void) | null = null;
  private disposed = false;

  /**
   * 跟踪本店分区里登录凭据的过期时间：凭据变化时（扫码、续期、退出）立即重读，另每 10 分钟兜底重读一次。
   * 读不到时为 null；任何异常都不影响平台页面与收发。
   */
  private watchLoginExpiry() {
    if (this.loginExpiryWatched || this.disposed) return;
    this.loginExpiryWatched = true;
    try {
      const cookies = session.fromPartition(partitionFor(this.shopId)).cookies;
      const refresh = () => {
        if (this.disposed) return;
        void cookies
          .get({ url: LOGIN_COOKIE_URL, name: LOGIN_COOKIE_NAME })
          .then((list) => {
            if (this.disposed) return;
            const next = loginExpiryOf(list);
            if (next === this.loginExpiresAt) return;
            this.loginExpiresAt = next;
            console.log(`[${this.shopId}] platform login expires_at=${next === null ? "none" : new Date(next * 1000).toISOString()}`);
            this.emit({ type: "status" });
          })
          .catch(() => undefined);
      };
      const onChanged = (_e: unknown, cookie: { name?: string } | undefined) => {
        if (cookie?.name === LOGIN_COOKIE_NAME) refresh();
      };
      cookies.on("changed", onChanged);
      const timer = setInterval(refresh, 10 * 60_000);
      timer.unref?.();
      this.loginExpiryStop = () => {
        clearInterval(timer);
        cookies.removeListener("changed", onChanged);
      };
      refresh();
    } catch {
      // 读不到过期时间只是少一条提醒。
    }
  }

  /**
   * 平台页面是否停在会话页、能否后退（读不到时按“不在会话页、不能后退”处理）。
   * 只在离开会话页时允许后退，且上一条记录须是平台页面、不是登录页：退回登录页会被当成退出登录。
   */
  private navState(win: PlatformPage): PlatformNav {
    try {
      if (win.isDestroyed()) return { on_chat: false, can_go_back: false };
      const wc = win.webContents;
      const onChat = wc.getURL().startsWith(LOGIN_URL);
      if (onChat) return { on_chat: true, can_go_back: false };
      const history = wc.navigationHistory;
      const index = history.getActiveIndex();
      const prev = index > 0 ? (history.getEntryAtIndex(index - 1)?.url ?? "") : "";
      return { on_chat: false, can_go_back: isAllowedPlatformUrl(prev) && !isLoginPage(prev) };
    } catch {
      return { on_chat: false, can_go_back: false };
    }
  }

  /** 页面导航后：会话页 / 能否后退有变化时通知界面刷新“后退 / 回到会话”按钮；同一状态不重复通知。 */
  private noteNav(win: PlatformPage) {
    if (this.window !== win) return;
    const key = JSON.stringify(this.navState(win));
    if (key === this.navKey) return;
    this.navKey = key;
    this.emit({ type: "status" });
  }

  /**
   * 人工导航平台页面：back 后退一步（不满足 navState 的后退条件时拒绝），chat 回到会话页（已在会话页时不重载）。
   * 发送或待确认发送进行中（sending / outgoing）拒绝；导航使页面代次失效，未执行的点击按页面已变化放弃。
   */
  navigatePlatform(action: PlatformNavAction): string | null {
    const win = this.window;
    if (!win || win.isDestroyed()) return "platform_window_closed";
    if (this.sending || this.outgoing) return "pdd_send_busy";
    const nav = this.navState(win);
    if (action === "back" && !nav.can_go_back) return "platform_no_history";
    if (action === "chat" && nav.on_chat) return null;
    this.watchEpoch++;
    this.lastActiveUid = null;
    this.offChatSince = 0;
    console.log(`[${this.shopId}] platform navigate: ${action}`);
    this.enableNetwork(win);
    if (action === "back") win.webContents.navigationHistory.goBack();
    else void win.loadURL(LOGIN_URL).catch(() => undefined);
    return null;
  }

  /**
   * 定时检查页面健康并自动恢复。只在页面生命周期异常时动作；正在发送时先等待（有上限）。
   * 恢复会使页面代次失效：旧页面上尚未点击的操作按未发送放弃，已点击的保持原有不确定判定，不重发。
   */
  private healthTick(win: PlatformPage) {
    const health = this.health;
    if (this.window !== win || win.isDestroyed()) return;
    const action = health.decide(this.sending || !!this.outgoing);
    if (action === "reload" || action === "kill") {
      health.acted(action);
      this.watchEpoch++;
      this.lastActiveUid = null;
      if (action === "kill") {
        console.log(`[${this.shopId}] platform page unresponsive: ending renderer`);
        win.webContents.forcefullyCrashRenderer();
      } else {
        console.log(`[${this.shopId}] platform page recovery: reload (recent=${health.view().reloads})`);
        this.enableNetwork(win);
        void win.loadURL(LOGIN_URL).catch(() => undefined);
      }
    }
    const v = health.view();
    const key = `${v.state}|${v.gave_up}|${v.detail}|${v.session_lost}`;
    if (key !== this.healthKey) {
      if (v.gave_up && this.healthKey.split("|")[1] !== "true") console.log(`[${this.shopId}] platform page recovery: gave up`);
      this.healthKey = key;
      this.emit({ type: "status" });
    }
  }

  /** 人工“重新加载平台页”：清除放弃状态并重新打开聊天页。返回阻止原因，成功为 null。 */
  reloadPage(): string | null {
    const win = this.window;
    if (!win || win.isDestroyed()) return "platform_window_closed";
    if (this.sending || this.outgoing) return "pdd_send_busy";
    this.health.resetGiveUp();
    this.watchEpoch++;
    this.lastActiveUid = null;
    console.log(`[${this.shopId}] platform page reload: manual`);
    this.enableNetwork(win);
    void win.loadURL(LOGIN_URL).catch(() => undefined);
    return null;
  }

  async login() {
    if (this.window && !this.window.isDestroyed()) return;
    if (!this.createPage) throw new Error("platform_workspace_unavailable");
    this.startProbe();
    this.watchLoginExpiry();
    const win = this.createPage();
    this.health = new PageHealth();
    this.healthKey = "";
    // 只处理当前页面的事件；先更新健康状态，再立即检查是否需要恢复与提醒。
    const onPage = (update: (health: PageHealth) => void) => {
      if (this.window !== win) return;
      update(this.health);
      this.healthTick(win);
    };
    win.webContents.on("did-finish-load", () => onPage((h) => h.loadFinished()));
    win.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
      // -3（ERR_ABORTED）是被新导航中止，不算失败。
      if (!isMainFrame || code === -3) return;
      onPage((h) => h.loadFailed());
    });
    win.webContents.on("render-process-gone", (_e, details) =>
      onPage((h) => {
        console.log(`[${this.shopId}] platform page gone reason=${details.reason}`);
        h.crashed();
        this.watchEpoch++;
        this.lastActiveUid = null;
        this.tracker.end("platform_page_crashed");
      }),
    );
    win.webContents.on("unresponsive", () => onPage((h) => h.unresponsive()));
    win.webContents.on("responsive", () => onPage((h) => h.responsive()));
    const healthTimer = setInterval(() => this.healthTick(win), 1000);
    win.on("closed", () => clearInterval(healthTimer));
    const popupTimer = setInterval(() => this.autoPopups(win), POPUP_SWEEP_INTERVAL_MS);
    win.on("closed", () => clearInterval(popupTimer));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPlatformUrl(url)) void win.loadURL(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedPlatformUrl(url)) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event, url) => {
      if (!isAllowedPlatformUrl(url)) event.preventDefault();
    });
    win.webContents.on("did-start-loading", () => {
      this.lastActiveUid = null;
      // 崩溃后调试通道会断开；新页面开始加载时补附加，确保能观察页面请求并拦截发送。
      this.enableNetwork(win);
    });
    const onNavigate = (_e: unknown, url: string) => {
      if (isLoginPage(url)) this.tracker.end("platform_logged_out");
      this.noteNav(win);
    };
    win.webContents.on("did-navigate", onNavigate);
    win.webContents.on("did-navigate-in-page", onNavigate);
    win.on("resized", () => { this.watchEpoch++; });
    this.attachNetwork(win);
    if (this.probeFile) {
      const domFile = this.probeFile.replace(/requests\.jsonl$/, "dom.json");
      const timer = setInterval(() => {
        win.webContents
          .executeJavaScriptInIsolatedWorld(1001, [{ code: DOM_PROBE }])
          .then(async (r) => {
            const randoms: string[] = await win.webContents.executeJavaScriptInIsolatedWorld(1001, [
              { code: `[...document.querySelectorAll("li.chat-item .chat-item-box[data-random]")].map((e) => e.getAttribute("data-random"))` },
            ]);
            const known = new Set(this.tracker.knownConversations());
            const items = randoms.map((v) => ({ prefix_is_known_buyer: known.has((/^[0-9]+/.exec(v) ?? [""])[0]), shape: v.replace(/[0-9]/g, "9").replace(/[^9]/g, (c) => (c === "-" || c === "_" ? c : "a")) }));
            fs.writeFile(domFile, JSON.stringify({ at: new Date().toISOString(), items, ...r }, null, 1), { mode: 0o600 }, () => undefined);
          })
          .catch((err: unknown) => {
            const e = err as { name?: unknown; message?: unknown } | null;
            fs.writeFile(domFile, JSON.stringify({ at: new Date().toISOString(), error: String(e?.name), message: String(e?.message).slice(0, 160) }, null, 1), { mode: 0o600 }, () => undefined);
          });
      }, 10_000);
      win.on("closed", () => clearInterval(timer));
      this.startUiRecorder(win, this.probeFile);
    }
    this.messageWatcher = new PddMessageWatcher(win.webContents, () => this.watch(), () => (this.sending && !this.warmRun) || !!this.outgoing, () => { this.watchEpoch++; this.pendingFreshBuyer = false; });
    const watcher = this.messageWatcher;
    win.on("closed", () => {
      watcher.close();
      if (this.messageWatcher === watcher) this.messageWatcher = null;
      if (this.window !== win) return;
      this.window = null;
      this.tracker.end("platform_window_closed");
      this.emit({ type: "status" });
    });
    this.window = win;
    this.navKey = "";
    this.emit({ type: "status" });
    await win.loadURL(LOGIN_URL).catch(() => undefined);
  }

  async logout() {
    this.window?.close();
  }

  async fetchHistory(conversationId: string): Promise<HistoryResult> {
    return this.tracker.history(conversationId);
  }

  async collectProducts(selection: { goods_id?: string; mall_id?: string }, batch: (products: ProductDoc[], total: number) => Promise<void>, check: () => void) {
    const win = this.window;
    const mall = this.status().identity?.platform_shop_id;
    if (!win || win.isDestroyed() || !mall) throw Error("product_page_unavailable");
    // Click/layout epochs also change on resize and popup cleanup. Goods reads only bind the page lifecycle.
    let changed = false;
    const invalidate = () => { changed = true; };
    const events = ["did-start-loading", "did-navigate", "render-process-gone", "destroyed"] as const;
    for (const event of events) win.webContents.on(event as "destroyed", invalidate);
    const valid = () => {
      check();
      const status = this.status();
      if (changed || this.window !== win || win.isDestroyed() || !status.logged_in
          || status.identity?.platform_shop_id !== mall || !win.webContents.getURL().startsWith(LOGIN_URL)) throw Error("product_source_changed");
    };
    try {
      return await collectStoreProducts(this.shopId, mall, selection, async (kind, params) => {
        valid();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const value = await Promise.race([win.webContents.executeJavaScript(productReadScript(kind, params)),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("product_page_unavailable")), 12000); })]);
          valid();
          return value;
        } finally { if (timer) clearTimeout(timer); }
      }, batch, valid);
    } finally {
      for (const event of events) win.webContents.removeListener(event as "destroyed", invalidate);
    }
  }

  historyLoadedAt(conversationId: string): number {
    return this.tracker.lastLoadedAt(conversationId) * 1000;
  }

  historyLoads(conversationId: string): HistoryLoad[] {
    return this.tracker.historyLoads(conversationId);
  }

  /**
   * 提交前让页面读一次该买家的订单：只在该对话正打开时，确保选中“最新订单”与“个人订单”两个只读标签（未选中才点）。
   * 同一买家 30 秒内只点一次；找不到标签或对话未打开就跳过，不重试。
   */
  async ordersSettled(conversationId: string, timeoutMs: number): Promise<void> {
    await this.yieldWarm();
    const deadline = Date.now() + timeoutMs;
    const last = this.ordersRefreshAt.get(conversationId) ?? 0;
    if (!this.sending && Date.now() - last >= 30_000) {
      this.ordersRefreshAt.set(conversationId, Date.now());
      const since = Date.now();
      const result = await this.run<string>(orderTabsScript(conversationId)).catch(() => "error");
      const loaded = result === "clicked" ? await this.orders.startedSince(conversationId, since, Math.min(1500, Math.max(0, deadline - Date.now()))) : false;
      console.log(`[${this.shopId}] platform orders refresh result=${result}${result === "clicked" ? ` loaded=${loaded}` : ""}`);
    }
    return this.orders.settled(conversationId, Math.max(0, deadline - Date.now()));
  }

  async fetchImage(ref: string): Promise<ImageFetchResult> {
    if (!isAllowedImageUrl(ref)) {
      let host = "invalid";
      try {
        host = new URL(ref).hostname;
      } catch {
        // 保持 invalid
      }
      return { ok: false, reason: `image_host_not_allowed:${host}` };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await session.fromPartition(partitionFor(this.shopId)).fetch(ref, { signal: ctrl.signal, redirect: "error" });
      if (!res.ok) return { ok: false, reason: `image_http_${res.status}` };
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_IMAGE_BYTES) return { ok: false, reason: "image_too_large" };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: "image_too_large" };
      const mime = sniffImage(bytes);
      return mime ? { ok: true, mime, bytes } : { ok: false, reason: "image_type_unsupported" };
    } catch {
      return { ok: false, reason: ctrl.signal.aborted ? "image_fetch_timeout" : "image_fetch_failed" };
    } finally {
      clearTimeout(timer);
    }
  }

  async send(request: SendRequest): Promise<SendResult> {
    const notSent = (reason: string): SendResult => ({ status: "not_sent", reason });
    // 占用页面：等清理与预热结束后，在 await 返回的同一同步段里复核并置 sending（见 popupSweep 说明）。
    do await this.yieldWarm(); while (this.popupSweep || this.warmRun);
    if (!this.window || this.window.isDestroyed()) return notSent("platform_window_closed");
    if (!this.tracker.status(true).logged_in) return notSent("platform_logged_out");
    if (this.sending || this.outgoing) return notSent("pdd_send_busy");
    if (!/^[0-9]{1,32}$/.test(request.conversation_id) || !request.text.trim()) return notSent("pdd_send_invalid_request");
    const uid = request.conversation_id;
    const text = request.text;
    const page = this.window, epoch = this.watchEpoch;
    this.sending = true;
    try {
      const deadline = request.deadline ?? Date.now() / 1000 + 8;
      const left = () => deadline - Date.now() / 1000;
      const recheck = () => this.window !== page || this.watchEpoch !== epoch ? "pdd_page_changed" :
        request.recheck?.() ?? (left() < 1.5 ? "claim_expiring" : null);
      // 第一阶段：打开对话、检查输入框。失败均未触碰发送按钮。
      const notOpened = await this.openConversation(uid, deadline, recheck);
      if (notOpened) return notSent(notOpened);
      let didPress = false, didFill = false;
      let observed: SendResult | null = null;
      const result = new Promise<SendResult>(resolve => {
        this.outgoing = { to_uid: uid, text, matched: null, blocked: 0, recheck, clicked: () => didPress, resolve: r => { observed = r; resolve(r); } };
      });
      const click = await this.clickText(page.webContents, uid, text, deadline, recheck, value => { didPress = value; }, () => { didFill = true; });
      if (click.status !== "dispatched") {
        if (didPress && observed && (observed as SendResult).status === "confirmed") return observed;
        if (click.status === "not_sent" && didFill && this.window === page && this.watchEpoch === epoch) {
          await Promise.race([this.clearInput(text, uid).catch(() => undefined), sleep(500)]);
        }
        return click;
      }
      // 第二阶段：已点发送；此后除平台确认外一律不确定。
      const r = await Promise.race([result, sleep(Math.max(500, Math.min(8000, left() * 1000))).then(() => null)]);
      const out = this.outgoing as { matched: string | null; blocked: number } | null;
      this.outgoing = null;
      if (r) return r;
      if (out && !out.matched && out.blocked > 0) return { status: "unknown", reason: "pdd_send_blocked_mismatch" };
      return { status: "unknown", reason: out?.matched ? "send_timeout" : "pdd_send_request_not_observed" };
    } finally {
      this.outgoing = null;
      this.sending = false;
    }
  }

  /** 点开该买家对话并等它成为当前对话；返回失败原因，成功为 null。 */
  private async openConversation(uid: string, deadline = Date.now() / 1000 + 7, current?: () => string | null, prepareMs = 5000): Promise<string | null> {
    const page = this.window, epoch = this.watchEpoch;
    const until = Math.min(Date.now() + prepareMs, deadline * 1000 - 1500);
    // 按剩余预算等待会话出现，但不超过上限：既覆盖页面刚刷新后的慢渲染，又保留填入与回执的时间。
    const missingUntil = Math.min(until, Date.now() + OPEN_CONVERSATION_WAIT_MAX_MS);
    const guard = () => this.window !== page || this.watchEpoch !== epoch || !page || page.isDestroyed() ? "pdd_page_changed" :
      current?.() ?? (Date.now() >= deadline * 1000 - 1500 ? "claim_expiring" : null);
    const readTimeout = new Error("conversation_read_timeout");
    const read = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(readTimeout), Math.max(1, until - Date.now()));
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    try {
      let found = false;
      // 迭代上限只作保险，真正的边界是 missingUntil（按剩余预算计算）。
      for (let i = 0; i < 80; i++) {
        const blocked = guard(); if (blocked) return blocked;
        const clicked = await read(this.clickConversation(uid, missingUntil));
        const changed = guard(); if (changed) return changed;
        if (clicked) { found = true; break; }
        if (Date.now() >= missingUntil) return "pdd_conversation_not_in_list";
        await sleep(Math.min(100, missingUntil - Date.now()));
      }
      if (!found) return "pdd_conversation_not_in_list";
      for (let i = 0; i < 50 && Date.now() < until; i++) {
        const blocked = guard(); if (blocked) return blocked;
        const scan = await read(this.run<Scan>(SCAN));
        const changed = guard(); if (changed) return changed;
        const active = new Set((scan?.items ?? []).filter(it => it.active).map(it => buyerFromListKey(it.key)));
        if (active.size === 1 && active.has(uid)) return null;
        await sleep(Math.min(100, Math.max(0, until - Date.now())));
      }
      return guard() ?? "pdd_conversation_not_opened";
    } catch (error) {
      return guard() ?? (error === readTimeout ? "pdd_page_script_timeout" : "pdd_page_script_failed");
    }
  }

  private nativeClick(pt: { x: number; y: number }, win: PlatformPage | null, epoch: number): Promise<PageClickResult> {
    if (!win || win.isDestroyed()) return Promise.resolve({ status: "not_sent", reason: "platform_window_closed" });
    return dispatchPageClick(win.webContents, pt, () => this.window !== win || this.watchEpoch !== epoch ? "pdd_page_changed" : null);
  }

  /** 展开视频弹窗（点页面的相机图标），等页面列出视频。返回 "opened" | "already" | 失败原因。 */
  private async openVideoPanel(): Promise<string> {
    const page = this.window, epoch = this.watchEpoch;
    const state = await this.run<string | { x: number; y: number }>(VIDEO_PANEL).catch(() => "pdd_page_script_failed");
    if (state === "open") return "already";
    if (typeof state === "string") return state;
    const click = await this.nativeClick(state, page, epoch);
    if (click.status !== "dispatched") return click.reason;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      if ((await this.run<unknown>(VIDEO_PANEL).catch(() => null)) === "open") return "opened";
    }
    await this.closeVideoPanel();
    return "pdd_video_panel_not_opened";
  }

  /** 弹窗仍展开时再点一次相机图标收起。 */
  private async closeVideoPanel() {
    const page = this.window, epoch = this.watchEpoch;
    const state = await this.run<string | { x: number; y: number }>(`(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(VIDEO_ROWS)})].filter((li) => li.getClientRects().length > 0);
      const cam = document.querySelector(${JSON.stringify(CAMERA)});
      if (!rows.length || !cam) return "closed";
      const r = cam.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`).catch(() => "closed");
    if (typeof state !== "string") await this.nativeClick(state, page, epoch);
  }

  /**
   * 自动模式且附加发送能力已确认时，每个平台会话展开一次视频弹窗让页面加载视频库，随即收起。
   * 只在已打开某个对话时进行（相机图标在对话输入区）；不发送任何内容。
   */
  async prepareSendOptions(): Promise<void> {
    do await this.popupIdle(); while (this.popupSweep);
    if (this.optionsPrepared || this.sending || this.outgoing || !this.window || this.window.isDestroyed()) return;
    if (!this.tracker.status(true).logged_in) return;
    this.sending = true;
    try {
      const result = await this.openVideoPanel();
      if (result === "opened" || result === "already") this.optionsPrepared = true;
      if (result === "opened") {
        await sleep(800);
        await this.closeVideoPanel();
      }
      if (result !== this.prepareResult) console.log(`[${this.shopId}] platform send options prepare result=${result}`);
      this.prepareResult = result;
    } finally {
      this.sending = false;
    }
  }

  /**
   * 附加发送（视频、商品卡片）：打开对话 → 展开视频弹窗 / 切到“商品推荐”页签 → 核对所选页面行的对象身份 → 点击前复核 → 原生点击页面的按钮。
   * 页面发出的发送请求在本机核对买家与对象；以平台接口成功且相对基线恰好新增一条同对象消息为确认。
   */
  async sendItem(request: SendItemRequest): Promise<SendResult> {
    const notSent = (reason: string): SendResult => ({ status: "not_sent", reason });
    // 占用页面：等清理与预热结束后，在 await 返回的同一同步段里复核并置 sending（见 popupSweep 说明）。
    do await this.yieldWarm(); while (this.popupSweep || this.warmRun);
    if (!this.window || this.window.isDestroyed()) return notSent("platform_window_closed");
    if (!this.tracker.status(true).logged_in) return notSent("platform_logged_out");
    if (this.sending || this.outgoing) return notSent("pdd_send_busy");
    if (!/^[0-9]{1,32}$/.test(request.conversation_id)) return notSent("pdd_send_invalid_request");
    if (!SENDABLE_ITEMS.has(request.option.type)) return notSent("pdd_item_type_unsupported");
    const uid = request.conversation_id;
    const option = request.option;
    const page = this.window, epoch = this.watchEpoch;
    this.sending = true;
    const watch: NonNullable<PddPageAdapter["itemWatch"]> = { buyer: uid, path: option.type === "instruction" ? INSTRUCT_SEND_PATH : option.type === "goods_card" ? GOODS_CARD_SEND_PATH : LIBRARY_SEND_PATH, url: null, goodsId: null, bookId: null, seen: [], clicked: false, requests: 0, blocked: 0, apiOk: null };
    this.itemWatch = watch;
    let opened = false;
    let dialog = false;
    try {
      // 第一阶段：打开对话与弹窗、定位按钮、复核。失败均未触碰发送按钮。
      const notOpened = await this.openConversation(uid);
      if (notOpened) return notSent(notOpened);
      let located: { x: number; y: number };
      if (option.type === "instruction") {
        dialog = true;
        const ins = await this.locateInstruction(uid, option, watch, request.deadline * 1000);
        if (typeof ins === "string") return notSent(ins);
        located = ins;
      } else if (option.type === "goods_card") {
        const goods = await this.locateGoods(uid, option, watch);
        if (typeof goods === "string") return notSent(goods);
        located = goods;
      } else {
      const before = this.videoRows;
      const panel = await this.openVideoPanel();
      if (panel !== "opened" && panel !== "already") return notSent(panel);
      opened = panel === "opened";
      for (let i = 0; opened && this.videoRows === before && i < 10; i++) await sleep(150);
      await sleep(300);
      // 以文件编号定位，点击前核对所选页面行的文件身份；请求放行时再核对文件地址。
      const rows = this.videoRows;
      const plan = planVideoClick(rows, option);
      if (typeof plan === "string" || !rows) return notSent(typeof plan === "string" ? plan : "pdd_video_library_not_loaded");
      const dom = await this.run<string | { texts: string[]; srcs: string[][]; x: number; y: number }>(videoRowsScript(uid, plan.index)).catch(() => "pdd_page_script_failed");
      if (typeof dom === "string") return notSent(dom);
      const target = verifyVideoTarget(rows, plan.index, dom);
      if (typeof target === "string") return notSent(target);
      console.log(`[${this.shopId}] platform video target identity=${target.basis}`);
      if (this.videoRows !== rows) return notSent("pdd_video_list_changed");
      watch.url = plan.url;
      located = { x: dom.x, y: dom.y };
      }
      const blocked = request.recheck();
      if (blocked) return notSent(blocked);
      if (request.deadline - Date.now() / 1000 < 1.5) return notSent("claim_expiring");
      if (watch.blocked) return notSent("pdd_item_concurrent_send");
      const baseline = new Set([...this.tracker.history(uid).messages.flatMap((m) => (m.platform_message_id ? [m.platform_message_id] : [])), ...watch.seen.map((m) => m.msg_id)]);
      const click = await dispatchPageClick(page.webContents, located, () => {
        if (this.window !== page || this.watchEpoch !== epoch) return "pdd_page_changed";
        return request.recheck() ?? (request.deadline - Date.now() / 1000 < 1.5 ? "claim_expiring" : watch.blocked ? "pdd_item_concurrent_send" : null);
      }, () => { watch.clicked = true; });
      if (click.status !== "dispatched") return click;
      // 第二阶段：已点发送；此后除平台确认外一律不确定。
      // 页面发送后的同步消息不带新消息（实测为空），接口成功后仍无回执就刷新一次页面，让页面重新加载该对话的聊天记录。
      let okAt = 0;
      let reloaded = false;
      while (Date.now() / 1000 < request.deadline) {
        if (watch.blocked) return { status: "unknown", reason: "pdd_item_blocked_mismatch" };
        const r = judgeItemReceipt({ apiOk: watch.apiOk, option, buyer: uid, baseline, seen: watch.seen });
        if (r) return r;
        if (watch.apiOk === true) okAt ||= Date.now();
        if (okAt && !reloaded && Date.now() - okAt > 1000) {
          reloaded = true;
          opened = false;
          this.reload("send_item_receipt", true);
        }
        await sleep(200);
      }
      if (!watch.requests) return { status: "unknown", reason: "pdd_item_request_not_observed" };
      return { status: "unknown", reason: watch.apiOk === true ? "receipt_not_observed" : "send_timeout" };
    } finally {
      this.itemWatch = null;
      if (dialog) void this.run(INSTRUCT_CLOSE).catch(() => undefined).finally(() => (this.sending = false));
      else if (opened) void this.closeVideoPanel().finally(() => (this.sending = false));
      else this.sending = false;
    }
  }

  /** 切到“商品推荐”页签，以缩略图核对所选行就是候选商品，返回其“发送商品”按钮中心点或原因。 */
  private async locateGoods(uid: string, option: SendItemRequest["option"], watch: NonNullable<PddPageAdapter["itemWatch"]>): Promise<{ x: number; y: number } | string> {
    const since = Date.now();
    const tab = await this.run<string>(goodsTabScript(uid)).catch(() => "pdd_page_script_failed");
    if (tab !== "clicked" && tab !== "already") return tab.startsWith("pdd_") ? tab : `pdd_goods_tab_${tab}`;
    for (let i = 0; tab === "clicked" && (this.goodsRows.get(uid)?.at ?? 0) < since && i < 20; i++) await sleep(150);
    await sleep(300);
    const entry = this.goodsRows.get(uid);
    const plan = planGoodsClick(entry?.rows ?? null, option);
    if (typeof plan === "string" || !entry) return typeof plan === "string" ? plan : "pdd_goods_list_not_loaded";
    const dom = await this.run<string | { srcs: string[][]; hasBtn: boolean[] }>(GOODS_ROWS).catch(() => "pdd_page_script_failed");
    if (typeof dom === "string") return dom;
    const index = verifyGoodsTarget(entry.rows, plan.goods_id, dom);
    if (typeof index === "string") return index;
    const point = await this.run<string | { x: number; y: number }>(goodsButtonScript(uid, index, plan.thumb)).catch(() => "pdd_page_script_failed");
    if (typeof point === "string") return point;
    if (this.goodsRows.get(uid) !== entry) return "pdd_goods_list_changed";
    console.log(`[${this.shopId}] platform goods target identity=thumb`);
    watch.goodsId = plan.goods_id;
    return point;
  }

  /** 点开第 index 个订单“发送说明书”按钮，等页面为此加载说明书并弹出对话框；返回该次加载的请求与响应。 */
  private async openInstructDialog(uid: string, index: number, waitMs: number, aborted: () => boolean = () => false): Promise<{ request: unknown; response: unknown } | string> {
    const since = Date.now();
    const clicked = await this.run<string>(instructOpenScript(uid, index)).catch(() => "pdd_page_script_failed");
    if (clicked !== "clicked") return clicked;
    while ((this.lastInstruct?.at ?? 0) < since && Date.now() - since < waitMs && !aborted()) await sleep(100);
    const got = this.lastInstruct;
    if (!got || got.at < since) return "pdd_instruct_not_loaded";
    await sleep(300);
    return got;
  }

  /**
   * 切到订单页签，逐个点开订单上的“发送说明书”，找到页面所加载的说明书（商品、模板、版本）与候选一致的那个对话框，
   * 核对对话框显示该说明书名称，返回其“发送说明书”按钮中心点；不一致的对话框随即关闭。
   */
  private async locateInstruction(uid: string, option: SendItemRequest["option"], watch: NonNullable<PddPageAdapter["itemWatch"]>, deadline: number): Promise<{ x: number; y: number } | string> {
    // 至少留 2.5 秒给点击与回执；时间不够就在点击前放弃（not_sent），不让外层超时记成不确定。
    const spare = () => deadline - Date.now() - 2500;
    const target = instructTarget(option);
    if (!target || option.type !== "instruction" || !option.name) return "pdd_instruct_option_invalid";
    const tab = await this.run<string>(orderTabsScript(uid)).catch(() => "pdd_page_script_failed");
    if (tab !== "clicked" && tab !== "already") return tab.startsWith("pdd_") ? tab : `pdd_order_tab_${tab}`;
    if (tab === "clicked") await sleep(800);
    const count = await this.run<string | number>(instructButtonsScript(uid)).catch(() => "pdd_page_script_failed");
    if (typeof count === "string") return count;
    for (let i = 0; i < Math.min(count, 5); i++) {
      if (spare() < 500) return "claim_expiring";
      const got = await this.openInstructDialog(uid, i, Math.min(1500, spare()));
      if (typeof got === "string") return got;
      if (!instructMatches(option, got.request, got.response)) {
        await this.run(INSTRUCT_CLOSE).catch(() => undefined);
        await sleep(300);
        continue;
      }
      // 对话框弹出有过渡动画，按钮未就绪（未出现、尺寸为 0、被遮挡）时短暂重试。
      let point: string | { x: number; y: number } = "pdd_instruct_dialog_missing";
      for (let k = 0; k < 10; k++) {
        point = await this.run<string | { x: number; y: number }>(instructDialogScript(uid, option.name)).catch(() => "pdd_page_script_failed");
        if (typeof point !== "string" || !/^pdd_instruct_(dialog_missing|send_button_hidden|send_button_covered)/.test(point) || spare() < 500) break;
        await sleep(150);
      }
      if (typeof point === "string") {
        console.log(`[${this.shopId}] platform instruction dialog not ready reason=${point}`);
        return point.split(":")[0];
      }
      if (this.lastInstruct !== got) return "pdd_instruct_changed";
      console.log(`[${this.shopId}] platform instruction target identity=template`);
      watch.goodsId = target.goodsId;
      watch.bookId = target.bookId;
      return point;
    }
    return count ? "pdd_instruct_not_found" : "pdd_instruct_button_missing";
  }

  /**
   * 提交前让页面加载该买家可发的说明书与推荐商品（自动模式且附加发送能力已确认时由运行时调用），只做界面操作，不发送。
   * timeoutMs 是准备阶段的剩余预算（默认合计 2 秒），本方法同时负责订单的确认，运行时不再另读一次订单：
   * 先切到“商品推荐”页签（每买家 5 分钟一次，最多等 1.2 秒）；再切回订单页签并等订单读完——订单每次重新读取都会使上下文版本变化，
   * 提交时停在订单页签，发送说明书时就不必再切页签；最后，剩余预算足够时才逐个点开订单上的“发送说明书”再关闭
   * （每买家 10 分钟一次、最多 3 个），不够的留给预热（warmConversation）。
   */
  async sendOptionsSettled(conversationId: string, timeoutMs: number): Promise<void> {
    await this.yieldWarm();
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    await this.goodsSettled(conversationId, Math.min(PREP_GOODS_WAIT_MS, Math.max(0, left() - PREP_ORDERS_RESERVE_MS)));
    if (this.sending || this.outgoing) return;
    const since = Date.now();
    const back = await this.run<string>(orderTabsScript(conversationId)).catch(() => "error");
    if (back === "clicked") {
      this.ordersRefreshAt.set(conversationId, since);
      await this.orders.startedSince(conversationId, since, Math.min(1500, left()));
    }
    await this.orders.settled(conversationId, left());
    if (left() >= PREP_INSTRUCT_MIN_MS) await this.instructionsSettled(conversationId, deadline);
    else if (this.instructDue(conversationId)) console.log(`[${this.shopId}] platform instruct collect deferred=warm`);
  }

  /** 该买家订单中有商品的说明书未读到或已过 10 分钟，且距上次收集已满限流间隔。 */
  private instructDue(uid: string): boolean {
    return Date.now() - (this.instructTriedAt.get(uid) ?? 0) >= 600_000 && this.sendOptions.instructStale(uid, Math.floor(Date.now() / 1000), 600).length > 0;
  }

  private async instructionsSettled(uid: string, deadline: number) {
    do await this.popupIdle(); while (this.popupSweep);
    if (this.sending || this.outgoing || !this.instructDue(uid)) return;
    this.sending = true;
    try {
      await this.collectInstructions(uid, deadline, () => false);
    } finally {
      this.sending = false;
    }
  }

  /**
   * 逐个点开订单上的“发送说明书”再关闭，让页面加载说明书；调用方持有页面（sending）。结束时按结果区分：
   * - complete：没有未新鲜的说明书了 → 10 分钟内不再收集；
   * - partial：预算耗尽或被抢占，还有没试的按钮 → 不限流，本轮已读按钮的指纹保留，下次只跳过能对上的；
   * - exhausted：页面上每个按钮都能对上本轮已读的指纹，或本轮已打开 3 次，仍有未新鲜的 → 10 分钟后再来一轮；
   * - failed：一个对话框也没打开就失败（不在订单页签、没有按钮、脚本失败、加载失败）→ 30 秒后再试，本轮进度保留。
   */
  private async collectInstructions(uid: string, deadline: number, aborted: () => boolean) {
    const stale = () => this.sendOptions.instructStale(uid, Math.floor(Date.now() / 1000), 600).length > 0;
    let round = this.instructRound.get(uid);
    if (!round || Date.now() - round.startedAt >= 600_000) this.instructRound.set(uid, (round = { done: new Set(), opens: 0, startedAt: Date.now() }));
    let keys: string | (string | null)[] = "error";
    let opened = 0;
    let outcome: "complete" | "partial" | "exhausted" | "failed" = "failed";
    try {
      keys = await this.run<string | (string | null)[]>(instructButtonKeysScript(uid)).catch(() => "error");
      if (!Array.isArray(keys)) return opened;
      const current = keys;
      // 只按可核验的指纹跳过；本轮打开次数达上限后不再打开。
      const todo = () => (round!.opens >= 3 ? [] : current.flatMap((k, i) => (k !== null && round!.done.has(k) ? [] : [i])));
      const stopped = () => aborted() || deadline - Date.now() <= 500;
      for (const i of todo()) {
        if (!stale() || stopped() || round.opens >= 3) break;
        const got = await this.openInstructDialog(uid, i, Math.min(1500, deadline - Date.now()), aborted);
        await this.run(INSTRUCT_CLOSE).catch(() => undefined);
        await sleep(300);
        if (typeof got === "string") {
          // 等待中被抢占或到预算截止不算失败；真正加载失败才退避。
          outcome = stopped() ? "partial" : "failed";
          return opened;
        }
        round.opens++;
        const key = current[i];
        if (key !== null) round.done.add(key);
        opened++;
      }
      outcome = !stale() ? "complete" : todo().length && stopped() ? "partial" : !todo().length && round.opens ? "exhausted" : "failed";
      return opened;
    } finally {
      if (outcome === "complete" || outcome === "exhausted") {
        this.instructTriedAt.set(uid, Date.now());
        this.instructRound.delete(uid);
      } else if (outcome === "partial") this.instructTriedAt.delete(uid);
      else this.instructTriedAt.set(uid, Date.now() - 570_000);
      console.log(`[${this.shopId}] platform instruct collect buttons=${Array.isArray(keys) ? keys.length : keys} loaded=${opened} outcome=${outcome}`);
    }
  }

  private async goodsSettled(conversationId: string, timeoutMs: number): Promise<void> {
    if (this.sending || this.outgoing || Date.now() - (this.goodsTabAt.get(conversationId) ?? 0) < GOODS_TAB_REFRESH_MS) return;
    await this.collectGoods(conversationId, timeoutMs, () => false);
  }

  private async collectGoods(conversationId: string, timeoutMs: number, aborted: () => boolean): Promise<void> {
    this.goodsTabAt.set(conversationId, Date.now());
    const since = Date.now();
    const result = await this.run<string>(goodsTabScript(conversationId)).catch(() => "error");
    // 页签已选中时，页面刚为这个买家打开对话、推荐商品列表可能还在加载：没读到过就同样等它，
    // 否则列表在提交后才到，候选变化使刚做好的判断失效。
    const waits = result === "clicked" || (result === "already" && !this.goodsRows.has(conversationId));
    const rowsSince = result === "clicked" ? since : 0;
    let loaded = false;
    for (let i = 0; waits && !loaded && Date.now() - since < timeoutMs && !aborted(); i++) {
      await sleep(100);
      loaded = (this.goodsRows.get(conversationId)?.at ?? -1) >= rowsSince;
    }
    console.log(`[${this.shopId}] platform goods tab result=${result}${waits ? ` loaded=${loaded}` : ""}`);
  }

  /**
   * 预热：该买家没有进行中的处理时（运行时调用），在后台补齐下一条消息要用的候选——过期的推荐商品、未读到或过期的说明书。
   * 只做界面操作，不发送；没人在用页面（无焦点、输入框为空、无对话框）且该买家对话仍是当前对话时才进行。
   * 持有页面期间发送与准备会先抢占它（在下一步之间停下、关闭对话框），所以不会让发送因“忙”被拒。
   */
  async warmConversation(conversationId: string): Promise<void> {
    if (this.warmRun || this.popupSweep || this.sending || this.outgoing || !this.window || this.window.isDestroyed()) return;
    if (!/^[0-9]{1,32}$/.test(conversationId) || !this.tracker.status(true).logged_in) return;
    const goodsDue = Date.now() - (this.goodsTabAt.get(conversationId) ?? 0) >= GOODS_TAB_REFRESH_MS;
    if (!goodsDue && !this.instructDue(conversationId)) return;
    const ctrl = new AbortController();
    let finish!: () => void;
    const run = { ctrl, done: new Promise<void>((r) => (finish = r)) };
    const page = this.window;
    const aborted = () => ctrl.signal.aborted || this.window !== page || page.isDestroyed();
    this.warmRun = run;
    this.sending = true;
    const started = Date.now();
    let result = "done";
    let instructLoaded = 0;
    try {
      const idle = await this.run<string>(warmIdleScript(conversationId)).catch(() => "error");
      if (idle !== "idle") {
        result = idle;
        return;
      }
      if (goodsDue) {
        await this.collectGoods(conversationId, WARM_GOODS_WAIT_MS, aborted);
        if (aborted()) return void (result = "preempted");
        const since = Date.now();
        const back = await this.run<string>(orderTabsScript(conversationId)).catch(() => "error");
        if (back === "clicked") {
          this.ordersRefreshAt.set(conversationId, since);
          await unlessAborted(this.orders.startedSince(conversationId, since, 1500), ctrl.signal);
        }
        await unlessAborted(this.orders.settled(conversationId, WARM_ORDERS_WAIT_MS), ctrl.signal);
        if (aborted()) return void (result = "preempted");
      }
      if (this.instructDue(conversationId)) instructLoaded = await this.collectInstructions(conversationId, Date.now() + WARM_INSTRUCT_MS, aborted);
      if (aborted()) result = "preempted";
    } finally {
      this.sending = false;
      this.warmRun = null;
      finish();
      console.log(`[${this.shopId}] platform warm result=${result} goods=${goodsDue} instruct_loaded=${instructLoaded} ms=${Date.now() - started}`);
    }
  }

  /** 发送未被确认时清掉自动填入的文字，避免人工误点发送。 */
  /**
   * 开发自检：验证原生点击能触发页面发送，但请求在本机即被拦截、不到达平台。
   * 设置一个不可能匹配的待发记录，使页面发出的 send_message 必然被 onSendPaused 拦截。
   * 仅在当前已打开的对话上进行，且需调用方确认该对话允许自检。
   */
  async clickProbe(allow: (uid: string) => boolean): Promise<string> {
    if (!this.window || this.window.isDestroyed() || !this.tracker.status(true).logged_in) return "not_ready";
    if (this.sending || this.outgoing || this.popupSweep) return "busy";
    const text = "测试点击（不会发出）";
    const page = this.window, epoch = this.watchEpoch;
    this.sending = true;
    try {
      const scan = await this.run<Scan>(SCAN).catch(() => null);
      const active = scan?.items.find((i) => i.active);
      const uid = active ? buyerFromListKey(active.key) : null;
      if (!uid || !allow(uid)) return "conversation_not_allowed";
      const filled = await this.run<string>(`(() => {
        const ta = document.querySelector(${JSON.stringify(TEXTAREA)});
        if (!ta) return "input_missing";
        if (ta.value.trim()) return "input_not_empty";
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return "filled"; })()`).catch(() => "script_failed");
      if (filled !== "filled") return filled;
      await sleep(300);
      let blocked = 0;
      this.outgoing = { to_uid: "probe-never-matches", text: "", matched: null, blocked: 0, resolve: () => undefined };
      const located = await this.run<string | { x: number; y: number }>(`(() => {
        const btn = document.querySelector(${JSON.stringify(SEND_BTN)});
        if (!btn) return "button_missing";
        const r = btn.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(SEND_BTN)}) !== btn) return "button_covered";
        return { x, y }; })()`).catch(() => "script_failed");
      if (typeof located === "string") {
        this.outgoing = null;
        await this.clearInput(text);
        return located;
      }
      const click = await this.nativeClick(located, page, epoch);
      if (click.status !== "dispatched") return click.reason;
      for (let i = 0; i < 25 && !blocked; i++) {
        await sleep(200);
        blocked = this.outgoing?.blocked ?? 0;
      }
      // 拦截后页面可能把失败消息留在列表或输入框里；输入框残留时清掉。
      await sleep(1000);
      this.outgoing = null;
      await this.clearInput(text);
      return blocked ? "intercepted" : "no_send_request";
    } finally {
      this.outgoing = null;
      this.sending = false;
    }
  }

  /**
   * 诊断模式下的人工触发测试：在当前已打开的对话上把“收藏该用户”设为指定颜色（只点颜色项，不点星标本身，避免误取消）。
   * 点击前写本地尝试记录；结果只以页面状态判定（星标 active 且该颜色带勾），无平台回执；不重试。
   */
  /** 诊断测试用的 SCAN：SCAN 会把最后一条消息标为已见，新买家消息标记须交回 watch()，否则会漏掉 reload。 */
  private async scanKeepingFresh(): Promise<Scan | null> {
    const scan = await this.run<Scan>(SCAN).catch(() => null);
    if (scan?.freshBuyer) this.pendingFreshBuyer = true;
    return scan;
  }

  /**
   * 记下某个客服列表来源的最新结果。只采用仍属当前页面代次、且不比已记录的更旧（请求序号）的响应；
   * 空列表、无法解析（null）或读取失败同样覆盖该来源的旧结果。返回是否采用与来源匿名序号。
   */
  private recordAssignSource(r: { source: string | null; epoch: number; at: number; seq: number }, candidates: AssignCandidates | null, tokens: AssignTokens | null): { cached: boolean; ord: number | null } {
    if (r.source === null) return { cached: false, ord: null };
    let ord = this.assignSourceOrds.get(r.source);
    if (ord === undefined) {
      ord = this.assignSourceOrds.size + 1;
      this.assignSourceOrds.set(r.source, ord);
    }
    if (r.epoch !== this.watchEpoch) return { cached: false, ord };
    const prev = this.assignSources.get(r.source);
    if (prev && prev.epoch === r.epoch && prev.seq > r.seq) return { cached: false, ord };
    for (const [k, v] of this.assignSources) if (v.epoch !== r.epoch) this.assignSources.delete(k);
    this.assignSources.set(r.source, { ord, epoch: r.epoch, at: r.at, seq: r.seq, candidates, tokens });
    return { cached: true, ord };
  }

  /** 同一页面代次、各自请求发出后 10 分钟内的来源（按各来源自己的时间过期，别的来源的新响应不给它续期）。 */
  private liveAssignSources(epoch: number) {
    const now = Date.now();
    return [...this.assignSources.values()].filter((v) => v.epoch === epoch && now - v.at < 10 * 60_000);
  }

  /** 各有效来源的候选合并；任一来源不完整或无法解析则不完整；没有可解析的来源为 null。 */
  private assignFor(epoch: number): AssignCandidates | null {
    return mergeAssignCandidates(this.liveAssignSources(epoch).map((v) => v.candidates));
  }

  /** 各有效来源键值的并集；任一来源不完整或无法解析则不完整；没有可解析的来源为 null。 */
  private assignTokensFor(epoch: number): AssignTokens | null {
    const live = this.liveAssignSources(epoch);
    const parsed = live.map((v) => v.tokens).filter((t): t is AssignTokens => t !== null);
    const merged = parsed.reduce<AssignTokens | null>((acc, t) => mergeAssignTokens(acc, t), null);
    return merged && parsed.length < live.length ? { ...merged, complete: false } : merged;
  }

  /**
   * 现场读取唯一打开对话的买家编号（不用扫描缓存 lastActiveUid）。
   * 页面代次已不是请求发出时的 sentEpoch（读取前或读取后）、或没有唯一打开的对话时返回 null（未知）。
   * 扫描只能看到读取时刻，不能证明两次读取之间未切换对话，因此不提供“与请求时同一会话”的判断。
   */
  private async freshActive(sentEpoch: number): Promise<string | null> {
    const scan = this.watchEpoch === sentEpoch ? await this.scanKeepingFresh() : null;
    // 同一对话可同时出现在“待回复”与“全部”列表并都带 active；按买家去重后仍须唯一。
    const buyers = new Set((scan?.items ?? []).filter((i) => i.active).map((i) => buyerFromListKey(i.key)));
    const [only] = buyers;
    return this.watchEpoch === sentEpoch && buyers.size === 1 && only ? only : null;
  }

  /**
   * 只读收藏状态：不点击、不悬停。打开的会话与星标状态须来自同一次页面快照（分开读时中途换走又换回，
   * 会把别的会话的星标记给本会话）；快照里打开项按买家去重后须恰好是该买家，且读取前后页面代次未变，
   * 否则 marked=null。颜色要悬停才能读，本步不读，color 一律 null。
   */
  async readConvState(conversationId: string, _timeoutMs: number): Promise<{ marked: boolean | null; color: null }> {
    if (!this.window || this.window.isDestroyed() || this.sending || this.outgoing) return { marked: null, color: null };
    return { marked: await this.starMarked(conversationId, this.window, this.watchEpoch), color: null };
  }

  /** 同一次页面快照里打开的会话按买家去重恰好是该买家、且读取前后页面未变时，返回星标是否已收藏；否则 null。 */
  private async starMarked(uid: string, page: PlatformPage, epoch: number): Promise<boolean | null> {
    const snap = await this.run<{ keys: unknown[]; active: boolean } | string>(CONV_STAR_SNAPSHOT).catch(() => "script_failed");
    if (this.window !== page || this.watchEpoch !== epoch || typeof snap === "string" || !Array.isArray(snap?.keys) || typeof snap.active !== "boolean") return null;
    return onlyBuyer(snap.keys) === uid ? snap.active : null;
  }

  /**
   * 契约“标星执行与成功判据”：只点星标颜色浮层中的目标颜色项。点击前核对（任一不满足都不点击）：
   * 页面代次与登录归属不变；同一次快照里打开的会话按买家去重恰好是该买家；星标唯一且未收藏；浮层由星标关联、目标点是目标颜色项；
   * 来源绑定（从占用页面起没有外来输入、没有标星/取消收藏请求，点击前 3 秒内页面也没有发出过）；运行时再核验通过、离确认截止不少于 1.5 秒。
   * 核对与点击之间只有等浮层出现、把鼠标移到目标项，不做其他页面操作。点击窗口内只放行一条与本次一致的 mark 请求，
   * 按它自己的响应判定；窗口内出现第二条请求、外来输入、页面或登录变化都是 unknown。不重试、不取消收藏、不改色。
   */
  async markConversation(request: MarkRequest): Promise<MarkResult> {
    const notSent = (reason: string, detail = reason): MarkResult => {
      console.log(`[${this.shopId}] platform mark not_sent reason=${reason} detail=${detail}`);
      return { status: "not_sent", reason };
    };
    // 占用页面：等清理与预热结束后，在 await 返回的同一同步段里复核并置 sending（见 popupSweep 说明）。
    do await this.yieldWarm(); while (this.popupSweep || this.warmRun);
    if (!this.window || this.window.isDestroyed()) return notSent("platform_window_closed");
    const status = this.tracker.status(true);
    if (!status.logged_in) return notSent("platform_logged_out");
    if (this.sending || this.outgoing || this.markWatch) return notSent("pdd_send_busy");
    const color = MARK_COLOR_VALUE[request.color];
    if (!/^[0-9]{1,32}$/.test(request.conversation_id) || !color) return notSent("pdd_mark_invalid_request");
    const uid = request.conversation_id;
    const page = this.window, epoch = this.watchEpoch;
    const shop = status.identity?.platform_shop_id ?? null;
    // 从占用页面起守护：外来输入、页面发出的标星 / 取消收藏请求、页面或登录变化都记在这里。
    const watch = newMarkWatch(uid, color, epoch);
    this.markWatch = watch;
    this.markPage = page;
    this.markCheck = () => {
      if (this.window !== page || page.isDestroyed() || this.watchEpoch !== epoch) return "page_changed_during_mark";
      const now = this.tracker.status(true);
      return now.logged_in && (now.identity?.platform_shop_id ?? null) === shop ? null : "platform_changed_during_mark";
    };
    /** 点击前的守护核对：返回放弃原因（页面变化、外来输入或请求为 conv_state_changed；登录变化为原样，由运行时归为 not_started）。 */
    const guard = (): string | null => {
      const lost = this.markCheck?.() ?? null;
      const detail = lost ?? (watch.foreign ? "manual_input" : watch.before ? "mark_request_before_click" : Date.now() - this.lastMarkRequestAt < MARK_QUIET_MS ? "mark_request_recent" : null);
      if (!detail) return null;
      console.log(`[${this.shopId}] platform mark guard detail=${detail}`);
      return detail === "platform_changed_during_mark" ? detail : "conv_state_changed";
    };
    /** 前台自己的输入命令：执行期间到达的对应类型事件算自己的，命令结束后清掉未到的期望。 */
    const own = async (types: string[], run: () => Promise<unknown>) => {
      watch.expected = [...types];
      try {
        return await run();
      } finally {
        watch.expected = [];
      }
    };
    const hover = (pt: Point) => own(["mouseMove"], () => Promise.race([
      Promise.resolve().then(() => page.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y })), sleep(500),
    ]).catch(() => undefined));
    const read = <T>(script: string): Promise<T> => Promise.race([
      this.run<T>(script), sleep(Math.max(1, Math.min(500, request.deadline * 1000 - Date.now()))).then(() => { throw Error("mark_read_timeout"); }),
    ]);
    let hovered = false;
    this.sending = true;
    try {
      const notOpened = await this.openConversation(uid, request.deadline, () => guard() ?? request.recheck(), 1000);
      if (notOpened) return notSent(notOpened);
      let stop = guard();
      if (stop) return notSent(stop);
      // 核对 2–4：同一次快照里的打开会话与星标状态。
      const snap = await read<{ keys: unknown[]; active: boolean } | string>(CONV_STAR_SNAPSHOT).catch(() => "script_failed");
      if ((stop = guard())) return notSent(stop);
      if (typeof snap === "string" || !Array.isArray(snap?.keys) || typeof snap.active !== "boolean") return notSent("conv_state_unavailable", typeof snap === "string" ? snap : "snapshot_invalid");
      if (onlyBuyer(snap.keys) !== uid) return notSent("conv_state_changed", "conversation_mismatch");
      if (snap.active) return notSent("conv_state_changed", "already_marked");
      // 核对 5：悬停星标等浮层出现；浮层须由星标关联、可见、唯一、至少三种已知颜色。
      const star = await read<{ x: number; y: number; active: boolean } | string>(STAR_ICON).catch(() => "script_failed");
      if ((stop = guard())) return notSent(stop);
      if (typeof star === "string") return notSent("conv_state_unavailable", star);
      hovered = true;
      await hover(star);
      let pop: StarSnapshot | string = "popover_missing";
      for (let i = 0; i < 8 && typeof pop === "string" && !guard(); i++) {
        await sleep(200);
        pop = await read<StarSnapshot | string>(starOptionsScript()).catch(() => "script_failed");
      }
      if ((stop = guard())) return notSent(stop);
      if (typeof pop === "string" || !Array.isArray(pop?.keys) || typeof pop.active !== "boolean" || !Array.isArray(pop.options)) return notSent("conv_state_unavailable", typeof pop === "string" ? pop : "popover_invalid");
      if (onlyBuyer(pop.keys) !== uid) return notSent("conv_state_changed", "conversation_mismatch");
      if (pop.active) return notSent("conv_state_changed", "already_marked");
      const hits = pop.options.filter((o) => o.color === request.color);
      if (hits.length !== 1 || hits[0].checked || !Number.isFinite(hits[0].x) || !Number.isFinite(hits[0].y)) return notSent("conv_state_unavailable", hits.length === 1 ? "target_checked_or_invalid" : "target_not_unique");
      const target = { x: hits[0].x, y: hits[0].y };
      // 鼠标移到目标颜色项（浮层保持展开）后，在该点核对命中元素属于星标浮层中目标颜色的列表项。
      await hover(target);
      // 最终核对在同一次页面快照里完成：命中目标颜色项（唯一、未勾选）、唯一打开的会话仍是本事件买家、星标仍未收藏。
      const owned = await read<string>(starOptionsScript({ ...target, color: request.color, buyer: uid })).catch(() => "script_failed");
      if ((stop = guard())) return notSent(stop);
      if (owned === "conversation_mismatch" || owned === "already_marked") return notSent("conv_state_changed", owned);
      if (owned !== "ok") return notSent("conv_state_unavailable", owned);
      // 按下前一刻：最后一次守护核对与运行时再核验，随即打开点击窗口；按下与松开两条命令各对应一条输入事件。
      const click = await dispatchPageClick(page.webContents, target, () => {
        return guard() ?? request.recheck() ?? (request.deadline - Date.now() / 1000 < 1.5 ? "claim_expiring" : null);
      }, () => {
        watch.open = true;
        watch.expected = ["mouseDown", "mouseUp"];
      });
      watch.expected = [];
      if (click.status === "not_sent") return notSent(click.reason);
      // 已开始点击（按下命令一旦尝试就不能证明未点击）：等放行请求的响应直到确认截止，此后只能是 confirmed 或 unknown。
      while (!watch.outcome && Date.now() / 1000 < request.deadline) await sleep(100);
      const late = this.markCheck?.() ?? null;
      if (late) watch.invalid ??= late;
      watch.closed = true;
      const verdict = judgeMark(watch);
      const observed = await this.observeMark(uid, page, epoch);
      console.log(`[${this.shopId}] platform mark result=${verdict.ok ? "confirmed" : "unknown"} reason=${verdict.ok ? "-" : verdict.reason} click=${click.status} allowed=${watch.allowed ? 1 : 0} blocked=${watch.blocked} foreign=${watch.foreign} observed=${observed}`);
      if (verdict.ok) return { status: "confirmed", page_observed: observed };
      return { status: "unknown", reason: click.status === "unknown" && !watch.allowed ? click.reason : verdict.reason, page_observed: observed };
    } finally {
      watch.closed = true;
      this.markWatch = null;
      this.markCheck = null;
      this.markPage = null;
      if (hovered) await hover({ x: 1, y: 1 });
      this.sending = false;
    }
  }

  /** 点击后读一次星标（最多 300 毫秒），只供显示：marked / unchanged；读不到或不能归属该买家为 unknown。 */
  private async observeMark(uid: string, page: PlatformPage, epoch: number): Promise<PageObserved> {
    const marked = await Promise.race([this.starMarked(uid, page, epoch), sleep(300).then(() => null)]);
    return marked === true ? "marked" : marked === false ? "unchanged" : "unknown";
  }

  /** 当前打开对话的绑定令牌：页面代次＋买家编号的摘要（不含可读身份）；按买家去重后没有唯一打开的对话返回 null。 */
  private async activeConvToken(): Promise<string | null> {
    const scan = await this.scanKeepingFresh();
    const buyer = onlyBuyer((scan?.items ?? []).filter((i) => i.active).map((i) => i.key));
    return buyer === null ? null : this.convTokenFor(buyer);
  }

  private convTokenFor(buyer: string): string {
    return crypto.createHash("sha256").update(`${this.watchEpoch}|${buyer}`).digest("hex").slice(0, 16);
  }

  /** 诊断模式：供人工测试在用户确认时取当前对话令牌，之后的动作请求须携带它。 */
  async activeConversationToken(): Promise<string | null> {
    return this.probeFile ? this.activeConvToken() : null;
  }

  /** 每次点击前的核对：对话须仍是 conv 指定的那个，且请求未过 exp；通过返回 null，否则返回原因。 */
  private async actionGate(epoch: number, conv: string, exp: number): Promise<string | null> {
    if (this.watchEpoch !== epoch || conv === null || (await this.activeConvToken()) !== conv) return "conversation_mismatch";
    return Date.now() > exp ? "expired" : null;
  }

  async starTest(color: StarColor, conv: string, exp: number): Promise<string> {
    if (!this.probeFile) return "not_executed:probe_mode_required";
    if (!this.window || this.window.isDestroyed() || !this.tracker.status(true).logged_in) return "not_executed:not_ready";
    if (this.sending || this.outgoing || this.popupSweep) return "not_executed:busy";
    const page = this.window, epoch = this.watchEpoch;
    const log = (rec: Record<string, unknown>) => fs.appendFileSync(path.join(path.dirname(this.probeFile!), "star-test.jsonl"), JSON.stringify({ at: new Date().toISOString(), color, ...rec }) + "\n", { mode: 0o600 });
    const same = async () => this.watchEpoch === epoch && (await this.activeConvToken()) === conv && conv !== null;
    const gate = () => this.actionGate(epoch, conv, exp);
    const hover = (pt: { x: number; y: number }) => page.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }).catch(() => undefined);
    const read = async (): Promise<StarState | string> => {
      const star = await this.run<{ x: number; y: number; active: boolean } | string>(STAR_ICON).catch(() => "script_failed");
      if (typeof star === "string") return star;
      await hover(star);
      await sleep(500);
      // 对话身份、星标状态与颜色项须来自同一次页面快照：分两次读时，中途换走又换回会把别的对话的颜色当成本对话的。
      const snap = await this.run<StarSnapshot | string>(starOptionsScript()).catch(() => "script_failed");
      if (typeof snap === "string") return snap;
      const buyer = Array.isArray(snap.keys) ? onlyBuyer(snap.keys) : null;
      if (this.watchEpoch !== epoch || buyer === null || this.convTokenFor(buyer) !== conv) return "conversation_mismatch";
      return { star: { x: star.x, y: star.y, active: snap.active }, options: snap.options };
    };
    this.sending = true;
    try {
      let blocked = await gate();
      if (blocked) return `not_executed:${blocked}`;
      const before = await read();
      if (typeof before === "string") return `not_executed:${before}`;
      const target = before.options.find((o) => o.color === color);
      if (!target) return `not_executed:color_missing(${before.options.map((o) => o.color).join(",")})`;
      if (before.star.active && target.checked) return "already";
      const owned = await this.run<string>(starOptionsScript({ x: target.x, y: target.y, color })).catch(() => "script_failed");
      if (owned !== "ok") return `not_executed:${owned}`;
      blocked = await gate();
      if (blocked) return `not_executed:${blocked}`;
      log({ phase: "attempt", before: { active: before.star.active, checked: before.options.find((o) => o.checked)?.color ?? null } });
      const click = await this.nativeClick({ x: target.x, y: target.y }, page, epoch);
      if (click.status !== "dispatched") {
        log({ phase: click.status, reason: click.reason });
        return `${click.status}:${click.reason}`;
      }
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        if (!(await same())) break;
        const after = await read();
        if (after === "conversation_mismatch") break;
        if (typeof after !== "string" && after.star.active && after.options.find((o) => o.color === color)?.checked) {
          log({ phase: "confirmed" });
          return "confirmed";
        }
      }
      log({ phase: "unknown", reason: "page_state_not_confirmed" });
      return "unknown:page_state_not_confirmed";
    } finally {
      await hover({ x: 1, y: 1 });
      this.sending = false;
    }
  }

  async transferConversation(request: TransferRequest): Promise<TransferResult> {
    const page = this.window, epoch = this.watchEpoch, status = this.tracker.status(true);
    const shop = status.identity?.platform_shop_id;
    if (!page || page.isDestroyed() || !status.logged_in || !shop) return { status: "not_sent", reason: "platform_logged_out" };
    if (request.allow_unmark && !request.before_unmark) return { status: "not_sent", reason: "unmark_not_authorized" };
    do await this.yieldWarm(); while (this.popupSweep || this.warmRun);
    if (this.sending || this.outgoing || this.markWatch) return { status: "not_sent", reason: "pdd_send_busy" };
    const watch = newMarkWatch(request.conversation_id, 2, epoch);
    let started = false;
    const checkPage = () => {
      if (watch.invalid) return watch.invalid;
      if (this.window !== page || page.isDestroyed() || this.watchEpoch !== epoch) return watch.invalid = "conv_state_changed";
      const status = this.tracker.status(true);
      if (!status.logged_in || status.identity?.platform_shop_id !== shop) return watch.invalid = "platform_changed";
      return watch.foreign || watch.before ? "conv_state_changed" : null;
    };
    const check = () => checkPage() ?? (Date.now() / 1000 >= request.deadline ? "claim_expiring" : null) ?? request.recheck();
    this.markWatch = watch; this.markPage = page; this.markCheck = check;
    const click = async (pt: Point, action: boolean, beforePress?: () => void) => {
      watch.expected = ["mouseDown", "mouseUp"];
      try {
        return await dispatchPageClick(page.webContents, pt, check, action ? () => {
          beforePress?.();
          if (beforePress) this.transferUnmarkWatch = watch;
          started = true;
        } : undefined);
      }
      finally { watch.expected = []; }
    };
    try {
      const blocked = check();
      if (blocked) return { status: "not_sent", reason: blocked };
      const result = await this.performTransfer(request.account, true, this.convTokenFor(request.conversation_id), request.deadline * 1000, request.allow_unmark,
        { check, click, unmark: pt => click(pt, true, request.before_unmark) });
      const completed = result === "confirmed:left_list_observed" || result === "confirmed:left_list_observed,unfavorited";
      const completionBlocker = completed ? check() : null;
      if (started && completed && (!completionBlocker || completionBlocker === "reply_deadline_exceeded")) {
        return { status: "confirmed", page_observed: "left_list", ...(result.endsWith(",unfavorited") ? { unmarked: true as const } : {}) };
      }
      if (started) return { status: "unknown", reason: "transfer_binding_unproven", page_observed: result.includes("left_list_observed") ? "left_list" : "unknown" };
      const detail = result.startsWith("not_executed:") ? result.slice("not_executed:".length) : "not_started";
      const reason = detail.startsWith("transfer_") || detail.startsWith("conv_state_") ? detail : "transfer_" + detail;
      console.log(`[${this.shopId}] transfer not_started reason=${reason}`);
      return { status: "not_sent", reason };
    } catch {
      return started ? { status: "unknown", reason: "transfer_exception_or_timeout" } : { status: "not_sent", reason: "transfer_read_failed" };
    } finally {
      watch.closed = true; this.markWatch = null; this.markPage = null; this.markCheck = null; this.transferUnmarkWatch = null;
    }
  }

  /**
   * 诊断模式下的人工触发测试：把当前对话转移给账号名完全等于 target 的唯一客服。
   * confirm=false 只打开转移对话框和确认气泡、记录内容后关闭，不点确认；confirm=true 才点确认。
   * 每次点击前核对当前对话仍是 conv 指定的那个，不符则不点。点确认前写本地尝试记录；结果只看页面状态，无平台回执；不重试。
   * 平台拒绝转移已收藏会话时，只有 allowUnfavorite 才点“取消收藏并转移”，否则返回需确认。
   */
  async transferTest(target: string, confirm: boolean, conv: string, exp: number, allowUnfavorite = false): Promise<string> {
    if (!this.probeFile) return "not_executed:probe_mode_required";
    return this.performTransfer(target, confirm, conv, exp, allowUnfavorite);
  }

  private async performTransfer(target: string, confirm: boolean, conv: string, exp: number, allowUnfavorite: boolean,
    hooks?: TransferHooks): Promise<string> {
    if (!this.window || this.window.isDestroyed() || !this.tracker.status(true).logged_in) return "not_executed:not_ready";
    if (this.sending || this.outgoing || this.popupSweep) return "not_executed:busy";
    if (!target.trim()) return "not_executed:no_target";
    const page = this.window, epoch = this.watchEpoch;
    const log = (rec: Record<string, unknown>) => { if (this.probeFile && !hooks) fs.appendFileSync(path.join(path.dirname(this.probeFile), "transfer-test.jsonl"), JSON.stringify({ at: new Date().toISOString(), confirm, ...rec }) + "\n", { mode: 0o600 }); };
    const ctx = { seq: ++this.transferDiagSeq, target, epoch, startedAt: Date.now(), attemptAt: null as number | null };
    if (!hooks) this.transferProbeCtx = ctx;
    const read = <T>(script: string): Promise<T> => !hooks ? this.run<T>(script) : Promise.race([
      this.run<T>(script), sleep(Math.max(1, Math.min(500, exp - Date.now()))).then(() => { throw Error("transfer_read_timeout"); }),
    ]);
    const same = async () => this.watchEpoch === epoch && (await (!hooks ? this.activeConvToken() : Promise.race([this.activeConvToken(), sleep(500).then(() => null)]))) === conv && conv !== null;
    const gate = async () => {
      const before = hooks?.check();
      if (before) return before;
      const result = await (!hooks ? this.actionGate(epoch, conv, exp) : Promise.race([this.actionGate(epoch, conv, exp), sleep(500).then(() => "transfer_read_timeout")]));
      return result ?? hooks?.check() ?? null;
    };
    const clickPage = (pt: Point, action = false) => hooks ? hooks.click(pt, action) : this.nativeClick(pt, page, epoch);
    const leftovers = () => Promise.race([read<{ dialogs: number; popovers: number } | string>(TRANSFER_LEFTOVERS), sleep(500).then(() => "unavailable")]).catch(() => "script_failed");
    // 收尾只点转移弹窗自己的空白遮罩，不发全局按键、不碰气泡动作；关不掉就保留未知，不重试。
    const dismiss = async (): Promise<Record<string, unknown>> => {
      const steps: Record<string, unknown>[] = [];
      let left = await leftovers();
      if (typeof left !== "string" && (left.dialogs || left.popovers) && buyer && this.window === page && this.watchEpoch === epoch && !page.isDestroyed() && await Promise.race([same(), sleep(150).then(() => false)])) {
        const result = await Promise.race([read<string>(transferDialogBlankScript(buyer, Date.now() + 500)), sleep(500).then(() => "unavailable")]).catch(() => "script_failed");
        await sleep(100);
        left = await leftovers();
        steps.push({ step: "blank_click", result, left });
      }
      return { steps, leftover: left };
    };
    // 点过行内“转移”后确认气泡可能还开着：提前返回时点一次气泡里的“取消”，再关对话框（否则下次点“转移会话”只会关掉气泡）。
    // 只在原页面、原会话、有效期都仍成立时点；点击前最后一步核对命中点属于目标行关联的唯一气泡里唯一的“取消”。
    // 每次 transferTest 最多尝试一次，不论结果；返回实际点击状态或跳过原因（dispatched 只表示命令已被接受，是否关掉看收尾的残留观察）。
    let cancelTried = false;
    let buyer: string | null = null;
    const cancelPopover = async (): Promise<string> => {
      if (cancelTried) return "skipped:already_tried";
      cancelTried = true;
      if (buyer === null) return "skipped:no_buyer";
      let blocked = await gate();
      if (blocked) return `skipped:${blocked}`;
      const list = await read<{ text: string; x: number; y: number }[] | string>(popoverButtonsScript(target)).catch(() => "script_failed");
      if (typeof list === "string") return `skipped:${list}`;
      const cancels = list.filter((b) => b.text === "取消");
      if (cancels.length !== 1) return `skipped:cancel_${cancels.length ? "not_unique" : "missing"}`;
      blocked = await gate();
      if (blocked) return `skipped:${blocked}`;
      // 最后一次页面快照里同时核对：当前对话仍是本次买家、“取消”属于目标行关联的唯一气泡、命中点落在它上面。
      const owned = await read<string>(popoverButtonsScript(target, { x: cancels[0].x, y: cancels[0].y, text: "取消", buyer })).catch(() => "script_failed");
      if (owned !== "ok") return `skipped:${owned}`;
      // 快照之后不再等任何页面读取；提交点击前同步复核页面代次与期限。
      if (this.watchEpoch !== epoch) return "skipped:conversation_mismatch";
      if (Date.now() > exp) return "skipped:expired";
      const click = await clickPage(cancels[0]);
      return click.status === "dispatched" ? "dispatched" : `${click.status}:${click.reason}`;
    };
    this.sending = true;
    let opened = false;
    let popoverMaybe = false;
    try {
      let blocked = await gate();
      if (blocked) return `not_executed:${blocked}`;
      const scan = hooks ? await read<Scan>(SCAN).catch(() => null) : await this.scanKeepingFresh();
      if (scan?.freshBuyer) this.pendingFreshBuyer = true;
      const active = scan?.items.find((i) => i.active);
      const uid = active ? buyerFromListKey(active.key) : null;
      if (!uid) return "not_executed:no_active_conversation";
      // 这次扫描读到的买家须与请求携带的对话令牌一致，之后的页面快照按这个买家核对。
      if (this.convTokenFor(uid) !== conv) return "not_executed:conversation_mismatch";
      buyer = uid;
      if (hooks) {
        const marked = await Promise.race([
          this.starMarked(uid, page, epoch), sleep(Math.max(1, Math.min(500, exp - Date.now()))).then(() => null),
        ]).catch(() => null);
        if (marked === null) return "not_executed:conv_state_unavailable";
        if (marked && !allowUnfavorite) return "not_executed:transfer_blocked_by_mark";
      }
      if (hooks && await read(transferUnmarkScript(uid)).catch(() => "script_failed") !== null) return "not_executed:leftover_failure";
      // 上次留下的对话框或确认气泡还开着时，点“转移会话”可能只是关掉气泡；不在这种状态下开始。
      const left = await read<{ dialogs: number; popovers: number } | string>(TRANSFER_LEFTOVERS).catch(() => "script_failed");
      if (typeof left === "string" || left.dialogs || left.popovers) {
        log({ phase: "not_executed", reason: "leftover_popup", detail: typeof left === "string" ? left : left });
        return "not_executed:leftover_popup";
      }
      const open = await read<Point | string>(textTargetScript("转移会话", ".chat-list, li.chat-item, .el-dialog")).catch(() => "script_failed");
      if (typeof open === "string") return `not_executed:open_button_${open}`;
      blocked = await gate();
      if (blocked) return `not_executed:${blocked}`;
      // 打开对话框：not_sent 保持原样；unknown 表示按下命令已发出、可能已经生效，不补点，记一条结果后按页面观察继续。
      const openClick = await clickPage(open);
      if (openClick.status === "not_sent") return "not_executed:open_click_failed";
      opened = true;
      if (openClick.status === "unknown") log({ phase: "open_click", result: "unknown", reason: openClick.reason });
      let rows: TransferRow[] | string = "dialog_missing";
      for (let i = 0; i < 10 && Date.now() < exp && (typeof rows === "string" || !rows.length); i++) {
        await sleep(300);
        rows = await read<TransferRow[] | string>(hooks ? FORMAL_TRANSFER_ROWS : TRANSFER_ROWS).catch(() => "script_failed");
      }
      if (Date.now() >= exp) return "not_executed:expired";
      if (typeof rows === "string") return `not_executed:${rows}`;
      // 只认第一列（客服名）与用户指定名称完全相同；备注、状态等其他列命中不算。
      const matches = rows.filter((r) => r.cells[0] === target);
      log({ phase: "rows", rows: rows.length, matches: matches.length });
      if (matches.length !== 1) return `not_executed:target_${matches.length ? "ambiguous" : "missing"}`;
      if (!matches[0].button) return "not_executed:target_button_missing";
      // 对话框打开有动画：连续两次（间隔 300ms）读到同一位置才算稳定，否则不点。
      let btn: Point | string = await read<Point | string>(transferTargetScript(target, uid)).catch(() => "script_failed");
      let stable = false;
      for (let i = 0; i < 6 && Date.now() < exp && typeof btn !== "string" && !stable; i++) {
        await sleep(300);
        const next = await read<Point | string>(transferTargetScript(target, uid)).catch(() => "script_failed");
        stable = typeof next !== "string" && Math.abs(next.x - btn.x) <= 1 && Math.abs(next.y - btn.y) <= 1;
        btn = next;
      }
      if (typeof btn === "string") return `not_executed:${btn}`;
      if (!stable) {
        log({ phase: "not_executed", reason: "target_unstable" });
        return "not_executed:target_unstable";
      }
      blocked = await gate();
      if (blocked) return `not_executed:${blocked}`;
      // Last DOM read before pressing: do not await another scan after the hit/owner snapshot.
      btn = await read<Point | string>(transferTargetScript(target, uid)).catch(() => "script_failed");
      if (typeof btn === "string") return `not_executed:${btn}`;
      if ((await clickPage(btn, true)).status !== "dispatched") return "not_executed:row_click_failed";
      popoverMaybe = true;
      await sleep(500);
      // 点行后重读：目标行须仍唯一且仍在刚才点的位置（表格重排/身份变化时可能点到了别人）。确认气泡可能盖住按钮，所以这里不核对遮挡。
      const again = await read<Point | string>(transferTargetRectScript(target, uid)).catch(() => "script_failed");
      if (again === "conversation_mismatch") return "not_executed:conversation_mismatch";
      if (typeof again === "string" || Math.abs(again.x - btn.x) > 2 || Math.abs(again.y - btn.y) > 2) {
        log({ phase: "not_executed", reason: "target_moved", detail: typeof again === "string" ? again : "moved", dx: typeof again === "string" ? null : again.x - btn.x, dy: typeof again === "string" ? null : again.y - btn.y });
        return "not_executed:target_moved";
      }
      const buttons = await read<{ text: string; x: number; y: number }[] | string>(popoverButtonsScript(target)).catch(() => "script_failed");
      log({ phase: "popover", buttons: typeof buttons === "string" ? buttons : buttons.length, kinds: typeof buttons === "string" ? null : popoverButtonKinds(buttons) });
      if (typeof buttons === "string") return `not_executed:${buttons}`;
      // 气泡里另有转移原因和“发送”（可能向买家发消息），只认“无原因直接转移”。
      const ok = buttons.filter((b) => b.text === "无原因直接转移");
      if (!confirm) {
        log({ phase: "inspect_cancel", result: await cancelPopover() });
        return `inspected:rows=${rows.length},confirm_buttons=${ok.length}`;
      }
      if (ok.length !== 1) return `not_executed:confirm_button_${ok.length ? "not_unique" : "missing"}`;
      // 点确认前在同一次页面核对里确认：命中点属于目标行关联的唯一气泡中那一个“无原因直接转移”控件。
      blocked = await gate();
      if (blocked) return `not_executed:${blocked}`;
      const owned = await read<string>(popoverButtonsScript(target, { x: ok[0].x, y: ok[0].y, text: "无原因直接转移", buyer: uid })).catch(() => "script_failed");
      if (owned !== "ok") {
        log({ phase: "not_executed", reason: owned });
        return `not_executed:${owned}`;
      }
      if (this.watchEpoch !== epoch || Date.now() > exp) return "not_executed:expired_or_page_changed";
      log({ phase: "attempt" });
      ctx.attemptAt = Date.now();
      const click = await clickPage(ok[0], true);
      if (click.status !== "dispatched") {
        log({ phase: click.status, reason: click.reason });
        return `${click.status}:${click.reason}`;
      }
      opened = false;
      popoverMaybe = false;
      return await this.settleTransfer(uid, page, epoch, exp, same, gate, allowUnfavorite, log, hooks ? read : undefined, hooks);
    } finally {
      // 收尾出错不得让本适配器一直处于忙碌：无论收尾结果如何都释放 sending。
      try {
        if (opened) {
          if (popoverMaybe && !cancelTried) {
            log({ phase: "cleanup", popover_cancel: await cancelPopover() });
            await sleep(300);
          }
          await sleep(300);
          log({ phase: "cleanup", ...(await dismiss()) });
        }
      } catch {
        try {
          log({ phase: "cleanup", result: "cleanup_failed" });
        } catch {
          // 连日志都写不了时只放弃记录。
        }
      } finally {
        this.sending = false;
      }
    }
  }

  /**
   * 点了转移后观察页面：平台提示“已收藏的会话不可转移”时，allowUnfavorite 才点一次“取消收藏并转移”，
   * 否则点“暂不转移收藏会话”（保持原状）并返回需确认。
   * 确认转接后，在原页面、店铺和期限内观察到会话离开非空列表即成功；未确认完成则不重试。
   */
  private async settleTransfer(uid: string, page: PlatformPage, epoch: number, expiresAt: number, same: () => Promise<boolean>, gate: () => Promise<string | null>, allowUnfavorite: boolean, log: (rec: Record<string, unknown>) => void,
    read?: <T>(script: string) => Promise<T>, hooks?: TransferHooks): Promise<string> {
    const shop = this.tracker.status(true).identity?.platform_shop_id;
    const valid = () => this.window === page && !page.isDestroyed() && this.watchEpoch === epoch && Date.now() < expiresAt
      && this.tracker.status(true).logged_in && this.tracker.status(true).identity?.platform_shop_id === shop;
    // 20秒限制开始动作；确认后的结果观察仍受原许可和确认期限约束。
    const observationBlocker = () => {
      const blocked = hooks?.check();
      return blocked === "reply_deadline_exceeded" ? null : blocked;
    };
    let unfavorited = false;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      if (!valid()) return "unknown:transfer_observation_invalid";
      const blocked = observationBlocker();
      if (blocked) return `unknown:${blocked}`;
      const fail = await (read ?? this.run.bind(this))<{ text: string; unfav: Point | null; keep: Point | null } | string | null>(hooks ? transferUnmarkScript(uid, undefined, !allowUnfavorite) : TRANSFER_FAIL_DIALOG).catch(() => "script_failed");
      if (typeof fail === "string") return `unknown:${fail}`;
      if (fail && !unfavorited) {
        if (!fail.text.includes("已收藏") || !fail.unfav) {
          log({ phase: "page_failed", kind: "other" });
          return "page_failed:other";
        }
        if (!allowUnfavorite) {
          log({ phase: "needs_confirmation", kind: "favorited" });
          if (hooks && fail.keep) {
            const blocked = await gate();
            if (blocked) return `unknown:${blocked}`;
            const owned = await read!<string>(transferUnmarkScript(uid, fail.keep, true)).catch(() => "script_failed");
            if (owned === "ok") await hooks.click(fail.keep, true);
          } else if (fail.keep && (await same())) await this.nativeClick(fail.keep, page, epoch);
          return "needs_confirmation:unfavorite";
        }
        // 首次转移已点过，结果仍按 unknown；过期或换了对话就不再补做取消收藏。
        const blocked = await gate();
        if (blocked) {
          log({ phase: "unknown", reason: `${blocked}_before_unfavorite` });
          return `unknown:${blocked}_before_unfavorite`;
        }
        if (hooks) {
          // 最后一个异步读取同时核对买家、唯一拒绝框和命中；之后只有同步守护与一次点击。
          const owned = await read!<string>(transferUnmarkScript(uid, fail.unfav)).catch(() => "script_failed");
          if (owned !== "ok") return `unknown:${owned}`;
          const click = await hooks.unmark(fail.unfav);
          if (click.status !== "dispatched") return `unknown:unmark_and_transfer_${click.status}`;
          unfavorited = true;
          continue;
        }
        log({ phase: "unfavorite_and_transfer" });
        const click = await this.nativeClick(fail.unfav, page, epoch);
        if (click.status !== "dispatched") {
          log({ phase: click.status, reason: click.reason });
          return `${click.status}:${click.reason}`;
        }
        unfavorited = true;
        continue;
      }
      const scan = read ? await read<Scan>(SCAN).catch(() => null) : await this.scanKeepingFresh();
      if (scan?.freshBuyer) this.pendingFreshBuyer = true;
      if (!valid()) return "unknown:transfer_observation_invalid";
      const afterReadBlocker = observationBlocker();
      if (afterReadBlocker) return `unknown:${afterReadBlocker}`;
      // 列表为空可能是筛选/刷新/加载中，不算观察到离开。
      if (!fail && scan && scan.items.length > 0 && scan.items.every((it) => buyerFromListKey(it.key) !== null) && !scan.items.some((it) => buyerFromListKey(it.key) === uid)) {
        log({ phase: "confirmed", observed: "left_list", unfavorited });
        return `confirmed:left_list_observed${unfavorited ? ",unfavorited" : ""}`;
      }
    }
    log({ phase: "unknown", observed: "none", unfavorited });
    return `unknown:not_observed${unfavorited ? ",unfavorited" : ""}`;
  }

  private async clearInput(text: string, uid?: string) {
    await this.run(`(() => {
      const buyer = ${JSON.stringify(uid ?? null)};
      const keys = [...document.querySelectorAll("li.chat-item .chat-item-box.active[data-random]")].map(e => /^([0-9]{1,32})-/.exec(e.getAttribute("data-random") || "")?.[1]);
      if (buyer !== null && (!keys.length || !keys.every(k => k === buyer))) return;
      const ta = document.querySelector(${JSON.stringify(TEXTAREA)});
      if (!ta || ta.value !== ${JSON.stringify(text)}) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    })()`).catch(() => undefined);
  }

  onEvent(listener: (e: AdapterEvent) => void) {
    this.listeners.push(listener);
  }

  private emit(e: AdapterEvent) {
    if (e.type === "session_started") this.health.sessionStarted();
    if (e.type === "session_ended" && e.reason === "platform_logged_out") this.health.sessionEnded(false);
    if (e.type === "session_started" || e.type === "session_ended") {
      this.optionsPrepared = false;
      this.prepareResult = null;
      this.videoRows = null;
      this.goodsRows.clear();
      this.goodsTabAt.clear();
      this.instructTriedAt.clear();
      this.instructRound.clear();
      this.lastInstruct = null;
      this.orders.reset();
      this.sendOptions.reset();
    }
    for (const l of this.listeners) l(e);
  }

  dispose() {
    this.disposed = true;
    this.loginExpiryStop?.();
    this.loginExpiryStop = null;
    this.messageWatcher?.close();
    this.listeners.length = 0;
    if (this.window && !this.window.isDestroyed()) this.window.close();
  }
}

function isLoginPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === "mms.pinduoduo.com" && /^\/login/.test(url.pathname);
  } catch {
    return false;
  }
}
