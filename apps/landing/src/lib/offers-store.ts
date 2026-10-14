'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { parseOffers, pickView, type Market, type Offers, type View } from './offers';
import { hasSiteConsent } from './site-preferences';
import { APP_URL } from './site';

// One shared, lazily started fetch for every price on the page (cards, table, buttons, currency switch).
// The page is prerendered with the snapshot, so nothing waits for the network: the leaves re-render once,
// after hydration, only if the server's answer differs from the snapshot.

export const OFFERS_URL = `${APP_URL}/api/billing/public/offers`;
export const MARKET_COOKIE = 'calab_market';
const COOKIE_MAX_AGE = 180 * 24 * 60 * 60;

type State = { offers: Offers | null; choice: Market | null };
let state: State = { offers: null, choice: null };
let started = false;
const listeners = new Set<() => void>();

const emit = (next: State) => {
  state = next;
  listeners.forEach((l) => {
    l();
  });
};

/** The explicit currency choice lives in a first-party cookie, like the language: only with the «preferences» permission. */
export function readMarketCookie(): Market | null {
  try {
    if (!hasSiteConsent('language')) return null;
    const m = document.cookie.match(new RegExp(`(?:^|; )${MARKET_COOKIE}=(ru|global)(?:;|$)`));
    return m ? (m[1] as Market) : null;
  } catch {
    return null;
  }
}

function writeMarketCookie(m: Market) {
  try {
    if (!hasSiteConsent('language')) return;
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${MARKET_COOKIE}=${m}; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
  } catch {
    /* The choice still holds for this visit. */
  }
}

async function load() {
  try {
    const res = await fetch(OFFERS_URL, { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const offers = parseOffers(await res.json());
    if (offers) emit({ ...state, offers });
  } catch {
    /* Unreachable / blocked / bad body: the snapshot stays. */
  }
}

function start() {
  if (started) return;
  started = true;
  const choice = readMarketCookie();
  if (choice) emit({ ...state, choice });
  const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (idle) idle(() => void load());
  else setTimeout(() => void load(), 0);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getState = () => state;
const getServerState = (): State => SERVER_STATE;
const SERVER_STATE: State = { offers: null, choice: null };

/** The prices the page should show right now (snapshot until the server answers). */
export function useOffersView(lang: string): { view: View; choose: (m: Market) => void } {
  const s = useSyncExternalStore(subscribe, getState, getServerState);
  useEffect(start, []);
  const choose = useCallback((m: Market) => {
    writeMarketCookie(m);
    emit({ ...state, choice: m });
  }, []);
  return { view: pickView(s.offers, lang, s.choice), choose };
}
