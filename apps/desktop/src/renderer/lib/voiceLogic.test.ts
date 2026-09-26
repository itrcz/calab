import { describe, expect, it } from 'vitest';
import { qualityOf, remoteAudio, toggleDeafen, toggleMute, transmitDecision, withUserMuted, withUserVolume } from './voiceLogic';

describe('mute / deafen', () => {
  it('mute toggles; unmute while deafened also undeafens', () => {
    expect(toggleMute({ muted: false, deafened: false })).toEqual({ muted: true, deafened: false });
    expect(toggleMute({ muted: true, deafened: false })).toEqual({ muted: false, deafened: false });
    expect(toggleMute({ muted: true, deafened: true })).toEqual({ muted: false, deafened: false });
  });
  it('deafen implies mute and restores both', () => {
    expect(toggleDeafen({ muted: false, deafened: false })).toEqual({ muted: true, deafened: true });
    expect(toggleDeafen({ muted: true, deafened: true })).toEqual({ muted: false, deafened: false });
  });
  it('undeafen under a moderator mute keeps the mic muted (review pass 3 M1)', () => {
    expect(toggleDeafen({ muted: true, deafened: true, serverMuted: true })).toEqual({ muted: true, deafened: false });
    expect(toggleDeafen({ muted: true, deafened: true, serverMuted: false })).toEqual({ muted: false, deafened: false });
    expect(toggleDeafen({ muted: true, deafened: false, serverMuted: true })).toEqual({ muted: true, deafened: true });
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
    expect(remoteAudio(base)).toEqual({ muted: false, volume: 1 });
  });
  it('applies the per-user volume and local mute to the voice only', () => {
    expect(remoteAudio({ ...base, userVolumes: { u1: 0.4 } })).toEqual({ muted: false, volume: 0.4 });
    expect(remoteAudio({ ...base, mutedUsers: { u1: true } }).muted).toBe(true);
    // Their stream audio is not muted by «Заглушить для меня»; it has its own volume.
    expect(remoteAudio({ ...base, stream: true, mutedUsers: { u1: true }, userVolumes: { u1: 0.4 }, streamVolume: { u1: 0.7 } })).toEqual({ muted: false, volume: 0.7 });
  });
  it('deafen silences everything', () => {
    expect(remoteAudio({ ...base, deafened: true }).muted).toBe(true);
    expect(remoteAudio({ ...base, deafened: true, stream: true }).muted).toBe(true);
  });
  it('never boosts above 100 % (no WebAudio)', () => {
    expect(remoteAudio({ ...base, userVolumes: { u1: 1.8 } }).volume).toBe(1);
    expect(remoteAudio({ ...base, userVolumes: { u1: -1 } }).volume).toBe(0);
  });
  it('stores only non-default volumes and toggles local mute', () => {
    expect(withUserVolume({ u1: 0.5 }, 'u1', 1)).toEqual({});
    expect(withUserVolume({}, 'u2', 0.25)).toEqual({ u2: 0.25 });
    expect(withUserVolume({}, 'u2', 3)).toEqual({});
    expect(withUserMuted({}, 'u1', true)).toEqual({ u1: true });
    expect(withUserMuted({ u1: true }, 'u1', false)).toEqual({});
  });
});
