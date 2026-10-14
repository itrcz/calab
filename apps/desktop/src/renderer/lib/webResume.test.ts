import { describe, expect, it } from 'vitest';
import type { ResumeVoiceSeat } from '../../shared/resumeVoice';
import {
  WEB_RESUME_KEY,
  WEB_RESUME_WINDOW_MS,
  WEB_SELF_KEY,
  canAutoplayAudio,
  saveVoiceSelf,
  saveWebResume,
  takeVoiceSelf,
  takeWebResume,
  type KV,
} from './webResume';

const AT = 1_800_000_000_000;

function mem(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const broken: KV = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

const seat = (over: Partial<ResumeVoiceSeat> = {}): ResumeVoiceSeat => ({
  kind: 'room',
  roomId: 'r1',
  workspaceId: 'w1',
  userId: 'u1',
  muted: true,
  deafened: true,
  mutedBeforeDeafen: false,
  cameraOn: false,
  ...over,
});

describe('web resume seat (update reload)', () => {
  it('round-trips once: stamped with the server and time, removed on read', () => {
    const s = mem();
    saveWebResume(s, seat(), 'https://app.calab.io', AT);
    expect(takeWebResume(s, AT + 3_000)).toEqual({ ...seat(), serverUrl: 'https://app.calab.io', at: AT });
    expect(s.data.has(WEB_RESUME_KEY)).toBe(false);
    expect(takeWebResume(s, AT + 4_000)).toBeNull();
  });

  it('null clears a stored seat', () => {
    const s = mem();
    saveWebResume(s, seat(), 'https://app.calab.io', AT);
    saveWebResume(s, null, 'https://app.calab.io', AT);
    expect(takeWebResume(s, AT)).toBeNull();
  });

  it('expires after the web window (a restored / crashed tab does not join)', () => {
    const s = mem();
    saveWebResume(s, seat(), 'https://app.calab.io', AT);
    expect(takeWebResume(s, AT + WEB_RESUME_WINDOW_MS + 1)).toBeNull();
    expect(s.data.has(WEB_RESUME_KEY)).toBe(false);
    saveWebResume(s, seat(), 'https://app.calab.io', AT);
    expect(takeWebResume(s, AT + WEB_RESUME_WINDOW_MS)).not.toBeNull();
  });

  it('malformed records and broken storage mean «nothing stored»', () => {
    const s = mem();
    s.data.set(WEB_RESUME_KEY, '{not json');
    expect(takeWebResume(s, AT)).toBeNull();
    s.data.set(WEB_RESUME_KEY, JSON.stringify({ kind: 'room', roomId: 'r1' }));
    expect(takeWebResume(s, AT)).toBeNull();
    expect(() => saveWebResume(broken, seat(), 'https://x', AT)).not.toThrow();
    expect(takeWebResume(broken, AT)).toBeNull();
    expect(takeWebResume(null, AT)).toBeNull();
  });
});

describe('voice self state (any reload)', () => {
  it('keeps muted / deafened for the same user, once', () => {
    const s = mem();
    saveVoiceSelf(s, { userId: 'u1', muted: true, deafened: false, mutedBeforeDeafen: false });
    expect(takeVoiceSelf(s, 'u1')).toEqual({ userId: 'u1', muted: true, deafened: false, mutedBeforeDeafen: false });
    expect(takeVoiceSelf(s, 'u1')).toBeNull();
  });

  it('deafened always comes back muted; mutedBeforeDeafen only with deafen', () => {
    const s = mem();
    s.data.set(WEB_SELF_KEY, JSON.stringify({ userId: 'u1', muted: false, deafened: true, mutedBeforeDeafen: true }));
    expect(takeVoiceSelf(s, 'u1')).toEqual({ userId: 'u1', muted: true, deafened: true, mutedBeforeDeafen: true });
    s.data.set(WEB_SELF_KEY, JSON.stringify({ userId: 'u1', muted: true, deafened: false, mutedBeforeDeafen: true }));
    expect(takeVoiceSelf(s, 'u1')?.mutedBeforeDeafen).toBe(false);
  });

  it('the default state clears the record; another user or no user gets nothing', () => {
    const s = mem();
    saveVoiceSelf(s, { userId: 'u1', muted: true, deafened: false, mutedBeforeDeafen: false });
    saveVoiceSelf(s, { userId: 'u1', muted: false, deafened: false, mutedBeforeDeafen: false });
    expect(s.data.has(WEB_SELF_KEY)).toBe(false);
    saveVoiceSelf(s, { userId: '', muted: true, deafened: false, mutedBeforeDeafen: false });
    expect(s.data.has(WEB_SELF_KEY)).toBe(false);
    saveVoiceSelf(s, { userId: 'u1', muted: true, deafened: false, mutedBeforeDeafen: false });
    expect(takeVoiceSelf(s, 'u2')).toBeNull();
    saveVoiceSelf(s, { userId: 'u1', muted: true, deafened: false, mutedBeforeDeafen: false });
    expect(takeVoiceSelf(s, '')).toBeNull();
  });

  it('broken storage never throws', () => {
    expect(() => saveVoiceSelf(broken, { userId: 'u1', muted: true, deafened: false, mutedBeforeDeafen: false })).not.toThrow();
    expect(takeVoiceSelf(broken, 'u1')).toBeNull();
  });
});

describe('canAutoplayAudio', () => {
  const el = (play: () => Promise<void>): (() => HTMLAudioElement) => () =>
    ({ src: '', play, pause: () => undefined, removeAttribute: () => undefined }) as unknown as HTMLAudioElement;
  const refused = (name: string) => () => Promise.reject(Object.assign(new Error(name), { name }));

  it('allowed when play() resolves', async () => {
    expect(await canAutoplayAudio(el(() => Promise.resolve()))).toBe(true);
  });

  it('blocked only on NotAllowedError (the autoplay policy)', async () => {
    expect(await canAutoplayAudio(el(refused('NotAllowedError')))).toBe(false);
    expect(await canAutoplayAudio(el(refused('NotSupportedError')))).toBe(true);
  });

  it('no Audio at all → allowed (nothing to probe)', async () => {
    expect(
      await canAutoplayAudio(() => {
        throw new Error('no Audio');
      }),
    ).toBe(true);
  });
});
