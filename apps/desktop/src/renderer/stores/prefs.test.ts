import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => {
  const m = new Map<string, string>();
  const ls = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('window', { localStorage: ls });
  return ls;
});
const { usePrefs } = await import('./prefs');

it('keeps the native notification offer on this device and defaults older preferences to not offered', async () => {
  usePrefs.setState({ nativeNotifyOffered: false });
  mem.setItem('calaba-prefs', JSON.stringify({ state: { onboarded: true }, version: 4 }));
  await usePrefs.persist.rehydrate();
  expect(usePrefs.getState().nativeNotifyOffered).toBe(false);
  usePrefs.getState().setPrefs({ nativeNotifyOffered: true });
  expect(JSON.parse(mem.getItem('calaba-prefs') ?? '{}')).toMatchObject({ state: { nativeNotifyOffered: true } });
});

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
