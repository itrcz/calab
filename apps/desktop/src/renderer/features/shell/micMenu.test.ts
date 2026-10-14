import { describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { selectAutoMute, selectMicMode, swallowMenuKey, CAPTURE_KEY_TAIL_MS } = await import('./micMenu');
const { usePrefs } = await import('../../stores/prefs');

describe('mic ▾ «Режим» (docs/09 #28)', () => {
  it('switches voice activation ↔ push-to-talk', () => {
    usePrefs.getState().setPrefs({ micMode: 'voice' });
    selectMicMode('ptt');
    expect(usePrefs.getState().micMode).toBe('ptt');
    selectMicMode('voice');
    expect(usePrefs.getState().micMode).toBe('voice');
  });

  it('ignores unknown values and does not re-set the same mode', () => {
    usePrefs.getState().setPrefs({ micMode: 'ptt' });
    const changes: string[] = [];
    const unsub = usePrefs.subscribe((s, p) => {
      if (s.micMode !== p.micMode) changes.push(s.micMode);
    });
    selectMicMode('ptt');
    selectMicMode('bogus');
    unsub();
    expect(changes).toEqual([]);
    expect(usePrefs.getState().micMode).toBe('ptt');
  });

  it('keys belong to the capture while armed and for a short tail after it', () => {
    expect(swallowMenuKey(true, 0, 10_000)).toBe(true);
    expect(swallowMenuKey(false, 10_000, 10_000 + CAPTURE_KEY_TAIL_MS - 1)).toBe(true);
    expect(swallowMenuKey(false, 10_000, 10_000 + CAPTURE_KEY_TAIL_MS)).toBe(false);
    expect(swallowMenuKey(false, 0, 10_000)).toBe(false);
  });
});

describe('mic ▾ «Выключать, если я молчу»', () => {
  it('sets each offered period and back to off', () => {
    for (const v of ['30', '60', '300', '600', '0']) {
      selectAutoMute(v);
      expect(usePrefs.getState().autoMuteSec).toBe(Number(v));
    }
  });

  it('ignores unknown values and does not re-set the same period', () => {
    usePrefs.getState().setPrefs({ autoMuteSec: 300 });
    let changes = 0;
    const unsub = usePrefs.subscribe((s, p) => {
      if (s.autoMuteSec !== p.autoMuteSec) changes++;
    });
    selectAutoMute('300');
    selectAutoMute('45');
    selectAutoMute('bogus');
    unsub();
    expect(changes).toBe(0);
    expect(usePrefs.getState().autoMuteSec).toBe(300);
  });
});
