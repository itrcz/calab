import { SpeechLog } from '../lib/recordingSpeech';
import { useRecordings } from '../stores/recordings';
import { useVoice } from '../stores/voice';
import { sendRecordingSpeech } from './gateway';

/**
 * On-air reports of a recorded meeting (ADR-0169). While the room I am in is being recorded,
 * my `transmitting` edges (VAD gate / PTT, docs/02) are logged and sent over the gateway every
 * 10 s, and once more when the recording stops or I leave / move. Outside React: no state, no
 * re-renders; no timer while nothing is recorded.
 */

const FLUSH_MS = 10_000;

interface Target {
  roomId: string;
  recordingId: string;
}

const log = new SpeechLog();
let target: Target | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

function flush(to: Target): void {
  if (log.empty) return;
  const now = performance.now();
  let sent = 0;
  const ok = sendRecordingSpeech(to.roomId, to.recordingId, () => {
    const ivs = log.peek(now);
    sent = ivs.length;
    return ivs;
  });
  if (ok) log.commit(now, sent);
}

/** The recording of my room, if any. */
function currentTarget(): Target | null {
  const roomId = useVoice.getState().roomId;
  const rec = roomId ? useRecordings.getState().byRoom[roomId] : undefined;
  return roomId && rec ? { roomId, recordingId: rec.recordingId } : null;
}

function retarget(): void {
  const next = currentTarget();
  if (next?.roomId === target?.roomId && next?.recordingId === target?.recordingId) return;
  const now = performance.now();
  if (target) {
    log.off(now);
    flush(target); // the stop, the leave or the move: the last stretch goes now
  }
  log.clear();
  target = next;
  if (target && useVoice.getState().transmitting) log.on(now);
  if (target && !timer) {
    timer = setInterval(() => {
      if (target) flush(target);
    }, FLUSH_MS);
  } else if (!target && timer) {
    clearInterval(timer);
    timer = null;
  }
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
  retarget();
}
