import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { SearchHitSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { placeLine, type PlaceCtx } from './place';

const AT = Date.UTC(2026, 9, 3, 10, 0);

const ctx: PlaceCtx = {
  room: (id) => ({ r1: '#разработка', r2: '«Созвон»', n1: '📝 Идеи', d1: 'Вера' })[id] ?? '',
  author: (_ws, uid) => ({ u1: 'Борис', u2: 'Анна' })[uid] ?? '',
  board: (id) => (id === 'b1' ? 'Доска' : ''),
  workspace: (ws) => (ws === 'w2' ? 'Дизайн' : ''),
  date: () => '3 окт.',
  when: () => 'пт, 3 окт., 10:00',
  offset: (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`,
  size: (n) => `${n} Б`,
};

const hit = (init: MessageInitShape<typeof SearchHitSchema>) => create(SearchHitSchema, { at: timestampFromMs(AT), workspaceId: 'w1', authorId: 'u1', ...init });

describe('placeLine', () => {
  it('message: room · author · date', () => {
    expect(placeLine(hit({ ref: { case: 'message', value: { messageId: 'm', roomId: 'r1' } } }), ctx)).toBe('#разработка · Борис · 3 окт.');
  });
  it('DM message: the peer, no workspace', () => {
    expect(placeLine(hit({ workspaceId: '', authorId: 'u2', ref: { case: 'message', value: { messageId: 'm', roomId: 'd1' } } }), ctx)).toBe('Вера · Анна · 3 окт.');
  });
  it('task comment: key · task title · author · date', () => {
    expect(placeLine(hit({ ref: { case: 'taskComment', value: { messageId: 'm', roomId: 'tr', taskId: 't', taskKey: 'FNG-12', taskTitle: 'Релиз' } } }), ctx)).toBe('FNG-12 · Релиз · Борис · 3 окт.');
  });
  it('task: key · board', () => {
    expect(placeLine(hit({ title: 'Релиз', ref: { case: 'task', value: { taskId: 't', boardId: 'b1', key: 'FNG-12' } } }), ctx)).toBe('FNG-12 · Доска');
  });
  it('event: occurrence · room; no room — just the time', () => {
    expect(placeLine(hit({ ref: { case: 'event', value: { eventId: 'e', occurrenceStart: timestampFromMs(AT), roomId: 'r2' } } }), ctx)).toBe('пт, 3 окт., 10:00 · «Созвон»');
    expect(placeLine(hit({ ref: { case: 'event', value: { eventId: 'e', occurrenceStart: timestampFromMs(AT) } } }), ctx)).toBe('пт, 3 окт., 10:00');
  });
  it('file: room · size · date', () => {
    expect(placeLine(hit({ title: 'report.pdf', ref: { case: 'file', value: { fileId: 'f', messageId: 'm', roomId: 'r1', mime: 'application/pdf', size: 1024n } } }), ctx)).toBe('#разработка · 1024 Б · 3 окт.');
  });
  it('note: shelf · date', () => {
    expect(placeLine(hit({ workspaceId: '', ref: { case: 'note', value: { messageId: 'm', roomId: 'n1' } } }), ctx)).toBe('📝 Идеи · 3 окт.');
  });
  it('transcript: room · offset · date', () => {
    expect(placeLine(hit({ ref: { case: 'transcript', value: { recordingId: 'rec', roomId: 'r2', offsetMs: 754_000n } } }), ctx)).toBe('«Созвон» · 12:34 · 3 окт.');
  });
  it('another workspace («Везде») is named at the end; unknown parts are skipped', () => {
    expect(placeLine(hit({ workspaceId: 'w2', ref: { case: 'message', value: { messageId: 'm', roomId: 'r1' } } }), ctx)).toBe('#разработка · Борис · 3 окт. · Дизайн');
    expect(placeLine(hit({ authorId: '', ref: { case: 'message', value: { messageId: 'm', roomId: 'gone' } } }), ctx)).toBe('3 окт.');
  });
});
