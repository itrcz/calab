/**
 * Load state of the hosted web client (ADR-0067). The host covers the WebView only until the app
 * document loads and when a top-level load fails; once the web client runs, its own reconnect UI
 * handles network loss. Nothing here clears cookies or storage: a retry remounts the WebView
 * (`generation` is its key) over the same persistent session.
 */

export type HostError = 'network' | 'server' | 'blocked' | 'crashed';

export interface HostState {
  generation: number;
  phase: 'loading' | 'ready' | 'error';
  error: HostError | null;
}

export type HostEvent =
  | { type: 'loadStart' }
  | { type: 'loaded' }
  | { type: 'failed'; error: HostError }
  | { type: 'retry' }
  /** The web content process died (iOS memory pressure, an Android renderer crash). */
  | { type: 'processGone' };

export const initialHostState: HostState = { generation: 0, phase: 'loading', error: null };

export function hostReducer(state: HostState, event: HostEvent): HostState {
  switch (event.type) {
    case 'loadStart':
      // An error stays until the user retries: the WebView is unmounted then, nothing loads.
      return state.phase === 'ready' ? { ...state, phase: 'loading' } : state;
    case 'loaded':
      return state.phase === 'loading' ? { ...state, phase: 'ready' } : state;
    case 'failed':
      return { ...state, phase: 'error', error: event.error };
    case 'retry':
      return { generation: state.generation + 1, phase: 'loading', error: null };
    case 'processGone':
      // A page that kills its process before it even loads would otherwise remount forever.
      if (state.phase !== 'ready') return { ...state, phase: 'error', error: 'crashed' };
      return { generation: state.generation + 1, phase: 'loading', error: null };
  }
}
