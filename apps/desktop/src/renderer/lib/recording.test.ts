import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { MessageKind, MessageSchema, RecordingStatus, RoomRecordingSchema, RoomRecordingState } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import {
  cardErrorKey,
  cardStatus,
  durationText,
  formatPairCode,
  pairCodeComplete,
  pairErrorKey,
  recPulseDelay,
  recordingCardOf,
  retryActions,
  retryRefusalKey,
  stopReasonKey,
  systemPreview,
  withEvent,
  withSnapshot,
  withoutRooms,
  type RecordingMap,
} from './recording';

const rec = (roomId: string, recordingId: string, state: RoomRecordingState, extra: { ws?: string; by?: string; since?: number; reason?: string } = {}) =>
  create(RoomRecordingSchema, {
    workspaceId: extra.ws ?? 'w1',
    roomId,
    recordingId,
    state,
    byUserId: extra.by ?? 'boris',
    since: timestampFromMs(extra.since ?? 1_000),
    stopReason: extra.reason ?? '',
  });

describe('pairing code mask', () => {
  it('upper-cases, keeps letters and digits, adds the dash after 4', () => {
    expect(formatPairCode('ab')).toBe('AB');
    expect(formatPairCode('abcd')).toBe('ABCD');
    expect(formatPairCode('abcde')).toBe('ABCD-E');
    expect(formatPairCode('ab2d-ef9h')).toBe('AB2D-EF9H');
    expect(formatPairCode('  ab cd  ef gh ')).toBe('ABCD-EFGH');
  });

  it('typing past 8 keeps the first 8; a pasted labelled code keeps the code', () => {
    expect(formatPairCode('ABCD-EFGHX')).toBe('ABCD-EFGH');
    expect(formatPairCode('Код: abcd-efgh')).toBe('ABCD-EFGH');
    expect(formatPairCode('Code ABCD-EFGH')).toBe('ABCD-EFGH');
  });

  it('is complete at 8 characters', () => {
    expect(pairCodeComplete('ABCD-EFG')).toBe(false);
    expect(pairCodeComplete('ABCD-EFGH')).toBe(true);
  });

  it('pairing errors → inline texts', () => {
    const api = (code: string, status: number): Error => Object.assign(new Error('x'), { code, status });
    expect(pairErrorKey(api('ERROR_CODE_CODE_INVALID', 422))).toBe('gpt.err.code');
    expect(pairErrorKey(api('ERROR_CODE_VALIDATION', 422))).toBe('gpt.err.format');
    expect(pairErrorKey(api('ERROR_CODE_RATE_LIMITED', 429))).toBe('gpt.err.rate');
    expect(pairErrorKey(api('ERROR_CODE_UNAVAILABLE', 503))).toBe('gpt.err.unavailable');
    expect(pairErrorKey(api('ERROR_CODE_UNAVAILABLE', 0))).toBeNull(); // offline: the generic text
    expect(pairErrorKey(new Error('boom'))).toBeNull();
  });
});

describe('recording state from READY and ROOM_RECORDING', () => {
  it('a snapshot replaces its workspace only, ACTIVE entries only', () => {
    const before: RecordingMap = {
      r1: { workspaceId: 'w1', recordingId: 'old', byUserId: 'x', since: 1 },
      r9: { workspaceId: 'w2', recordingId: 'other', byUserId: 'y', since: 2 },
    };
    const next = withSnapshot(before, 'w1', [rec('r2', 'a', RoomRecordingState.ACTIVE, { since: 5_000 }), rec('r3', 'b', RoomRecordingState.STOPPED)]);
    expect(next).toEqual({
      r9: before['r9'],
      r2: { workspaceId: 'w1', recordingId: 'a', byUserId: 'boris', since: 5_000 },
    });
  });

  it('ACTIVE sets the room; a replay changes nothing', () => {
    const one = withEvent({}, rec('r1', 'a', RoomRecordingState.ACTIVE));
    expect(one['r1']?.recordingId).toBe('a');
    expect(withEvent(one, rec('r1', 'a', RoomRecordingState.ACTIVE))).toBe(one);
  });

  it('STOPPED clears the same recording only', () => {
    const one = withEvent({}, rec('r1', 'b', RoomRecordingState.ACTIVE));
    expect(withEvent(one, rec('r1', 'a', RoomRecordingState.STOPPED))).toBe(one); // a late stop of an older one
    expect(withEvent(one, rec('r1', 'b', RoomRecordingState.STOPPED, { reason: 'user' }))).toEqual({});
    expect(withEvent({}, rec('r1', 'b', RoomRecordingState.STOPPED))).toEqual({});
  });

  it('drops rooms of a deleted room / left workspace', () => {
    const map = withSnapshot({}, 'w1', [rec('r1', 'a', RoomRecordingState.ACTIVE), rec('r2', 'b', RoomRecordingState.ACTIVE)]);
    expect(Object.keys(withoutRooms(map, (id) => id === 'r1'))).toEqual(['r2']);
    expect(withoutRooms(map, () => false)).toBe(map);
  });

  it('every stop reason has its own text', () => {
    const reasons = ['user', 'empty', 'max_duration', 'disabled', 'plan_inactive', 'egress', 'lost'];
    const keys = reasons.map(stopReasonKey);
    expect(new Set(keys).size).toBe(reasons.length);
    expect(stopReasonKey('something-new')).toBe('rec.stop.other');
  });
});

describe('chat card', () => {
  const card = (status: RecordingStatus, error = '', durationSec = 42 * 60) =>
    create(MessageSchema, {
      id: 'm1',
      kind: MessageKind.SYSTEM,
      system: { payload: { case: 'recording', value: { recordingId: 'a', startedBy: 'boris', durationSec, status, webUrl: '', error } } },
    });

  it('status line per state', () => {
    const st = (s: RecordingStatus, e = ''): string => {
      const c = recordingCardOf(card(s, e));
      if (!c) throw new Error('no card');
      const r = cardStatus(c);
      return `${r.tone}:${r.key}`;
    };
    expect(st(RecordingStatus.UPLOADING)).toBe('busy:rec.card.uploading');
    expect(st(RecordingStatus.PROCESSING)).toBe('busy:rec.card.processing');
    expect(st(RecordingStatus.DONE)).toBe('ok:rec.card.done');
    expect(st(RecordingStatus.FAILED, 'insufficient_balance')).toBe('error:rec.err.balance');
    expect(st(RecordingStatus.FAILED, 'device_revoked')).toBe('error:rec.err.revoked');
    expect(st(RecordingStatus.FAILED, '???')).toBe('error:rec.err.generic');
  });

  it('knows every documented error code', () => {
    const codes = ['insufficient_balance', 'account_unavailable', 'transcription_failed', 'summary_failed', 'empty_audio', 'storage_failed', 'device_revoked', 'not_paired', 'upload_failed', 'too_large', 'no_audio', 'recorder_failed', 'timeout', 'internal'];
    for (const c of codes) expect(cardErrorKey(c), c).not.toBe('rec.err.generic');
  });

  it('retry buttons of a failed card (docs/09 #40)', () => {
    const r = (status: RecordingStatus, notUploaded: boolean, fileGone: boolean) => retryActions({ status, notUploaded, fileGone });
    // Delivered to GPTunneL: only recheck, whether or not the file is still here.
    expect(r(RecordingStatus.FAILED, false, false)).toEqual(['recheck']);
    expect(r(RecordingStatus.FAILED, false, true)).toEqual(['recheck']);
    // Upload did not complete: send again while the file is kept.
    expect(r(RecordingStatus.FAILED, true, false)).toEqual(['reupload']);
    expect(r(RecordingStatus.FAILED, true, true)).toEqual([]);
    // Only failed cards retry.
    for (const s of [RecordingStatus.UPLOADING, RecordingStatus.PROCESSING, RecordingStatus.DONE]) expect(r(s, true, false)).toEqual([]);
  });

  it('refused retries say why', () => {
    expect(retryRefusalKey('ERROR_CODE_FILE_GONE')).toBe('rec.retry.fileGone');
    expect(retryRefusalKey('ERROR_CODE_ALREADY_UPLOADED')).toBe('rec.retry.alreadyUploaded');
    expect(retryRefusalKey('ERROR_CODE_CONFLICT')).toBe('rec.retry.changed');
    expect(retryRefusalKey('ERROR_CODE_INTERNAL')).toBeNull();
  });

  it('a user message is not a card', () => {
    expect(recordingCardOf(create(MessageSchema, { content: 'hi' }))).toBeNull();
    expect(systemPreview(create(MessageSchema, { content: 'hi' }))).toBe('');
  });

  it('duration and the one-line preview', () => {
    expect(durationText(20)).toBe(t('rec.dur.less'));
    expect(durationText(42 * 60 + 59)).toBe('42 мин');
    expect(durationText(3600)).toBe('1 ч');
    expect(durationText(65 * 60)).toBe('1 ч 5 мин');
    expect(systemPreview(card(RecordingStatus.DONE))).toBe('Встреча записана · 42 мин');
  });
});

describe('recPulseDelay (docs/09 #64)', () => {
  it('pulses only in the first 6 s, keeping the phase on a remount', () => {
    expect(recPulseDelay(0)).toBe('-0ms');
    expect(recPulseDelay(2500.4)).toBe('-2500ms');
    expect(recPulseDelay(5999)).toBe('-5999ms');
    expect(recPulseDelay(6000)).toBeNull();
    expect(recPulseDelay(754_000)).toBeNull();
  });
  it('treats a start slightly in the future (clock skew) as just started', () => {
    expect(recPulseDelay(-1500)).toBe('-0ms');
  });
});
