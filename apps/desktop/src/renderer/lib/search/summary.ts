import type { SearchHit, SearchResponse } from '@calaba/protocol';
import { hitId, orderedSections, sectionTotal, type SectionName } from './sections';

/** One row of the ⌘K server part (ADR-0062 §4). */
export type SummaryRow =
  | { kind: 'hit'; id: string; section: SectionName; hit: SearchHit; byKey?: boolean }
  /** «Все: N →» under a section. */
  | { kind: 'more'; id: string; section: SectionName; total: number }
  /** A section that did not answer in time (`timed_out`): a quiet link to the results panel. */
  | { kind: 'timeout'; id: string; section: SectionName };

/**
 * The summary as ⌘K rows: sections in display order, ≤ `max` hits each with «Все: N →» when it
 * has any, a timed-out section as one quiet row, empty sections left out. A task found by its key
 * (ABC-12) is taken out of its section into `byKey` — ⌘K lists it first.
 */
export function summaryRows(r: Pick<SearchResponse, 'sections'>, max = 4): { byKey: SummaryRow[]; rows: SummaryRow[] } {
  const byKey: SummaryRow[] = [];
  const rows: SummaryRow[] = [];
  for (const { name, section } of orderedSections(r)) {
    if (section.timedOut) {
      rows.push({ kind: 'timeout', id: `x-${name}`, section: name });
      continue;
    }
    let shown = 0;
    for (const hit of section.items) {
      if (name === 'tasks' && hit.ref.case === 'task' && hit.ref.value.keyMatch && byKey.length === 0) {
        byKey.push({ kind: 'hit', id: `k-${hitId(hit)}`, section: name, hit, byKey: true });
        continue;
      }
      if (shown >= max) break;
      rows.push({ kind: 'hit', id: `h-${hitId(hit)}`, section: name, hit });
      shown += 1;
    }
    const total = sectionTotal(section);
    if (shown > 0) rows.push({ kind: 'more', id: `a-${name}`, section: name, total });
  }
  return { byKey, rows };
}
