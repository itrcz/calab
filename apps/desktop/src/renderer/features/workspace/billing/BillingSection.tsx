import { BillingState, WorkspaceRole, type BillingSummary } from '@calaba/protocol';
import { CirclePause, Clock } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Spinner } from '../../../components/ui';
import { t } from '../../../i18n';
import { billingStateOf, currencyOf } from '../../../lib/billing/model';
import { billingMock, billingPaymentsAllowed, loadBilling } from '../../../services/billing';
import { useBilling } from '../../../stores/billing';
import { useWorkspaces } from '../../../stores/workspaces';
import { AutoTopupCard } from './AutoTopupCard';
import { BalanceCard } from './BalanceCard';
import { HistoryCard } from './HistoryCard';
import { PayerCard } from './PayerCard';
import { QuoteDialog, type QuoteAction } from './QuoteDialog';
import { TopupDialog } from './TopupDialog';
import { Note } from './parts';

/**
 * Balance billing in workspace settings → «Тариф» (ADR-0080 v5 §13). Only the owner sees money: the
 * owner gets the cabinet (balance, plan actions, top-up, auto-topup, payer, history); members of a
 * billing workspace see a stub without amounts. 501 from the server — «Оплата скоро будет
 * доступна»; 404 (no billing account) — nothing, the plan tab stays as it was.
 */

/** Dialogs of the cabinet, one at a time. */
type Open = { kind: 'topup'; amount?: bigint } | { kind: 'quote'; action: QuoteAction } | null;

export function BillingCabinet({ workspaceId, summary, state }: { workspaceId: string; summary: BillingSummary; state: BillingState }): ReactNode {
  const [open, setOpen] = useState<Open>(null);
  const payments = billingPaymentsAllowed();
  const close = useCallback(() => setOpen(null), []);
  const onTopup = useCallback(() => setOpen({ kind: 'topup' }), []);
  const onQuote = useCallback((action: QuoteAction) => setOpen({ kind: 'quote', action }), []);
  return (
    <div className="flex flex-col gap-6" data-testid="billing-cabinet">
      <BalanceCard workspaceId={workspaceId} summary={summary} state={state} payments={payments} onTopup={onTopup} onQuote={onQuote} />
      {summary.methods.some((m) => m.autoTopupCapable) ? <AutoTopupCard workspaceId={workspaceId} summary={summary} payments={payments} /> : null}
      <PayerCard workspaceId={workspaceId} payer={summary.payer} payments={payments} />
      <HistoryCard workspaceId={workspaceId} currency={currencyOf(summary)} payments={payments} />
      {open?.kind === 'topup' ? <TopupDialog workspaceId={workspaceId} summary={summary} initialAmount={open.amount} onClose={close} /> : null}
      {open?.kind === 'quote' ? (
        <QuoteDialog workspaceId={workspaceId} action={open.action} onClose={close} onTopup={(amount) => setOpen({ kind: 'topup', amount })} />
      ) : null}
    </div>
  );
}

/** Members (not the owner): the state only, never amounts or the card. */
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
  const owner = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.OWNER);
  const wsState = useWorkspaces((s) => billingStateOf(s.byId[workspaceId]?.ws.billing));
  // The owner always asks (a 404 / 501 answer decides what shows); a member only in a billing workspace.
  const wanted = owner || wsState !== BillingState.UNSPECIFIED || billingMock();
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
  if (entry.load === 'none') return null;
  if (entry.load === 'unavailable') {
    return (
      <Card title={t('billing.title')}>
        <Note icon={<Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />} testId="billing-soon">
          {t('billing.soon')}
        </Note>
      </Card>
    );
  }
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
