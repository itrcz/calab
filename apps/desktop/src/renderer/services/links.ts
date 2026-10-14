import { openRoomLink } from '../features/people/roomLink';
import { HOME } from '../stores/dms';
import { setPendingInvite } from '../stores/invite';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { parseMailLink } from '../features/mail/mailLink';

/**
 * Invite links: `https://<server>/join/<code>` (shareable: opens the web client, and the
 * desktop app accepts it pasted or via the join dialog), the `calab://join/<code>` deep
 * link (legacy `calaba://` too), or the bare code. → join dialog (after login if needed).
 *
 * Shared links are ALWAYS https (docs/09 #53): the web page `/join/<code>` / `/r/<code>` offers
 * «Открыть в Calab» itself; `calab://` stays an internal mechanism, never copied or shown.
 */
const CODE = '([A-Za-z0-9_-]{4,64})';
/** Deep-link schemes: `calab://`, and `calaba://` from before the rename (docs/10). */
const SCHEME = 'calaba?';

export function parseInviteCode(input: string): string | null {
  const s = input.trim();
  const m =
    new RegExp(`^${SCHEME}://join/${CODE}/?$`).exec(s) ??
    new RegExp(`^https?://[^/\\s]+/join/${CODE}/?(?:[?#].*)?$`).exec(s) ??
    new RegExp(`^${CODE}$`).exec(s);
  return m?.[1] ?? null;
}

const HTTP_ORIGIN = /^https?:\/\/[^/\s]+/;

/**
 * The base for shared links: the session's server, else the configured server (settings), else
 * — on the web — the page's own origin (same origin as the API, ADR-0015). null = nothing to
 * build an https link from (never falls back to a deep link).
 */
export function shareOrigin(serverUrl: string): string | null {
  const web = import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' ? location.origin : '';
  for (const c of [serverUrl, useSession.getState().settings?.serverUrl ?? '', web]) {
    const o = c.trim().replace(/\/+$/, '');
    if (HTTP_ORIGIN.test(o)) return o;
  }
  return null;
}

/** The shareable https link for an invite code on this server (null: no server known). */
export function inviteUrl(serverUrl: string, code: string): string | null {
  const origin = shareOrigin(serverUrl);
  return origin ? `${origin}/join/${code}` : null;
}

/** The made-up code in the join field's placeholder (a valid code shape, never a real invite). */
export const INVITE_EXAMPLE_CODE = 'AbC123xYz';

/**
 * Placeholder for the «join a workspace» field: a real-looking link on this server
 * (`https://<server>/join/AbC123xYz`; on the web the page's origin), else the bare example code.
 */
export function joinPlaceholder(serverUrl: string): string {
  return inviteUrl(serverUrl, INVITE_EXAMPLE_CODE) ?? INVITE_EXAMPLE_CODE;
}

/**
 * Room links (ADR-0016): `https://<server>/r/<code>` or the `calab://r/<code>` deep link. No bare
 * codes: a bare code is a workspace invite.
 */
export function parseRoomInviteCode(input: string): string | null {
  const s = input.trim();
  const m = new RegExp(`^${SCHEME}://r/${CODE}/?$`).exec(s) ?? new RegExp(`^https?://[^/\\s]+/r/${CODE}/?(?:[?#].*)?$`).exec(s);
  return m?.[1] ?? null;
}

/** The shareable https link for a room invite code on this server (null: no server known). */
export function roomInviteUrl(serverUrl: string, code: string): string | null {
  const origin = shareOrigin(serverUrl);
  return origin ? `${origin}/r/${code}` : null;
}

/**
 * DM links (ADR-0020): `calab://dm/<room id>` and `https://<server>/dm/<room id>` (web). Only
 * the participants can open one; for anyone else it is just an unknown room.
 */
export function parseDmLink(input: string): string | null {
  const s = input.trim();
  const ID = '([0-9a-fA-F-]{36})';
  const m = new RegExp(`^${SCHEME}://dm/${ID}/?$`).exec(s) ?? new RegExp(`^https?://[^/\\s]+/dm/${ID}/?(?:[?#].*)?$`).exec(s);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Opens «Личные» on that DM (it shows once READY has the DM; before sign-in it waits for it). */
function openDmLink(roomId: string): void {
  useUi.getState().openRoom(HOME, roomId);
  // Not a DM of this user (someone else's link): a clear error once READY is in (services/dms.ts).
  // Loaded lazily: links.ts stays free of the API / platform graph (link landing, tests).
  void import('./dms').then((m) => m.checkDmLink(roomId)).catch(() => undefined);
  // Web: the address bar had /dm/<id>; the app does not route by URL (a reload would come back here).
  if (import.meta.env.VITE_PLATFORM === 'web' && typeof location !== 'undefined' && location.pathname.startsWith('/dm/')) {
    try {
      history.replaceState(null, '', '/');
    } catch {
      // not fatal
    }
  }
}

/**
 * Meeting links (ADR-0038): `https://<server>/e/<id>` (the invitation mail) and `calab://e/<id>`.
 * The answer page of external attendees (`/e/<id>/rsvp?t=…`) is not this link.
 */
export function parseEventLink(input: string): string | null {
  const s = input.trim();
  const ID = '([0-9a-fA-F-]{36})';
  const m = new RegExp(`^${SCHEME}://e/${ID}/?$`).exec(s) ?? new RegExp(`^https?://[^/\\s]+/e/${ID}/?(?:[?#].*)?$`).exec(s);
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Board and task links (ADR-0042 §5): `https://<server>/b/<board id>`, `/t/<KEY-N>` and the
 * `calab://` forms.
 */
export function parseBoardLink(input: string): { kind: 'board' | 'task'; id: string } | null {
  const s = input.trim();
  const ID = '([0-9a-fA-F-]{36})';
  const KEY = '([A-Za-z][A-Za-z0-9]{1,5}-[0-9]{1,7})';
  const b = new RegExp(`^${SCHEME}://b/${ID}/?$`).exec(s) ?? new RegExp(`^https?://[^/\\s]+/b/${ID}/?(?:[?#].*)?$`).exec(s);
  if (b?.[1]) return { kind: 'board', id: b[1].toLowerCase() };
  const k = new RegExp(`^${SCHEME}://t/${KEY}/?$`).exec(s) ?? new RegExp(`^https?://[^/\\s]+/t/${KEY}/?(?:[?#].*)?$`).exec(s);
  if (k?.[1]) return { kind: 'task', id: k[1].toUpperCase() };
  return null;
}

/**
 * Message links (the «задача из сообщения» description, ADR-0042): `https://<server>/m/<room id>/
 * <message id>` and `calab://m/…` — the room opens scrolled to the message.
 */
export function parseMessageLink(input: string): { roomId: string; messageId: string } | null {
  const s = input.trim();
  const ID = '([0-9a-fA-F-]{36})';
  const m = new RegExp(`^${SCHEME}://m/${ID}/${ID}/?$`).exec(s) ?? new RegExp(`^https?://[^/\\s]+/m/${ID}/${ID}/?(?:[?#].*)?$`).exec(s);
  return m?.[1] && m[2] ? { roomId: m[1].toLowerCase(), messageId: m[2].toLowerCase() } : null;
}

/**
 * A link clicked in a message: our own /m/, /t/, /b/ links (this server) open in the app instead
 * of the browser. False = not ours (the caller opens it outside).
 */
export function openOwnLink(href: string): boolean {
  const origin = shareOrigin('');
  if (!origin || !href.startsWith(`${origin}/`)) return false;
  if (!parseMessageLink(href) && !parseBoardLink(href)) return false;
  handleDeepLink(href);
  return true;
}

export function handleDeepLink(url: string): void {
  // Mail links (ADR-0088 §12): `calab://mail/<payload>` carries a password — parsed here, never
  // logged; the section and its form are loaded lazily (desktop only, a no-op elsewhere).
  const mail = parseMailLink(url);
  if (mail) {
    void import('../features/mail/links').then((m) => m.openMailLink(mail)).catch(() => undefined);
    return;
  }
  const msg = parseMessageLink(url);
  if (msg) {
    void import('./messageLink').then((m) => m.openMessageLink(msg.roomId, msg.messageId)).catch(() => undefined);
    return;
  }
  const board = parseBoardLink(url);
  if (board) {
    // Loaded lazily, like the calendar: links.ts stays free of the API / platform graph.
    void import('./boards').then((m) => m.openBoardLink(board.kind, board.id)).catch(() => undefined);
    return;
  }
  const ev = parseEventLink(url);
  if (ev) {
    // Loaded lazily, like the DM check: links.ts stays free of the API / platform graph.
    void import('./calendar').then((m) => m.openEventLink(ev)).catch(() => undefined);
    return;
  }
  const dm = parseDmLink(url);
  if (dm) {
    openDmLink(dm);
    return;
  }
  const room = parseRoomInviteCode(url);
  if (room) {
    openRoomLink(room);
    return;
  }
  const code = parseInviteCode(url);
  if (!code) return;
  if (useSession.getState().status === 'authed') useUi.getState().openDialog({ kind: 'join-workspace', code });
  else setPendingInvite(code);
}

export { takePendingInvite } from '../stores/invite';
