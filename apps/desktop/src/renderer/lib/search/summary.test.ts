import { create } from '@bufbuild/protobuf';
import { SearchResponseSchema, SearchType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { summaryRows } from './summary';

const msg = (id: string) => ({ snippet: `m ${id}`, ref: { case: 'message' as const, value: { messageId: id, roomId: 'r' } } });
const task = (id: string, keyMatch = false) => ({ title: id, ref: { case: 'task' as const, value: { taskId: id, boardId: 'b', key: id, keyMatch } } });

describe('⌘K summary rows', () => {
  it('≤ 4 hits per section in display order, «Все: N» after each, empty sections left out', () => {
    const r = create(SearchResponseSchema, {
      sections: [
        { type: SearchType.MESSAGES, items: ['1', '2', '3', '4', '5'].map(msg), totalEstimate: 37 },
        { type: SearchType.TASK_COMMENTS },
        { type: SearchType.TASKS, items: [task('t1')], totalEstimate: 1 },
        { type: SearchType.FILES },
      ],
    });
    const { byKey, rows } = summaryRows(r);
    expect(byKey).toEqual([]);
    expect(rows.map((x) => (x.kind === 'hit' ? `${x.section}:${x.id}` : `${x.kind}:${x.section}`))).toEqual([
      'messages:h-message:1',
      'messages:h-message:2',
      'messages:h-message:3',
      'messages:h-message:4',
      'more:messages',
      'tasks:h-t:t1',
      'more:tasks',
    ]);
    expect(rows[4]).toMatchObject({ kind: 'more', total: 37 });
  });

  it('a timed-out section is one quiet row; others are unaffected', () => {
    const r = create(SearchResponseSchema, {
      sections: [
        { type: SearchType.MESSAGES, timedOut: true },
        { type: SearchType.EVENTS, items: [{ title: 'Созвон', ref: { case: 'event', value: { eventId: 'e1' } } }], totalEstimate: 1 },
      ],
    });
    expect(summaryRows(r).rows.map((x) => x.kind)).toEqual(['timeout', 'hit', 'more']);
  });

  it('a task found by its key goes first, out of its section', () => {
    const r = create(SearchResponseSchema, {
      sections: [
        { type: SearchType.MESSAGES, items: [msg('1')], totalEstimate: 1 },
        { type: SearchType.TASKS, items: [task('FNG-12', true), task('FNG-120')], totalEstimate: 2 },
      ],
    });
    const { byKey, rows } = summaryRows(r);
    expect(byKey).toMatchObject([{ kind: 'hit', byKey: true, section: 'tasks', id: 'k-t:FNG-12' }]);
    expect(rows.filter((x) => x.kind === 'hit').map((x) => x.id)).toEqual(['h-message:1', 'h-t:FNG-120']);
  });

  it('the section of a lone key match keeps no «Все» row of its own', () => {
    const r = create(SearchResponseSchema, { sections: [{ type: SearchType.TASKS, items: [task('FNG-12', true)], totalEstimate: 1 }] });
    expect(summaryRows(r)).toMatchObject({ byKey: [{ id: 'k-t:FNG-12' }], rows: [] });
  });
});
