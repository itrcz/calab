import type { SearchResponse } from '@calaba/protocol';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api/endpoints';
import { SearchCache } from '../../lib/search/cache';
import { paramsKey, summaryParams, type SearchParams } from '../../lib/search/query';
import { debouncedSearch } from '../../lib/search/runner';
import { log } from '../../lib/log';

/** Answers of GET /api/search shared by ⌘K and the results panel (20 requests, 60 s; ADR-0062 §4). */
export const searchCache = new SearchCache<SearchResponse>(20, 60_000);

export function fetchSearch(p: SearchParams, signal: AbortSignal): Promise<SearchResponse> {
  return api.search(p, signal);
}

export interface SummaryState {
  /** The latest answer — of this query, or of the previous one while this one loads. */
  data: SearchResponse | null;
  /** `data` answers the current query. */
  fresh: boolean;
  busy: boolean;
  failed: boolean;
}

/**
 * The ⌘K summary of `q` in `scope` (every section, 4 hits each): one debounced request at a
 * time, the previous one aborted, answers cached. While a new query loads, the last answer stays
 * on screen (no flicker between keystrokes).
 */
export function useSearchSummary(q: string, scope: string, enabled = true): SummaryState {
  const text = q.trim();
  const params = useMemo(() => (text && enabled ? summaryParams(text, scope) : null), [text, scope, enabled]);
  const key = params ? paramsKey(params) : '';
  const [state, setState] = useState<{ key: string; data: SearchResponse | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!params) return;
    return debouncedSearch({
      key,
      run: (signal) => fetchSearch(params, signal),
      cache: searchCache,
      onDone: (k, data) => setState({ key: k, data, failed: false }),
      onError: (k, e) => {
        log.warn('search failed', e);
        // 422 (no words left, e.g. only punctuation), 429, offline: no server sections.
        setState({ key: k, data: null, failed: true });
      },
    });
  }, [key, params]);
  if (!key) return { data: null, fresh: false, busy: false, failed: false };
  const fresh = state?.key === key;
  return { data: state?.data ?? null, fresh: fresh && !state.failed, busy: !fresh, failed: fresh && state.failed };
}
