import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetNativeShellForTests } from '../platform/nativeShell';

const handled = vi.hoisted(() => [] as string[]);
vi.mock('../stores/session', () => ({ useSession: { getState: () => ({ status: 'anon', settings: null }) } }));
vi.mock('../stores/ui', () => ({ useUi: { getState: () => ({ openDialog: () => undefined }) } }));
vi.mock('../features/people/roomLink', () => ({ openRoomLink: (c: string) => handled.push(`room:${c}`) }));

const { continueInBrowser, landingFor, rememberedChoice, setRememberedChoice, showLinkLanding, skipsLanding, useLinkLanding } = await import('./linkLanding');

/** A fake localStorage, same shape as the real one (see `nativeShell.test.ts` for the bridge pattern). */
function fakeStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void } {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetNativeShellForTests();
  useLinkLanding.setState({ link: null });
  handled.length = 0;
});

describe('link landing (docs/09 #53)', () => {
  it('recognises web /join and /r links only', () => {
    expect(landingFor('https://app.calab.io/join/calaba-team-2026')).toEqual({ kind: 'join', code: 'calaba-team-2026', url: 'https://app.calab.io/join/calaba-team-2026' });
    expect(landingFor('https://app.calab.io/r/call-guest-link')).toMatchObject({ kind: 'r', code: 'call-guest-link' });
    expect(landingFor('calaba-team-2026')).toBeNull(); // a bare code is not a link
    expect(landingFor('https://app.calab.io/rooms/x')).toBeNull();
  });

  it('continue in the browser hands the link to the app flow and clears the card', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState });
    expect(showLinkLanding('https://app.calab.io/r/call-guest-link')).toBe(true);
    expect(useLinkLanding.getState().link?.code).toBe('call-guest-link');
    continueInBrowser();
    expect(useLinkLanding.getState().link).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(handled).toEqual(['room:call-guest-link']);
  });
});

describe('no card inside a native phone shell (DEV-4947)', () => {
  it('a shell bridge makes showLinkLanding defer to handleDeepLink (handled by the caller), and clears the address bar', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', { CalabHostActivity: { version: 1, platform: 'ios' } });
    vi.stubGlobal(
      'navigator',
      { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' },
    );
    vi.stubGlobal('history', { replaceState });
    resetNativeShellForTests(); // the bridge is read once and cached: reset before and after stubbing it
    expect(showLinkLanding('https://app.calab.io/join/calaba-team-2026')).toBe(false);
    expect(useLinkLanding.getState().link).toBeNull();
    // Review follow-up (DEV-4947): a reload must not re-run the same skip from a stale address bar.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('no bridge: the card shows as usual', () => {
    resetNativeShellForTests();
    expect(showLinkLanding('https://app.calab.io/join/calaba-team-2026')).toBe(true);
  });
});

describe('«запомнить выбор» (DEV-4947)', () => {
  it('the two keys are mutually exclusive and survive blocked storage', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    expect(rememberedChoice()).toBeNull();

    setRememberedChoice('app');
    expect(rememberedChoice()).toBe('app');
    expect(storage.getItem('calab-open-links-in-browser')).toBeNull();

    setRememberedChoice('browser'); // setting one clears the other
    expect(rememberedChoice()).toBe('browser');
    expect(storage.getItem('calab-open-links-in-app')).toBeNull();

    setRememberedChoice('app');
    expect(rememberedChoice()).toBe('app');
    expect(storage.getItem('calab-open-links-in-browser')).toBeNull();

    setRememberedChoice(null);
    expect(rememberedChoice()).toBeNull();
    expect(storage.getItem('calab-open-links-in-app')).toBeNull();
    expect(storage.getItem('calab-open-links-in-browser')).toBeNull();

    const boom = (): never => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    expect(rememberedChoice()).toBeNull();
    expect(() => setRememberedChoice('app')).not.toThrow();
  });

  it('a remembered browser choice expires after 30 days and is cleaned up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    setRememberedChoice('browser');
    expect(rememberedChoice()).toBe('browser');

    vi.setSystemTime(new Date('2026-01-30T23:59:59Z')); // just under 30 days
    expect(rememberedChoice()).toBe('browser');
    expect(storage.getItem('calab-open-links-in-browser')).not.toBeNull();

    vi.setSystemTime(new Date('2026-01-31T00:00:01Z')); // just over 30 days
    expect(rememberedChoice()).toBeNull(); // expired
    expect(storage.getItem('calab-open-links-in-browser')).toBeNull(); // and cleaned up
  });

  it('a remembered browser choice skips the card outright, same as skipsLanding, and clears the address bar', () => {
    const replaceState = vi.fn();
    resetNativeShellForTests();
    vi.stubGlobal('localStorage', fakeStorage());
    vi.stubGlobal('history', { replaceState });
    setRememberedChoice('browser');
    expect(showLinkLanding('https://app.calab.io/join/calaba-team-2026')).toBe(false);
    expect(useLinkLanding.getState().link).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('a remembered app choice still shows the card (the screen auto-tries the app on arrival)', () => {
    resetNativeShellForTests();
    vi.stubGlobal('localStorage', fakeStorage());
    setRememberedChoice('app');
    expect(showLinkLanding('https://app.calab.io/join/calaba-team-2026')).toBe(true);
  });
});

describe('task links on the web landing (CBF-40)', () => {
  it('recognises /t/<KEY-N> as a task card with the key upper-cased', () => {
    expect(landingFor('https://app.calab.io/t/inv-820')).toEqual({ kind: 't', code: 'INV-820', url: 'https://app.calab.io/t/inv-820' });
    expect(landingFor('https://app.calab.io/t/INV-812/')).toMatchObject({ kind: 't', code: 'INV-812' });
    expect(landingFor('https://app.calab.io/t/INV-812/x')).toBeNull();
    expect(landingFor('https://app.calab.io/b/0190aaaa-0000-4000-8000-000000000000')).toBeNull();
  });

  it('is skipped for a signed-in web visitor only, and only for tasks', () => {
    const task = landingFor('https://app.calab.io/t/INV-820');
    const join = landingFor('https://app.calab.io/join/calaba-team-2026');
    expect(task && skipsLanding(task, true)).toBe(true);
    expect(task && skipsLanding(task, false)).toBe(false);
    expect(join && skipsLanding(join, true)).toBe(false);
  });
});
