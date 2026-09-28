import { describe, expect, it } from 'vitest';
import { meterUpdate, qualityOf, remoteAudio, toggleDeafen, toggleMute, transmitDecision, userVolumeCapped, withUserMuted, withUserVolume } from './voiceLogic';

describe('mute / deafen', () => {
  it('mute toggles; unmute while deafened also undeafens', () => {
    expect(toggleMute({ muted: false, deafened: false })).toEqual({ muted: true, deafened: false });
    expect(toggleMute({ muted: true, deafened: false })).toEqual({ muted: false, deafened: false });
    expect(toggleMute({ muted: true, deafened: true })).toEqual({ muted: false, deafened: false });
  });
  it.each([true, false])('undeafen restores the prior mic mute (%s)', (muted) => {
    const before = { muted, deafened: false, mutedBeforeDeafen: false };
    const deafened = toggleDeafen(before);
    expect(deafened).toMatchObject({ muted: true, deafened: true });
    expect(toggleDeafen(deafened)).toMatchObject({ muted, deafened: false });
  });
  it('each deafen cycle remembers the latest mic choice', () => {
    const before = { muted: true, deafened: false, mutedBeforeDeafen: false };
    const restored = toggleDeafen(toggleDeafen(before));
    expect(restored).toMatchObject({ muted: true, deafened: false });
    const unmuted = { ...restored, ...toggleMute(restored) };
    expect(toggleDeafen(toggleDeafen(unmuted))).toMatchObject({ muted: false, deafened: false });
  });
  it('explicit mic unmute while deafened clears both, including on the next deafen cycle', () => {
    const before = { muted: true, deafened: false, mutedBeforeDeafen: false };
    const deafened = toggleDeafen(before);
    const unmuted = { ...deafened, ...toggleMute(deafened) };
    expect(unmuted).toMatchObject({ muted: false, deafened: false });
    expect(toggleDeafen(toggleDeafen(unmuted))).toMatchObject({ muted: false, deafened: false });
  });
  it('undeafen under a moderator mute keeps the mic muted (review pass 3 M1)', () => {
    const before = { muted: true, deafened: true, mutedBeforeDeafen: false };
    expect(toggleDeafen({ ...before, serverMuted: true })).toMatchObject({ muted: true, deafened: false });
    expect(toggleDeafen({ ...before, serverMuted: false })).toMatchObject({ muted: false, deafened: false });
    expect(toggleDeafen({ ...before, deafened: false, serverMuted: true })).toMatchObject({ muted: true, deafened: true });
  });
});

describe('transmitDecision', () => {
  const base = { muted: false, deafened: false, canSpeak: true, mode: 'voice' as const, gateOpen: false, pttDown: false };

  it('VAD gate closed: audio off but NOT a LiveKit mute (no signalling on pauses)', () => {
    expect(transmitDecision(base)).toEqual({ livekitMuted: false, audioEnabled: false, transmitting: false });
    expect(transmitDecision({ ...base, gateOpen: true })).toEqual({ livekitMuted: false, audioEnabled: true, transmitting: true });
  });

  it('PTT follows the key, ignores the gate', () => {
    expect(transmitDecision({ ...base, mode: 'ptt', gateOpen: true }).transmitting).toBe(false);
    expect(transmitDecision({ ...base, mode: 'ptt', pttDown: true }).transmitting).toBe(true);
  });

  it('explicit mute / deafen / no SPEAK are LiveKit mutes', () => {
    for (const s of [{ muted: true }, { deafened: true }, { canSpeak: false }]) {
      const d = transmitDecision({ ...base, gateOpen: true, ...s });
      expect(d.livekitMuted).toBe(true);
      expect(d.transmitting).toBe(false);
    }
  });
});

describe('qualityOf', () => {
  it('classifies RTT/loss', () => {
    expect(qualityOf(null, null)).toBe('unknown');
    expect(qualityOf(40, 0)).toBe('good');
    expect(qualityOf(200, 1)).toBe('fair');
    expect(qualityOf(80, 5)).toBe('fair');
    expect(qualityOf(400, 0)).toBe('poor');
    expect(qualityOf(50, 12)).toBe('poor');
  });
});

describe('remote audio (per-user volume, «Заглушить для меня»)', () => {
  const base = { deafened: false, stream: false, userId: 'u1', userVolumes: {}, mutedUsers: {}, streamVolume: {} };
  it('plays at 100 % by default', () => {
    expect(remoteAudio(base)).toEqual({ muted: false, volume: 1, capped: false });
  });
  it('applies the per-user volume and local mute to the voice only', () => {
    expect(remoteAudio({ ...base, userVolumes: { u1: 0.4 } })).toEqual({ muted: false, volume: 0.4, capped: false });
    expect(remoteAudio({ ...base, mutedUsers: { u1: true } }).muted).toBe(true);
    // Their stream audio is not muted by «Заглушить для меня»; its own volume × theirs (docs/09 #20).
    const s = remoteAudio({ ...base, stream: true, mutedUsers: { u1: true }, userVolumes: { u1: 0.5 }, streamVolume: { u1: 0.7 } });
    expect(s.muted).toBe(false);
    expect(s.volume).toBeCloseTo(0.35);
  });
  it('the headphones ▾ volume scales every voice, not stream audio', () => {
    expect(remoteAudio({ ...base, userVolumes: { u1: 0.5 }, outputVolume: 0.5 }).volume).toBe(0.25);
    expect(remoteAudio({ ...base, stream: true, streamVolume: { u1: 0.8 }, outputVolume: 0.5 }).volume).toBe(0.8);
  });
  it('«Не слышать» silences their voice and their stream audio', () => {
    expect(remoteAudio({ ...base, deafUsers: { u1: true } }).muted).toBe(true);
    expect(remoteAudio({ ...base, stream: true, deafUsers: { u1: true } }).muted).toBe(true);
    expect(remoteAudio({ ...base, userId: 'u2', deafUsers: { u1: true } }).muted).toBe(false);
  });
  it('deafen silences everything', () => {
    expect(remoteAudio({ ...base, deafened: true }).muted).toBe(true);
    expect(remoteAudio({ ...base, deafened: true, stream: true }).muted).toBe(true);
  });
  it('never boosts above 100 % (no WebAudio): 200 % only compensates a lower headphones volume', () => {
    expect(remoteAudio({ ...base, userVolumes: { u1: 1.8 } })).toEqual({ muted: false, volume: 1, capped: true });
    expect(remoteAudio({ ...base, userVolumes: { u1: -1 } }).volume).toBe(0);
    expect(remoteAudio({ ...base, userVolumes: { u1: 2 }, outputVolume: 0.5 })).toEqual({ muted: false, volume: 1, capped: false });
    expect(remoteAudio({ ...base, userVolumes: { u1: 1.5 }, outputVolume: 0.5 }).volume).toBe(0.75);
    expect(remoteAudio({ ...base, userVolumes: { u1: 9 }, outputVolume: 0.25 }).volume).toBe(0.5); // clamped to 200 %
    expect(userVolumeCapped(1.5, 1)).toBe(true);
    expect(userVolumeCapped(1.5, 0.5)).toBe(false);
    expect(userVolumeCapped(0.8, 1)).toBe(false);
  });
  it('stores only non-default volumes and toggles local mute', () => {
    expect(withUserVolume({ u1: 0.5 }, 'u1', 1)).toEqual({});
    expect(withUserVolume({}, 'u2', 0.25)).toEqual({ u2: 0.25 });
    expect(withUserVolume({}, 'u2', 3)).toEqual({ u2: 2 });
    expect(withUserVolume({}, 'u2', 1.5)).toEqual({ u2: 1.5 });
    expect(withUserMuted({}, 'u1', true)).toEqual({ u1: true });
    expect(withUserMuted({ u1: true }, 'u1', false)).toEqual({});
  });
});

describe('meterUpdate', () => {
  const base = { open: false, wasOpen: false, meter: false, now: 1000, last: 0, intervalMs: 50 };
  it('without a meter: nothing between gate edges, only the edge', () => {
    expect(meterUpdate(base)).toBe('none');
    expect(meterUpdate({ ...base, open: true })).toBe('gate');
    expect(meterUpdate({ ...base, wasOpen: true })).toBe('gate');
  });
  it('with a meter: the level at most every interval, and on an edge at once', () => {
    expect(meterUpdate({ ...base, meter: true })).toBe('level');
    expect(meterUpdate({ ...base, meter: true, last: 980 })).toBe('none');
    expect(meterUpdate({ ...base, meter: true, last: 980, open: true })).toBe('level');
  });
});
