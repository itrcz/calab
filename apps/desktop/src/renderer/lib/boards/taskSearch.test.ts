import { TaskField, TaskOp } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { useTaskSearch } from '../../stores/taskSearch';
import { fieldDef, fieldInScope } from './filterFields';
import { EMPTY_QUERY, clearQueryText, fromSavedQuery, hasConditions, isModified, nextSort, queryKey, searchParams, soleBoard, sortOf, toSavedQuery, type TaskQuery } from './taskSearch';

const q = (p: Partial<TaskQuery>): TaskQuery => ({ ...EMPTY_QUERY, ...p });
const board = (ids: string[], op = TaskOp.IS) => ({ conds: [{ field: TaskField.BOARD, op, values: ids }], any: false });

describe('task search query (ADR-0139)', () => {
  it('maps the four states to state + archived', () => {
    expect(searchParams(q({ state: 'all' }))).toEqual({ state: 'all', archived: '1' });
    expect(searchParams(q({ state: 'open', q: ' itms ' }))).toEqual({ q: 'itms', state: 'open' });
    expect(searchParams(q({ state: 'done', sort: '-key' }))).toEqual({ state: 'done', sort: '-key' });
    expect(searchParams(q({ state: 'archived' }))).toEqual({ archived: 'only' });
  });

  it('knows when there is something to search and something to reset', () => {
    expect(hasConditions(EMPTY_QUERY)).toBe(false);
    expect(hasConditions(q({ q: 'DOC-426' }))).toBe(true);
    expect(hasConditions(q({ state: 'archived' }))).toBe(true);
    expect(hasConditions(q({ filter: board(['b1']) }))).toBe(true);
    expect(hasConditions(q({ filter: board([]) }))).toBe(false); // an incomplete chip filters nothing
    expect(isModified(EMPTY_QUERY)).toBe(false);
    expect(isModified(q({ sort: 'key' }))).toBe(true);
  });

  it('keys equal conditions alike (the request is not repeated)', () => {
    expect(queryKey(q({ q: 'itms ' }))).toBe(queryKey(q({ q: 'itms' })));
    expect(queryKey(q({ state: 'open' }))).not.toBe(queryKey(q({ state: 'done' })));
  });

  it('cycles a column sort: ascending, descending, default; dates newest first', () => {
    expect(nextSort('', 'key')).toBe('key');
    expect(nextSort('key', 'key')).toBe('-key');
    expect(nextSort('-key', 'key')).toBe('');
    expect(nextSort('', 'updated')).toBe('-updated');
    expect(nextSort('-updated', 'updated')).toBe('updated');
    expect(nextSort('key', 'title')).toBe('title');
    expect(sortOf('-status')).toEqual({ col: 'status', desc: true });
    expect(sortOf('')).toBeNull();
  });

  it('finds the one chosen board', () => {
    expect(soleBoard(board(['b1']))).toBe('b1');
    expect(soleBoard(board(['b1', 'b2']))).toBe('');
    expect(soleBoard(board(['b1'], TaskOp.IS_NOT))).toBe('');
    expect(soleBoard(EMPTY_QUERY.filter)).toBe('');
  });

  it('round-trips a saved query', () => {
    const v = q({ q: 'itms', state: 'open', sort: '-updated', filter: { conds: [{ field: TaskField.ASSIGNEE, op: TaskOp.IS, values: ['me'] }], any: false } });
    expect(fromSavedQuery(toSavedQuery(v))).toEqual(v);
    expect(fromSavedQuery(undefined)).toEqual(EMPTY_QUERY);
  });

  it('offers fields by scope: «Доска» across boards, no «Текст» beside a search field, board fields with one board', () => {
    const def = (f: TaskField) => fieldDef(f) ?? (() => { throw new Error('no field'); })();
    expect(fieldInScope(def(TaskField.BOARD), 'search', false)).toBe(true);
    expect(fieldInScope(def(TaskField.BOARD), 'board', true)).toBe(false);
    expect(fieldInScope(def(TaskField.TEXT), 'board', true)).toBe(false);
    expect(fieldInScope(def(TaskField.TEXT), 'rule', true)).toBe(true);
    expect(fieldInScope(def(TaskField.STATUS), 'search', false)).toBe(false);
    expect(fieldInScope(def(TaskField.STATUS), 'search', true)).toBe(true);
    expect(fieldInScope(def(TaskField.STATUS_TYPE), 'search', false)).toBe(true);
  });
});

describe('«×» in the search field (CBF-157)', () => {
  it('clears the text only, state / filter / sort stay', () => {
    const cur = q({ q: 'регистрац', state: 'open', sort: '-key', filter: board(['b1']) });
    const next = clearQueryText(cur);
    expect(next).toEqual({ ...cur, q: '' });
    expect(next.filter).toBe(cur.filter);
    expect(clearQueryText(next)).toBe(next);
  });

  it('empties the remembered query of the workspace', () => {
    const ts = useTaskSearch.getState();
    ts.setQuery('ws1', q({ q: 'abc', state: 'done' }));
    ts.setQuery('ws1', clearQueryText(useTaskSearch.getState().byWs['ws1'] ?? EMPTY_QUERY));
    expect(useTaskSearch.getState().byWs['ws1']).toMatchObject({ q: '', state: 'done' });
  });
});
