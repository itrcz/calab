/**
 * Load state of the hosted web client (ADR-0067). The host covers the WebView only until the app
 * document loads and when a top-level load fails; once the web client runs, its own reconnect UI
 * handles network loss. Nothing here clears cookies or storage: a retry remounts the WebView
 * (`generation` is its key) over the same persistent session.
 *
 * `entry` is the URL the mounted WebView opens (null: the web origin) and MUST NOT change while
 * that generation stays mounted — `App.tsx` passes it straight to `source={{ uri: ... }}` of the
 * WebView keyed by `generation`, and react-native-webview reloads whenever `source.uri` changes
 * (regression from #263, DEV-4947: clearing `entry` on `loaded` made the WebView navigate away
 * from the link it had just finished loading, back to the origin). `entryLoaded` tracks whether
 * the current `entry` finished loading, separately from the WebView's own `uri`: a retry drops
 * the link once it loaded (goes back to the origin) but keeps it when it never finished loading
 * (a failure while it was still loading) — only `retry`, `open` and `processGone` ever touch
 * `entry`/`entryLoaded`.
 */

export type HostError = 'network' | 'server' | 'blocked' | 'crashed';

export interface HostState {
  generation: number;
  phase: 'loading' | 'ready' | 'error';
  error: HostError | null;
  entry: string | null;
  /** Whether `entry` (this generation's entry URL) already finished loading. */
  entryLoaded: boolean;
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

export const initialHostState: HostState = {
  generation: 0,
  phase: 'loading',
  error: null,
  entry: null,
  entryLoaded: false,
};

export function hostReducer(state: HostState, event: HostEvent): HostState {
  switch (event.type) {
    case 'loadStart':
      // An error stays until the user retries: the WebView is unmounted then, nothing loads.
      return state.phase === 'ready' ? { ...state, phase: 'loading' } : state;
    case 'loaded':
      // `entry` stays as-is: it is the URL the mounted WebView opened with, and must not change
      // while that generation stays mounted (it would make the WebView navigate away, DEV-4947).
      return state.phase === 'loading' ? { ...state, phase: 'ready', entryLoaded: true } : state;
    case 'failed':
      return { ...state, phase: 'error', error: event.error };
    case 'retry':
      // A link that made it this far was taken (or the running page's own routing handled it):
      // drop it so the new generation goes back to the origin, not to an old link (review
      // follow-up). Only a link that never finished loading survives the retry.
      return {
        ...state,
        generation: state.generation + 1,
        phase: 'loading',
        error: null,
        entry: state.entryLoaded ? null : state.entry,
        entryLoaded: false,
      };
    case 'open':
      // The same link announced twice at a cold start (initial URL and event): load it once.
      if (state.phase === 'loading' && state.entry === event.url) return state;
      return { generation: state.generation + 1, phase: 'loading', error: null, entry: event.url, entryLoaded: false };
    case 'processGone':
      // A page that kills its process before it even loads would otherwise remount forever.
      if (state.phase !== 'ready') return { ...state, phase: 'error', error: 'crashed', entryLoaded: false };
      return { generation: state.generation + 1, phase: 'loading', error: null, entry: null, entryLoaded: false };
  }
}
