/**
 * Navigation guard for mail bodies (ADR-0088 §10). A message is shown in an `<iframe sandbox srcdoc>`
 * without scripts; a click on a link navigates that frame. Here main decides, on top of the general
 * guards in windows.ts (which already cancel every foreign sub-frame navigation):
 * - a navigation the mail frame starts itself: `http(s)` → the system browser (cancelled here),
 *   `mailto:` → the deep link `calab://mail/compose?…` (shared/mail.ts `mailComposeLink`) sent to
 *   the window's renderer on the deep-link channel, anything else → blocked;
 * - frames whose src the page set (not from inside a mail body) → only blocked, never opened;
 * - the app window navigating to `calaba-mail://attachment/…` → cancelled and downloaded (§7).
 * `about:srcdoc` / `about:blank` (the reader iframe and its hidden measuring copy) always pass.
 */
import { app, session, shell, type WebContents, type WebFrameMain } from 'electron';
import { IPC } from '../../shared/ipc';
import { mailComposeLink } from '../../shared/mail';
import { installMailDownloads, parseAttachmentUrl } from './attachmentProtocol';

export type FrameDecision = { action: 'ignore' } | { action: 'block' } | { action: 'external'; url: string } | { action: 'compose'; link: string };

const ADDRESS_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;

/** `mailto:` (RFC 6068) → the compose deep link; null when malformed. Only plain addresses are kept. */
export function parseMailto(url: string): string | null {
  if (!/^mailto:/i.test(url) || url.length > 8192) return null;
  const body = url.slice(7);
  const q = body.indexOf('?');
  const path = q < 0 ? body : body.slice(0, q);
  // RFC 6068: '+' is literal (a+tag@x.org), not a space as in forms.
  const params = new URLSearchParams(q < 0 ? '' : body.slice(q + 1).replace(/\+/g, '%2B'));
  const list = (v: string): string[] => {
    let s: string;
    try {
      s = decodeURIComponent(v);
    } catch {
      return [];
    }
    return s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => ADDRESS_RE.test(x))
      .slice(0, 50);
  };
  const get = (k: string): string => {
    for (const [key, v] of params) if (key.toLowerCase() === k) return v;
    return '';
  };
  // Bcc from a link is dropped: a hidden recipient planted by the sender of the message.
  return mailComposeLink({
    to: [...list(path), ...list(get('to'))],
    cc: list(get('cc')),
    subject: get('subject').replace(/[\r\n]+/g, ' ').slice(0, 1000),
    body: get('body').slice(0, 10_000),
  });
}

export interface FrameNav {
  url: string;
  isMainFrame: boolean;
  /** The navigating frame's current URL (`about:srcdoc` for a mail body). */
  frameUrl: string;
  /** The navigation was started by the navigating frame itself (a link click inside it). */
  selfInitiated: boolean;
}

export function decideFrameNavigation(n: FrameNav): FrameDecision {
  if (n.isMainFrame) return { action: 'ignore' };
  if (n.url === 'about:srcdoc' || n.url === 'about:blank') return { action: 'ignore' };
  // Only a link inside a mail body (an about:srcdoc document) may leave the app.
  if (!n.selfInitiated || n.frameUrl !== 'about:srcdoc') return { action: 'block' };
  if (/^https?:\/\//i.test(n.url)) return { action: 'external', url: n.url };
  if (/^mailto:/i.test(n.url)) {
    const link = parseMailto(n.url);
    return link ? { action: 'compose', link } : { action: 'block' };
  }
  return { action: 'block' };
}

const sameFrame = (a: WebFrameMain | null | undefined, b: WebFrameMain | null | undefined): boolean =>
  !!a && !!b && a.processId === b.processId && a.routingId === b.routingId;

/** One external open per window per 2 s: a body cannot spray browser tabs (e.g. a refresh loop). */
const EXTERNAL_GAP_MS = 2000;

function guard(wc: WebContents): void {
  let lastExternal = 0;
  wc.on('will-frame-navigate', (e) => {
    let frameUrl: string;
    try {
      frameUrl = e.frame?.url ?? '';
    } catch {
      frameUrl = '';
    }
    const d = decideFrameNavigation({ url: e.url, isMainFrame: e.isMainFrame, frameUrl, selfInitiated: sameFrame(e.initiator, e.frame) });
    if (d.action === 'ignore') return;
    e.preventDefault();
    if (d.action === 'external') {
      const now = Date.now();
      if (now - lastExternal < EXTERNAL_GAP_MS) return;
      lastExternal = now;
      void shell.openExternal(d.url);
    } else if (d.action === 'compose') {
      // Straight to this window: handleDeepLink() would park the link as «pending» because the
      // window counts as loading while the frame's navigation is being cancelled — and lose it.
      wc.send(IPC.appDeepLink, d.link);
    }
  });
  // The window navigating to an attachment URL = «save this attachment» (shared/mail.ts attachmentUrl).
  wc.on('will-navigate', (e) => {
    if (!parseAttachmentUrl(e.url)) return;
    e.preventDefault();
    if (e.initiator && e.frame && !sameFrame(e.initiator, e.frame)) return;
    installMailDownloads(wc.session);
    // `download=1`: the handler names the file (an image would otherwise be saved as its id).
    wc.downloadURL(`${e.url.split(/[?#]/)[0] ?? e.url}?download=1`);
  });
}

/**
 * Installs the guard on every app window of the default session (our renderer), next to
 * installWebContentsGuards; web apps and the checkout window live in other sessions.
 */
export function installMailGuards(): void {
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'window' || wc.session !== session.defaultSession) return;
    guard(wc);
  });
}
