import { BILLING_BITS, BillingState, type BillingSummary } from '@calaba/protocol';
import { CirclePause } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Spinner } from '../../../components/ui';
import { t } from '../../../i18n';
import { billingStateOf, currencyOf } from '../../../lib/billing/model';
import { billingMock, billingPaymentsAllowed, loadBilling } from '../../../services/billing';
import { useBilling } from '../../../stores/billing';
import { useWorkspaces } from '../../../stores/workspaces';
import { capsOf, useBillingBits } from './access';
import { AutoTopupCard } from './AutoTopupCard';
import { BalanceCard } from './BalanceCard';
import { HistoryCard } from './HistoryCard';
import { PayerCard } from './PayerCard';
import { QuoteDialog, type QuoteAction } from './QuoteDialog';
import { TopupDialog } from './TopupDialog';
import { Note } from './parts';

/**
 * Balance billing in workspace settings → «Тариф» (ADR-0080 v5 §13, ADR-0087). Money is seen by
 * BILLING_VIEW (the owner has all three bits): the cabinet — balance, plan, payer, history — with
 * the actions of the bits held: «Пополнить» for TOPUP, plan changes / auto-topup / saved cards /
 * payer / refund requests for MANAGE; none of them in the iOS shell (App Store rules). Members
 * without VIEW see a stub without amounts (the server sends no summary). 501 (billing off) and 404
 * (no billing account) render nothing and are not retried by events — the plan tab stays as it was.
 */

/** Dialogs of the cabinet, one at a time. */
type Open = { kind: 'topup'; amount?: bigint } | { kind: 'quote'; action: QuoteAction } | null;

export function BillingCabinet({ workspaceId, summary, state }: { workspaceId: string; summary: BillingSummary; state: BillingState }): ReactNode {
  const [open, setOpen] = useState<Open>(null);
  const payments = billingPaymentsAllowed();
  const { topup, manage } = capsOf(useBillingBits(workspaceId));
  const close = useCallback(() => setOpen(null), []);
  const onTopup = useCallback(() => setOpen({ kind: 'topup' }), []);
  const onQuote = useCallback((action: QuoteAction) => setOpen({ kind: 'quote', action }), []);
  return (
    <div className="flex flex-col gap-6" data-testid="billing-cabinet">
      <BalanceCard workspaceId={workspaceId} summary={summary} state={state} payments={payments} topup={topup} manage={manage} onTopup={onTopup} onQuote={onQuote} />
      {/* The iOS shell: no auto-topup or saved-card management, no payer form (App Store rules). */}
      {payments && summary.methods.some((m) => m.autoTopupCapable) ? <AutoTopupCard workspaceId={workspaceId} summary={summary} payments={manage} /> : null}
      {payments ? <PayerCard workspaceId={workspaceId} payer={summary.payer} market={summary.market} payments={manage} /> : null}
      <HistoryCard workspaceId={workspaceId} currency={currencyOf(summary)} payments={manage} />
      {open?.kind === 'topup' && topup ? <TopupDialog workspaceId={workspaceId} summary={summary} initialAmount={open.amount} manage={manage} onClose={close} /> : null}
      {open?.kind === 'quote' ? (
        <QuoteDialog workspaceId={workspaceId} action={open.action} onClose={close} onTopup={(amount) => setOpen({ kind: 'topup', amount })} />
      ) : null}
    </div>
  );
}

/** Members without BILLING_VIEW: the state only, never amounts or the card. */
export function MemberBillingStub({ state }: { state: BillingState }): ReactNode {
  const suspended = state === BillingState.SUSPENDED;
  return (
    <Card title={t('billing.title')}>
      <Note
        tone={suspended ? 'danger' : 'muted'}
        icon={suspended ? <CirclePause className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden /> : undefined}
        testId="billing-member-stub"
      >
        {suspended ? t('billing.member.suspended') : t('billing.member.text')}
      </Note>
    </Card>
  );
}

export function BillingSection({ workspaceId }: { workspaceId: string }): ReactNode {
  const bits = useBillingBits(workspaceId);
  // A MANAGE holder may start billing (self-serve): asks always (a 404 / 501 answer decides what shows).
  const manager = (bits & BILLING_BITS.MANAGE) !== 0n;
  const wsState = useWorkspaces((s) => billingStateOf(s.byId[workspaceId]?.ws.billing));
  // Everyone else only in a billing workspace.
  const wanted = manager || wsState !== BillingState.UNSPECIFIED || billingMock();
  const entry = useBilling((s) => s.byWs[workspaceId]);
  useEffect(() => {
    if (wanted) void loadBilling(workspaceId);
  }, [wanted, workspaceId]);
  if (!wanted || !entry) return null;
  if (entry.load === 'loading') {
    return (
      <Card title={t('billing.title')}>
        <div className="grid place-items-center py-6">
          <Spinner />
        </div>
      </Card>
    );
  }
  // 501 (billing off) / 404 (no account): nothing at all — the plan tab stays exactly as it was.
  if (entry.load === 'none' || entry.load === 'unavailable') return null;
  const data = entry.data;
  if (entry.load === 'error' && !data) {
    return (
      <Card title={t('billing.title')}>
        <div className="flex flex-wrap items-center gap-3 px-3 py-3">
          <p className="min-w-0 flex-1 text-body text-danger-text">{entry.error ?? t('err.generic')}</p>
          <Button size="sm" variant="secondary" onClick={() => void loadBilling(workspaceId)}>
            {t('common.retry')}
          </Button>
        </div>
      </Card>
    );
  }
  const state = data?.status?.state ?? wsState;
  if (!data?.summary) return state === BillingState.UNSPECIFIED ? null : <MemberBillingStub state={state} />;
  return <BillingCabinet workspaceId={workspaceId} summary={data.summary} state={state} />;
}
