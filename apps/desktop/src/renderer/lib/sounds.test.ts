import { describe, expect, it } from 'vitest';
import { ROOM_AUDIO_CUES } from '../../shared/hostRoomAudio';
import manifest from '../assets/sounds/manifest.json';
import { FILE_SOUNDS, SAMPLE_RATE, SOUNDS, SOUND_EVENTS, createGate, durationMs, synth } from './sounds';

describe('event sounds', () => {
  it('every event has a sound of at most 300 ms (docs/09 #29)', () => {
    for (const name of SOUND_EVENTS) {
      expect(SOUNDS[name].length).toBeGreaterThan(0);
      expect(durationMs(name)).toBeLessThanOrEqual(300);
    }
  });

  it('names every event and built-in clip in the native room audio cues (ADR-0149)', () => {
    expect([...ROOM_AUDIO_CUES].sort()).toEqual([...SOUND_EVENTS, ...manifest.sounds.map(s => `builtin:${s.id}`)].sort());
  });

  it('synthesises click-free PCM within the headroom', () => {
    for (const name of SOUND_EVENTS) {
      const pcm = synth(SOUNDS[name]);
      expect(Math.abs(pcm.length - (durationMs(name) / 1000) * SAMPLE_RATE)).toBeLessThanOrEqual(2);
      let peak = 0;
      for (const v of pcm) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(1000);
      expect(peak).toBeLessThanOrEqual(Math.round(0.32 * 32767));
      // Starts and ends silent (attack / release ramps).
      expect(Math.abs(pcm[0] ?? 1)).toBe(0);
      expect(Math.abs(pcm[pcm.length - 1] ?? 1)).toBeLessThan(200);
    }
  });
});

describe('sound rate limit', () => {
  it('a new message sounds at most once per 2 s', () => {
    const gate = createGate();
    expect(gate.allow('message', 0)).toBe(true);
    expect(gate.allow('message', 500)).toBe(false);
    expect(gate.allow('message', 1999)).toBe(false);
    expect(gate.allow('message', 2000)).toBe(true);
    expect(gate.allow('message', 3000)).toBe(false);
  });

  it('events are limited independently; others use the short burst gap', () => {
    const gate = createGate();
    expect(gate.allow('message', 0)).toBe(true);
    expect(gate.allow('mention', 10)).toBe(true);
    expect(gate.allow('join', 20)).toBe(true);
    expect(gate.allow('join', 100)).toBe(false);
    expect(gate.allow('join', 200)).toBe(true);
  });

  it('a forced preview counts as a play', () => {
    const gate = createGate();
    gate.mark('message', 0);
    expect(gate.allow('message', 1000)).toBe(false);
    expect(gate.allow('message', 2000)).toBe(true);
  });
});

describe('bundled event sounds', () => {
  it('every event plays its own MP3 from tools/gen-event-sounds.py', () => {
    const urls = SOUND_EVENTS.map((name) => FILE_SOUNDS[name]);
    for (const url of urls) expect(url).toMatch(/\.mp3/);
    expect(new Set(urls).size).toBe(SOUND_EVENTS.length);
    expect(FILE_SOUNDS.message).toMatch(/message\.mp3/);
    expect(FILE_SOUNDS.streamEnd).toMatch(/stream-end\.mp3/);
  });
});

describe('stream viewer sounds', () => {
  it('a viewer coming and going in bursts sounds at most once per second each', () => {
    const gate = createGate();
    expect(gate.allow('watchStart', 0)).toBe(true);
    expect(gate.allow('watchStop', 100)).toBe(true);
    expect(gate.allow('watchStart', 500)).toBe(false);
    expect(gate.allow('watchStop', 900)).toBe(false);
    expect(gate.allow('watchStart', 1000)).toBe(true);
  });
});
