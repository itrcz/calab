import { create } from 'zustand';
import { nativeShell } from '../platform/nativeShell';
import { handleDeepLink, parseBoardLink, parseInviteCode, parseRoomInviteCode } from './links';

/**
 * Web link page (docs/09 #53): `https://<server>/join/<code>` and `/r/<code>` first show a card —
 * «Открыть в Calab» / «Продолжить в браузере» / «Скачать приложение» — instead of jumping straight
 * into the web flow. `/t/<KEY-N>` (a task link copied by hand and sent through a messenger, CBF-40)
 * gets the same card, but only for a visitor without a web session (see `skipsLanding`). Web only: the desktop app handles `calab://` and pasted https links directly.
 *
 * Two cases skip the card and hand the link straight to `handleDeepLink` (DEV-4947): inside a
 * native phone shell (`nativeShell()`, ADR-0140) the shell already is the app — «Открыть в Calab»
 * offering to open the app it is running in is wrong; and a visitor who last pressed «Продолжить в
 * браузере» with «Запомнить выбор» checked (`rememberedChoice() === 'browser'`, expires after 30
 * days) gets the browser flow again without being asked.
 */
export interface LinkLanding {
  kind: 'join' | 'r' | 't';
  code: string;
  /** The link as the app flow takes it (`handleDeepLink`). */
  url: string;
}

interface LinkLandingState {
  link: LinkLanding | null;
}

export const useLinkLanding = create<LinkLandingState>()(() => ({ link: null }));

export function landingFor(url: string): LinkLanding | null {
  const room = parseRoomInviteCode(url);
  if (room) return { kind: 'r', code: room, url };
  const board = /\/t\/[^/]+\/?(?:[?#].*)?$/.test(url) ? parseBoardLink(url) : null;
  if (board?.kind === 'task') return { kind: 't', code: board.id, url };
  // Bare codes are not links: the landing is for /join/<code> URLs only.
  const code = /\/join\//.test(url) ? parseInviteCode(url) : null;
  return code ? { kind: 'join', code, url } : null;
}

/**
 * A task link opens the card straight away for someone already signed in on the web (the card is
 * for links coming from outside: messengers, mail). Join / room links always show it (docs/09 #53).
 */
export function skipsLanding(link: LinkLanding, signedIn: boolean): boolean {
  return link.kind === 't' && signedIn;
}

/**
 * Shows the card for a web link; false = not a link, or one of the two skip cases above (the
 * caller handles the url as before — `handleDeepLink`).
 */
export function showLinkLanding(url: string): boolean {
  if (nativeShell()) return false;
  const link = landingFor(url);
  if (!link) return false;
  if (rememberedChoice() === 'browser') return false;
  useLinkLanding.setState({ link });
  return true;
}

/** «Продолжить в браузере»: the regular web flow (login / guest screen / join dialog). */
export function continueInBrowser(): void {
  const link = useLinkLanding.getState().link;
  if (!link) return;
  useLinkLanding.setState({ link: null });
  // The address bar keeps /join/<code> while the card is shown (a reload shows it again).
  try {
    history.replaceState(null, '', '/');
  } catch {
    // not fatal
  }
  handleDeepLink(link.url);
}

/**
 * «Запомнить выбор» (DEV-4947) — a per-browser convenience, so localStorage. It sticks to
 * whichever primary action the visitor pressed with the box checked: «Открыть в Calab» → auto-try
 * the app again on the next link (as before); «Продолжить в браузере» → skip the card outright
 * (`showLinkLanding` above) until the choice expires. The two keys are mutually exclusive.
 */
const REMEMBER_APP_KEY = 'calab-open-links-in-app';
const REMEMBER_BROWSER_KEY = 'calab-open-links-in-browser';
const REMEMBER_BROWSER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type RememberedChoice = 'app' | 'browser' | null;

/** What a previous visit remembered, if anything still in effect (the browser choice expires). */
export function rememberedChoice(): RememberedChoice {
  try {
    if (localStorage.getItem(REMEMBER_APP_KEY) === '1') return 'app';
    const at = localStorage.getItem(REMEMBER_BROWSER_KEY);
    if (at === null) return null;
    if (Date.now() - Number(at) < REMEMBER_BROWSER_TTL_MS) return 'browser';
    localStorage.removeItem(REMEMBER_BROWSER_KEY); // expired: stop carrying it around
    return null;
  } catch {
    return null;
  }
}

/** Sets (or, with `null`, clears) the remembered choice. Setting one key clears the other. */
export function setRememberedChoice(choice: RememberedChoice): void {
  try {
    if (choice === 'app') {
      localStorage.setItem(REMEMBER_APP_KEY, '1');
      localStorage.removeItem(REMEMBER_BROWSER_KEY);
    } else if (choice === 'browser') {
      localStorage.setItem(REMEMBER_BROWSER_KEY, String(Date.now()));
      localStorage.removeItem(REMEMBER_APP_KEY);
    } else {
      localStorage.removeItem(REMEMBER_APP_KEY);
      localStorage.removeItem(REMEMBER_BROWSER_KEY);
    }
  } catch {
    // storage blocked: the option just does not stick
  }
}
