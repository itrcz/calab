import { describe, expect, it } from 'vitest';
import { meterUpdate, pttAllowed, pttCue, qualityOf, remoteAudio, toggleDeafen, toggleMute, transmitDecision, userVolumeCapped, withUserMuted, withUserVolume } from './voiceLogic';

describe('mute / deafen', () => {
  it('mute toggles; the mic button while deafened lifts deafen and turns the mic on (Discord)', () => {
    expect(toggleMute({ muted: false, deafened: false })).toEqual({ muted: true, deafened: false, mutedBeforeDeafen: false });
    expect(toggleMute({ muted: true, deafened: false })).toEqual({ muted: false, deafened: false, mutedBeforeDeafen: false });
    expect(toggleMute({ muted: true, deafened: true, mutedBeforeDeafen: true })).toEqual({ muted: false, deafened: false, mutedBeforeDeafen: false });
  });
  it('deafen implies mute; undeafen returns the mic as it was (#11)', () => {
    const on = toggleDeafen({ muted: false, deafened: false });
    expect(on).toEqual({ muted: true, deafened: true, mutedBeforeDeafen: false });
    expect(toggleDeafen(on)).toEqual({ muted: false, deafened: false, mutedBeforeDeafen: false });
  });
  it('a mic muted before deafen stays muted after it (#11)', () => {
    const on = toggleDeafen({ muted: true, deafened: false });
    expect(on).toEqual({ muted: true, deafened: true, mutedBeforeDeafen: true });
    expect(toggleDeafen(on)).toEqual({ muted: true, deafened: false, mutedBeforeDeafen: false });
  });
  it('undeafen under a moderator mute keeps the mic muted (review pass 3 M1)', () => {
    expect(toggleDeafen({ muted: true, deafened: true, mutedBeforeDeafen: false, serverMuted: true })).toEqual({ muted: true, deafened: false, mutedBeforeDeafen: false });
    expect(toggleDeafen({ muted: true, deafened: true, mutedBeforeDeafen: false, serverMuted: false })).toEqual({ muted: false, deafened: false, mutedBeforeDeafen: false });
    expect(toggleDeafen({ muted: true, deafened: false, serverMuted: true })).toEqual({ muted: true, deafened: true, mutedBeforeDeafen: true });
  });
});

describe('push-to-talk while muted / deafened (#12)', () => {
  const ptt = { canSpeak: true, mode: 'ptt' as const, gateOpen: false };
  it('deafened: the press is ignored — nothing on air, no activation cue', () => {
    const s = toggleDeafen({ muted: false, deafened: false });
    expect(pttAllowed(s)).toBe(false);
    // The press never reaches the gate (pttDown stays false); even a held key would not transmit.
    expect(transmitDecision({ ...s, ...ptt, pttDown: false }).transmitting).toBe(false);
    expect(transmitDecision({ ...s, ...ptt, pttDown: true }).transmitting).toBe(false);
    expect(pttCue(true, s, true)).toBeNull();
    expect(pttCue(false, s, true)).toBeNull();
  });
  it('muted: the same', () => {
    const s = { muted: true, deafened: false };
    expect(pttAllowed(s)).toBe(false);
    expect(pttCue(true, s, true)).toBeNull();
  });
  it('mic on, in a call: the key opens the gate with its cues', () => {
    const s = { muted: false, deafened: false };
    expect(pttAllowed(s)).toBe(true);
    expect(transmitDecision({ ...s, ...ptt, pttDown: true }).transmitting).toBe(true);
    expect(pttCue(true, s, true)).toBe('pttOn');
    expect(pttCue(false, s, true)).toBe('pttOff');
    expect(pttCue(true, s, false)).toBeNull();
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
