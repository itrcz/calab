// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// `Legal.tsx` imports `../../platform`, which picks electron vs. web at module load by
// `VITE_PLATFORM` (unset in the test env → the electron branch, which reads `window.calaba` and
// would throw here); stub it out like plan.test.ts does.
vi.mock('../../platform', () => ({ platform: { kind: 'web', app: { openExternal: vi.fn(), log: vi.fn() } } }));

const { legalPageUrl } = await import('./Legal');
const { resetNativeShellForTests } = await import('../../platform/nativeShell');

/** The native shell's host bridge (platform/nativeShell): any bridge is a shell (ADR-0148). */
const IOS_SHELL_BRIDGE = { version: 1, platform: 'ios' };

afterEach(() => {
  delete window.CalabHostActivity;
  resetNativeShellForTests();
  vi.unstubAllEnvs();
});

describe('legalPageUrl', () => {
  it('no landing origin configured → null', () => {
    vi.stubEnv('VITE_LEGAL_URL', '');
    expect(legalPageUrl('privacy', 'ru')).toBeNull();
  });

  it('browser / desktop: the public landing legal page', () => {
    vi.stubEnv('VITE_LEGAL_URL', 'https://calab.io');
    expect(legalPageUrl('privacy', 'ru')).toBe('https://calab.io/ru/legal/privacy/');
    expect(legalPageUrl('terms', 'en')).toBe('https://calab.io/en/legal/terms/');
  });

  it('native shell (#139, ADR-0148): the app-mode page — no pricing/offer/payments reachable', () => {
    vi.stubEnv('VITE_LEGAL_URL', 'https://calab.io');
    Object.defineProperty(window, 'CalabHostActivity', { value: IOS_SHELL_BRIDGE, configurable: true });
    expect(legalPageUrl('privacy', 'ru')).toBe('https://calab.io/ru/legal/app/privacy/');
    expect(legalPageUrl('terms', 'en')).toBe('https://calab.io/en/legal/app/terms/');
  });
});
