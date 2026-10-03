import { timestampMs } from '@bufbuild/protobuf/wkt';
import { MessageKind, RecordingStatus, RoomRecordingState, type AutomationCard, type BirthdayCard, type Message, type RecordingCard, type RoomRecording } from '@calaba/protocol';
import { t, type MessageKey } from '../i18n';
import { stickerPreview } from './stickers';
import { callCardOf, callLogLine } from './callModel';
import { myUserId } from '../stores/session';
import { achievementCardOf } from './achievements';
import { cachedAchievement } from './achievementCache';

/**
 * Meeting recording (ADR-0025, docs/08 «Запись встреч»): the pure parts — the GPTunneL pairing
 * code mask, the «which rooms are being recorded» map built from READY and ROOM_RECORDING, and
 * the texts of the chat card and of the stop toast. No stores here: unit-tested.
 */

// ---------------------------------------------------------------- pairing code

/** GPTunneL codes: 8 letters / digits, shown as ABCD-EFGH. */
export const PAIR_CODE_LENGTH = 8;

/**
 * Input mask of the pairing code: upper case, letters and digits only (a pasted «abcd efgh»,
 * «ABCD-EFGH» or «Код: ABCDEFGH» works), at most 8, a dash after the 4th.
 */
export function formatPairCode(input: string): string {
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // A pasted «Код: ABCD-EFGH» / «Code ABCD-EFGH» (a label before it): the code is the last 8.
  // Typing past the 8th character keeps the first 8.
  if (s.length > PAIR_CODE_LENGTH && /[\s:]/.test(input.trim())) s = s.slice(-PAIR_CODE_LENGTH);
  s = s.slice(0, PAIR_CODE_LENGTH);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export const pairCodeComplete = (code: string): boolean => code.replace(/-/g, '').length === PAIR_CODE_LENGTH;

/**
 * A failed pairing → the inline text under the code field (docs/05: 422 CODE_INVALID or a
 * VALIDATION of `code`, 429, 503); null = no specific text (the generic error mapping).
 */
export function pairErrorKey(e: unknown): MessageKey | null {
  // Structural (an ApiError): lib/api/client pulls in the platform layer, which unit tests lack.
  if (!(e instanceof Error) || !('code' in e) || !('status' in e)) return null;
  const { code, status } = e as { code: unknown; status: unknown };
  if (code === 'ERROR_CODE_CODE_INVALID' || code === 'ERROR_CODE_CODE_EXPIRED') return 'gpt.err.code';
  if (code === 'ERROR_CODE_VALIDATION') return 'gpt.err.format';
  if (code === 'ERROR_CODE_RATE_LIMITED' || status === 429) return 'gpt.err.rate';
  if (status === 503 || (code === 'ERROR_CODE_UNAVAILABLE' && status !== 0)) return 'gpt.err.unavailable';
  return null;
}

// ---------------------------------------------------------------- recording state

/** A room being recorded now: the REC indicator and the «Остановить запись» item. */
export interface ActiveRecording {
  workspaceId: string;
  recordingId: string;
  byUserId: string;
  /** ms; the REC timer counts from it. */
  since: number;
}

export type RecordingMap = Readonly<Record<string, ActiveRecording>>;

function active(r: RoomRecording): ActiveRecording {
  return { workspaceId: r.workspaceId, recordingId: r.recordingId, byUserId: r.byUserId, since: r.since ? timestampMs(r.since) : Date.now() };
}

/**
 * The recordings of one workspace from its snapshot (READY / WORKSPACE_CREATE): replaces what
 * the map had for that workspace (a recording that stopped while we were away is gone).
 */
export function withSnapshot(map: RecordingMap, workspaceId: string, recordings: readonly RoomRecording[]): RecordingMap {
  const out: Record<string, ActiveRecording> = {};
  for (const [roomId, r] of Object.entries(map)) if (r.workspaceId !== workspaceId) out[roomId] = r;
  for (const r of recordings) if (r.state === RoomRecordingState.ACTIVE && r.roomId) out[r.roomId] = active(r);
  return out;
}

/**
 * ROOM_RECORDING: ACTIVE sets the room, STOPPED clears it — only the same recording (a late
 * STOPPED of an older one must not hide a newer recording of the room).
 */
export function withEvent(map: RecordingMap, r: RoomRecording): RecordingMap {
  if (!r.roomId) return map;
  const cur = map[r.roomId];
  if (r.state === RoomRecordingState.ACTIVE) {
    if (cur && cur.recordingId === r.recordingId && cur.byUserId === r.byUserId) return map;
    return { ...map, [r.roomId]: active(r) };
  }
  if (r.state === RoomRecordingState.STOPPED && cur && (!r.recordingId || cur.recordingId === r.recordingId)) {
    const { [r.roomId]: _gone, ...rest } = map;
    return rest;
  }
  return map;
}

/** Drops rooms (deleted room, left workspace). */
export function withoutRooms(map: RecordingMap, drop: (roomId: string, r: ActiveRecording) => boolean): RecordingMap {
  const entries = Object.entries(map).filter(([id, r]) => !drop(id, r));
  return entries.length === Object.keys(map).length ? map : Object.fromEntries(entries);
}

/** Why a recording stopped (RoomRecording.stop_reason) → the toast text. */
export function stopReasonKey(reason: string): MessageKey {
  switch (reason) {
    case 'user':
      return 'rec.stop.user';
    case 'empty':
      return 'rec.stop.empty';
    case 'max_duration':
      return 'rec.stop.maxDuration';
    case 'disabled':
      return 'rec.stop.disabled';
    case 'egress':
      return 'rec.stop.egress';
    case 'lost':
      return 'rec.stop.lost';
    default:
      return 'rec.stop.other';
  }
}

// ---------------------------------------------------------------- chat card

/** The birthday card of a system message, if it is one (docs/09 #76). */
export function birthdayCardOf(m: Pick<Message, 'kind' | 'system'>): BirthdayCard | null {
  if (m.kind !== MessageKind.SYSTEM) return null;
  const p = m.system?.payload;
  return p?.case === 'birthday' ? p.value : null;
}

/** The automation card of a system message (ADR-0060), if it is one. */
export function automationCardOf(m: Pick<Message, 'kind' | 'system'>): AutomationCard | null {
  if (m.kind !== MessageKind.SYSTEM) return null;
  const p = m.system?.payload;
  return p?.case === 'automation' ? p.value : null;
}

/** The recording card of a system message, if it is one. */
export function recordingCardOf(m: Pick<Message, 'kind' | 'system'>): RecordingCard | null {
  if (m.kind !== MessageKind.SYSTEM) return null;
  const p = m.system?.payload;
  return p?.case === 'recording' ? p.value : null;
}

export type CardTone = 'busy' | 'ok' | 'error';

/** The card's status line: what it says and how it looks. */
export function cardStatus(card: Pick<RecordingCard, 'status' | 'error' | 'resultPending'>): { key: MessageKey; tone: CardTone } {
  switch (card.status) {
    case RecordingStatus.DONE:
      // Done in GPTunneL; the summary / transcript / audio are still being brought here.
      return card.resultPending ? { key: 'rec.card.fetching', tone: 'busy' } : { key: 'rec.card.done', tone: 'ok' };
    case RecordingStatus.FAILED:
      return { key: cardErrorKey(card.error), tone: 'error' };
    case RecordingStatus.PROCESSING:
      return { key: 'rec.card.processing', tone: 'busy' };
    case RecordingStatus.RECORDING:
      return { key: 'rec.card.recording', tone: 'busy' };
    default:
      return { key: 'rec.card.uploading', tone: 'busy' };
  }
}

const ERRORS: Record<string, MessageKey> = {
  insufficient_balance: 'rec.err.balance',
  account_unavailable: 'rec.err.account',
  transcription_failed: 'rec.err.transcription',
  summary_failed: 'rec.err.summary',
  empty_audio: 'rec.err.emptyAudio',
  no_audio: 'rec.err.emptyAudio',
  storage_failed: 'rec.err.storage',
  device_revoked: 'rec.err.revoked',
  not_paired: 'rec.err.revoked',
  upload_failed: 'rec.err.upload',
  too_large: 'rec.err.tooLarge',
  recorder_failed: 'rec.err.recorder',
  timeout: 'rec.err.timeout',
  internal: 'rec.err.internal',
};

// ---------------------------------------------------------------- retry (docs/09 #40)

export type RetryAction = 'recheck' | 'reupload';

/**
 * Which retry a FAILED card offers (RecordingCard.not_uploaded / file_gone): a delivered file
 * is only rechecked (GPTunneL polled again), a file whose upload did not complete is sent again
 * while the server keeps it. Cards stored before these fields (both false) offer the recheck.
 */
export function retryActions(card: Pick<RecordingCard, 'status' | 'notUploaded' | 'fileGone'>): RetryAction[] {
  if (card.status !== RecordingStatus.FAILED) return [];
  if (!card.notUploaded) return ['recheck'];
  return card.fileGone ? [] : ['reupload'];
}

/**
 * A refused retry → an info toast text (the card is refreshed by the server at the same time);
 * null = not a known refusal (a generic error toast; NOT_PAIRED is handled like start).
 */
export function retryRefusalKey(code: string): MessageKey | null {
  switch (code) {
    case 'ERROR_CODE_FILE_GONE':
      return 'rec.retry.fileGone';
    case 'ERROR_CODE_ALREADY_UPLOADED':
      return 'rec.retry.alreadyUploaded';
    case 'ERROR_CODE_CONFLICT':
    case 'ERROR_CODE_NOT_FOUND':
      return 'rec.retry.changed';
    default:
      return null;
  }
}

/** FAILED card: the machine-readable reason → a human text. */
export function cardErrorKey(error: string): MessageKey {
  return ERRORS[error] ?? 'rec.err.generic';
}

/** Whole minutes of a recording for the card («42 мин», «1 ч 5 мин», «< 1 мин»). */
export function durationText(sec: number): string {
  const min = Math.floor(Math.max(0, sec) / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return m === 0 ? t('rec.dur.less') : t('rec.dur.min', { n: m });
  return m === 0 ? t('rec.dur.h', { h }) : t('rec.dur.hMin', { h, m });
}

/**
 * One line for a system message wherever a message is previewed (pins, search, reply quote,
 * notification, DM list): «Встреча записана · 42 мин», and «😀 Стикер» for a sticker message.
 * '' = a plain message (use its content); an unknown system payload also previews as ''.
 * With the author's name (a notification), a birthday card previews as the card's own line.
 */
export function systemPreview(m: Pick<Message, 'kind' | 'system'> & { sticker?: Message['sticker']; content?: string }, authorName?: string): string {
  // A sticker message (ADR-0030) previews as «😀 Стикер» too; one whose sticker is gone has no content.
  if (m.sticker) return stickerPreview(m.sticker.emoji);
  if (birthdayCardOf(m)) return authorName ? t('birthday.card', { name: authorName }) : t('birthday.preview');
  // An achievement card (ADR-0061): «🏆 Имя получает ачивку «Больше года»».
  const ach = achievementCardOf(m);
  if (ach) {
    const title = cachedAchievement(ach.achievementId)?.title ?? '';
    if (authorName) return title ? t('ach.notify', { name: authorName, title }) : t('ach.notifyNoTitle', { name: authorName });
    return title ? t('ach.preview', { title }) : t('ach.previewNoTitle');
  }
  // A board automation (ADR-0060): «Автоматизация: <text>».
  const auto = automationCardOf(m);
  if (auto) return t('rules.cardPreview', { text: auto.text || auto.ruleName });
  // A DM call log line (ADR-0034): «Исходящий звонок · 5:12», «Пропущенный звонок»…
  const call = callCardOf(m);
  if (call) return callLogLine(call, myUserId()).text;
  const card = recordingCardOf(m);
  if (!card) return '';
  return card.deletedAt ? t('rec.card.deleted') : t('rec.card.preview', { duration: durationText(card.durationSec) });
}

/** 3 pulses × 2 s of a fresh REC dot (`.rec-dot-pulse`, styles.css; docs/09 #64). */
export const REC_PULSE_MS = 6000;

/**
 * How far into the start pulse a REC dot mounted `ageMs` after the recording started is — the
 * negative delay that keeps a remounted dot (hover, a list re-render) in phase instead of pulsing
 * anew — or null once the pulse is over: a still dot, no animation at all.
 */
export function recPulseDelay(ageMs: number): string | null {
  const age = Math.max(0, ageMs);
  return age < REC_PULSE_MS ? `-${Math.round(age)}ms` : null;
}
