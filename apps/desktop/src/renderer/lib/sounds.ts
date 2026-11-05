import type { HostRoomAudioCue } from '../../shared/hostRoomAudio';
import { prefs } from '../stores/prefs';
// Every event cue and both call rings are bundled MP3s rendered by tools/gen-event-sounds.py
// (owner-approved set, 1.3.1). MP3: plays in Electron and in every browser of the web client.
import deafenUrl from '../../../resources/sounds/deafen.mp3?url';
import disconnectUrl from '../../../resources/sounds/disconnect.mp3?url';
import joinUrl from '../../../resources/sounds/join.mp3?url';
import leaveUrl from '../../../resources/sounds/leave.mp3?url';
import mentionUrl from '../../../resources/sounds/mention.mp3?url';
import messageUrl from '../../../resources/sounds/message.mp3?url';
import movedUrl from '../../../resources/sounds/moved.mp3?url';
import muteUrl from '../../../resources/sounds/mute.mp3?url';
import pttOffUrl from '../../../resources/sounds/ptt-off.mp3?url';
import pttOnUrl from '../../../resources/sounds/ptt-on.mp3?url';
import reconnectUrl from '../../../resources/sounds/reconnect.mp3?url';
import recStartUrl from '../../../resources/sounds/rec-start.mp3?url';
import recStopUrl from '../../../resources/sounds/rec-stop.mp3?url';
import streamEndUrl from '../../../resources/sounds/stream-end.mp3?url';
import streamStartUrl from '../../../resources/sounds/stream-start.mp3?url';
import undeafenUrl from '../../../resources/sounds/undeafen.mp3?url';
import unmuteUrl from '../../../resources/sounds/unmute.mp3?url';
import watchStartUrl from '../../../resources/sounds/watch-start.mp3?url';
import watchStopUrl from '../../../resources/sounds/watch-stop.mp3?url';
// One-to-one call ringing (ADR-0034).
import callIncomingUrl from '../../../resources/sounds/call-incoming.mp3?url';
import callOutgoingUrl from '../../../resources/sounds/call-outgoing.mp3?url';

/**
 * UI event sounds (docs/09 #29). Bundled files (FILE_SOUNDS) played through a plain <audio>
 * element on the selected output device — never through WebAudio, so AEC3 sees them as
 * WebRTC-independent playback exactly like any other system sound (docs/02, echo rule 1).
 * Each event also has a short (≤ 300 ms) synthesised stand-in (SOUNDS, rendered once into a WAV
 * blob) for when its file cannot be loaded.
 */
export const SOUND_EVENTS = [
  'join',
  'leave',
  'mute',
  'unmute',
  'deafen',
  'undeafen',
  'pttOn',
  'pttOff',
  'mention',
  'message',
  'streamStart',
  'streamEnd',
  'watchStart',
  'watchStop',
  'moved',
  'disconnect',
  'reconnect',
  'recStart',
  'recStop',
] as const;

export type SoundName = (typeof SOUND_EVENTS)[number];

/** The bundled file of each event; its SOUNDS entry is only the fallback when the file cannot be loaded. */
export const FILE_SOUNDS: Record<SoundName, string> = {
  join: joinUrl,
  leave: leaveUrl,
  mute: muteUrl,
  unmute: unmuteUrl,
  deafen: deafenUrl,
  undeafen: undeafenUrl,
  pttOn: pttOnUrl,
  pttOff: pttOffUrl,
  mention: mentionUrl,
  message: messageUrl,
  streamStart: streamStartUrl,
  streamEnd: streamEndUrl,
  watchStart: watchStartUrl,
  watchStop: watchStopUrl,
  moved: movedUrl,
  disconnect: disconnectUrl,
  reconnect: reconnectUrl,
  recStart: recStartUrl,
  recStop: recStopUrl,
};

/** One partial of a sound: frequency (Hz), start and length (s), relative gain. */
export interface Note {
  f: number;
  at: number;
  dur: number;
  gain?: number;
}

/*
 * Timbre: a soft "glass" tone — fundamental + weak 2nd/3rd harmonics, 4 ms attack and an
 * exponential decay, so notes ring out naturally instead of stopping like a beep.
 * Pairs rise for "on/in" and fall for "off/out" (macOS/Discord convention).
 */
export const SOUNDS: Record<SoundName, Note[]> = {
  join: [
    { f: 659.25, at: 0, dur: 0.12 },
    { f: 987.77, at: 0.07, dur: 0.18 },
  ],
  leave: [
    { f: 987.77, at: 0, dur: 0.12 },
    { f: 659.25, at: 0.07, dur: 0.18 },
  ],
  mute: [{ f: 587.33, at: 0, dur: 0.1, gain: 0.8 }],
  unmute: [{ f: 783.99, at: 0, dur: 0.1, gain: 0.8 }],
  deafen: [
    { f: 587.33, at: 0, dur: 0.1, gain: 0.8 },
    { f: 440, at: 0.06, dur: 0.14, gain: 0.8 },
  ],
  undeafen: [
    { f: 440, at: 0, dur: 0.1, gain: 0.8 },
    { f: 587.33, at: 0.06, dur: 0.14, gain: 0.8 },
  ],
  pttOn: [{ f: 1174.66, at: 0, dur: 0.05, gain: 0.45 }],
  pttOff: [{ f: 880, at: 0, dur: 0.05, gain: 0.4 }],
  mention: [
    { f: 1046.5, at: 0, dur: 0.09 },
    { f: 1318.51, at: 0.06, dur: 0.09 },
    { f: 1567.98, at: 0.12, dur: 0.16 },
  ],
  message: [
    { f: 987.77, at: 0, dur: 0.08, gain: 0.7 },
    { f: 1318.51, at: 0.06, dur: 0.14, gain: 0.7 },
  ],
  streamStart: [
    { f: 523.25, at: 0, dur: 0.1 },
    { f: 659.25, at: 0.07, dur: 0.1 },
    { f: 783.99, at: 0.14, dur: 0.16 },
  ],
  streamEnd: [
    { f: 783.99, at: 0, dur: 0.1 },
    { f: 659.25, at: 0.07, dur: 0.1 },
    { f: 523.25, at: 0.14, dur: 0.16 },
  ],
  // Someone started / stopped watching my stream: a soft note up / down, quieter than the rest.
  watchStart: [
    { f: 659.25, at: 0, dur: 0.08, gain: 0.6 },
    { f: 1318.51, at: 0.06, dur: 0.14, gain: 0.6 },
  ],
  watchStop: [{ f: 932.33, at: 0, dur: 0.16, gain: 0.5 }],
  moved: [
    { f: 698.46, at: 0, dur: 0.1 },
    { f: 698.46, at: 0.1, dur: 0.16, gain: 0.6 },
    { f: 880, at: 0.1, dur: 0.16 },
  ],
  disconnect: [
    { f: 392, at: 0, dur: 0.12 },
    { f: 293.66, at: 0.09, dur: 0.2 },
  ],
  reconnect: [
    { f: 293.66, at: 0, dur: 0.1 },
    { f: 392, at: 0.07, dur: 0.1 },
    { f: 587.33, at: 0.14, dur: 0.16 },
  ],
  // Meeting recording (ADR-0025): a double tick then a high note on start, the reverse on stop —
  // unlike join / leave, so «the room is being recorded» is not mistaken for someone arriving.
  recStart: [
    { f: 1046.5, at: 0, dur: 0.06, gain: 0.7 },
    { f: 1046.5, at: 0.09, dur: 0.06, gain: 0.7 },
    { f: 1567.98, at: 0.17, dur: 0.13 },
  ],
  recStop: [
    { f: 1567.98, at: 0, dur: 0.07, gain: 0.8 },
    { f: 1046.5, at: 0.09, dur: 0.06, gain: 0.7 },
    { f: 783.99, at: 0.16, dur: 0.14, gain: 0.7 },
  ],
};

export const SAMPLE_RATE = 24000;
const PEAK = 0.32 * 32767;

/** PCM samples of a sound (mono, SAMPLE_RATE). Pure: used by tests. */
export function synth(notes: readonly Note[], sr = SAMPLE_RATE): Int16Array {
  const end = notes.reduce((a, n) => Math.max(a, n.at + n.dur), 0);
  const total = Math.ceil(end * sr);
  const buf = new Float32Array(total);
  for (const n of notes) {
    const start = Math.round(n.at * sr);
    const len = Math.round(n.dur * sr);
    const attack = Math.round(0.004 * sr);
    const release = Math.round(0.012 * sr);
    const tau = n.dur / 3.2;
    const g = n.gain ?? 1;
    for (let i = 0; i < len && start + i < total; i++) {
      const tt = i / sr;
      const w = 2 * Math.PI * n.f * tt;
      const tone = Math.sin(w) + 0.22 * Math.sin(2 * w) + 0.06 * Math.sin(3 * w);
      // Attack ramp, exponential ring-out, and a short linear fade at the end (no click).
      const env = Math.min(1, i / attack) * Math.exp(-tt / tau) * Math.min(1, (len - i) / release);
      buf[start + i] = (buf[start + i] ?? 0) + tone * env * g;
    }
  }
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const norm = peak > 1 ? 1 / peak : 1;
  const out = new Int16Array(total);
  for (let i = 0; i < total; i++) out[i] = Math.round((buf[i] ?? 0) * norm * PEAK);
  return out;
}

/** Duration of a sound in ms. */
export function durationMs(name: SoundName): number {
  return Math.round(SOUNDS[name].reduce((a, n) => Math.max(a, n.at + n.dur), 0) * 1000);
}

/** 16-bit mono PCM → WAV blob (UI sounds; the echo check fallback player). */
export function wav(pcm: Int16Array, sr = SAMPLE_RATE): Blob {
  const dv = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  w(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i] ?? 0, true);
  return new Blob([dv.buffer], { type: 'audio/wav' });
}

/** Whether an event sound is enabled in the preferences (master switch + per-event toggle). */
export function soundEnabled(name: SoundName): boolean {
  const p = prefs();
  return p.voiceSounds && p.sounds[name] !== false;
}

/** The same sound fired in a burst (e.g. several people moved in at once) plays once. */
const MIN_GAP_MS = 150;
/**
 * Chat sounds in a busy room: at most one per interval (docs/09 P1 #13: a message ≤ 1 per 2 s);
 * viewers of my stream coming and going (people clicking through streams): ≤ 1 per 1 s each.
 */
export const GAP_MS: Partial<Record<SoundName, number>> = { message: 2000, mention: 1000, watchStart: 1000, watchStop: 1000 };

export interface SoundGate {
  /** Whether `name` may play at `now` (ms); a «yes» is recorded as a play. */
  allow: (name: SoundName, now: number) => boolean;
  /** Records a play that bypassed the gate (the «прослушать» button). */
  mark: (name: SoundName, now: number) => void;
}

/** Per-event rate limit. Pure (clock passed in): used by tests. */
export function createGate(gaps: Partial<Record<SoundName, number>> = GAP_MS, minGap = MIN_GAP_MS): SoundGate {
  const last = new Map<SoundName, number>();
  return {
    allow: (name, now) => {
      if (now - (last.get(name) ?? -Infinity) < (gaps[name] ?? minGap)) return false;
      last.set(name, now);
      return true;
    },
    mark: (name, now) => void last.set(name, now),
  };
}

const cache = new Map<SoundName, string>();
const gate = createGate();
/** After «moved», the new room's participants and streams arrive as joins/leaves: not worth a sound each. */
const SUPPRESS: Partial<Record<SoundName, { names: SoundName[]; ms: number }>> = {
  moved: { names: ['join', 'leave', 'streamStart', 'streamEnd'], ms: 1500 },
};
const suppressedUntil = new Map<SoundName, number>();

function synthUrl(name: SoundName): string {
  let url = cache.get(name);
  if (!url) {
    url = URL.createObjectURL(wav(synth(SOUNDS[name])));
    cache.set(name, url);
  }
  return url;
}

export interface PlayOptions {
  /** Play regardless of the toggles and the rate limit (the «прослушать» button in settings). */
  force?: boolean;
  /** Multiplier on the user's sound volume (the quieter cue in the open chat). */
  volume?: number;
}

/**
 * A native-audio room (ADR-0149 §5) plays cues and built-in clips itself, by name, inside its echo
 * canceller's reference: while it is set, nothing here opens an <audio> (services/voice.ts sets it).
 */
let cueRoute: ((cue: HostRoomAudioCue, volume: number) => void) | null = null;
export function routeCues(route: typeof cueRoute): void {
  cueRoute = route;
}
export const nativeCue = (): typeof cueRoute => cueRoute;

/** Plays an event sound if enabled, through a plain <audio> element on the output device (or the native room). */
export function playSound(name: SoundName, opts: PlayOptions = {}): void {
  const now = performance.now();
  if (!opts.force) {
    const sup = SUPPRESS[name];
    if (sup) for (const n of sup.names) suppressedUntil.set(n, now + sup.ms);
    if (!soundEnabled(name)) return;
    if (now < (suppressedUntil.get(name) ?? 0)) return;
    if (!gate.allow(name, now)) return;
  } else gate.mark(name, now);
  const p = prefs();
  const volume = Math.max(0, Math.min(1, p.soundVolume * (opts.volume ?? 1)));
  if (cueRoute) {
    cueRoute(name, volume);
    return;
  }
  const file = FILE_SOUNDS[name];
  const el = new Audio(file);
  el.volume = volume;
  // A bundled file that cannot be loaded falls back to its synthesised stand-in (once).
  el.onerror = () => {
    el.onerror = null;
    el.src = synthUrl(name);
    play();
  };
  const sink = p.outputDeviceId;
  const play = (): void => void el.play().catch(() => undefined);
  if (sink) void el.setSinkId(sink).then(play, play);
  else play();
}

// ---------------------------------------------------------------- keypad click

/** The tone keypad's click: one soft 40 ms tick, quieter than every event cue. */
export const KEY_CLICK: readonly Note[] = [{ f: 1318.51, at: 0, dur: 0.04, gain: 0.35 }];

let keyClick: { el: HTMLAudioElement; sink: string } | null = null;

/**
 * A key of the tone keypad was sent (ADR-0046 addendum «Тональный набор»): a short local click
 * through the same plain <audio> as the event cues (never WebAudio, docs/02), on the output
 * device at the sound volume; off with the sounds' master switch. Local only: the line gets the
 * key as data. One element, rewound per key (fast typing restarts the tick).
 */
export function playKeyClick(): void {
  const p = prefs();
  if (!p.voiceSounds) return;
  if (!keyClick) keyClick = { el: new Audio(URL.createObjectURL(wav(synth(KEY_CLICK)))), sink: '' };
  const k = keyClick;
  k.el.volume = Math.max(0, Math.min(1, p.soundVolume));
  k.el.currentTime = 0;
  const play = (): void => void k.el.play().catch(() => undefined);
  const sink = p.outputDeviceId ?? '';
  if (sink !== k.sink) {
    k.sink = sink;
    void k.el.setSinkId(sink).then(play, play);
  } else play();
}

// ---------------------------------------------------------------- call ringing (ADR-0034)

/** `call-incoming` — the ringtone; `call-outgoing` — the ring-back the caller hears. */
export type RingName = 'call-incoming' | 'call-outgoing';

/** One ring of each file, then this pause (the files carry no silence: ≤ 50 KB each). */
export const RINGS: Record<RingName, { url: string; pauseMs: number }> = {
  'call-incoming': { url: callIncomingUrl, pauseMs: 1000 },
  'call-outgoing': { url: callOutgoingUrl, pauseMs: 3000 },
};

/** A call rings 45 s at most (the server's timeout): the ringer stops by itself after it. */
export const RING_MAX_MS = 45_000;

let ringing: { name: RingName; el: HTMLAudioElement; timer: number | null; stopAt: number } | null = null;

/**
 * Rings `name` over and over (one plain <audio>, the output device, the sound volume — docs/02
 * echo rule 1) until stopRing() or RING_MAX_MS. The same ring again is a no-op; another one
 * replaces it. Timers only while ringing (docs/14: nothing ticks when idle).
 */
export function startRing(name: RingName, maxMs = RING_MAX_MS): void {
  // A native-audio room holds the session (ADR-0149 §1): no WebKit ringtone beside it in v1 (the modal still shows).
  if (cueRoute) return;
  if (ringing?.name === name) return;
  stopRing();
  const p = prefs();
  const el = new Audio(RINGS[name].url);
  el.volume = Math.max(0, Math.min(1, p.soundVolume));
  const r = { name, el, timer: null as number | null, stopAt: Date.now() + maxMs };
  ringing = r;
  const play = (): void => {
    if (ringing !== r) return;
    if (Date.now() >= r.stopAt) {
      stopRing();
      return;
    }
    void el.play().catch(() => undefined);
  };
  el.onended = () => {
    if (ringing === r) r.timer = window.setTimeout(play, RINGS[name].pauseMs);
  };
  const sink = p.outputDeviceId;
  if (sink) void el.setSinkId(sink).then(play, play);
  else play();
}

/** Stops the ringing (if any). */
export function stopRing(): void {
  const r = ringing;
  if (!r) return;
  ringing = null;
  if (r.timer !== null) window.clearTimeout(r.timer);
  r.el.onended = null;
  r.el.pause();
  r.el.removeAttribute('src');
}

/** What rings now (tests, the call service). */
export const currentRing = (): RingName | null => ringing?.name ?? null;
