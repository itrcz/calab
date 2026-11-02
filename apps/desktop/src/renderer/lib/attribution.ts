// First-touch ad attribution of the web client (ADR-0135). The landing appends utm_* / yclid
// and, only for a visitor who consented to analytics there, ym_cid (the Metrika ClientID) to
// its links to the app. The first open keeps them here and removes them from the address bar;
// the registration sends them once (RegisterRequest.attribution) and forgets them.
// No third party is contacted from the app: the server reports the conversion.
//
// ADR-0135 addendum (2026-11-02): the native phone shell (apps/mobile, ADR-0067) never captures,
// stores or sends this attribution, so the store privacy forms can answer "Tracking: No"
// (docs/mobile/store-listing.md) — a registration from the shell must never be able to produce
// a Metrika conversion, whatever link it was opened from.

import { inNativeShell } from '../platform/nativeShell';

const KEY = 'calab-attribution';
/** A stored campaign older than this is replaced by a newer one (and ignored at sign-up). */
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;
const MAX_LEN = 200;

const FIELDS = {
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_content: 'utmContent',
  utm_term: 'utmTerm',
  yclid: 'yclid',
  ym_cid: 'ymClientId',
} as const;

type Field = (typeof FIELDS)[keyof typeof FIELDS];
/** JSON of calaba.v1.SignupAttribution. */
export type SignupAttribution = Partial<Record<Field, string>>;

interface Stored {
  at: number;
  a: SignupAttribution;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(s: Storage, now: number): SignupAttribution | null {
  try {
    const raw = s.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored> | null;
    if (!v || typeof v.at !== 'number' || now - v.at > MAX_AGE_MS || !v.a || typeof v.a !== 'object') return null;
    return v.a;
  } catch {
    return null;
  }
}

/**
 * Takes the campaign params of `href` (the first open of the app): stores them unless a
 * fresh campaign is stored already (first touch wins) and returns the URL without them
 * (null: nothing to strip).
 */
export function captureAttribution(href: string, s: Storage | null = storage(), now = Date.now()): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const found: SignupAttribution = {};
  let seen = false;
  for (const [param, field] of Object.entries(FIELDS) as [keyof typeof FIELDS, Field][]) {
    if (!url.searchParams.has(param)) continue;
    seen = true;
    const v = (url.searchParams.get(param) ?? '').trim().slice(0, MAX_LEN);
    url.searchParams.delete(param);
    if (!v || (field === 'ymClientId' && !/^\d{1,32}$/.test(v))) continue;
    found[field] = v;
  }
  if (!seen) return null;
  if (s && Object.keys(found).length > 0 && !read(s, now)) {
    try {
      s.setItem(KEY, JSON.stringify({ at: now, a: found } satisfies Stored));
    } catch {
      /* Storage full or blocked: attribution is best effort. */
    }
  }
  return url.toString();
}

/**
 * The stored campaign to send with a registration, if any. Never returns one in the native
 * shell (ADR-0135 addendum), even leftover data a pre-fix client version captured there.
 */
export function storedAttribution(s: Storage | null = storage(), now = Date.now()): SignupAttribution | undefined {
  if (inNativeShell()) return undefined;
  return (s && read(s, now)) || undefined;
}

/** Forget the campaign (after a registration sent it). */
export function clearAttribution(s: Storage | null = storage()): void {
  try {
    s?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Capture from the current page and clean the address bar (web client start). */
export function captureFromLocation(): void {
  if (inNativeShell()) return; // ADR-0135 addendum: no attribution is ever captured there
  try {
    const clean = captureAttribution(window.location.href);
    if (clean && clean !== window.location.href) window.history.replaceState(window.history.state, '', clean);
  } catch {
    /* Never break the start of the app. */
  }
}
