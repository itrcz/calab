/**
 * «Это пространство | Везде» of ⌘K and the results panel (ADR-0062 §4), remembered on this
 * device. Without an active workspace («Личные») the search is always «Везде».
 */
export type ScopeMode = 'workspace' | 'all';

const KEY = 'calaba-search-scope';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readScope(s: Storage | null = storage()): ScopeMode {
  try {
    return s?.getItem(KEY) === 'all' ? 'all' : 'workspace';
  } catch {
    return 'workspace';
  }
}

export function writeScope(mode: ScopeMode, s: Storage | null = storage()): void {
  try {
    s?.setItem(KEY, mode);
  } catch {
    // private mode / blocked storage: the choice lasts until the window closes
  }
}

/** The `scope` parameter: the active workspace, or "all". */
export function scopeParam(mode: ScopeMode, activeWorkspaceId: string | null): string {
  return mode === 'workspace' && activeWorkspaceId ? activeWorkspaceId : 'all';
}
