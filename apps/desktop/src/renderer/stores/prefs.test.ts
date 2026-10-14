import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => {
  const m = new Map<string, string>();
  const ls = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('window', { localStorage: ls });
  return ls;
});
const { usePrefs } = await import('./prefs');

describe('prefs.cameraBgFps', () => {
  beforeEach(() => mem.clear());
  it('defaults to 20', () => expect(usePrefs.getState().cameraBgFps).toBe(20));
  it('a stored unknown value is rehydrated as 20, a valid one is kept', async () => {
    mem.setItem('calaba-prefs', JSON.stringify({ state: { cameraBgFps: 13 }, version: 4 }));
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().cameraBgFps).toBe(20);
    mem.setItem('calaba-prefs', JSON.stringify({ state: { cameraBgFps: 8 }, version: 4 }));
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().cameraBgFps).toBe(8);
  });
  it('an older version migrates to 20', async () => {
    mem.setItem('calaba-prefs', JSON.stringify({ state: {}, version: 3 }));
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().cameraBgFps).toBe(20);
  });
});

describe('prefs.autoMuteSec', () => {
  beforeEach(() => mem.clear());
  it('is off by default (also for stored prefs that predate it)', async () => {
    expect(usePrefs.getState().autoMuteSec).toBe(0);
    mem.setItem('calaba-prefs', JSON.stringify({ state: { micMode: 'voice' }, version: 4 }));
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().autoMuteSec).toBe(0);
  });
  it('keeps an offered value, drops anything else to off', async () => {
    mem.setItem('calaba-prefs', JSON.stringify({ state: { autoMuteSec: 300 }, version: 4 }));
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().autoMuteSec).toBe(300);
    mem.setItem('calaba-prefs', JSON.stringify({ state: { autoMuteSec: 42 }, version: 4 }));
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().autoMuteSec).toBe(0);
  });
});

describe('prefs.haptics', () => {
  beforeEach(() => mem.clear());
  it('is on by default and kept when stored data predates it', async () => {
    expect(usePrefs.getState().haptics).toBe(true);
    mem.setItem('calaba-prefs', JSON.stringify({ state: { theme: 'light' }, version: 4 }));
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().haptics).toBe(true);
    mem.setItem('calaba-prefs', JSON.stringify({ state: { haptics: false }, version: 4 }));
    await usePrefs.persist.rehydrate();
    expect(usePrefs.getState().haptics).toBe(false);
  });
});
