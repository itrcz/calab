/**
 * My on-air intervals while my room is being recorded (ADR-0169): the server matches them to
 * the transcript's speaker numbers. Times are a monotonic clock (`performance.now()`); a report
 * turns them into «ms ago» at the moment of sending, so no clock sync is needed.
 */

/** At most this many intervals per report (the server's limit). */
export const MAX_REPORT = 200;
/** Unsent intervals kept while the socket is away; older ones are dropped. */
const MAX_KEPT = 1000;

export interface AgoInterval {
  agoStartMs: number;
  agoEndMs: number;
}

export class SpeechLog {
  private openAt: number | null = null;
  private closed: [number, number][] = [];

  /** The microphone went on air (`transmitting` true). */
  on(t: number): void {
    if (this.openAt === null) this.openAt = t;
  }

  /** The microphone went off air. */
  off(t: number): void {
    if (this.openAt === null) return;
    if (t > this.openAt) this.closed.push([this.openAt, t]);
    this.openAt = null;
    if (this.closed.length > MAX_KEPT) this.closed.splice(0, this.closed.length - MAX_KEPT);
  }

  /** Whether there is anything to report. */
  get empty(): boolean {
    return this.openAt === null && this.closed.length === 0;
  }

  /**
   * The intervals to report at `now` (the oldest MAX_REPORT, an interval still on air closes at
   * now). Nothing is forgotten until `commit` — a report that could not be sent keeps them.
   */
  peek(now: number): AgoInterval[] {
    const all = this.openAt !== null && now > this.openAt ? [...this.closed, [this.openAt, now] as [number, number]] : this.closed;
    return all.slice(0, MAX_REPORT).map(([a, b]) => ({ agoStartMs: Math.max(0, Math.round(now - a)), agoEndMs: Math.max(0, Math.round(now - b)) }));
  }

  /** The report built by `peek(now)` was sent: forget what it carried (an on-air interval continues from now). */
  commit(now: number, sent: number): void {
    const fromClosed = Math.min(sent, this.closed.length);
    this.closed.splice(0, fromClosed);
    if (sent > fromClosed && this.openAt !== null) this.openAt = now;
  }

  clear(): void {
    this.openAt = null;
    this.closed = [];
  }
}
