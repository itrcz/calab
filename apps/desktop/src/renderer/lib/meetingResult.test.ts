import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { FileMetaSchema, RecordingCardSchema, RecordingStatus } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import {
  mayDeleteRecording,
  recordingAudio,
  remarkSpeaker,
  searchSegments,
  segmentAt,
  speakerNumber,
  speakersByNumber,
  stamp,
  summaryBlocks,
  summaryFoldsUpfront,
  summaryPlainText,
  transcriptFileName,
  transcriptText,
} from './meetingResult';

describe('summary blocks', () => {
  it('headings, bullets, numbered items and paragraphs', () => {
    const md = '## **Темы**\n- Релиз **0.7**\n* второй\n\n### Решения\n1. Выпускаем\n2) в пятницу\nПросто текст\nпродолжение\n\nНовый абзац';
    expect(summaryBlocks(md)).toEqual([
      { t: 'h', text: 'Темы' },
      { t: 'li', text: 'Релиз **0.7**' },
      { t: 'li', text: 'второй' },
      { t: 'h', text: 'Решения' },
      { t: 'li', text: 'Выпускаем', n: '1' },
      { t: 'li', text: 'в пятницу', n: '2' },
      { t: 'p', text: 'Просто текст продолжение' },
      { t: 'p', text: 'Новый абзац' },
    ]);
  });
  it('empty and CRLF input', () => {
    expect(summaryBlocks('')).toEqual([]);
    expect(summaryBlocks('# A\r\n- b\r\n')).toEqual([
      { t: 'h', text: 'A' },
      { t: 'li', text: 'b' },
    ]);
  });
});

describe('summary folds upfront', () => {
  it('more blocks than folded lines fold before layout; fewer are left to the measure', () => {
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => `- пункт ${i}`).join('\n');
    expect(summaryFoldsUpfront(summaryBlocks(lines(7)))).toBe(true);
    expect(summaryFoldsUpfront(summaryBlocks(lines(6)))).toBe(false);
    expect(summaryFoldsUpfront(summaryBlocks(''))).toBe(false);
  });
});

describe('summary plain text', () => {
  it('headings, lists and inline markers as plain lines', () => {
    const md =
      '## **Темы**\r\n- Релиз **0.7** и __тесты__\n* `make gen` — _быстро_\n\n\n### Решения\n1. Выпускаем [план](https://x.test/p)\n2) в пятницу https://x.test/a\nПросто текст\nпродолжение\n\n';
    expect(summaryPlainText(md)).toBe(
      'Темы\n• Релиз 0.7 и тесты\n• make gen — быстро\n\nРешения\n1. Выпускаем план (https://x.test/p)\n2. в пятницу https://x.test/a\nПросто текст\nпродолжение',
    );
  });
  it('mentions and empty input', () => {
    expect(summaryPlainText('')).toBe('');
    expect(summaryPlainText('  \n\n')).toBe('');
    expect(summaryPlainText('Спасибо @everyone')).toBe('Спасибо @everyone');
  });
});

describe('card', () => {
  const audio = create(FileMetaSchema, { id: 'f1', name: 'voice 2026-09-27 15-04.m4a', mime: 'audio/mp4' });
  const doc = create(FileMetaSchema, { id: 'f2', name: 'x.pdf', mime: 'application/pdf' });
  it('the audio is the attachment while audio_until is set', () => {
    const card = create(RecordingCardSchema, { audioUntil: timestampFromMs(Date.now() + 1000) });
    expect(recordingAudio(card, [doc, audio])?.id).toBe('f1');
    expect(recordingAudio(create(RecordingCardSchema, {}), [audio])).toBeNull();
    expect(recordingAudio(create(RecordingCardSchema, { audioUntil: timestampFromMs(1), deletedAt: timestampFromMs(2) }), [audio])).toBeNull();
  });
  it('who may delete', () => {
    const done = create(RecordingCardSchema, { status: RecordingStatus.DONE, startedBy: 'bob' });
    const none = { owner: false, manageMessages: false };
    expect(mayDeleteRecording(done, 'bob', none)).toBe(true);
    expect(mayDeleteRecording(done, 'carol', none)).toBe(false);
    expect(mayDeleteRecording(done, 'carol', { owner: true, manageMessages: false })).toBe(true);
    expect(mayDeleteRecording(done, 'carol', { owner: false, manageMessages: true })).toBe(true);
    // ADR-0048: MANAGE_RECORDINGS of the workspace.
    expect(mayDeleteRecording(done, 'carol', { owner: false, manageMessages: false, manageRecordings: true })).toBe(true);
    expect(mayDeleteRecording(create(RecordingCardSchema, { status: RecordingStatus.RECORDING, startedBy: 'bob' }), 'bob', none)).toBe(false);
    expect(mayDeleteRecording(create(RecordingCardSchema, { status: RecordingStatus.FAILED, startedBy: 'bob', deletedAt: timestampFromMs(1) }), 'bob', none)).toBe(false);
    expect(mayDeleteRecording(create(RecordingCardSchema, { status: RecordingStatus.DONE, startedBy: '' }), '', none)).toBe(false);
  });
});

describe('transcript', () => {
  const segs = [
    { speaker: 0, startMs: 480, endMs: 6900, text: 'Коллеги, начнём с релиза' },
    { speaker: 1, startMs: 7200, endMs: 12050, text: 'Эталоны пересняли' },
    { speaker: -1, startMs: 3_725_000, endMs: 3_726_000, text: 'Угу' },
  ];
  it('stamps and speakers', () => {
    expect(stamp(480)).toBe('0:00');
    expect(stamp(65_000)).toBe('1:05');
    expect(stamp(3_723_000)).toBe('1:02:03');
    expect(speakerNumber(0)).toBe(1);
    expect(speakerNumber(-1)).toBeNull();
  });
  it('search keeps remarks with every word', () => {
    expect(searchSegments(segs, '')).toEqual([0, 1, 2]);
    expect(searchSegments(segs, 'РЕЛИЗА коллеги')).toEqual([0]);
    expect(searchSegments(segs, 'эталоны релиз')).toEqual([]);
  });
  it('named speakers (ADR-0169): the remark\'s own person, then its number\'s, then the number', () => {
    const by = speakersByNumber([
      { speaker: 0, userId: 'u-anna', name: '' },
      { speaker: 2, userId: '', name: '+79990000000' },
    ]);
    expect(remarkSpeaker({ speaker: 0, userId: '' }, by)).toEqual({ userId: 'u-anna', n: 1 });
    expect(remarkSpeaker({ speaker: 1, userId: 'u-boris' }, by)).toEqual({ userId: 'u-boris', n: 2 });
    expect(remarkSpeaker({ speaker: 2, userId: '' }, by)).toEqual({ name: '+79990000000', n: 3 });
    expect(remarkSpeaker({ speaker: 3, userId: '' }, by)).toEqual({ n: 4 });
    expect(remarkSpeaker({ speaker: -1, userId: '' }, by)).toBeNull();
    expect(remarkSpeaker({ speaker: -1, userId: 'u-anna' }, by)).toEqual({ userId: 'u-anna', n: null });
    const names: Record<number, string> = { 0: 'Анна', 1: 'Борис' };
    expect(searchSegments(segs, 'борис', (s) => names[s.speaker] ?? '')).toEqual([1]);
    expect(transcriptText(segs, (s) => names[s.speaker] ?? '')).toBe('[0:00] Анна: Коллеги, начнём с релиза\n[0:07] Борис: Эталоны пересняли\n[1:02:05] Угу\n');
  });
  it('the remark under the player', () => {
    expect(segmentAt(segs, 0)).toBe(-1);
    expect(segmentAt(segs, 1)).toBe(0);
    expect(segmentAt(segs, 7.2)).toBe(1);
    expect(segmentAt(segs, 16)).toBe(1); // within 5 s after its end
    expect(segmentAt(segs, 60)).toBe(-1); // a long pause
    expect(segmentAt(segs, 3725.5)).toBe(2);
    expect(segmentAt([], 3)).toBe(-1);
  });
  it('plain text and file name', () => {
    expect(transcriptText(segs, (s) => (s.speaker >= 0 ? `Спикер ${s.speaker + 1}` : ''), 'Встреча')).toBe(
      'Встреча\n\n[0:00] Спикер 1: Коллеги, начнём с релиза\n[0:07] Спикер 2: Эталоны пересняли\n[1:02:05] Угу\n',
    );
    expect(transcriptFileName('Транскрипт: a/b', new Date(2026, 8, 27, 15, 4))).toBe('Транскрипт a b 2026-09-27 15-04.txt');
  });
});
