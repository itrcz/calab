import { SpeechLog } from '../lib/recordingSpeech';
import { useRecordings } from '../stores/recordings';
import { useVoice } from '../stores/voice';
import { sendRecordingSpeech } from './gateway';
import { voice } from './voice';

/**
 * On-air reports of a recorded meeting (ADR-0169). While the room I am in is being recorded,
 * my `transmitting` edges (VAD gate / PTT, docs/02) are logged and sent over the gateway every
 * 10 s, and once more when the recording stops or I leave / move — a leave flushes before the
 * voice connection is torn down, so the server still sees me in the room. A final report that
 * could not go (no READY gateway, no token) is kept with its recording and retried on the same
 * timer within the server's one-minute grace after the stop, then dropped. Outside React: no
 * state, no re-renders; no timer while nothing is recorded or pending.
 */

export const FLUSH_MS = 10_000;
/** A left-behind log is retried this long (the server accepts reports up to 1 min after the stop). */
export const PENDING_MS = 50_000;

interface Target {
  roomId: string;
  recordingId: string;
}

interface Pending {
  to: Target;
  log: SpeechLog;
  until: number;
}

let log = new SpeechLog();
let target: Target | null = null;
let pending: Pending[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

/** Sends what `l` holds (several reports if it is over the per-report cap); true = all sent. */
function flush(to: Target, l: SpeechLog): boolean {
  for (let i = 0; i < 10 && !l.empty; i++) {
    const now = performance.now();
    if (l.peek(now).length === 0) break; // on air only since this very moment: nothing to say yet
    let sent = 0;
    const ok = sendRecordingSpeech(to.roomId, to.recordingId, () => {
      const ivs = l.peek(now);
      sent = ivs.length;
      return ivs;
    });
    if (!ok) return false;
    l.commit(now, sent);
  }
  return true;
}

/** The recording of my room, if any. */
function currentTarget(): Target | null {
  const roomId = useVoice.getState().roomId;
  const rec = roomId ? useRecordings.getState().byRoom[roomId] : undefined;
  return roomId && rec ? { roomId, recordingId: rec.recordingId } : null;
}

function tick(): void {
  if (target) flush(target, log);
  const now = performance.now();
  pending = pending.filter((p) => !flush(p.to, p.log) && now < p.until);
  syncTimer();
}

function syncTimer(): void {
  const need = target !== null || pending.length > 0;
  if (need && !timer) timer = setInterval(tick, FLUSH_MS);
  else if (!need && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** The last stretch for the current target now (the stop, a leave, a move). */
function flushFinal(now: number): void {
  if (!target) return;
  log.off(now);
  if (!flush(target, log)) pending.push({ to: target, log, until: now + PENDING_MS });
  log = new SpeechLog();
  if (useVoice.getState().transmitting) log.on(now);
}

function retarget(): void {
  const next = currentTarget();
  if (next?.roomId === target?.roomId && next?.recordingId === target?.recordingId) return;
  const now = performance.now();
  flushFinal(now);
  log.clear();
  target = next;
  if (target && useVoice.getState().transmitting) log.on(now);
  syncTimer();
}

/** Subscribes the reporter (app start; idempotent). */
export function startSpeechReports(): void {
  if (started) return;
  started = true;
  useRecordings.subscribe(retarget);
  // The voice store changes many times a second (levels): only the two fields matter here.
  useVoice.subscribe((s, p) => {
    if (s.roomId !== p.roomId) retarget();
    if (s.transmitting === p.transmitting || !target) return;
    if (s.transmitting) log.on(performance.now());
    else log.off(performance.now());
  });
  // Leaving / switching rooms: report before the connection goes, not after the store follows.
  voice.onBeforeLeave(() => {
    flushFinal(performance.now());
    log.clear(); // the mic goes off with the connection
  });
  retarget();
}

/** Test hook: back to the initial state. */
export function resetSpeechReportsForTest(): void {
  if (timer) clearInterval(timer);
  timer = null;
  log = new SpeechLog();
  target = null;
  pending = [];
  started = false;
}
