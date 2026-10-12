/**
 * Update feed rules (security review M3, review pass 3 B1), pure for tests.
 *
 * Trust model:
 * - Two PINNED sources, both baked into the bundle at build time and never changeable by the
 *   server, the renderer or a runtime env; only these may download and install automatically:
 *   - «GitHub» (default, `updateChannel: 'github'`): electron-updater's `github` provider for the
 *     repo MAIN_VITE_UPDATE_GITHUB (`itrcz/calab`, public, no token). It sees published releases
 *     only — the draft release.yml creates is invisible until the lead publishes it.
 *   - «Сервер Calab» (`'s3'`): the generic feed MAIN_VITE_UPDATE_FEED (`https://releases.calab.io/`,
 *     the S3 bucket behind Caddy; https only).
 *   Both serve the same signed artifacts from the same build; electron-updater checks the sha512
 *   from latest*.yml (and the publisher on a signed Windows build), Squirrel.Mac the signature.
 *   The user picks the channel (Settings → «Основное» → «Обновления»); one that is not baked in
 *   falls back to the other (pinnedSource). Neither baked (dev / self-built) → no auto-install.
 * - The feed derived from the server the app is connected to is notify-only: it can at most show
 *   «Доступна версия X — Скачать», which opens a download page in the browser.
 *   `https://app.X[:port]` → `https://releases.X[:port]/` (the releases.<domain> vhost, see
 *   infra/docker Caddyfile); any other host → `https://<host>/download/`.
 * - CALABA_UPDATE_URL (runtime) is a notify-only override (testing another feed); it never enables
 *   auto-install.
 * https only everywhere.
 */

/** «Источник обновлений» (AppSettings.updateChannel). */
export type UpdateChannel = 'github' | 's3';

export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['github', 's3'];
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'github';

/** A stored / sent value → a known channel (anything else → the default). */
export function parseUpdateChannel(v: unknown): UpdateChannel {
  return v === 'github' || v === 's3' ? v : DEFAULT_UPDATE_CHANNEL;
}

/** What electron-updater's setFeedURL gets. */
export type FeedSource = { provider: 'generic'; url: string } | { provider: 'github'; owner: string; repo: string };

/** Identity of a source (compares sources, logs). */
export function feedKey(s: FeedSource): string {
  return s.provider === 'github' ? `github:${s.owner}/${s.repo}` : s.url;
}

/** `owner/repo` (GitHub's allowed characters) → the github source, else null (empty, malformed). */
export function githubSource(raw: string): FeedSource | null {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(raw.trim());
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { provider: 'github', owner: m[1] ?? '', repo: m[2] ?? '' };
}

/**
 * The pinned source for the chosen channel: that channel when it is baked into the build, else the
 * other pinned one; null when neither is (dev / self-built → notify-only).
 */
export function pinnedSource(channel: UpdateChannel, buildFeed: string | null, github: FeedSource | null): FeedSource | null {
  const s3: FeedSource | null = buildFeed ? { provider: 'generic', url: buildFeed } : null;
  return channel === 's3' ? (s3 ?? github) : (github ?? s3);
}

/** Human page of a source's releases (the notification / «Скачать» fallback when there is no server). */
export function sourcePage(s: FeedSource): string {
  return s.provider === 'github' ? `https://github.com/${s.owner}/${s.repo}/releases/latest` : s.url;
}

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
 * `https://<server host>/download/` when an https server is set, else `fallback` (the pinned source's
 * page, sourcePage). null → none.
 */
export function downloadPage(serverUrl: string, fallback: string | null): string | null {
  const s = serverUrl.trim();
  if (s) {
    try {
      const u = new URL(s);
      if (u.protocol === 'https:') return `${u.origin}/download/`;
    } catch {
      // fall through to the build feed
    }
  }
  return fallback;
}
