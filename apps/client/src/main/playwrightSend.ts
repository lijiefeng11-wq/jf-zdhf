import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { errors } from "playwright-core";
import { connectExistingPage } from "./electronPlaywright.js";
import { selectSendControl } from "./scraplingSelector.js";
import type { PageClickResult } from "./pddClick.js";

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

/** Prepare one send attempt (click, or Enter behind the known fullscreen wrapper). Confirmation is the platform response. */
export async function clickSendWithPlaywright(wc: WebContents, uid: string, text: string, deadline: number, current: () => string | null,
  clicked: (pressed: boolean) => void, filled: () => void, diagnose: (detail: string) => void = () => undefined): Promise<PageClickResult> {
  let step = "connect";
  let pressed = false, released = false, active = true;
  let connection: Awaited<ReturnType<typeof connectExistingPage>> | null = null;
  let refusal: string | null = null;
  let verifyAtPress: () => Promise<string | null> = async () => "pdd_send_control_unverified";
  const disconnect = () => connection?.close();
  const nonce = randomUUID();
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
      connection = await connectExistingPage(wc, async type => {
        const block = blocked(); if (block) return block;
        // 回车发送与点击同等对待：按下前核验、整个过程只允许一次按下。
        if (type === "mousePressed" || type === "keyDown" || type === "rawKeyDown") {
          if (pressed) return "already_attempted";
          refusal = await verifyAtPress();
          const fresh = blocked(); if (fresh) return fresh;
          pressed = true; clicked(true);
        } else if (type === "mouseReleased" || type === "keyUp") {
          if (!pressed || released) return "already_attempted";
          released = true;
        } else if (type === "char") return "already_attempted";
        return null;
      });
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
      // 日志中挡住按钮的是平台全屏弹窗的空白 wrapper，点击与滚动都会超时。
      // 仅该 wrapper 覆盖可视区按钮所有取样点时用回复框回车（平台与按钮共用发送方法）；其他遮挡仍走点击核验。
      step = "hit";
      const covered = await button.evaluate(el => {
        const node = el as HTMLElement, r = node.getBoundingClientRect();
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
        if (right - left < 4 || bottom - top < 4) return false;
        const wrappers = new Set<Element>();
        for (const fy of [0.5, 0.25, 0.75]) for (const fx of [0.5, 0.25, 0.75]) {
          const hit = document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
          if (!hit?.matches(".fullscreen-dialog-manager .el-dialog__wrapper.full-screen-dialog-basic")) return false;
          wrappers.add(hit);
        }
        // 居中业务弹窗不一定覆盖按钮；外层任意位置有可见子内容时也不能旁路。
        return [...wrappers].every(wrapper => ![...wrapper.querySelectorAll("*")].some(child => {
          const rect = child.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight && getComputedStyle(child).visibility === "visible";
        }));
      });
      if (!covered) {
        step = "scroll";
        await button.scrollIntoViewIfNeeded({ timeout: left() });
      }
      const before = blocked(); if (before) return stop(before);
      verifyAtPress = () => input.evaluate((ta, args) => {
        const keys = [...document.querySelectorAll("li.chat-item .chat-item-box.active[data-random]")].map(e => /^([0-9]{1,32})-/.exec(e.getAttribute("data-random") ?? "")?.[1]);
        const target = document.querySelector<HTMLElement>(`[data-claw-send-key="${args.key}"]`);
        const label = target?.innerText?.replace(/\s+/g, "");
        if (!keys.length || !keys.every(k => k === args.uid)) return "pdd_conversation_changed";
        if (Date.now() >= args.until) return "claim_expiring";
        if ((ta as HTMLTextAreaElement).disabled || (ta as HTMLTextAreaElement).readOnly) return "pdd_input_missing";
        if ((ta as HTMLTextAreaElement).value !== args.text) return "pdd_input_mismatch";
        if (args.enter) {
          if (document.activeElement !== ta || /pddMerchant_mac_version/.test(navigator.userAgent)) return "pdd_send_button_covered";
          if (!target) return "pdd_send_control_unverified";
          const rect = target.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4 || getComputedStyle(target).visibility !== "visible" || target.matches(":disabled, [aria-disabled=true]")) return "pdd_send_control_unverified";
          const wrapper = document.elementFromPoint((Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2, (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2);
          if (!wrapper?.matches(".fullscreen-dialog-manager .el-dialog__wrapper.full-screen-dialog-basic") || [...wrapper.querySelectorAll("*")].some(child => {
            const r = child.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && getComputedStyle(child).visibility === "visible";
          })) return "pdd_send_button_covered";
        }
        return target?.closest("div.reply-box") === ta.closest("div.reply-box") && !target.classList.contains("sendBtn_disabled") && new RegExp(args.label).test(label ?? "") ? null : "pdd_send_control_unverified";
      }, { uid, text, key: `${nonce}-${selection.candidate}`, until: deadline * 1000 - 1500, label: SEND_LABEL, enter: covered });
      if (covered) {
        step = "enter";
        // 焦点不能穿过平台弹窗的焦点锁时停止；按下回车前再次核验焦点、会话与原文。
        const focused = await input.evaluate(ta => { (ta as HTMLTextAreaElement).focus(); return document.activeElement === ta; });
        if (!focused) return stop("pdd_send_button_covered");
        const valid = await verifyAtPress(); if (valid) return stop(valid);
        const ready = blocked(); if (ready) return stop(ready);
        await page.keyboard.press("Enter");
        return { status: "dispatched", via: "enter" };
      }
      step = "verify";
      const valid = await verifyAtPress(); if (valid) return stop(valid);
      const point = await button.evaluate(el => {
        const node = el as HTMLElement, r = node.getBoundingClientRect();
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
        for (const fy of [0.5, 0.25, 0.75, 0.1, 0.9]) for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
          const x = left + (right - left) * fx, y = top + (bottom - top) * fy;
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === node || node.contains(hit))) return { x: x - r.left - node.clientLeft, y: y - r.top - node.clientTop };
        }
        return null;
      });
      // Playwright handles visibility/stability/hit testing. The transport permits one press only.
      step = "click";
      await button.click({ timeout: left(), noWaitAfter: true, ...(point ? { position: point } : {}) });
      return { status: "dispatched" };
    };
    return await Promise.race([operation(), new Promise<PageClickResult>(resolve => {
      timer = setTimeout(() => { active = false; connection?.close(); resolve(stop("claim_expiring")); }, Math.max(1, deadline * 1000 - Date.now() - 1000));
    })]);
  } catch (error) {
    const kind = error instanceof errors.TimeoutError ? "timeout" : error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : "error";
    const layout = !pressed && !wc.isDestroyed()
      ? await Promise.race([wc.executeJavaScriptInIsolatedWorld(1001, [{ code: SEND_AREA_PROBE }]).catch(() => "probe_failed"), new Promise((r) => setTimeout(() => r("probe_timeout"), 500))])
      : "-";
    diagnose(`step=${step} error=${kind} ${typeof layout === "string" ? layout.slice(0, 300) : "probe_invalid"}`);
    return stop(pressed ? "pdd_playwright_click_uncertain" : blocked() ?? (deadlineBounded && error instanceof errors.TimeoutError ? "claim_expiring" : "pdd_send_button_not_ready"));
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    disconnect();
  }
}
