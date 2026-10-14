import { CheckoutState, type CheckoutStatus } from '@calaba/protocol';
import type { MessageKey } from '../../i18n';

/**
 * The hosted checkout of a manual top-up (ADR-0080 §13): POST …/topups gives a checkout id and
 * the provider URL, the page opens in the system browser, the cabinet polls GET …/checkouts/{id}
 * (which also pulls the provider state) until the payment is on the balance or the checkout ends.
 * A pure reducer + the poll schedule; the timer lives in the component (paused while hidden).
 */

export type CheckoutOutcome = 'credited' | 'expired' | 'canceled' | 'failed';

export type CheckoutFlow =
  | { phase: 'idle' }
  | { phase: 'creating' }
  /** Waiting for the payer (open) or for the credit (paid = completed, not on the balance yet). */
  | { phase: 'waiting'; checkoutId: string; url: string; polls: number; startedAt: number; paid: boolean }
  | { phase: 'done'; checkoutId: string; outcome: CheckoutOutcome }
  /** Polling gave up (the person may check again); a late payment still arrives by BILLING_UPDATE. */
  | { phase: 'stalled'; checkoutId: string; url: string; paid: boolean }
  | { phase: 'error'; message: string };

export type CheckoutEvent =
  | { type: 'create' }
  | { type: 'created'; checkoutId: string; url: string; now: number }
  | { type: 'createFailed'; message: string }
  | { type: 'polled'; status: CheckoutStatus; now: number }
  | { type: 'pollFailed'; now: number }
  | { type: 'recheck'; now: number }
  | { type: 'reset' };

export const IDLE: CheckoutFlow = { phase: 'idle' };

/** Wall-clock ms for the flow's events (called from handlers and effects, never during render). */
export const nowMs = (): number => Date.now();

/** Stop polling after this long without an end state (the checkout itself expires in 24 h). */
export const POLL_GIVE_UP_MS = 30 * 60_000;

function stalledOrWaiting(s: Extract<CheckoutFlow, { phase: 'waiting' }>, now: number, paid: boolean): CheckoutFlow {
  if (now - s.startedAt >= POLL_GIVE_UP_MS) return { phase: 'stalled', checkoutId: s.checkoutId, url: s.url, paid };
  return { ...s, polls: s.polls + 1, paid };
}

export function checkoutReducer(s: CheckoutFlow, e: CheckoutEvent): CheckoutFlow {
  switch (e.type) {
    case 'reset':
      return IDLE;
    case 'create':
      return s.phase === 'creating' || s.phase === 'waiting' ? s : { phase: 'creating' };
    case 'created':
      return s.phase === 'creating' ? { phase: 'waiting', checkoutId: e.checkoutId, url: e.url, polls: 0, startedAt: e.now, paid: false } : s;
    case 'createFailed':
      return s.phase === 'creating' ? { phase: 'error', message: e.message } : s;
    case 'polled': {
      if (s.phase !== 'waiting' || e.status.checkoutId !== s.checkoutId) return s;
      const st = e.status.state;
      if (e.status.credited) return { phase: 'done', checkoutId: s.checkoutId, outcome: 'credited' };
      if (st === CheckoutState.EXPIRED) return { phase: 'done', checkoutId: s.checkoutId, outcome: 'expired' };
      if (st === CheckoutState.CANCELED) return { phase: 'done', checkoutId: s.checkoutId, outcome: 'canceled' };
      if (st === CheckoutState.FAILED) return { phase: 'done', checkoutId: s.checkoutId, outcome: 'failed' };
      return stalledOrWaiting(s, e.now, st === CheckoutState.COMPLETED);
    }
    case 'pollFailed':
      return s.phase === 'waiting' ? stalledOrWaiting(s, e.now, s.paid) : s;
    case 'recheck':
      return s.phase === 'stalled' ? { phase: 'waiting', checkoutId: s.checkoutId, url: s.url, polls: 0, startedAt: e.now, paid: s.paid } : s;
  }
}

/** Delay before the next poll: quick while the person is likely paying, then slower. */
export function pollDelay(s: CheckoutFlow): number | null {
  if (s.phase !== 'waiting') return null;
  if (s.polls < 15) return 2_000;
  if (s.polls < 40) return 5_000;
  return 15_000;
}

/** The poll keeps going (a timer is due). */
export const polling = (s: CheckoutFlow): boolean => s.phase === 'waiting';

/**
 * Where the payment page of the last opened checkout is (ADR-0084; services/billing tracks it):
 * - `window`: the in-app checkout window is open (desktop);
 * - `returned`: it closed on the provider's return page — the dialog is checking the payment;
 * - `closed`: the person closed it (or the page reported a failure) — not paid yet, open again;
 * - `browser`: a browser tab / the system browser (web, or main refused the window).
 */
export type CheckoutPlace = 'window' | 'returned' | 'closed' | 'browser';

export interface CheckoutWaitingView {
  text: MessageKey;
  /** The page button (null: none); `external` adds the «leaves the app» icon. */
  button: MessageKey | null;
  external: boolean;
  spinner: boolean;
}

/**
 * The wording of the waiting / stalled dialog (2026-10-10: the desktop said «Ждём оплату в
 * браузере…» over the in-app window, and its button closed the form): the window is open → «open
 * in a separate window» + «show the window» (main focuses it); back from the return page →
 * «checking»; closed by the person → «not finished» + «open again»; a browser → as before.
 * `hasUrl`: the flow has a page (a one-click charge without 3-D Secure has none).
 */
export function checkoutWaitingView(v: { phase: 'waiting' | 'stalled'; paid: boolean; saved: boolean; hasUrl: boolean; place: CheckoutPlace }): CheckoutWaitingView {
  const waiting = v.phase === 'waiting';
  if (v.paid) return { text: 'billing.checkout.crediting', button: null, external: false, spinner: waiting };
  if (v.saved && !v.hasUrl) return { text: 'billing.saved.processing', button: null, external: false, spinner: waiting };
  switch (v.place) {
    case 'window':
      return { text: !waiting ? 'billing.checkout.stalled' : v.saved ? 'billing.saved.waiting' : 'billing.checkout.window', button: 'billing.checkout.showWindow', external: false, spinner: waiting };
    case 'returned':
      return { text: waiting ? 'billing.checkout.checking' : 'billing.checkout.stalled', button: 'billing.checkout.reopen', external: false, spinner: waiting };
    case 'closed':
      return { text: 'billing.checkout.notFinished', button: 'billing.checkout.reopen', external: false, spinner: false };
    case 'browser':
      return {
        text: !waiting ? 'billing.checkout.stalled' : v.saved ? 'billing.saved.waiting' : 'billing.checkout.waiting',
        button: v.saved ? 'billing.saved.open' : 'billing.checkout.open',
        external: true,
        spinner: waiting,
      };
  }
}
