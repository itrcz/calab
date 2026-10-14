import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { SearchHitSchema, SearchResponseSchema, SearchType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { NO_FILTERS, feedParams, panelRequest, paramsKey, periodRange, summaryParams, type RoomKindOf } from './query';
import { readScope, scopeParam, writeScope } from './scope';
import { orderedSections, sectionTotal, taskKeyOf } from './sections';

const NOW = new Date(2026, 9, 3, 15, 30).getTime();
const DAY = 86_400_000;
const kind: RoomKindOf = (id) => (id.startsWith('task') ? 'task' : id.startsWith('notes') ? 'notes' : 'chat');
const hit = (init: MessageInitShape<typeof SearchHitSchema>) => create(SearchHitSchema, init);
const base = { q: ' релиз ', scope: 'ws1', tab: 'messages' as const };

describe('request parameters', () => {
  it('summary and feed', () => {
    expect(summaryParams(' рел ', 'all')).toEqual({ q: 'рел', scope: 'all' });
    expect(feedParams('рел', 'ws1', 'tasks', 'relevance')).toEqual({ q: 'рел', scope: 'ws1', type: 'tasks' });
    expect(feedParams('рел', 'ws1', 'tasks', 'new', 'CUR')).toEqual({ q: 'рел', scope: 'ws1', type: 'tasks', sort: 'new', cursor: 'CUR' });
    expect(paramsKey({ scope: 'a', q: 'b' })).toBe(paramsKey({ q: 'b', scope: 'a' }));
  });
});

describe('panel filters → query params', () => {
  it('no filters: the tab as type, relevance', () => {
    const r = panelRequest(base, NO_FILTERS, NOW, kind);
    expect(r.params).toEqual({ q: 'релиз', scope: 'ws1', type: 'messages' });
    expect(r.filtered).toBe(false);
    expect(r.match(hit({}))).toBe(true);
  });

  it('sort «Сначала новые» → sort=new', () => {
    expect(panelRequest(base, { ...NO_FILTERS, sort: 'new' }, NOW, kind).params).toEqual({ q: 'релиз', scope: 'ws1', type: 'messages', sort: 'new' });
  });

  it('author / place / period stay client-side (the endpoint has no such parameters)', () => {
    const r = panelRequest(base, { ...NO_FILTERS, author: 'u1', place: 'r1', period: '7d' }, NOW, kind);
    expect(r.params).toEqual({ q: 'релиз', scope: 'ws1', type: 'messages' });
    expect(r.filtered).toBe(true);
    const ok = hit({ authorId: 'u1', at: timestampFromMs(NOW - DAY), ref: { case: 'message', value: { messageId: 'm', roomId: 'r1' } } });
    expect(r.match(ok)).toBe(true);
    expect(r.match({ ...ok, authorId: 'u2' })).toBe(false);
    expect(r.match(hit({ authorId: 'u1', at: timestampFromMs(NOW - DAY), ref: { case: 'message', value: { messageId: 'm', roomId: 'r2' } } }))).toBe(false);
    expect(r.match({ ...ok, at: timestampFromMs(NOW - 8 * DAY) })).toBe(false);
  });

  it('the board filters tasks', () => {
    const r = panelRequest({ ...base, tab: 'tasks' }, { ...NO_FILTERS, place: 'b1' }, NOW, kind);
    expect(r.params['type']).toBe('tasks');
    expect(r.match(hit({ ref: { case: 'task', value: { taskId: 't', boardId: 'b1' } } }))).toBe(true);
    expect(r.match(hit({ ref: { case: 'task', value: { taskId: 't', boardId: 'b2' } } }))).toBe(false);
  });

  it('«Только с файлами» asks for files, kept to the tab’s rooms', () => {
    const file = (roomId: string) => hit({ ref: { case: 'file', value: { fileId: 'f', messageId: 'm', roomId } } });
    const msgs = panelRequest(base, { ...NO_FILTERS, withFiles: true }, NOW, kind);
    expect(msgs.type).toBe('files');
    expect(msgs.params).toEqual({ q: 'релиз', scope: 'ws1', type: 'files' });
    expect(msgs.match(file('r1'))).toBe(true);
    expect(msgs.match(file('task-room'))).toBe(false);
    const comments = panelRequest({ ...base, tab: 'task_comments' }, { ...NO_FILTERS, withFiles: true }, NOW, kind);
    expect(comments.match(file('task-room'))).toBe(true);
    expect(comments.match(file('r1'))).toBe(false);
    const notes = panelRequest({ ...base, tab: 'notes' }, { ...NO_FILTERS, withFiles: true }, NOW, kind);
    expect(notes.match(file('notes-1'))).toBe(true);
    // Not a message-like tab: the toggle does nothing.
    expect(panelRequest({ ...base, tab: 'events' }, { ...NO_FILTERS, withFiles: true }, NOW, kind).params['type']).toBe('events');
  });

  it('periods: today, 7 / 30 days, dates with the end day included', () => {
    const today = new Date(2026, 9, 3).getTime();
    expect(periodRange({ period: 'any', from: '', to: '' }, NOW)).toEqual({ from: null, to: null });
    expect(periodRange({ period: 'today', from: '', to: '' }, NOW)).toEqual({ from: today, to: null });
    expect(periodRange({ period: '7d', from: '', to: '' }, NOW)).toEqual({ from: NOW - 7 * DAY, to: null });
    expect(periodRange({ period: '30d', from: '', to: '' }, NOW)).toEqual({ from: NOW - 30 * DAY, to: null });
    expect(periodRange({ period: 'range', from: '2026-10-01', to: '2026-10-02' }, NOW)).toEqual({ from: new Date(2026, 9, 1).getTime(), to: today });
    expect(periodRange({ period: 'range', from: '', to: 'bad' }, NOW)).toEqual({ from: null, to: null });
    const r = panelRequest(base, { ...NO_FILTERS, period: 'range', from: '2026-10-01', to: '2026-10-02' }, NOW, kind);
    expect(r.match(hit({ at: timestampFromMs(today - 1) }))).toBe(true);
    expect(r.match(hit({ at: timestampFromMs(today) }))).toBe(false);
    expect(r.match(hit({}))).toBe(false); // no time: not in a period
  });
});

describe('sections', () => {
  it('orders the summary as ⌘K shows it', () => {
    const r = create(SearchResponseSchema, {
      sections: [
        { type: SearchType.MESSAGES, totalEstimate: 7 },
        { type: SearchType.TASK_COMMENTS },
        { type: SearchType.TASKS, totalEstimate: 1000 },
        { type: SearchType.UNSPECIFIED },
      ],
    });
    expect(orderedSections(r).map((s) => s.name)).toEqual(['messages', 'tasks', 'task_comments']);
    expect(sectionTotal({ totalEstimate: 0, items: [hit({}), hit({})] })).toBe(2);
  });

  it('task keys', () => {
    expect(taskKeyOf('fng-12')).toBe('FNG-12');
    expect(taskKeyOf(' ABC-7 ')).toBe('ABC-7');
    expect(taskKeyOf('релиз')).toBeNull();
    expect(taskKeyOf('fng-12 релиз')).toBeNull();
  });
});

describe('scope', () => {
  it('is remembered, «Везде» without a workspace', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(readScope(s)).toBe('workspace');
    writeScope('all', s);
    expect(readScope(s)).toBe('all');
    expect(scopeParam('workspace', 'ws1')).toBe('ws1');
    expect(scopeParam('workspace', null)).toBe('all');
    expect(scopeParam('all', 'ws1')).toBe('all');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readScope(broken)).toBe('workspace');
    expect(() => writeScope('all', broken)).not.toThrow();
  });
});
