// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Plan toasts (ADR-0024): the text from the error, «Связаться» only with a usable contact. */

const openExternal = vi.fn((_url: string) => Promise.resolve());
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { openExternal: (u: string) => openExternal(u), log: () => undefined } } }));
vi.mock('../lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { ApiError } = await import('../lib/api/client');
const { reportPlanError, planOffersAllowed, planContact, openPlanContact } = await import('./plan');
const { resetNativeShellForTests } = await import('../platform/nativeShell');
const { useSession } = await import('../stores/session');
const { useToasts } = await import('../stores/toasts');

const roomFull = new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409, undefined, { reason: 'PLAN_LIMIT', used: 5, limit: 5 });

/** What apps/mobile's iOS host bridge declares (platform/nativeShell). */
const IOS_SHELL_BRIDGE = { version: 1, platform: 'ios' };
/** What a newer Android shell declares (DEV-5033): bridge present, UA marker too. */
const ANDROID_SHELL_BRIDGE = { version: 1, platform: 'android' };
/** The shell's WebView appends `applicationNameForUserAgent` to the stock UA (DEV-4947). */
const ANDROID_SHELL_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 CalabShell/1';
/** An ordinary Android browser: no marker, no bridge — not a shell. */
const ANDROID_BROWSER_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DEFAULT_UA = window.navigator.userAgent;

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

beforeEach(() => {
  useToasts.setState({ items: [] });
  openExternal.mockClear();
  resetNativeShellForTests();
});

afterEach(() => {
  delete window.CalabHostActivity;
  setUserAgent(DEFAULT_UA);
  resetNativeShellForTests();
});

describe('reportPlanError', () => {
  it('409 PLAN_LIMIT → info toast with «Связаться» that opens the contact', () => {
    useSession.getState().set({ planContact: 'mailto:support@calab.io' });
    expect(reportPlanError(roomFull, null)).toBe(true);
    const [toast] = useToasts.getState().items;
    expect(toast).toMatchObject({ kind: 'info', text: 'В бесплатном тарифе до 5 человек в комнате' });
    expect(toast?.action?.label).toBe('Связаться');
    toast?.action?.run();
    expect(openExternal).toHaveBeenCalledWith('mailto:support@calab.io');
  });

  it('no usable contact → the toast without a button', () => {
    useSession.getState().set({ planContact: 'javascript:alert(1)' });
    expect(reportPlanError(roomFull, null)).toBe(true);
    expect(useToasts.getState().items[0]?.action).toBeUndefined();
  });

  it('other errors are left to the caller', () => {
    expect(reportPlanError(new ApiError('ERROR_CODE_ROOM_FULL', 'full', 409), null)).toBe(false);
    expect(reportPlanError(new Error('boom'), null)).toBe(false);
    expect(useToasts.getState().items).toHaveLength(0);
  });

  it('keeps limits but removes sales actions in the iOS shell', () => {
    Object.defineProperty(window, 'CalabHostActivity', { value: IOS_SHELL_BRIDGE, configurable: true });
    useSession.getState().set({ planContact: 'mailto:support@calab.io' });
    expect(planOffersAllowed()).toBe(false);
    expect(planContact()).toBeNull();
    expect(reportPlanError(roomFull, null)).toBe(true);
    expect(useToasts.getState().items[0]).toMatchObject({ kind: 'info', text: 'В бесплатном тарифе до 5 человек в комнате' });
    expect(useToasts.getState().items[0]?.action).toBeUndefined();
    openPlanContact();
    expect(openExternal).not.toHaveBeenCalled();
  });

  /** ADR-0148 (owner, 2026-10-30): the Android shell hides payment UI too, like iOS. */
  it('removes sales actions in the Android shell too (UA marker + bridge)', () => {
    setUserAgent(ANDROID_SHELL_UA);
    Object.defineProperty(window, 'CalabHostActivity', { value: ANDROID_SHELL_BRIDGE, configurable: true });
    useSession.getState().set({ planContact: 'mailto:support@calab.io' });
    expect(planOffersAllowed()).toBe(false);
    expect(planContact()).toBeNull();
    openPlanContact();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('keeps website sales offers available', () => {
    useSession.getState().set({ planContact: 'https://calab.ru/' });
    expect(planOffersAllowed()).toBe(true);
    expect(planContact()).toBe('https://calab.ru/');
  });

  it('a plain Android browser (no marker, no bridge) keeps sales offers', () => {
    setUserAgent(ANDROID_BROWSER_UA);
    useSession.getState().set({ planContact: 'https://calab.ru/' });
    expect(planOffersAllowed()).toBe(true);
    expect(planContact()).toBe('https://calab.ru/');
  });
});
