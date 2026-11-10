import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { errors } from "playwright-core";
import { connectExistingPage } from "./electronPlaywright.js";
import { selectSendControl } from "./scraplingSelector.js";
import { dispatchPageClick, syncPageFrame, type PageClickResult } from "./pddClick.js";

/**
 * 平台发送按钮的文字。平台给出“推荐话术”时同一个按钮显示“坚持发送”，点下去仍发送输入框里的原文。
 */
const SEND_LABEL = "^(?:(发送|Send)(\\(?((Ctrl\\+)?Enter|回车)\\)?|↵)?|坚持发送)$";
/**
 * 平台在“推荐话术”时用 v-show 隐藏 reply-footer，并在回复框里另显示一个 div.send-btn（加载中带 sendBtn_disabled）；
 * 它和底栏按钮调用同一个发送方法。两处都算候选，不可用的那个按尺寸/禁用类排除。
 */
const SEND_CANDIDATES = ".reply-footer button, .reply-footer div, .reply-footer span, .reply-footer [role=button], div.send-btn:not(.sendBtn_disabled)";
/**
 * 发送区布局诊断（失败时记日志用）：只取可见性、数量与元素的类名签名，不取任何文字。
 * 平台在“推荐话术”时会隐藏 reply-footer、在别处显示另一个发送按钮；被浮层盖住时记下盖住它的元素。
 */
const SEND_AREA_PROBE = `(() => {
  const label = new RegExp(${JSON.stringify(SEND_LABEL)});
  const sig = (el) => el ? el.tagName.toLowerCase() + [...el.classList].slice(0, 2).map((c) => "." + c).join("") : "none";
  const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width >= 4 && r.height >= 4 && getComputedStyle(el).visibility === "visible"; };
  const box = document.querySelector("div.reply-box");
  const footer = box?.querySelector(".reply-footer");
  const btns = [...(box?.querySelectorAll(".send-btn") ?? [])].filter(shown);
  const inFooter = btns.find((b) => footer?.contains(b));
  let hit = "none";
  const probe = inFooter ?? btns[0];
  if (probe) { const r = probe.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); hit = h === probe || probe.contains(h) ? "self" : sig(h) + "<" + sig(h?.parentElement); }
  return "box=" + !!box + " footer=" + shown(footer) + " btns=" + btns.length + " in_footer=" + !!inFooter + " hit=" + hit +
    " labels=" + btns.map((b) => (label.test(b.innerText.replace(/\\s+/g, "")) ? "ok" : "other") + (b.classList.contains("sendBtn_disabled") ? "-disabled" : "")).join(",") +
    " gpt=" + shown(box?.querySelector(".gpt-suggest")) + " repeat=" + shown(box?.querySelector(".repeat-interceptor-popup")) +
    " vis=" + document.visibilityState + " focus=" + document.hasFocus() + " vw=" + innerWidth + "x" + innerHeight;
})()`;
const SAFE_ERRORS = new Set(["playwright_page_unavailable", "selector_unavailable", "selector_timeout"]);

/** Prepare one trusted button click. Confirmation still comes from the platform response. */
export async function clickSendWithPlaywright(wc: WebContents, uid: string, text: string, deadline: number, current: () => string | null,
  clicked: (pressed: boolean) => void, filled: () => void, diagnose: (detail: string) => void = () => undefined): Promise<PageClickResult> {
  let step = "connect";
  let pressed = false, active = true;
  let connection: Awaited<ReturnType<typeof connectExistingPage>> | null = null;
  let refusal: string | null = null;
  let verifyAtPress: () => Promise<string | null> = async () => "pdd_send_control_unverified";
  let clickPoint: { x: number; y: number } | null = null;
  const disconnect = () => connection?.close();
  const nonce = randomUUID();
  const surfaceKey = `claw-send-surface-${nonce}`;
  const restoreSurface = `globalThis[${JSON.stringify(surfaceKey)}]?.restore()`;
  const sweepSurface = `globalThis[${JSON.stringify(surfaceKey)}]?.sweep()`;
  let deadlineBounded = false;
  const left = () => {
    const remaining = deadline * 1000 - Date.now() - 1500;
    deadlineBounded = remaining <= 2000;
    return Math.max(1, Math.min(2000, Math.ceil(remaining)));
  };
  const blocked = () => refusal ?? (!active ? "pdd_page_changed" : current() ?? (Date.now() / 1000 >= deadline - 1.5 ? "claim_expiring" : null));
  const stop = (reason: string): PageClickResult => ({ status: pressed ? "unknown" : "not_sent", reason });
  let timer: NodeJS.Timeout | undefined;
  try {
    const initial = blocked(); if (initial) return stop(initial);
    const operation = async (): Promise<PageClickResult> => {
      // Playwright 只做 DOM 定位；可信输入由已有的单次 CDP 点击器执行。
      connection = await connectExistingPage(wc, () => "pdd_send_control_unverified");
      const connectedBlock = blocked();
      if (connectedBlock) { connection.close(); return stop(connectedBlock); }
      const page = connection.page;
      step = "input";
      const input = page.locator("div.reply-box div.reply-input textarea:visible");
      if (await input.count() !== 1) return stop("pdd_input_missing");
      // Atomic draft check and fill: never replace text that a human entered in the meantime.
      const fill = await input.evaluate((ta, args) => {
        const keys = [...document.querySelectorAll("li.chat-item .chat-item-box.active[data-random]")].map(e => /^([0-9]{1,32})-/.exec(e.getAttribute("data-random") ?? "")?.[1]);
        if (!keys.length || keys.some(k => !k) || new Set(keys).size !== 1 || keys[0] !== args.uid) return "pdd_conversation_changed";
        if (Date.now() >= args.until) return "claim_expiring";
        const el = ta as HTMLTextAreaElement;
        if (el.disabled || el.readOnly || !el.closest("div.reply-box")) return "pdd_input_missing";
        if (el.value.trim()) return "pdd_input_not_empty";
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, args.text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return null;
      }, { uid, text, until: deadline * 1000 - 1500 });
      if (fill) return stop(fill);
      filled();
      const block = blocked(); if (block) return stop(block);
      step = "wait_button";
      await page.waitForFunction(args => [...document.querySelectorAll("div.reply-box")].flatMap(box => [...box.querySelectorAll<HTMLElement>(args.scope)]).some(e => {
        const r = e.getBoundingClientRect();
        return new RegExp(args.label).test(e.innerText?.replace(/\s+/g, "") ?? "") && getComputedStyle(e).visibility === "visible" && r.width >= 4 && r.height >= 4;
      }), { label: SEND_LABEL, scope: SEND_CANDIDATES }, { timeout: left() });
      step = "collect";
      const html = await input.evaluate((ta, { key, scope }) => {
        const box = ta.closest("div.reply-box")!;
        const candidates = [...box.querySelectorAll<HTMLElement>(scope)].filter(e => {
          const r = e.getBoundingClientRect();
          return !!e.innerText?.trim() && getComputedStyle(e).visibility === "visible" && r.width >= 4 && r.height >= 4;
        });
        const explicit = candidates.filter(e => e.matches("div.send-btn, button, [role=button]"));
        const controls = explicit.filter(e => !explicit.some(other => other !== e && e.contains(other)));
        controls.push(...candidates.filter(e => !explicit.some(other => other.contains(e) || e.contains(other)) && !candidates.some(other => other !== e && e.contains(other))));
        if (controls.length > 101) return "";
        const area = document.createElement("div"); area.className = "reply-footer";
        controls.forEach((e, i) => {
          e.setAttribute("data-claw-send-key", `${key}-${i}`);
          const tag = e.tagName.toLowerCase();
          const clone = document.createElement(["button", "div", "span"].includes(tag) ? tag : "div");
          if (e.matches("div.send-btn")) clone.className = "send-btn";
          if (e.getAttribute("role") === "button") clone.setAttribute("role", "button");
          clone.textContent = e.innerText;
          clone.setAttribute("data-claw-candidate", String(i));
          clone.setAttribute("data-claw-send-control", "true");
          clone.querySelectorAll("textarea,input,script,style").forEach(n => n.remove());
          area.append(clone);
        });
        return area.outerHTML;
      }, { key: nonce, scope: SEND_CANDIDATES });
      step = "select";
      const selection = await selectSendControl(html, Math.max(1, deadline * 1000 - Date.now() - 1500));
      if ("error" in selection) return stop("pdd_send_control_unverified");
      const button = page.locator(`[data-claw-send-key="${nonce}-${selection.candidate}"]`);
      step = "surface";
      // 平台拒绝不可信 click；临时移开遮挡层后仍点原按钮，不关闭弹窗、不调用私有发送方法。
      // 恢复函数与观察器放在隔离世界，主进程退出/超时后页面也会自行恢复。
      await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: `(() => {
        const target = document.querySelector('[data-claw-send-key="${nonce}-${selection.candidate}"]');
        if (!target) return;
        const input = target.closest('div.reply-box')?.querySelector('textarea');
        const displays = new Map(), inert = new Map();
        let done = false, timer, observer;
        const restore = () => {
          if (done) return;
          done = true; observer?.disconnect(); clearTimeout(timer);
          document.removeEventListener('scroll', sweep, true);
          window.removeEventListener('resize', sweep);
          for (const [el, [value, priority]] of displays) {
            if (el.style.getPropertyValue('display') === 'none' && el.style.getPropertyPriority('display') === 'important') {
              if (value) el.style.setProperty('display', value, priority); else el.style.removeProperty('display');
            }
          }
          for (const [el, value] of inert) if (!el.hasAttribute('inert')) el.setAttribute('inert', value);
          delete globalThis[${JSON.stringify(surfaceKey)}];
        };
        const hide = el => {
          if (!el || el.contains(target) || (input && el.contains(input))) return;
          if (!displays.has(el)) displays.set(el, [el.style.getPropertyValue('display'), el.style.getPropertyPriority('display')]);
          if (el.style.getPropertyValue('display') !== 'none' || el.style.getPropertyPriority('display') !== 'important') el.style.setProperty('display', 'none', 'important');
        };
        const sweep = () => {
          if (done) return;
          if (Date.now() >= ${deadline * 1000 - 500}) { restore(); return; }
          for (let el = target; el; el = el.parentElement) if (el.hasAttribute('inert')) {
            if (!inert.has(el)) inert.set(el, el.getAttribute('inert'));
            el.removeAttribute('inert');
          }
          document.querySelectorAll('.fullscreen-dialog-manager, .el-dialog__wrapper, .v-modal, .el-overlay').forEach(hide);
          const r = target.getBoundingClientRect();
          const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
          const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
          if (right - left < 4 || bottom - top < 4) return;
          for (const fy of [0.5, 0.25, 0.75]) for (const fx of [0.5, 0.25, 0.75]) {
            const hit = document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
            if (hit && hit !== target && !target.contains(hit)) hide(hit);
          }
        };
        globalThis[${JSON.stringify(surfaceKey)}] = { restore, sweep };
        observer = new MutationObserver(sweep);
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'inert'] });
        document.addEventListener('scroll', sweep, true);
        window.addEventListener('resize', sweep);
        timer = setTimeout(restore, Math.max(1, ${deadline * 1000 - 500} - Date.now()));
        sweep();
      })()` }]);
      step = "scroll";
      await button.evaluate(el => el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }));
      const before = blocked(); if (before) return stop(before);
      verifyAtPress = async () => {
        step = "surface_sweep";
        await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: sweepSurface }]);
        // DOM 命中已变化时，合成器仍可能保留滚动前的点击区域；等新帧后再核验并按下。
        // 取不到画面（窗口在后台、被遮住、锁屏）时改等页面帧，不因此放弃发送；见 syncPageFrame。
        step = "frame_capture";
        await syncPageFrame(wc);
        const reason = blocked(); if (reason) return reason;
        step = "input_verify";
        return input.evaluate((ta, args) => {
          const keys = [...document.querySelectorAll("li.chat-item .chat-item-box.active[data-random]")].map(e => /^([0-9]{1,32})-/.exec(e.getAttribute("data-random") ?? "")?.[1]);
          const target = document.querySelector<HTMLElement>(`[data-claw-send-key="${args.key}"]`);
          const label = target?.innerText?.replace(/\s+/g, "");
          if (!keys.length || !keys.every(k => k === args.uid)) return "pdd_conversation_changed";
          if (Date.now() >= args.until) return "claim_expiring";
          if ((ta as HTMLTextAreaElement).disabled || (ta as HTMLTextAreaElement).readOnly) return "pdd_input_missing";
          if ((ta as HTMLTextAreaElement).value !== args.text) return "pdd_input_mismatch";
          if (!target) return "pdd_send_control_unverified";
          const rect = target.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4 || getComputedStyle(target).visibility !== "visible" || target.matches(":disabled, [aria-disabled=true]")) return "pdd_send_control_unverified";
          if (args.point) {
            const hit = document.elementFromPoint(args.point.x, args.point.y);
            if (!hit || (hit !== target && !target.contains(hit))) return "pdd_send_control_unverified";
          }
          return target.closest("div.reply-box") === ta.closest("div.reply-box") && !target.classList.contains("sendBtn_disabled") && new RegExp(args.label).test(label ?? "") ? null : "pdd_send_control_unverified";
        }, { uid, text, key: `${nonce}-${selection.candidate}`, until: deadline * 1000 - 1500, label: SEND_LABEL, point: clickPoint });
      };
      step = "verify";
      const valid = await verifyAtPress(); if (valid) return stop(valid);
      clickPoint = await button.evaluate(el => {
        const node = el as HTMLElement, r = node.getBoundingClientRect();
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
        for (const fy of [0.5, 0.25, 0.75, 0.1, 0.9]) for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
          const x = left + (right - left) * fx, y = top + (bottom - top) * fy;
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === node || node.contains(hit))) return { x, y };
        }
        return null;
      });
      if (!clickPoint) return stop("pdd_send_control_unverified");
      // 不等待元素稳定或 Playwright 鼠标准备；直接复用有界、单次的原生 CDP 点击。
      // 按下前再次核对坐标命中、同一买家与原文，按下异常后绝不重试。
      step = "click";
      refusal = await verifyAtPress();
      const result = await dispatchPageClick(wc, clickPoint, blocked, () => { pressed = true; clicked(true); });
      return result.status === "unknown" ? stop("pdd_playwright_click_uncertain") : result;
    };
    return await Promise.race([operation(), new Promise<PageClickResult>(resolve => {
      timer = setTimeout(() => { active = false; connection?.close(); resolve(stop("claim_expiring")); }, Math.max(1, deadline * 1000 - Date.now() - 1000));
    })]);
  } catch (error) {
    const kind = error instanceof errors.TimeoutError ? "timeout" : error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : "error";
    const layout = !pressed && !wc.isDestroyed()
      ? await Promise.race([wc.executeJavaScriptInIsolatedWorld(1001, [{ code: SEND_AREA_PROBE }]).catch(() => "probe_failed"), new Promise((r) => setTimeout(() => r("probe_timeout"), 500))])
      : "-";
    const message = (error instanceof Error ? error.message : String(error)).split("\n")[0].replace(/[^\w .:-]/g, "").slice(0, 80);
    diagnose(`step=${step} error=${kind} msg=${message} ${typeof layout === "string" ? layout.slice(0, 300) : "probe_invalid"}`);
    return stop(pressed ? "pdd_playwright_click_uncertain" : blocked() ?? (deadlineBounded && error instanceof errors.TimeoutError ? "claim_expiring" : "pdd_send_button_not_ready"));
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    if (!wc.isDestroyed()) await Promise.race([
      wc.executeJavaScriptInIsolatedWorld(1001, [{ code: restoreSurface }]).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 500))
    ]);
    disconnect();
  }
}
