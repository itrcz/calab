import { describe, expect, it } from 'vitest';
import { choiceOf, loadMuteRecord, resolveMute, saveMuteRecord, stateOf, VOICE_MUTE_KEY, type MuteRecord } from './voiceMuteMemory';

const rec = (p: Partial<MuteRecord>): MuteRecord => ({ userId: 'u', muted: false, deafened: false, dirty: false, at: 10, ...p });

describe('voice mute memory (ADR-0168)', () => {
  it('the choice: deafen keeps the mic as it was; a moderator mute is never the mic choice', () => {
    expect(choiceOf({ muted: true, deafened: false }, null)).toEqual({ muted: true, deafened: false });
    expect(choiceOf({ muted: true, deafened: true, mutedBeforeDeafen: false }, null)).toEqual({ muted: false, deafened: true });
    expect(choiceOf({ muted: true, deafened: false, serverMuted: true }, { muted: false, deafened: false })).toEqual({ muted: false, deafened: false });
    expect(choiceOf({ muted: true, deafened: true, mutedBeforeDeafen: true, serverMuted: true }, { muted: false, deafened: false })).toEqual({ muted: false, deafened: true });
  });

  it('the store state: deafen ⇒ mic off; undeafen returns to the choice; a moderator mute holds', () => {
    expect(stateOf({ muted: false, deafened: true })).toEqual({ muted: true, deafened: true, mutedBeforeDeafen: false });
    expect(stateOf({ muted: true, deafened: true })).toEqual({ muted: true, deafened: true, mutedBeforeDeafen: true });
    expect(stateOf({ muted: false, deafened: false }, true).muted).toBe(true);
  });

  it('resolve: a pending click wins and is sent; newer server wins; an older echo loses; nothing → local', () => {
    expect(resolveMute(rec({ dirty: true, muted: true }), { muted: false, deafened: false, at: 99 }, 'u')).toEqual({ apply: { muted: true, deafened: false }, record: null, push: true });
    const newer = resolveMute(rec({}), { muted: true, deafened: false, at: 20 }, 'u');
    expect(newer).toEqual({ apply: { muted: true, deafened: false }, record: rec({ muted: true, at: 20 }), push: false });
    expect(resolveMute(rec({ muted: true, at: 30 }), { muted: false, deafened: false, at: 20 }, 'u').apply).toEqual({ muted: true, deafened: false });
    expect(resolveMute(rec({ muted: true }), null, 'u').apply).toEqual({ muted: true, deafened: false });
    expect(resolveMute(null, null, 'u')).toEqual({ apply: null, record: null, push: false });
    expect(resolveMute(rec({ muted: true, at: 20 }), { muted: true, deafened: false, at: 20 }, 'u').record).toBeNull(); // nothing new to write
  });

  it('local copy: per user, malformed or blocked storage reads as none', () => {
    const mem = new Map<string, string>();
    const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveMuteRecord(kv, rec({ muted: true }));
    expect(loadMuteRecord(kv, 'u')).toEqual(rec({ muted: true }));
    expect(loadMuteRecord(kv, 'other')).toBeNull();
    mem.set(VOICE_MUTE_KEY, '{bad');
    expect(loadMuteRecord(kv, 'u')).toBeNull();
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadMuteRecord(blocked, 'u')).toBeNull();
    expect(() => saveMuteRecord(blocked, rec({}))).not.toThrow();
  });
});
