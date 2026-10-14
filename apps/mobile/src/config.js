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

module.exports = { WebOriginError, parseWebOrigin };
