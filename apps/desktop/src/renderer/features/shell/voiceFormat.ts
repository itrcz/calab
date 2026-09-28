import { useCallback, useSyncExternalStore } from 'react';

/** Call duration for the room list: «4:05», «1:02:03» (hours only when needed). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The REC timer (docs/09 #30): time since the recording started, like the call timer. */
export function recordingTime(since: number, now: number): string {
  return formatDuration(now - since);
}

/** Zero-pads 0..99 for the two-segment room-limit pill (docs/09 #9): 0 → "00", 7 → "07", 42 → "42". */
export function pad2(n: number): string {
  return String(Math.max(0, Math.min(99, Math.trunc(n)))).padStart(2, '0');
}

/** The invite row is visible for 30 s after joining a voice room (docs/09 #10). */
export const INVITE_ROW_MS = 30_000;

/** Is the «Пригласить в комнату» row shown? Not while the room is full, only within the window,
 * and only when `joinedAt` is set (I am actually in this room). */
export function inviteRowVisible(joinedAt: number | null, now: number, full: boolean): boolean {
  const until = inviteRowUntil(joinedAt);
  return !full && until !== null && now < until;
}

/** When the invite row's window ends (ms epoch); null when I am not in the room. */
export function inviteRowUntil(joinedAt: number | null): number | null {
  return joinedAt == null ? null : joinedAt + INVITE_ROW_MS;
}

/**
 * Whether `deadline` (ms epoch) has passed: one timer to the deadline, one re-render when it
 * passes — not a 1 s tick for a component that only cares about a single moment (docs/14).
 */
export function useDeadlinePassed(deadline: number | null): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (deadline === null) return () => undefined;
      const id = window.setTimeout(cb, Math.max(0, deadline - Date.now()) + 1);
      return () => window.clearTimeout(id);
    },
    [deadline],
  );
  return useSyncExternalStore(subscribe, () => deadline !== null && Date.now() >= deadline);
}

/** Parses the «Максимум участников» field: integer 0..99, anything else → null. */
export function parseUserLimit(v: string): number | null {
  const s = v.trim();
  if (s === '') return 0;
  if (!/^\d{1,2}$/.test(s)) return null;
  return Number(s);
}

// One shared ticker per period for everything on screen (no interval per row): the 1 s call
// timers, the 60 s local clocks of members (docs/09 #48). Ticks land on period boundaries, so a
// minute clock flips at :00 and every subscriber of a period re-renders from the same wake-up.
type Ticker = { now: number; timer: number | null; listeners: Set<() => void>; subscribe: (cb: () => void) => () => void };
const tickers = new Map<number, Ticker>();

function ticker(period: number): Ticker {
  let tk = tickers.get(period);
  if (tk) return tk;
  const self: Ticker = {
    now: Date.now(),
    timer: null,
    listeners: new Set(),
    subscribe(cb) {
      self.listeners.add(cb);
      if (self.timer === null) {
        self.now = Date.now();
        const schedule = (): void => {
          self.timer = window.setTimeout(() => {
            self.now = Date.now();
            for (const l of self.listeners) l();
            schedule();
          }, period - (Date.now() % period));
        };
        schedule();
      }
      return () => {
        self.listeners.delete(cb);
        if (!self.listeners.size && self.timer !== null) {
          window.clearTimeout(self.timer);
          self.timer = null;
        }
      };
    },
  };
  tk = self;
  tickers.set(period, tk);
  return tk;
}

/** Current time, re-rendering every `period` ms (default 1 s) while mounted; one timer per period. */
/** No clock: `useNow(0)` for components that only need the time when a condition holds. */
const idle: Pick<Ticker, 'subscribe' | 'now'> = { subscribe: () => () => undefined, now: Date.now() };

/** The clock store for a period; period ≤ 0 = no timer at all (exported for tests). */
export function clockFor(period: number): Pick<Ticker, 'subscribe' | 'now'> {
  return period > 0 ? ticker(period) : idle;
}

export function useNow(period = 1000): number {
  const tk = clockFor(period);
  return useSyncExternalStore(tk.subscribe, () => tk.now);
}
