import { create } from '@bufbuild/protobuf';
import { TaskField, TaskOp, TaskSearchQuerySchema, type TaskSearchQuery } from '@calaba/protocol';
import { EMPTY_FILTER, activeConds, filterKey, fromTaskFilter, toTaskFilter, type FilterState } from './filter';

/**
 * The task search (ADR-0139): one query shape for ⌘K «Задачи», the results page, a board and a
 * saved search — text, «Все / Незавершённые / Завершённые / В архиве», the universal filter's
 * conditions and a sort — and its mapping to GET …/tasks/search and the saved TaskSearchQuery.
 * Pure.
 */
export type SearchState = 'all' | 'open' | 'done' | 'archived';

export const SEARCH_STATES: readonly SearchState[] = ['all', 'open', 'done', 'archived'];

/** Sortable columns (server tokens); a leading "-" is descending. '' = the server default (relevance with text, newest update without). */
export type SortColumn = 'key' | 'title' | 'board' | 'status' | 'assignee' | 'updated' | 'created' | 'priority' | 'due';

export interface TaskQuery {
  q: string;
  state: SearchState;
  filter: FilterState;
  sort: string;
}

export const EMPTY_QUERY: TaskQuery = { q: '', state: 'all', filter: EMPTY_FILTER, sort: '' };

/** The «×» of the search field (CBF-157): the text goes, the state, the filter and the sort stay («Сбросить» is for them). */
export const clearQueryText = (q: TaskQuery): TaskQuery => (q.q === '' ? q : { ...q, q: '' });

export function isSearchState(v: unknown): v is SearchState {
  return v === 'all' || v === 'open' || v === 'done' || v === 'archived';
}

/** Anything to search by: text or an applied condition (the state alone lists too, but «пусто» shows a hint). */
export function hasConditions(q: TaskQuery): boolean {
  return q.q.trim() !== '' || activeConds(q.filter).length > 0 || q.state === 'archived';
}

/** Differs from a fresh search: «Сбросить» is offered. */
export function isModified(q: TaskQuery): boolean {
  return q.q !== '' || q.state !== 'all' || q.filter.conds.length > 0 || q.sort !== '';
}

/** Stable text of a query: the request key and «изменён» against a saved search. */
export function queryKey(q: TaskQuery): string {
  return JSON.stringify([q.q.trim(), q.state, filterKey(q.filter), q.sort]);
}

/** The query string of GET …/tasks/search (filter as protojson text, made by the caller's api helper). */
export function searchParams(q: TaskQuery): { q?: string; state?: 'open' | 'done' | 'all'; archived?: '1' | 'only'; sort?: string } {
  const text = q.q.trim();
  const out: ReturnType<typeof searchParams> = {};
  if (text) out.q = text;
  switch (q.state) {
    case 'all':
      out.state = 'all';
      out.archived = '1';
      break;
    case 'open':
    case 'done':
      out.state = q.state;
      break;
    case 'archived':
      out.archived = 'only';
      break;
  }
  if (q.sort) out.sort = q.sort;
  return out;
}

/** The sort after a click on a column header: ascending first, then descending, then the default. */
export function nextSort(current: string, col: SortColumn): string {
  // Dates read newest first: their first click is descending.
  const firstDesc = col === 'updated' || col === 'created';
  const asc = firstDesc ? `-${col}` : col;
  const desc = firstDesc ? col : `-${col}`;
  if (current === asc) return desc;
  if (current === desc) return '';
  return asc;
}

/** The column a sort token orders by and its direction (null = the default order). */
export function sortOf(sort: string): { col: string; desc: boolean } | null {
  if (!sort) return null;
  return sort.startsWith('-') ? { col: sort.slice(1), desc: true } : { col: sort, desc: false };
}

/** The one board a filter narrows to (a single «Доска is X»): its statuses, labels and milestones can be picked. */
export function soleBoard(f: FilterState): string {
  const boards = activeConds(f).filter((c) => c.field === TaskField.BOARD);
  if (boards.length !== 1) return '';
  const c = boards[0];
  return c && c.op === TaskOp.IS && c.values.length === 1 ? (c.values[0] ?? '') : '';
}

// ------------------------------------------------------------------ saved searches

export function toSavedQuery(q: TaskQuery): TaskSearchQuery {
  return create(TaskSearchQuerySchema, { q: q.q.trim(), state: q.state, filter: toTaskFilter(q.filter), sort: q.sort });
}

export function fromSavedQuery(s: TaskSearchQuery | undefined): TaskQuery {
  if (!s) return EMPTY_QUERY;
  return { q: s.q, state: isSearchState(s.state) ? s.state : 'all', filter: fromTaskFilter(s.filter), sort: s.sort };
}
