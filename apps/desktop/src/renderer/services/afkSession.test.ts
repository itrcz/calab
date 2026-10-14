import { PresenceStatus } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// installAfk end to end with a fake idle clock: the session's automatic status (SetPresence
// without until) must never stay IDLE once this device is no longer AFK — a manual status
// chosen meanwhile (here or on another device) is a separate per-user value on the server.
let idleSec = 0;
vi.mock('../platform', () => ({ platform: { kind: 'web', system: { idleSeconds: () => Promise.resolve(idleSec) } } }));
const setPresence = vi.fn<(status: PresenceStatus, untilMs?: number) => void>();
vi.mock('./gateway', () => ({ setPresence: (status: PresenceStatus, untilMs?: number) => setPresence(status, untilMs) }));

(globalThis as { window?: unknown }).window ??= globalThis;
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
const { installAfk } = await import('./afk');
const { usePrefs } = await import('../stores/prefs');
const { useSession } = await import('../stores/session');

/** The last automatic (session) status sent, as the server keeps it. */
function sessionStatus(): PresenceStatus | undefined {
  const auto = setPresence.mock.calls.filter((c) => c[1] === undefined);
  return auto.at(-1)?.[0];
}

describe('installAfk session status', () => {
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    setPresence.mockClear();
    idleSec = 0;
    useSession.setState({ gateway: 'ready' });
    usePrefs.getState().setPrefs({ presence: PresenceStatus.ONLINE, presenceUntil: null, afkMinutes: 10 });
    stop = installAfk();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  async function goAway(): Promise<void> {
    idleSec = 3600;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(sessionStatus()).toBe(PresenceStatus.IDLE);
  }

  it('a manual status arriving while AFK (e.g. set on the phone) resets the session to online', async () => {
    await goAway();
    usePrefs.getState().setPrefs({ presence: PresenceStatus.DND, presenceUntil: null });
    await vi.advanceTimersByTimeAsync(0);
    // Back at the desk, then «В сети» again: the server falls back to the session statuses.
    idleSec = 0;
    await vi.advanceTimersByTimeAsync(20_000);
    usePrefs.getState().setPrefs({ presence: PresenceStatus.ONLINE, presenceUntil: null });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sessionStatus()).toBe(PresenceStatus.ONLINE);
  });

  it('coming back sends ONLINE as the session status, never the manual one', async () => {
    await goAway();
    idleSec = 0;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sessionStatus()).toBe(PresenceStatus.ONLINE);
    // Every automatic status is ONLINE or IDLE.
    for (const c of setPresence.mock.calls.filter((x) => x[1] === undefined)) {
      expect([PresenceStatus.ONLINE, PresenceStatus.IDLE]).toContain(c[0]);
    }
  });
});
