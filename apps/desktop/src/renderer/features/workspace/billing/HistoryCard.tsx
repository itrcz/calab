import {
  LedgerEntryKind,
  PaymentOrigin,
  PaymentStatus,
  Plan,
  RefundRequestStatus,
  type BillingPayment,
  type BillingRefundRequest,
  type LedgerEntry,
} from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { memo, useRef, useState, type ReactNode } from 'react';
import { Button, Field, Input, Modal, Segmented, Spinner, cx } from '../../../components/ui';
import { plural, t, type MessageKey } from '../../../i18n';
import { billingErrorText } from '../../../lib/billing/errors';
import { amountProblem, requestId } from '../../../lib/billing/model';
import { formatMinor, formatMoney, minorOf, parseMajor } from '../../../lib/billing/money';
import { fmt } from '../../../lib/format';
import { billingKeys, openReceipt, ownerBilling } from '../../../services/billing';
import { toast } from '../../../stores/toasts';
import { PLAN_NAME } from './parts';

/**
 * «История» (ADR-0080 §13): the ledger (every daily charge, top-up, refund, compensation — cursor
 * pages), payments with the provider receipt (`receipt_url`), and refund requests with the form.
 * Rows are memo components with primitive / stable props (CLAUDE.md «Ререндеры»).
 */

export const LEDGER_KIND: Record<LedgerEntryKind, MessageKey> = {
  [LedgerEntryKind.UNSPECIFIED]: 'billing.kind.other',
  [LedgerEntryKind.TOPUP]: 'billing.kind.topup',
  [LedgerEntryKind.SEAT_CHARGE]: 'billing.kind.seats',
  [LedgerEntryKind.COMPENSATION]: 'billing.kind.compensation',
  [LedgerEntryKind.REFUND]: 'billing.kind.refund',
  [LedgerEntryKind.REFUND_REVERSAL]: 'billing.kind.refundReversal',
  [LedgerEntryKind.DISPUTE]: 'billing.kind.dispute',
  [LedgerEntryKind.DISPUTE_REVERSAL]: 'billing.kind.disputeReversal',
  [LedgerEntryKind.ADMIN_CREDIT]: 'billing.kind.adminCredit',
  [LedgerEntryKind.ADMIN_DEBIT]: 'billing.kind.adminDebit',
};

const skuPlan = (sku: string): string => (sku.includes('enterprise') ? t(PLAN_NAME[Plan.ENTERPRISE]) : t(PLAN_NAME[Plan.TEAM]));

/** The second line of a ledger row: what was bought / why. */
export function ledgerDetail(e: LedgerEntry): string {
  if (e.kind === LedgerEntryKind.SEAT_CHARGE && e.quantity > 0) {
    // The row already shows when it started (created_at ≈ starts_at): the end is what matters.
    const period = e.endsAt ? t('billing.until', { when: fmt.dateTime(timestampDate(e.endsAt), 'short') }) : '';
    return [plural('billing.nSeats', e.quantity), e.sku ? skuPlan(e.sku) : '', period].filter(Boolean).join(' · ');
  }
  return e.reason;
}

const cols = 'grid grid-cols-[96px_minmax(0,1fr)_96px_96px] items-center gap-3 mobile:grid-cols-[minmax(0,1fr)_auto]';

/** `action`: a stable render prop for a per-row control (the superadmin's «Отменить» of a credit). */
export const LedgerRow = memo(function LedgerRow({ e, action }: { e: LedgerEntry; action?: ((e: LedgerEntry) => ReactNode) | undefined }): ReactNode {
  const neg = minorOf(e.amount) < 0n;
  const detail = ledgerDetail(e);
  return (
    <div role="row" className={cx(cols, 'min-h-10 border-b border-[var(--color-card-line)] px-3 py-1.5 last:border-b-0')} data-testid="billing-ledger-row">
      <span role="cell" className="tabular-nums text-caption text-muted mobile:hidden">
        {e.createdAt ? fmt.dateTime(timestampDate(e.createdAt), 'short') : '—'}
      </span>
      <span role="cell" className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body">{t(LEDGER_KIND[e.kind])}</span>
          {action?.(e)}
        </span>
        <span className="truncate text-caption text-faint" title={detail}>
          <span className="hidden mobile:inline">{e.createdAt ? `${fmt.dateTime(timestampDate(e.createdAt), 'short')}${detail ? ' · ' : ''}` : ''}</span>
          {detail}
        </span>
      </span>
      <span role="cell" className={cx('text-right tabular-nums text-body', neg ? 'text-fg' : 'text-ok')}>
        {formatMoney(e.amount, { signed: true })}
      </span>
      <span role="cell" className={cx('text-right tabular-nums text-caption mobile:hidden', minorOf(e.balanceAfter) < 0n ? 'text-danger-text' : 'text-muted')}>
        {formatMoney(e.balanceAfter)}
      </span>
    </div>
  );
});

/** A ledger table with «Показать ещё» (cursor pages). Shared with the superadmin account page. */
export function LedgerTable({
  queryKey,
  fetchPage,
  action,
}: {
  queryKey: readonly unknown[];
  fetchPage: (cursor: string, signal: AbortSignal) => ReturnType<typeof ownerBilling.ledger>;
  action?: (e: LedgerEntry) => ReactNode;
}): ReactNode {
  const q = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor || undefined,
    retry: false,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  if (q.isLoading) return <Spinner className="mx-auto my-4" />;
  if (q.isError) return <p className="px-3 py-3 text-body text-danger-text">{billingErrorText(q.error)}</p>;
  if (entries.length === 0) return <p className="px-3 py-3 text-body text-muted">{t('billing.history.empty')}</p>;
  return (
    <>
      <div role="table" aria-label={t('billing.history.ledger')} data-testid="billing-ledger">
        <div role="row" className={cx(cols, 'border-b border-[var(--color-card-line)] px-3 py-1.5 text-caption font-medium text-muted mobile:hidden')}>
          <span role="columnheader">{t('billing.col.when')}</span>
          <span role="columnheader">{t('billing.col.what')}</span>
          <span role="columnheader" className="text-right">
            {t('billing.col.amount')}
          </span>
          <span role="columnheader" className="text-right">
            {t('billing.col.balance')}
          </span>
        </div>
        {entries.map((e) => (
          <LedgerRow key={e.id} e={e} action={action} />
        ))}
      </div>
      {q.hasNextPage ? (
        <div className="flex justify-center py-2">
          <Button size="sm" variant="ghost" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('billing.history.more')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

const PAYMENT_STATUS: Record<PaymentStatus, MessageKey> = {
  [PaymentStatus.UNSPECIFIED]: 'billing.pay.status.processing',
  [PaymentStatus.PROCESSING]: 'billing.pay.status.processing',
  [PaymentStatus.SUCCEEDED]: 'billing.pay.status.succeeded',
  [PaymentStatus.FAILED]: 'billing.pay.status.failed',
  [PaymentStatus.CANCELED]: 'billing.pay.status.canceled',
};

const ORIGIN: Record<PaymentOrigin, MessageKey> = {
  [PaymentOrigin.UNSPECIFIED]: 'billing.pay.origin.checkout',
  [PaymentOrigin.CHECKOUT]: 'billing.pay.origin.checkout',
  [PaymentOrigin.AUTO_TOPUP]: 'billing.pay.origin.auto',
  [PaymentOrigin.IMPORT]: 'billing.pay.origin.import',
};

export const PaymentRow = memo(function PaymentRow({ p, extra }: { p: BillingPayment; extra?: ReactNode }): ReactNode {
  const at = p.succeededAt ?? p.createdAt;
  const refunded = minorOf(p.refunded);
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-card-line)] px-3 py-2 last:border-b-0" data-testid="billing-payment-row">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2 text-body">
          <span className="tabular-nums font-medium">{formatMoney(p.amount)}</span>
          <span className={cx('text-caption', p.status === PaymentStatus.FAILED ? 'text-danger-text' : 'text-muted')}>{t(PAYMENT_STATUS[p.status])}</span>
        </span>
        <span className="truncate text-caption text-faint">
          {[at ? fmt.dateTime(timestampDate(at), 'short') : '', t(ORIGIN[p.origin]), refunded > 0n ? t('billing.pay.refunded', { amount: formatMoney(p.refunded) }) : ''].filter(Boolean).join(' · ')}
        </span>
      </span>
      {extra}
      {p.receiptUrl ? (
        <Button size="sm" variant="ghost" onClick={() => openReceipt(p.receiptUrl)}>
          {t('billing.pay.receipt')}
          <ExternalLink className="size-3" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
});

function Payments({ workspaceId }: { workspaceId: string }): ReactNode {
  const q = useInfiniteQuery({
    queryKey: billingKeys.payments(workspaceId),
    queryFn: ({ pageParam, signal }) => ownerBilling.payments(workspaceId, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor || undefined,
    retry: false,
  });
  const list = q.data?.pages.flatMap((p) => p.payments) ?? [];
  if (q.isLoading) return <Spinner className="mx-auto my-4" />;
  if (q.isError) return <p className="px-3 py-3 text-body text-danger-text">{billingErrorText(q.error)}</p>;
  if (list.length === 0) return <p className="px-3 py-3 text-body text-muted">{t('billing.history.noPayments')}</p>;
  return (
    <div data-testid="billing-payments">
      {list.map((p) => (
        <PaymentRow key={p.id} p={p} />
      ))}
      {q.hasNextPage ? (
        <div className="flex justify-center py-2">
          <Button size="sm" variant="ghost" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('billing.history.more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const REQ_STATUS: Record<RefundRequestStatus, MessageKey> = {
  [RefundRequestStatus.UNSPECIFIED]: 'billing.rr.status.requested',
  [RefundRequestStatus.REQUESTED]: 'billing.rr.status.requested',
  [RefundRequestStatus.APPROVED]: 'billing.rr.status.approved',
  [RefundRequestStatus.REJECTED]: 'billing.rr.status.rejected',
  [RefundRequestStatus.WITHDRAWN]: 'billing.rr.status.withdrawn',
};

export const RefundRequestRow = memo(function RefundRequestRow({ r, extra }: { r: BillingRefundRequest; extra?: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-card-line)] px-3 py-2 last:border-b-0" data-testid="billing-rr-row">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2 text-body">
          <span className="tabular-nums font-medium">{formatMoney(r.amount)}</span>
          <span className={cx('text-caption', r.status === RefundRequestStatus.REJECTED ? 'text-danger-text' : 'text-muted')}>{t(REQ_STATUS[r.status])}</span>
        </span>
        <span className="truncate text-caption text-faint" title={r.reason}>
          {[r.createdAt ? fmt.dateTime(timestampDate(r.createdAt), 'short') : '', r.reason].filter(Boolean).join(' · ')}
        </span>
      </span>
      {extra}
    </div>
  );
});

function RefundRequests({ workspaceId, currency, payments }: { workspaceId: string; currency: string; payments: boolean }): ReactNode {
  const q = useQuery({ queryKey: billingKeys.refundRequests(workspaceId), queryFn: ({ signal }) => ownerBilling.refundRequests(workspaceId, signal), retry: false });
  const [form, setForm] = useState(false);
  const list = q.data?.requests ?? [];
  return (
    <div data-testid="billing-refund-requests">
      <p className="px-3 pt-3 text-caption text-muted">{t('billing.rr.explain')}</p>
      {q.isLoading ? <Spinner className="mx-auto my-4" /> : null}
      {q.isError ? <p className="px-3 py-3 text-body text-danger-text">{billingErrorText(q.error)}</p> : null}
      {list.map((r) => (
        <RefundRequestRow key={r.id} r={r} />
      ))}
      {payments ? (
        <div className="flex px-3 py-2">
          <Button size="sm" variant="secondary" onClick={() => setForm(true)} data-testid="billing-rr-new">
            {t('billing.rr.new')}
          </Button>
        </div>
      ) : null}
      {form ? <RefundRequestDialog workspaceId={workspaceId} currency={currency} onClose={() => setForm(false)} /> : null}
    </div>
  );
}

function RefundRequestDialog({ workspaceId, currency, onClose }: { workspaceId: string; currency: string; onClose: () => void }): ReactNode {
  const qc = useQueryClient();
  const [raw, setRaw] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(requestId());
  const minor = parseMajor(raw, currency);
  const problem = amountProblem(minor, raw, { min: 1n, max: 10n ** 15n });
  const submit = async (): Promise<void> => {
    setTouched(true);
    if (problem || minor === null || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await ownerBilling.createRefundRequest(workspaceId, { amount: { minor, currency }, reason: reason.trim(), requestId: reqId.current });
      toast.success(t('billing.rr.sent'));
      void qc.invalidateQueries({ queryKey: billingKeys.refundRequests(workspaceId) });
      onClose();
    } catch (e) {
      setError(billingErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('billing.rr.title')}
      description={t('billing.rr.text')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} onClick={() => void submit()}>
            {t('billing.rr.send')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="billing-rr-form">
        <Field label={t('billing.rr.amount', { currency })} error={touched && problem ? t('billing.topup.err.invalid') : null}>
          <Input inputMode="decimal" className="w-40 tabular-nums mobile:w-full" value={raw} onChange={(e) => setRaw(e.target.value)} />
        </Field>
        <Field label={t('billing.rr.reason')} error={touched && !reason.trim() ? t('billing.rr.reasonRequired') : null}>
          <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error ? (
          <p role="alert" className="text-caption text-danger-text">
            {error}
          </p>
        ) : null}
        {minor !== null && !problem ? <p className="text-caption text-faint">{t('billing.rr.note', { amount: formatMinor(minor, currency) })}</p> : null}
      </div>
    </Modal>
  );
}

type Tab = 'ledger' | 'payments' | 'refunds';

export function HistoryCard({ workspaceId, currency, payments }: { workspaceId: string; currency: string; payments: boolean }): ReactNode {
  const [tab, setTab] = useState<Tab>('ledger');
  return (
    <section className="flex flex-col gap-1.5" data-testid="billing-history">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h3 className="text-caption font-semibold text-muted">{t('billing.history.title')}</h3>
        <Segmented<Tab>
          label={t('billing.history.title')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'ledger', label: t('billing.history.ledger') },
            { value: 'payments', label: t('billing.history.payments') },
            { value: 'refunds', label: t('billing.history.refunds') },
          ]}
        />
      </div>
      <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body">
        {tab === 'ledger' ? (
          <LedgerTable queryKey={billingKeys.ledger(workspaceId)} fetchPage={(cursor, signal) => ownerBilling.ledger(workspaceId, cursor, signal)} />
        ) : tab === 'payments' ? (
          <Payments workspaceId={workspaceId} />
        ) : (
          <RefundRequests workspaceId={workspaceId} currency={currency} payments={payments} />
        )}
      </div>
    </section>
  );
}
