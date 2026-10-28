// The web origin the phone host shows (ADR-0067): the web client's own origin, so its same-origin
// API and the HttpOnly SameSite refresh cookie (ADR-0015) work unchanged inside the WebView. It comes
// from env only (`EXPO_PUBLIC_CALAB_URL`): app.config.ts checks it at build time, App.tsx again at
// runtime. Plain CommonJS (types in config.d.ts), because Expo loads app.config.ts with plain Node,
// which cannot import a sibling .ts module.

class WebOriginError extends Error {}

/**
 * The canonical origin of `raw`, or throws WebOriginError. Accepted: `https://host[:port]` with an
 * optional trailing slash and nothing else — no credentials, path, query or fragment, already in
 * the form `URL.origin` prints (lowercase host, no default port). Anything the URL parser would
 * silently rewrite (backslashes, tabs, `:443`, mixed case) is rejected instead, so a typo fails the
 * build rather than pointing the app at a different host.
 * @param {string | undefined} raw
 * @returns {string}
 */
function parseWebOrigin(raw) {
  const value = raw?.trim() ?? '';
  if (!value) throw new WebOriginError('EXPO_PUBLIC_CALAB_URL is not set');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WebOriginError('EXPO_PUBLIC_CALAB_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new WebOriginError('EXPO_PUBLIC_CALAB_URL must use https');
  if (url.username || url.password) throw new WebOriginError('EXPO_PUBLIC_CALAB_URL must not contain credentials');
  if (value.replace(/\/$/, '') !== url.origin) {
    throw new WebOriginError(`EXPO_PUBLIC_CALAB_URL must be a bare origin such as ${url.origin}`);
  }
  return url.origin;
}

/** A DNS hostname as `URL.hostname` prints it: lowercase LDH labels, a letter in the last one (no IPs). */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?=[a-z0-9-]*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The hosts whose https links open the app (ADR-0142): universal links on iOS, verified app links
 * on Android, and the hosts the app accepts an incoming https link from. `raw` is the
 * space-separated `EXPO_PUBLIC_CALAB_LINK_HOSTS` (read by app.config.ts for the native config and
 * inlined into the bundle for App.tsx); absent or blank, it is the host of `origin` alone, or no
 * hosts at all without an origin. Every entry must be a bare lowercase hostname — no scheme, port,
 * path, wildcard or IP — otherwise this throws, so a typo fails the build.
 * @param {string | undefined} raw
 * @param {string | null} [origin]
 * @returns {string[]}
 */
function parseLinkHosts(raw, origin = null) {
  const names = (raw ?? '').split(/[ \t\n]+/).filter(Boolean);
  if (names.length === 0) return origin ? [new URL(origin).hostname] : [];
  for (const name of names) {
    if (!HOSTNAME.test(name)) throw new Error(`EXPO_PUBLIC_CALAB_LINK_HOSTS: ${JSON.stringify(name)} is not a lowercase hostname`);
  }
  return [...new Set(names)];
}

/** Local defaults; store uploads must supply an identity checked against distribution history. */
function parseReleaseIdentity(version = '0.1.0', buildNumber = '1') {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) || version.trim() !== version) {
    throw new Error('CALAB_APP_VERSION must be three non-negative integers (for example 1.2.3)');
  }
  if (!/^[1-9][0-9]{0,3}$/.test(buildNumber) || buildNumber.trim() !== buildNumber) {
    throw new Error('CALAB_IOS_BUILD_NUMBER must be an integer from 1 to 9999');
  }
  return { version, buildNumber };
}

module.exports = { WebOriginError, parseWebOrigin, parseLinkHosts, parseReleaseIdentity };
