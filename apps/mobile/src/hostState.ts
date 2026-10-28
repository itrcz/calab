/**
 * Load state of the hosted web client (ADR-0067). The host covers the WebView only until the app
 * document loads and when a top-level load fails; once the web client runs, its own reconnect UI
 * handles network loss. Nothing here clears cookies or storage: a retry remounts the WebView
 * (`generation` is its key) over the same persistent session.
 *
 * `entry` is the URL the WebView opens (null: the web origin). An incoming link the running page
 * cannot take (ADR-0142) remounts the WebView on it; `entry` is cleared as soon as that load
 * finishes (`loaded`), so a retry or a crash of a running app goes back to the origin rather than
 * to an old link — only a link that never finished loading (a failure while it was still loading)
 * survives a retry.
 */

export type HostError = 'network' | 'server' | 'blocked' | 'crashed';

export interface HostState {
  generation: number;
  phase: 'loading' | 'ready' | 'error';
  error: HostError | null;
  entry: string | null;
}

export type HostEvent =
  | { type: 'loadStart' }
  | { type: 'loaded' }
  | { type: 'failed'; error: HostError }
  | { type: 'retry' }
  /** The web content process died (iOS memory pressure, an Android renderer crash). */
  | { type: 'processGone' }
  /** Load this app URL (already validated by links.ts) instead of what the WebView shows. */
  | { type: 'open'; url: string };

export const initialHostState: HostState = { generation: 0, phase: 'loading', error: null, entry: null };

export function hostReducer(state: HostState, event: HostEvent): HostState {
  switch (event.type) {
    case 'loadStart':
      // An error stays until the user retries: the WebView is unmounted then, nothing loads.
      return state.phase === 'ready' ? { ...state, phase: 'loading' } : state;
    case 'loaded':
      // A link that made it this far was taken (or the running page's own routing handled it):
      // a later retry must not re-open it, only go back to the origin (review follow-up).
      return state.phase === 'loading' ? { ...state, phase: 'ready', entry: null } : state;
    case 'failed':
      return { ...state, phase: 'error', error: event.error };
    case 'retry':
      return { ...state, generation: state.generation + 1, phase: 'loading', error: null };
    case 'open':
      // The same link announced twice at a cold start (initial URL and event): load it once.
      if (state.phase === 'loading' && state.entry === event.url) return state;
      return { generation: state.generation + 1, phase: 'loading', error: null, entry: event.url };
    case 'processGone':
      // A page that kills its process before it even loads would otherwise remount forever.
      if (state.phase !== 'ready') return { ...state, phase: 'error', error: 'crashed' };
      return { generation: state.generation + 1, phase: 'loading', error: null, entry: null };
  }
}
