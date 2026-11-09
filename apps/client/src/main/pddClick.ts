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
