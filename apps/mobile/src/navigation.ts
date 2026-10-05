/**
 * What the phone host lets the WebView load (ADR-0067). Only the exact web origin may become app
 * content; third-party iframes (workspace web apps, embeds) keep loading inside their frame, as in a
 * browser, and get no native authority (the host has no bridge). A request is let into a frame only
 * when the event proves it is an iframe of the app; without frame identity it is judged as the top
 * frame. Links out go to the system browser / mail app; script, data, file and custom-scheme URLs go
 * nowhere.
 *
 * blob: stays blocked here. On iOS the app's own `<a download>` of a blob: never reaches this policy:
 * the react-native-webview patch makes it a native download first, only for the app's main frame
 * (ADR-0068). Any blob: request that does arrive here is not that case.
 *
 * Origins are compared as parsed `URL.origin` values, never as string prefixes:
 * `https://app.example.com.evil.test` and `https://app.example.com@evil.test` are other origins.
 */

/** `load` in the WebView, hand to the OS (`external`), or drop (`block`). */
export type Decision = 'load' | 'external' | 'block';

/** Handed to the OS: the system browser (http/https) or the mail app (mailto, the plan contact). */
const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
/** Empty documents a page may put in an iframe (`<iframe srcdoc>`, a frame not navigated yet). */
const BLANK_FRAMES = new Set(['about:blank', 'about:srcdoc']);

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The URL is a document of the app itself: https, exactly `origin`, no credentials. */
export function isAppUrl(raw: string, origin: string): boolean {
  const url = parse(raw);
  return url !== null && url.protocol === 'https:' && url.origin === origin && !url.username && !url.password;
}

/** May leave the app for the OS. `mailto:` needs an address, credentials in a web link are refused. */
function isExternal(url: URL): boolean {
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false;
  if (url.protocol === 'mailto:') return /^[^\s/@%]+@[^\s/@%]+$/.test(url.pathname);
  return !url.username && !url.password;
}

/** What `onShouldStartLoadWithRequest` reports about the frame. */
export interface NavigationRequest {
  url: string;
  /** iOS only: `request.URL == request.mainDocumentURL` (react-native-webview 13.16.1), not WKFrameInfo. */
  isTopFrame?: boolean | undefined;
  /** iOS only: the URL of the top document. */
  mainDocumentURL?: string | undefined;
}

/**
 * The request is proven to be an iframe of the app document: iOS reports it as not the top frame
 * and names the app as the top document. Android reports neither (the library drops
 * `WebResourceRequest.isForMainFrame()`), so on Android this is never true.
 */
export function isAppSubframe(req: NavigationRequest, origin: string): boolean {
  return req.isTopFrame === false && req.mainDocumentURL !== undefined && isAppUrl(req.mainDocumentURL, origin);
}

/**
 * A navigation the WebView is about to start (`onShouldStartLoadWithRequest`). Fails closed: a
 * request that is not a proven app iframe — every Android request, an iOS top frame — is judged as
 * the top frame and may only leave for the OS, never load another origin in the WebView.
 * This is a JS decision, not a native guard: on Android the library allows the load if JS does not
 * answer within 250 ms, and the engine does not ask for POST navigations (ADR-0067).
 */
export function decideNavigation(req: NavigationRequest, origin: string): Decision {
  if (isAppUrl(req.url, origin)) return 'load';
  const url = parse(req.url);
  if (url === null) return 'block';
  if (!isAppSubframe(req, origin)) return isExternal(url) ? 'external' : 'block';
  if (BLANK_FRAMES.has(url.href)) return 'load';
  return url.protocol === 'https:' && !url.username && !url.password ? 'load' : 'block';
}

/**
 * A new window (`target="_blank"`, `window.open`). The library checks no user gesture (Android
 * ignores `isUserGesture`); only the engine's popup blocker gates it, as
 * `javaScriptCanOpenWindowsAutomatically` stays off. Links out go to the OS. The app's own URLs
 * are dropped for now: the system browser has no session for them and loading one over the app
 * would discard its state (file opening/downloads are a later shared platform operation).
 */
export function decideNewWindow(raw: string, origin: string): Decision {
  if (isAppUrl(raw, origin)) return 'block';
  const url = parse(raw);
  return url !== null && isExternal(url) ? 'external' : 'block';
}
