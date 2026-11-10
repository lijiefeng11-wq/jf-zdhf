import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

export type PageClickResult = { status: "dispatched" } | { status: "not_sent" | "unknown"; reason: string };

type Contents = Pick<WebContents, "isDestroyed" | "debugger">;
type Point = { x: number; y: number };

/** 单条 CDP 命令的等待上限；超时后结果一律 unknown。 */
export const CLICK_COMMAND_TIMEOUT_MS = 500;

/** 发送一次鼠标命令；超时或异常都转成一个可判定的结果，不抛出。 */
function send(db: Contents["debugger"], type: "mousePressed" | "mouseReleased", p: Point): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "command_timeout" }), CLICK_COMMAND_TIMEOUT_MS);
    let call: Promise<unknown>;
    try {
      // 坐标是视口 CSS 像素，原样传给 CDP；不乘缩放、不聚焦窗口。
      call = db.sendCommand("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
    } catch {
      finish({ ok: false, reason: "command_exception" });
      return;
    }
    call.then(
      () => finish({ ok: true }),
      () => finish({ ok: false, reason: "command_rejected" }),
    );
  });
}

/**
 * 点击前等页面出一帧，让合成器的命中区域跟上刚做的滚动 / 移开遮挡。
 * 先取 1 像素画面（不保存图像）；窗口在后台、被遮住或锁屏时取不到，就改在页面里等两次 requestAnimationFrame（最多 300ms）。
 * 取不到画面不是放弃发送的理由：调用方随后照常按 DOM 命中、买家、原文与截止核验，点击仍只一次。
 */
export async function syncPageFrame(contents: Pick<WebContents, "capturePage" | "executeJavaScriptInIsolatedWorld">): Promise<void> {
  try {
    await contents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true, stayAwake: true });
  } catch {
    await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(1001, [{ code: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))" }]).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 300)),
    ]);
  }
}

/**
 * 通过 CDP 在当前页面视口坐标处点击一次。
 * 预检（存活、已附加、调用方 recheck）失败时零命令返回 not_sent；
 * 按下命令已发出后，任何异常、拒绝或超时都是 unknown，绝不重试或补发松开。
 */
export async function dispatchPageClick(contents: Contents, point: Point, recheck: () => string | null, beforePress?: () => void): Promise<PageClickResult> {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) return { status: "not_sent", reason: "invalid_point" };
  let attached: boolean;
  try {
    if (contents.isDestroyed()) return { status: "not_sent", reason: "contents_destroyed" };
    attached = contents.debugger.isAttached();
  } catch {
    return { status: "not_sent", reason: "preflight_failed" };
  }
  if (!attached) return { status: "not_sent", reason: "debugger_not_attached" };
  let blocked: string | null;
  try {
    blocked = recheck();
  } catch {
    return { status: "not_sent", reason: "recheck_failed" };
  }
  if (blocked) return { status: "not_sent", reason: blocked };
  const p = { x: point.x, y: point.y };
  if (beforePress) {
    try {
      beforePress();
    } catch {
      return { status: "not_sent", reason: "before_press_failed" };
    }
  }
  // 按下命令一旦尝试，结果就不再可证明为 not_sent。
  const press = await send(contents.debugger, "mousePressed", p);
  if (!press.ok) return { status: "unknown", reason: `press_${press.reason}` };
  const release = await send(contents.debugger, "mouseReleased", p);
  // dispatched 只表示两条命令都已被接受，不代表平台已确认。
  return release.ok ? { status: "dispatched" } : { status: "unknown", reason: `release_${release.reason}` };
}

/** 临时移开控件遮挡并恢复；只向仍唯一、可见的原控件发出一次可信点击。 */
export async function clickExposedPageControl(contents: WebContents, selector: string, options: {
  deadline: number;
  reasonPrefix: string;
  recheck: () => string | null;
  verify?: () => Promise<string | null>;
  beforePress?: () => void;
}): Promise<PageClickResult> {
  const key = `claw-click-surface-${randomUUID()}`;
  const until = options.deadline * 1000 - 1500;
  let active = true, pressed = false;
  const blocked = () => !active || contents.isDestroyed() ? "pdd_page_changed" : options.recheck() ?? (Date.now() >= until ? "claim_expiring" : null);
  const stop = (reason: string): PageClickResult => ({ status: pressed ? "unknown" : "not_sent", reason });
  const run = <T>(code: string): Promise<T> => contents.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
  let timer: NodeJS.Timeout | undefined;
  try {
    const initial = blocked(); if (initial) return stop(initial);
    const operation = async (): Promise<PageClickResult> => {
      const prepared = await run<string | null>(`(() => {
        const selector = ${JSON.stringify(selector)}, key = ${JSON.stringify(key)};
        const visible = () => [...document.querySelectorAll(selector)].filter(el => {
          const r = el.getBoundingClientRect(); return r.width >= 4 && r.height >= 4 && getComputedStyle(el).visibility === 'visible';
        });
        const targets = visible();
        if (targets.length !== 1) return targets.length ? 'ambiguous' : 'missing';
        const target = targets[0], displays = new Map(), inert = new Map();
        let done = false, observer, timer;
        const restore = () => {
          if (done) return;
          done = true; observer?.disconnect(); clearTimeout(timer);
          for (const [el, [value, priority]] of displays) if (el.style.getPropertyValue('display') === 'none' && el.style.getPropertyPriority('display') === 'important') {
            if (value) el.style.setProperty('display', value, priority); else el.style.removeProperty('display');
          }
          for (const [el, value] of inert) if (!el.hasAttribute('inert')) el.setAttribute('inert', value);
          delete globalThis[key];
        };
        const hide = el => {
          if (!el || el.contains(target)) return;
          if (!displays.has(el)) displays.set(el, [el.style.getPropertyValue('display'), el.style.getPropertyPriority('display')]);
          if (el.style.getPropertyValue('display') !== 'none' || el.style.getPropertyPriority('display') !== 'important') el.style.setProperty('display', 'none', 'important');
        };
        const point = () => {
          if (done || Date.now() >= ${until}) { restore(); return 'expired'; }
          if (!target.isConnected || visible().length !== 1 || visible()[0] !== target || target.matches(':disabled, [aria-disabled=true]')) return 'missing';
          for (let el = target; el; el = el.parentElement) if (el.hasAttribute('inert')) {
            if (!inert.has(el)) inert.set(el, el.getAttribute('inert'));
            el.removeAttribute('inert');
          }
          document.querySelectorAll('.fullscreen-dialog-manager,.el-dialog__wrapper,.v-modal,.el-overlay').forEach(hide);
          target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
          const r = target.getBoundingClientRect(), left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
          if (right - left < 4 || bottom - top < 4) return 'hidden';
          for (const fy of [0.5, 0.25, 0.75]) for (const fx of [0.5, 0.25, 0.75]) {
            const x = left + (right - left) * fx, y = top + (bottom - top) * fy;
            let hit = document.elementFromPoint(x, y);
            for (let i = 0; hit && hit !== target && !target.contains(hit) && !hit.contains(target) && i < 8; i++) {
              hide(hit); hit = document.elementFromPoint(x, y);
            }
            if (hit && (hit === target || target.contains(hit))) return { x, y };
          }
          return 'covered';
        };
        globalThis[key] = { point, restore };
        observer = new MutationObserver(() => { point(); });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'inert'] });
        timer = setTimeout(restore, Math.max(1, ${until} - Date.now()));
        const result = point();
        return typeof result === 'string' ? result : null;
      })()`);
      if (prepared) return stop(prepared === "expired" ? "claim_expiring" : `${options.reasonPrefix}_${prepared}`);
      const beforeFrame = blocked(); if (beforeFrame) return stop(beforeFrame);
      await syncPageFrame(contents);
      const afterFrame = blocked(); if (afterFrame) return stop(afterFrame);
      const invalid = await options.verify?.(); if (invalid) return stop(invalid);
      const afterVerify = blocked(); if (afterVerify) return stop(afterVerify);
      const point = await run<Point | string>(`globalThis[${JSON.stringify(key)}]?.point() ?? 'missing'`);
      if (typeof point === "string") return stop(point === "expired" ? "claim_expiring" : `${options.reasonPrefix}_${point}`);
      return await dispatchPageClick(contents, point, blocked, () => { options.beforePress?.(); pressed = true; });
    };
    return await Promise.race([operation(), new Promise<PageClickResult>(resolve => {
      timer = setTimeout(() => { active = false; resolve(stop("claim_expiring")); }, Math.max(1, until - Date.now()));
    })]);
  } catch {
    return stop("pdd_page_script_failed");
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    if (!contents.isDestroyed()) await Promise.race([
      run(`globalThis[${JSON.stringify(key)}]?.restore()`).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);
  }
}
