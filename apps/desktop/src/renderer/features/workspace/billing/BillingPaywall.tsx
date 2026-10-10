import { BillingState, WorkspaceRole } from '@calaba/protocol';
import { CirclePause, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Spinner, cx } from '../../../components/ui';
import { t } from '../../../i18n';
import { billingStateOf, tsMs } from '../../../lib/billing/model';
import { minorOf } from '../../../lib/billing/money';
import { billingMock, billingPaymentsAllowed, loadBilling } from '../../../services/billing';
import { useBilling } from '../../../stores/billing';
import { HOME } from '../../../stores/dms';
import { useUi } from '../../../stores/ui';
import { useWorkspaces } from '../../../stores/workspaces';
import { TopupDialog } from './TopupDialog';
import { Countdown, MoneyText } from './parts';

/**
 * Billing in the app shell (ADR-0080 §8, §13): the owner's debt bar with the deadline countdown,
 * and the suspension — the owner gets what to pay and the buttons, members «Пространство
 * приостановлено. Обратитесь к владельцу». State comes from Workspace.billing (every member, no
 * amounts); the owner's amounts from GET …/billing. Selectors are primitives (no re-render on a
 * presence / voice change); the countdown is its own leaf.
 */

/** Workspace.billing state of a workspace; in a mock build the mocked summary's state stands in. */
export function useBillingState(workspaceId: string | null | undefined): BillingState {
  const ws = useWorkspaces((s) => (workspaceId && workspaceId !== HOME ? billingStateOf(s.byId[workspaceId]?.ws.billing) : BillingState.UNSPECIFIED));
  const mocked = useBilling((s) => (billingMock() && workspaceId ? (s.byWs[workspaceId]?.data?.status?.state ?? BillingState.UNSPECIFIED) : BillingState.UNSPECIFIED));
  return ws !== BillingState.UNSPECIFIED ? ws : mocked;
}

/** The open workspace is closed for unpaid billing (the desktop shell shows BillingPaywall instead). */
export function useBillingSuspended(workspaceId: string | null | undefined): boolean {
  return useBillingState(workspaceId) === BillingState.SUSPENDED;
}

function openCabinet(workspaceId: string): void {
  useUi.getState().openDialog({ kind: 'workspace-settings', workspaceId, tab: 'plan' });
}

/** The owner's summary for the bar / paywall (loads once per workspace while shown). */
function useOwnerSummary(workspaceId: string, want: boolean) {
  useEffect(() => {
    if (want) void loadBilling(workspaceId);
  }, [want, workspaceId]);
  return useBilling((s) => (want ? s.byWs[workspaceId]?.data?.summary : undefined));
}

/** A bar under the title bar: the owner's debt with the deadline; the suspension for everyone. */
export function BillingBanner(): ReactNode {
  const wsId = useUi((s) => s.activeWorkspaceId);
  const id = wsId && wsId !== HOME ? wsId : null;
  const owner = useWorkspaces((s) => (id ? s.byId[id]?.role === WorkspaceRole.OWNER : false));
  // Mock builds: no Workspace.billing from the mock API — load the mocked summary to have a state.
  useEffect(() => {
    if (id && billingMock()) void loadBilling(id);
  }, [id]);
  const state = useBillingState(id);
  const suspendAt = useWorkspaces((s) => (id ? tsMs(s.byId[id]?.ws.billing?.suspendAt) : null));
  const arrears = state === BillingState.IN_ARREARS;
  const suspended = state === BillingState.SUSPENDED;
  const summary = useOwnerSummary(id ?? '', !!id && owner && (arrears || suspended));
  if (!id || (!arrears && !suspended) || (arrears && !owner)) return null;
  const deadline = suspendAt ?? tsMs(summary?.suspendAt);
  return (
    <section
      role="status"
      aria-label={suspended ? t('billing.paywall.title') : t('billing.banner.arrears')}
      data-testid="billing-banner"
      // Solid warning / danger surfaces (tokens), not a yellow tint over the dark window.
      className={cx('z-[var(--z-sticky)] flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3 py-1.5 mobile:py-2', suspended ? 'bg-danger-surface' : 'bg-warn-surface')}
    >
      {suspended ? <CirclePause className="size-4 shrink-0 text-danger" aria-hidden /> : <TriangleAlert className="size-4 shrink-0 text-warn" aria-hidden />}
      {/* Suspended: the stub under the bar is the message — the bar only names the state. */}
      <p className="min-w-0 flex-1 text-caption text-fg">
        {suspended ? (
          <span className="font-semibold">{t('billing.state.suspended')}</span>
        ) : (
          <>
            <span className="font-semibold">{t('billing.banner.arrears')}</span>
            {' · '}
            {summary?.debt ? <MoneyText m={summary.debt} danger className="font-semibold" /> : null}
            {summary?.debt && deadline ? ' · ' : null}
            {deadline ? (
              <>
                {t('billing.banner.closesIn')} <Countdown at={deadline} className="font-semibold" />
              </>
            ) : null}
          </>
        )}
      </p>
      {owner ? (
        <Button size="sm" onClick={() => openCabinet(id)} data-testid="billing-banner-pay">
          {t('billing.banner.pay')}
        </Button>
      ) : null}
    </section>
  );
}

/**
 * The desktop shell's content while the workspace is closed for unpaid billing (instead of the
 * rooms and the chat, which the server refuses anyway): the owner — the debt, «Пополнить» and the
 * cabinet; members — a short note.
 */
export function BillingPaywall({ workspaceId }: { workspaceId: string }): ReactNode {
  const owner = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.OWNER);
  const name = useWorkspaces((s) => s.byId[workspaceId]?.ws.name ?? '');
  const summary = useOwnerSummary(workspaceId, owner);
  const loading = useBilling((s) => owner && !s.byWs[workspaceId]?.data && s.byWs[workspaceId]?.load === 'loading');
  const [topup, setTopup] = useState(false);
  const payments = billingPaymentsAllowed();
  const debt = minorOf(summary?.debt);
  return (
    <div
      className="mat-content grid min-w-0 flex-1 place-items-center overflow-y-auto rounded-tl-[var(--radius-panel)] border-l border-t border-[var(--color-panel-edge)] px-6 py-10 mobile:rounded-none mobile:border-0 mobile:px-4"
      data-testid="billing-paywall"
    >
      <div className="flex w-full max-w-[420px] flex-col items-center gap-4 text-center">
        <CirclePause className="size-10 text-danger" strokeWidth={1.5} aria-hidden />
        <div className="flex flex-col gap-1.5">
          <h2 className="text-title font-semibold">{t('billing.paywall.title')}</h2>
          {name ? <p className="text-body text-muted">{name}</p> : null}
        </div>
        {owner ? (
          <>
            <p className="text-body text-muted">{t('billing.paywall.owner')}</p>
            {loading ? <Spinner /> : null}
            {debt > 0n && summary ? (
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-caption text-muted">{t('billing.paywall.debt')}</span>
                <MoneyText m={summary.debt} danger className="text-[26px] font-semibold leading-tight" />
              </div>
            ) : null}
            <div className="flex flex-wrap justify-center gap-2">
              {payments && summary ? (
                <Button size="lg" onClick={() => setTopup(true)} data-testid="billing-paywall-topup">
                  {t('billing.topup.open')}
                </Button>
              ) : null}
              <Button size="lg" variant="secondary" onClick={() => openCabinet(workspaceId)} data-testid="billing-paywall-cabinet">
                {t('billing.paywall.cabinet')}
              </Button>
            </div>
            <p className="text-caption text-faint">{t('billing.paywall.after')}</p>
          </>
        ) : (
          <p className="text-body text-muted" data-testid="billing-paywall-member">
            {t('billing.paywall.member')}
          </p>
        )}
      </div>
      {topup && summary ? <TopupDialog workspaceId={workspaceId} summary={summary} initialAmount={debt > 0n ? debt : undefined} onClose={() => setTopup(false)} /> : null}
    </div>
  );
}
