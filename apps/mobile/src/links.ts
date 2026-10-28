import { hostLinkRoute } from '../../desktop/src/shared/hostActivity';

/**
 * Incoming links (ADR-0142): what the OS hands the app through `Linking` — a universal link / app
 * link of a web host, or the product scheme — mapped to the web client's own URL for the same
 * route, `${origin}/<kind>/<code>`. Only a task, a workspace invite and a room link are accepted;
 * everything else (other paths, hosts, ports, credentials, encodings) is null and the app ignores it.
 *
 * Parsed with one strict pattern, not `URL`: React Native's URL is a regex approximation that
 * disagrees with WHATWG parsing (hosts with `@`, ports, backslashes), so the same input must give
 * the same answer in Hermes and in Node tests. Query and fragment are dropped, as `takeDeepLink`
 * reads only `location.pathname`.
 */

/** `scheme://authority/path` with an optional `?query` / `#fragment`, nothing before or around. */
const LINK = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:[?#].*)?$/s;
/** `calab://`, and `calaba://` from before the rename — as on the desktop (main/deeplink.ts). */
const SCHEMES = new Set(['calab', 'calaba']);

export function appUrlForLink(raw: string, origin: string, hosts: readonly string[]): string | null {
  const m = LINK.exec(raw);
  if (!m?.[1]) return null;
  const scheme = m[1].toLowerCase();
  const authority = m[2] ?? '';
  const path = m[3] ?? '';
  // calab://t/INV-820: the route kind is the authority of a custom-scheme URL.
  const route = SCHEMES.has(scheme) ? hostLinkRoute(`/${authority}${path}`)
    : scheme === 'https' && hosts.includes(authority.toLowerCase()) ? hostLinkRoute(path)
      : null;
  return route ? `${origin}${route}` : null;
}
