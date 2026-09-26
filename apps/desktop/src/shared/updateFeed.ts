/**
 * Update feed rules (security review M3, review pass 3 B1), pure for tests.
 *
 * Trust model:
 * - The build-time feed (MAIN_VITE_UPDATE_FEED, `https://releases.calab.ru/` in release builds,
 *   empty in dev) is the ONLY feed an update may be downloaded and installed from automatically.
 *   It is baked into the bundle; neither the server, the renderer nor a runtime env can change it.
 * - The feed derived from the server the app is connected to is notify-only: it can at most show
 *   «Доступна версия X — Скачать», which opens a download page in the browser.
 *   `https://app.X[:port]` → `https://releases.X[:port]/` (the releases.<domain> vhost, see
 *   infra/docker Caddyfile); any other host → `https://<host>/download/`.
 * - CALABA_UPDATE_URL (runtime) is a notify-only override (testing another feed); it never enables
 *   auto-install.
 * https only everywhere.
 */

/** https URL with a trailing slash on the path, or null (empty, malformed, not https). */
export function httpsFeed(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null;
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.toString();
  } catch {
    return null;
  }
}

/** Server URL → notify-only feed (not yet validated), '' when there is no server. */
function derivedFeed(serverUrl: string): string {
  const s = serverUrl.trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    // `app.X` with a non-empty X (a bare «app» host keeps /download/).
    if (u.hostname.startsWith('app.') && u.hostname.length > 'app.'.length) {
      return `${u.protocol}//releases.${u.hostname.slice('app.'.length)}${u.port ? `:${u.port}` : ''}/`;
    }
    return `${u.origin}/download/`;
  } catch {
    return '';
  }
}

/**
 * Notify-only feed: the runtime override when set (it does not fall back to the server when it is
 * invalid), else derived from the server. null → none (no server, not https).
 */
export function feedUrl(serverUrl: string, override: string): string | null {
  if (override.trim()) return httpsFeed(override);
  return httpsFeed(derivedFeed(serverUrl));
}

/**
 * Human download page for the «Скачать» notification / «О программе» button (never a feed root):
 * `https://<server host>/download/` when an https server is set, else the build-time feed. null → none.
 */
export function downloadPage(serverUrl: string, buildFeed: string | null): string | null {
  const s = serverUrl.trim();
  if (s) {
    try {
      const u = new URL(s);
      if (u.protocol === 'https:') return `${u.origin}/download/`;
    } catch {
      // fall through to the build feed
    }
  }
  return buildFeed;
}
