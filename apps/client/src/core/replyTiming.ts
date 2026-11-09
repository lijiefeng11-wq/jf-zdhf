import type { StoredMessage } from "./journal.js";

export const REPLY_START_BUDGET_MS = 20_000;
export const TIMEOUT_TRANSFER_BUDGET_MS = 60_000;
export const TRANSFER_RESERVE_MS = 15_000;
export const REPLY_DEADLINE_REASON = "reply_deadline_exceeded";
type TimingRecord = { start: number | null; deadline: number; stages: Record<string, number>; logged: boolean };

/** 墙钟只用于恢复；本次运行的预算与分段耗时只用单调时钟。 */
export class ReplyTiming {
  private readonly records = new WeakMap<StoredMessage, TimingRecord>();
  constructor(private readonly mono: () => number, private readonly wall: () => number) {}

  observe(message: StoredMessage, fresh = false) {
    if (this.records.has(message)) return;
    const now = this.mono(), wall = this.wall();
    const first = message.first_seen_at;
    const age = fresh ? 0 : typeof first === "number" && Number.isFinite(first) ? wall - first : NaN;
    const valid = Number.isFinite(now) && Number.isFinite(wall) && Number.isFinite(age) && age >= 0;
    const start = valid ? now - age : null;
    this.records.set(message, { start, deadline: start === null ? -Infinity : start + (message.timeout_transfer ? TIMEOUT_TRANSFER_BUDGET_MS : REPLY_START_BUDGET_MS), stages: {}, logged: false });
  }

  private record(message: StoredMessage) {
    this.observe(message);
    return this.records.get(message)!;
  }

  remaining(message: StoredMessage): number {
    const rec = this.record(message), now = this.mono();
    return Number.isFinite(now) && rec.start !== null && now >= rec.start ? Math.max(0, rec.deadline - now) : 0;
  }

  async measure<T>(message: StoredMessage, stage: string, action: () => Promise<T>): Promise<T> {
    const started = this.mono();
    try { return await action(); }
    finally {
      const elapsed = this.mono() - started;
      if (Number.isFinite(elapsed) && elapsed >= 0) {
        const rec = this.record(message);
        rec.stages[stage] = (rec.stages[stage] ?? 0) + Math.round(elapsed);
      }
    }
  }

  summary(message: StoredMessage, abandoned: boolean) {
    const rec = this.record(message);
    if (rec.logged) return null;
    rec.logged = true;
    const elapsed = rec.start === null ? NaN : this.mono() - rec.start;
    const total = Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : null;
    const slowest = Object.entries(rec.stages).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { total_ms: total, over_10s: total === null ? null : total > 10_000, abandoned, stages_ms: { ...rec.stages }, slowest };
  }
}
