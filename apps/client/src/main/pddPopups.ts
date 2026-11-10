/**
 * 平台页面的引导 / 广告弹窗清理（在隔离环境执行，页面脚本不可见）。
 *
 * 自动（auto）：只点浮层里“我知道了 / 跳过 / 下次再说”这类没有副作用的按钮，以及类名明显是引导、公告、
 * 活动的浮层右上角关闭按钮；不点“关闭 / 取消”，避免关掉人工自己打开的对话框。
 * 手动（manual，人工点“清理弹窗”）：另外点浮层里的“关闭 / 取消”和任意浮层的关闭图标。
 *
 * 两种方式都不碰聊天输入区、消息列表、买家列表、说明书与视频弹窗，也不碰含文本输入框的浮层；
 * 浮层文字涉及协议、授权、付款、违规处罚等内容时一律留给人工阅读处理；浮层文字超过 400 字也不处理。
 * 浮层取按钮祖先链上最外层的定位容器（fixed，或 absolute 且 z-index ≥ 100），上述检查都针对这整个容器：
 * 按钮放在内层定位容器里也逃不过外层对话框的文字与输入框检查；最外层若是包含聊天区的整页容器就整体跳过。
 * 每个元素最多点两次；每次最多点 4 个。返回点过的按钮与因上述规则跳过的浮层（只有结构签名与不含数字的短标题）。
 *
 * deadline（本机毫秒时间）：脚本开始执行时、以及每次点击前都核对，过了就不再点击并返回 expired。
 * 页面忙时排队迟到的旧脚本因此不会改变页面；调用方仍须等脚本真正结束（或页面已销毁）才解除与发送的互斥。
 */
export type PopupSweepMode = "auto" | "manual";
export type PopupSweepResult = { dismissed: { label: string; layer: string }[]; seen: { layer: string; title: string | null; why: string }[]; expired?: boolean };

/** 自动清理的按钮文字（去掉空白后整段相等）。 */
export const AUTO_DISMISS_LABELS = ["我知道了", "知道了", "我已知晓", "已知晓", "好的知道了", "跳过", "跳过引导", "下次再说", "以后再说", "稍后再说", "暂不需要", "不再提示", "今天不再提示", "今日不再提示", "我已了解"] as const;
/** 人工“清理弹窗”时额外点击的按钮文字。 */
export const MANUAL_DISMISS_LABELS = ["关闭", "取消", "暂不", "我再想想"] as const;
/** 浮层文字含这些内容时不自动处理，留给人工。 */
export const POPUP_RISKY = "协议|同意|授权|支付|付款|扣款|保证金|提现|违规|处罚|罚款|扣分|封禁|冻结|申诉|注销";
/** 业务区域：其内的元素、包含它们的浮层都不处理。 */
/** 类名明显是引导、公告、活动的浮层（自动清理可点其关闭图标）。installerContact 是平台“联系安装师傅”的纯图片引导，关闭只是隐藏、7 天显示一次，会挡住输入区的视频入口。 */
export const POPUP_GUIDE = "guide|tour|intro|novice|newbie|onboard|announce|advert|promot|activity|upgrade|spotlight|coach|feature|notice-pop|ad-pop|adpop|installerContact";
export const POPUP_SKIP =
  "div.reply-box, ul.msg-list, li.chat-item, .chat-list, textarea, [contenteditable=true], input[type=text], input[type=search], input:not([type]), div.el-dialog.goods-desc-modal-part-dialog, ul.video-list-box";

export function popupSweepScript(mode: PopupSweepMode, deadline: number): string {
  const labels = mode === "manual" ? [...AUTO_DISMISS_LABELS, ...MANUAL_DISMISS_LABELS] : [...AUTO_DISMISS_LABELS];
  if (!Number.isFinite(deadline)) throw new Error("invalid_deadline");
  return `(() => {
  const DEADLINE = ${Math.floor(deadline)};
  if (Date.now() > DEADLINE) return { dismissed: [], seen: [], expired: true };
  const MODE = ${JSON.stringify(mode)};
  const LABELS = new Set(${JSON.stringify(labels)});
  const RISKY = new RegExp(${JSON.stringify(POPUP_RISKY)});
  const SKIP = ${JSON.stringify(POPUP_SKIP)};
  const GUIDE = new RegExp(${JSON.stringify(POPUP_GUIDE)}, "i");
  const state = (window.__clawPopups ??= { tries: new WeakMap() });
  const vw = innerWidth, vh = innerHeight;
  const cls = (el) => (typeof el.className === "string" ? el.className : el.getAttribute?.("class") || "").trim();
  const sig = (el) => el.tagName.toLowerCase() + (cls(el) ? "." + cls(el).split(/\\s+/).slice(0, 3).join(".") : "");
  const chain = (el) => { const out = []; for (let e = el, i = 0; e && e !== document.body && i < 3; e = e.parentElement, i++) out.unshift(sig(e)); return out.join(" > "); };
  const short = (s) => { const t = (s || "").replace(/\\s+/g, " ").trim(); return t && t.length <= 12 && !/[0-9０-９¥￥@]/.test(t) ? t : null; };
  const norm = (s) => (s || "").replace(/\\s+/g, "");
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    const s = getComputedStyle(el);
    return s.visibility === "visible" && s.display !== "none" && Number(s.opacity) > 0.05 && s.pointerEvents !== "none";
  };
  // 浮层：祖先链上最外层的 fixed，或 absolute 且 z-index ≥ 100 的容器（整条链都看，不只最近一层）。
  const layerOf = (el) => {
    let layer = null;
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.position === "fixed" || (s.position === "absolute" && Number(s.zIndex) >= 100)) layer = e;
    }
    return layer;
  };
  const guideLike = (layer, el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (GUIDE.test(cls(e))) return true;
      if (e === layer) break;
    }
    for (let e = layer; e && e !== document.body; e = e.parentElement) if (GUIDE.test(cls(e))) return true;
    return false;
  };
  const closeIcon = (el) => {
    if (el.getAttribute("aria-label") === "关闭" || el.getAttribute("title") === "关闭") return true;
    return cls(el).split(/\\s+/).some((t) => /close/i.test(t) && !/closed|enclose|closest/i.test(t)) || /headerbtn|close-btn/i.test(cls(el));
  };
  const candidates = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = norm(n.nodeValue);
    if (!t || t.length > 8 || !LABELS.has(t) || !n.parentElement) continue;
    const el = n.parentElement.closest("button, a, [role=button]") ?? n.parentElement;
    if (norm(el.textContent) !== t) continue;
    candidates.push({ el, label: t, icon: false });
  }
  for (const el of document.querySelectorAll("[class*=close], [class*=Close], [aria-label=关闭], [title=关闭], [class*=headerbtn]")) {
    if (!closeIcon(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 64 || r.height > 64) continue;
    candidates.push({ el, label: "×", icon: true });
  }
  const dismissed = [], seen = [], done = new Set();
  let expired = false;
  const note = (layer, why) => { if (seen.length < 10 && !seen.some((s) => s.layer === chain(layer))) seen.push({ layer: chain(layer), title: short(layer.querySelector("[class*=title], h1, h2, h3, h4")?.textContent), why }); };
  for (const c of candidates) {
    if (dismissed.length >= 4) break;
    const { el } = c;
    if (el.closest(SKIP) || !visible(el) || (state.tries.get(el) ?? 0) >= 2) continue;
    const layer = layerOf(el);
    if (!layer || done.has(layer)) continue;
    if (layer.matches(SKIP) || layer.closest(SKIP) || layer.querySelector(SKIP)) continue;
    const text = norm(layer.textContent);
    if (text.length > 400) continue;
    if (RISKY.test(text)) { note(layer, "risky"); continue; }
    if (c.icon && MODE === "auto" && !guideLike(layer, el)) { note(layer, "not_guide"); continue; }
    if (Date.now() > DEADLINE) { expired = true; break; }
    state.tries.set(el, (state.tries.get(el) ?? 0) + 1);
    done.add(layer);
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    dismissed.push({ label: c.label, layer: chain(layer) });
  }
  return expired ? { dismissed, seen, expired } : { dismissed, seen };
})()`;
}
