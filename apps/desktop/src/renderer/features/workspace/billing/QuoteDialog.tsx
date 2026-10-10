import { BillingQuotePurpose, BillingResumeMode, Plan, type BillingQuote, type PlanLimitViolation } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { Button, Modal, Spinner } from '../../../components/ui';
import { t, type MessageKey } from '../../../i18n';
import { billingErrorText, billingStale } from '../../../lib/billing/errors';
import { nowMs } from '../../../lib/billing/checkout';
import { requestId } from '../../../lib/billing/model';
import { formatMinor, formatMoney, minorOf } from '../../../lib/billing/money';
import { adminAssignedError, violationsOf } from '../../../lib/billing/violations';
import { PLAN_LABEL } from '../../../lib/plan';
import { ownerBilling, reloadBilling } from '../../../services/billing';
import { useBilling } from '../../../stores/billing';
import { toast } from '../../../stores/toasts';
import { PLAN_NAME, SumLine } from './parts';
import { AdminAssignedNote, ViolationList } from './Violations';

/**
 * The net effect of a plan change in one sentence (owner, 10.10): «Вернём 0,07 $ за неиспользованное
 * время Business, спишем 0,10 $ за сутки Team — итого −0,03 $» (the balance change, signed).
 */
export function ChangeNet({ q, from, to }: { q: BillingQuote; from: Plan; to: Plan }): ReactNode {
  const cur = q.charge?.currency || q.compensation?.currency || '';
  const total = minorOf(q.compensation) - minorOf(q.charge);
  return (
    <p className="pt-2 text-caption text-muted" data-testid="billing-change-net">
      {t('billing.quote.netChange', {
        back: formatMoney(q.compensation),
        from: t(PLAN_LABEL[from]),
        charge: formatMoney(q.charge),
        to: t(PLAN_LABEL[to]),
        total: formatMinor(total, cur, { signed: true }),
      })}
    </p>
  );
}

/** The target plan's name of a refused transition (Free for a stop). */
const targetName = (a: QuoteAction, accountPlan: Plan): string =>
  t(PLAN_LABEL[a.kind === 'change' ? a.plan : a.kind === 'stop' ? Plan.FREE : accountPlan === Plan.UNSPECIFIED ? Plan.TEAM : accountPlan]);

/**
 * Activate / change plan / stop / resume (ADR-0080 §8, §9, lead plan «v1 cut»): the server's quote
 * first (POST …/quote — the client never sets the price), then the action with quote_id +
 * request_id + expected_revision. A stale quote (BILLING_QUOTE_EXPIRED / REVISION_CONFLICT) is
 * fetched again. When the balance does not cover it, «to pay» leads to the top-up instead.
 */

export type QuoteAction =
  | { kind: 'activate' }
  | { kind: 'change'; plan: Plan.TEAM | Plan.ENTERPRISE }
  | { kind: 'stop' }
  | { kind: 'resume'; mode: BillingResumeMode.FREE | BillingResumeMode.PAID };

const PURPOSE = (a: QuoteAction): BillingQuotePurpose =>
  a.kind === 'activate'
    ? BillingQuotePurpose.ACTIVATE
    : a.kind === 'change'
      ? BillingQuotePurpose.CHANGE_PLAN
      : a.kind === 'stop'
        ? BillingQuotePurpose.STOP
        : a.mode === BillingResumeMode.PAID
          ? BillingQuotePurpose.RESUME_PAID
          : BillingQuotePurpose.RESUME_FREE;

const TITLE: Record<BillingQuotePurpose, MessageKey> = {
  [BillingQuotePurpose.UNSPECIFIED]: 'billing.quote.title.activate',
  [BillingQuotePurpose.ACTIVATE]: 'billing.quote.title.activate',
  [BillingQuotePurpose.CHANGE_PLAN]: 'billing.quote.title.change',
  [BillingQuotePurpose.STOP]: 'billing.quote.title.stop',
  [BillingQuotePurpose.RESUME_PAID]: 'billing.quote.title.resumePaid',
  [BillingQuotePurpose.RESUME_FREE]: 'billing.quote.title.resumeFree',
};

const TEXT: Record<BillingQuotePurpose, MessageKey> = {
  [BillingQuotePurpose.UNSPECIFIED]: 'billing.quote.text.activate',
  [BillingQuotePurpose.ACTIVATE]: 'billing.quote.text.activate',
  [BillingQuotePurpose.CHANGE_PLAN]: 'billing.quote.text.change',
  [BillingQuotePurpose.STOP]: 'billing.quote.text.stop',
  [BillingQuotePurpose.RESUME_PAID]: 'billing.quote.text.resumePaid',
  [BillingQuotePurpose.RESUME_FREE]: 'billing.quote.text.resumeFree',
};

const ACTION: Record<BillingQuotePurpose, MessageKey> = {
  [BillingQuotePurpose.UNSPECIFIED]: 'billing.quote.do.activate',
  [BillingQuotePurpose.ACTIVATE]: 'billing.quote.do.activate',
  [BillingQuotePurpose.CHANGE_PLAN]: 'billing.quote.do.change',
  [BillingQuotePurpose.STOP]: 'billing.quote.do.stop',
  [BillingQuotePurpose.RESUME_PAID]: 'billing.quote.do.resume',
  [BillingQuotePurpose.RESUME_FREE]: 'billing.quote.do.resume',
};

async function apply(ws: string, a: QuoteAction, q: BillingQuote, reqId: string): Promise<void> {
  const base = { quoteId: q.quoteId, requestId: reqId, expectedRevision: q.revision };
  if (a.kind === 'activate') await ownerBilling.activate(ws, base);
  else if (a.kind === 'stop') await ownerBilling.stop(ws, base);
  else if (a.kind === 'change') await ownerBilling.changePlan(ws, { ...base, plan: a.plan });
  else await ownerBilling.resume(ws, { ...base, mode: a.mode });
}

export function QuoteDialog({
  workspaceId,
  action,
  onClose,
  onTopup,
}: {
  workspaceId: string;
  action: QuoteAction;
  onClose: () => void;
  /** The balance does not cover it: open the top-up with this amount (minor units). */
  onTopup: (minor: bigint) => void;
}): ReactNode {
  const purpose = PURPOSE(action);
  const plan = action.kind === 'change' ? action.plan : Plan.UNSPECIFIED;
  const quote = useQuery({
    queryKey: ['billing', workspaceId, 'quote', purpose, plan],
    queryFn: () => ownerBilling.quote(workspaceId, { purpose, plan }),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ADR-0086: the commit re-checks the limits (a member / bot added since the quote).
  const [blocked, setBlocked] = useState<readonly PlanLimitViolation[]>([]);
  const accountPlan = useBilling((s) => s.byWs[workspaceId]?.data?.summary?.plan ?? Plan.UNSPECIFIED);
  const reqId = useRef(requestId());
  const q = quote.data;
  const quoteBlocked = violationsOf(quote.error);
  const violations = blocked.length ? blocked : quoteBlocked;
  const cur = q?.charge?.currency || q?.toPay?.currency || '';
  const toPay = minorOf(q?.toPay);
  const net = minorOf(q?.debt) + minorOf(q?.charge) - minorOf(q?.compensation);

  const confirm = async (): Promise<void> => {
    if (!q) return;
    if (q.expiresAt && timestampMs(q.expiresAt) <= nowMs()) {
      void quote.refetch();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apply(workspaceId, action, q, reqId.current);
      toast.success(t('billing.quote.done'));
      reloadBilling(workspaceId);
      onClose();
    } catch (e) {
      if (billingStale(e)) {
        reqId.current = requestId();
        void quote.refetch();
      }
      const v = violationsOf(e);
      if (v.length) setBlocked(v);
      else setError(billingErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const destructive = purpose === BillingQuotePurpose.STOP;
  return (
    <Modal
      open
      initialFocus="body"
      onClose={onClose}
      title={t(TITLE[purpose], action.kind === 'change' ? { plan: t(PLAN_NAME[action.plan]) } : undefined)}
      description={t(TEXT[purpose])}
      closeButton={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {violations.length ? null : q && toPay > 0n ? (
            <Button onClick={() => onTopup(toPay)} data-testid="billing-quote-topup">
              {t('billing.quote.topup', { amount: formatMoney(q.toPay) })}
            </Button>
          ) : (
            <Button variant={destructive ? 'destructive' : 'primary'} busy={busy} disabled={!q} onClick={() => void confirm()} data-testid="billing-quote-confirm">
              {t(ACTION[purpose])}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col" data-testid="billing-quote">
        {quote.isLoading ? <Spinner className="mx-auto my-4" /> : null}
        {violations.length ? (
          <ViolationList workspaceId={workspaceId} plan={targetName(action, accountPlan)} violations={violations} />
        ) : adminAssignedError(quote.error) ? (
          <AdminAssignedNote />
        ) : quote.isError ? (
          <p className="text-body text-danger-text">{billingErrorText(quote.error)}</p>
        ) : null}
        {q && !violations.length ? (
          <>
            {minorOf(q.debt) > 0n ? <SumLine label={t('billing.quote.debt')}>{formatMoney(q.debt)}</SumLine> : null}
            {minorOf(q.charge) > 0n ? (
              <SumLine label={t('billing.quote.charge', { seats: q.seats, price: formatMoney(q.unitPrice) })}>{formatMoney(q.charge)}</SumLine>
            ) : null}
            {minorOf(q.compensation) > 0n ? <SumLine label={t('billing.quote.compensation')}>{formatMoney(q.compensation, { signed: true })}</SumLine> : null}
            <SumLine label={toPay > 0n ? t('billing.quote.toPay') : net < 0n ? t('billing.quote.returns') : t('billing.quote.fromBalance')} strong>
              {toPay > 0n ? formatMoney(q.toPay) : formatMinor(net < 0n ? -net : net, cur)}
            </SumLine>
            {action.kind === 'change' && accountPlan !== Plan.UNSPECIFIED ? <ChangeNet q={q} from={accountPlan} to={action.plan} /> : null}
            {toPay > 0n ? <p className="pt-2 text-caption text-muted">{t('billing.quote.needTopup')}</p> : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="pt-2 text-caption text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
