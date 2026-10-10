import { BillingState, Plan, type Workspace } from '@calaba/protocol';
import type { CheckoutWindowOutcome } from '../../shared/ipc';
import { restAdminApi, restOwnerApi, type AdminBillingApi, type BillingAdapters, type OwnerBillingApi } from '../lib/billing/api';
import { billingErrorText, billingNotFound, billingUnavailable } from '../lib/billing/errors';
import { forSale } from '../lib/billing/plans';
import type { FixPlace } from '../lib/billing/violations';
import { openSection } from '../features/shell/sectionNav';
import { openTab } from './phoneNav';
import { log } from '../lib/log';
import { queryClient } from '../lib/queryClient';
import { platform } from '../platform';
import { useBilling } from '../stores/billing';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { planOffersAllowed } from './plan';

/**
 * Balance billing in the client (ADR-0080 v5 §13): loading the owner's summary into stores/billing,
 * reacting to BILLING_UPDATE / Workspace.billing, opening the hosted checkout. The REST adapter is
 * the default; a build with VITE_BILLING_MOCK=1 (dev / QA screenshots) swaps in the in-memory mock —
 * the import is dead code in production builds, so the mock never ships.
 */

const MOCK = import.meta.env.VITE_BILLING_MOCK === '1';
const REST: BillingAdapters = { owner: restOwnerApi, admin: restAdminApi };
let mock: Promise<BillingAdapters> | null = null;

function adapters(): Promise<BillingAdapters> {
  if (!MOCK) return Promise.resolve(REST);
  mock ??= import('../lib/billing/mock').then((m) => m.createMockAdapters());
  return mock;
}

/** True in a mock build: the cabinet loads for any workspace (no Workspace.billing from the mock API). */
export const billingMock = (): boolean => MOCK;

/** Lazily resolved adapter methods (the same shape as the REST one). */
function proxy<T extends object>(pick: (a: BillingAdapters) => T): T {
  return new Proxy({} as T, {
    get:
      (_t, key) =>
      async (...args: unknown[]) => {
        const api = pick(await adapters()) as Record<string | symbol, (...a: unknown[]) => unknown>;
        const fn = api[key];
        if (typeof fn !== 'function') throw new Error(`billing api: no ${String(key)}`);
        return fn(...args);
      },
  });
}

export const ownerBilling: OwnerBillingApi = MOCK ? proxy((a) => a.owner) : restOwnerApi;
export const adminBilling: AdminBillingApi = MOCK ? proxy((a) => a.admin) : restAdminApi;

/** react-query keys of the cabinet's lists (invalidated by BILLING_UPDATE). */
export const billingKeys = {
  all: (ws: string) => ['billing', ws] as const,
  ledger: (ws: string) => ['billing', ws, 'ledger'] as const,
  payments: (ws: string) => ['billing', ws, 'payments'] as const,
  refundRequests: (ws: string) => ['billing', ws, 'refund-requests'] as const,
  methods: (ws: string) => ['billing', ws, 'methods'] as const,
  payer: (ws: string) => ['billing', ws, 'payer'] as const,
};

const inflight = new Map<string, Promise<void>>();

/** Loads (or reloads) the summary of a workspace into the store; concurrent calls share one GET. */
export function loadBilling(ws: string): Promise<void> {
  const running = inflight.get(ws);
  if (running) return running;
  const st = useBilling.getState();
  st.begin(ws);
  const p = ownerBilling
    .get(ws)
    .then((data) => useBilling.getState().loaded(ws, data))
    .catch((e: unknown) => {
      if (billingUnavailable(e)) useBilling.getState().failed(ws, 'unavailable', null);
      else if (billingNotFound(e)) useBilling.getState().failed(ws, 'none', null);
      else {
        log.warn('[billing] load failed', e);
        useBilling.getState().failed(ws, 'error', billingErrorText(e));
      }
    })
    .finally(() => inflight.delete(ws));
  inflight.set(ws, p);
  return p;
}

/** After a mutation / payment: the summary and every list of the cabinet. */
export function reloadBilling(ws: string): void {
  void loadBilling(ws);
  void queryClient.invalidateQueries({ queryKey: billingKeys.all(ws) });
}

/** DispatchEvent.billing_update (owner only): reload what is shown when the revision is newer. */
export function onBillingUpdate(ws: string, revision: bigint): void {
  const load = useBilling.getState().byWs[ws]?.load;
  if (!load || load === 'unavailable') return; // nothing on screen / billing off: the next tab open asks again
  if (useBilling.getState().update(ws, revision)) reloadBilling(ws);
}

/**
 * WORKSPACE_UPDATE carried Workspace.billing (every member): a changed state / deadline also changes
 * the owner's summary — BILLING_UPDATE may not reach a suspended owner (docs/plans/billing-v1-tasks).
 */
export function onWorkspaceBilling(ws: Workspace): void {
  const e = useBilling.getState().byWs[ws.id];
  if (!e?.data) return;
  const shown = e.data.status;
  const next = ws.billing;
  const changed = (shown?.state ?? BillingState.UNSPECIFIED) !== (next?.state ?? BillingState.UNSPECIFIED) || shown?.suspendAt?.seconds !== next?.suspendAt?.seconds;
  if (changed) reloadBilling(ws.id);
}

/** After READY: reload the summaries on screen, forget workspaces I am no longer in. */
export function resyncBilling(workspaceIds: ReadonlySet<string>): void {
  for (const [ws, entry] of Object.entries(useBilling.getState().byWs)) {
    // 501 / 404 answers are not re-asked on reconnect: the next tab open does.
    if (workspaceIds.has(ws)) {
      if (entry.load !== 'unavailable' && entry.load !== 'none') reloadBilling(ws);
    } else useBilling.getState().drop(ws);
  }
}

/** Payment UI is offered here: everywhere but the iOS shell (App Store rules; services/plan planOffersAllowed). */
export const billingPaymentsAllowed = (): boolean => planOffersAllowed();

/** Opens «Тариф и оплата» of a workspace (links; the plan step after creating a workspace). */
export function openPlans(workspaceId: string): void {
  useUi.getState().openDialog({ kind: 'billing-plans', workspaceId });
}

/**
 * The plan badge (owner, 10.10): workspace settings → «Тариф» — the plan, its limits against the
 * usage and the cabinet; the plans comparison opens from «Сменить тариф» there.
 */
export function openPlanSettings(workspaceId: string): void {
  useUi.getState().openDialog({ kind: 'workspace-settings', workspaceId, tab: 'plan' });
}

/**
 * Where a plan violation is fixed (ADR-0086, lib/billing/violations): a workspace settings tab, or
 * the boards section of the workspace (the open dialogs close first).
 */
export function openFixPlace(workspaceId: string, place: Exclude<FixPlace, null>): void {
  const ui = useUi.getState();
  if (place.kind === 'settings') {
    ui.openDialog({ kind: 'workspace-settings', workspaceId, tab: place.tab });
    return;
  }
  ui.openDialog(null);
  if (ui.activeWorkspaceId !== workspaceId) ui.setWorkspace(workspaceId);
  if (ui.phone.on) openTab('boards');
  else openSection('boards');
}

/**
 * Right after the owner created a workspace: the plan choice, when this workspace can be paid for
 * here (an account or self-serve, a paid plan for sale). Never blocks the creation — the workspace
 * is already open; a 501 / 404 / error, or another dialog opened meanwhile, shows nothing.
 */
export async function offerPlansAfterCreate(workspaceId: string): Promise<void> {
  // A new workspace has no account: only a self-serve server (READY.billing_self_serve) has a plan
  // to offer — with billing off no request at all.
  if (!billingPaymentsAllowed() || !(useSession.getState().billingSelfServe || MOCK)) return;
  await loadBilling(workspaceId);
  const data = useBilling.getState().byWs[workspaceId]?.data;
  if (!data || !(data.selfServe || data.summary)) return;
  if (!forSale(data.offers, Plan.TEAM) && !forSale(data.offers, Plan.ENTERPRISE)) return;
  if (useUi.getState().dialog !== null) return;
  useUi.getState().openDialog({ kind: 'billing-plans', workspaceId, welcome: true });
}

const checkoutReturnListeners = new Set<(outcome: CheckoutWindowOutcome) => void>();

/**
 * The person is back from the checkout window (ADR-0084): the open checkout dialog polls at once
 * (useCheckoutPoll) instead of waiting for its timer. The outcome is only a hint — the poll is
 * the truth, and the dialog's own guards keep the activation to one.
 */
export function onCheckoutReturn(cb: (outcome: CheckoutWindowOutcome) => void): () => void {
  checkoutReturnListeners.add(cb);
  return () => checkoutReturnListeners.delete(cb);
}

/**
 * Opens the provider's hosted checkout (ADR-0084): the in-app checkout window on the desktop, a
 * new tab on the web (a popup blocker may stop it after the async POST — the dialog keeps a
 * «Открыть страницу оплаты» button, a direct click, for that case). Only https links are opened;
 * a URL main does not take for the window (a provider host off its allowlist) goes to the system
 * browser as before.
 */
export function openCheckout(url: string): void {
  const u = url.trim();
  if (!/^https:\/\//i.test(u)) {
    log.warn('[billing] refused a non-https checkout url');
    return;
  }
  platform.app.openCheckout(u).then(
    (outcome) => {
      if (outcome === 'external') return;
      for (const cb of [...checkoutReturnListeners]) cb(outcome);
    },
    (e: unknown) => {
      log.warn('[billing] checkout window refused, opening the browser', e);
      void platform.app.openExternal(u);
    },
  );
}

/** Receipts (BillingPayment.receipt_url) open in the browser (to print or save). */
export function openReceipt(url: string): void {
  if (!/^https:\/\//i.test(url.trim())) {
    log.warn('[billing] refused a non-https receipt url');
    return;
  }
  void platform.app.openExternal(url.trim());
}
