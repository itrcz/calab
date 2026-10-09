import {
  BillingAccountStatus,
  BillingState,
  DisputeStatus,
  LedgerEntryKind,
  Plan,
  RefundStatus,
  type AdminBillingAccount,
  type AdminBillingPayment,
  type AdminBillingRefund,
  type AdminBillingRefundRequest,
  type AdminProviderEvent,
  type LedgerEntry,
} from '@calaba/protocol';
import { timestampDate, timestampFromDate, timestampFromMs } from '@bufbuild/protobuf/wkt';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Inbox, Search, Tags } from 'lucide-react';
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, CloseButton, Empty, Field, Input, Modal, Row, Segmented, Select, Spinner, Toggle, cx } from '../../../components/ui';
import { plural, t, type MessageKey } from '../../../i18n';
import { recentAuthRequired } from '../../../lib/api/errors';
import { billingErrorText } from '../../../lib/billing/errors';
import { nowMs } from '../../../lib/billing/checkout';
import { refundableMinor, rejectRefundRequest } from '../../../lib/billing/model';
import { formatMinor, formatMoney, minorOf, parseMajor } from '../../../lib/billing/money';
import { fmt } from '../../../lib/format';
import { adminBilling } from '../../../services/billing';
import { PlanPill } from '../../workspace/PlanTab';
import { LedgerTable, PaymentRow, RefundRequestRow } from '../../workspace/billing/HistoryCard';
import { MoneyText, StatePill } from '../../workspace/billing/parts';
import { MoneyActionDialog, type MoneyActionArgs } from './MoneyAction';

/**
 * «Оплата» in the superadmin window (ADR-0080 §13, docs/plans/billing-v1-tasks T6): billing
 * accounts (search by workspace / owner e-mail), an account (balance, ledger, payments, refunds,
 * disputes) with the money actions — manual credit / its reversal, refund of a payment (≤
 * refundable), hold, discount, reconcile — the owners' refund requests, price versions (from now +
 * 10 days) and provider events with errors. Every money action: reason + preview + confirm; the
 * window's password notice handles RECENT_AUTH_REQUIRED.
 */

export type AdminSection = 'workspaces' | 'billing';
export type BillingView = { kind: 'account'; id: string } | { kind: 'requests' } | { kind: 'prices' } | { kind: 'events' } | null;

const KEY = {
  accounts: (q: string) => ['admin', 'billing', 'accounts', q] as const,
  account: (id: string) => ['admin', 'billing', 'account', id] as const,
  ledger: (id: string) => ['admin', 'billing', 'ledger', id] as const,
  payments: (id: string) => ['admin', 'billing', 'payments', id] as const,
  refunds: (id: string) => ['admin', 'billing', 'refunds', id] as const,
  disputes: (id: string) => ['admin', 'billing', 'disputes', id] as const,
  requests: ['admin', 'billing', 'refund-requests'] as const,
  prices: ['admin', 'billing', 'prices'] as const,
  events: (open: boolean) => ['admin', 'billing', 'events', open] as const,
};

/** A price version takes effect at least this far ahead (no price-increase consent flow in v1). */
export const PRICE_LEAD_DAYS = 10;

/** «Пространства | Оплата» under the window title. */
export function AdminSectionSwitch({ value, onChange }: { value: AdminSection; onChange: (v: AdminSection) => void }): ReactNode {
  return (
    <div className="px-2">
      <Segmented<AdminSection>
        label={t('adminBilling.section')}
        value={value}
        onChange={onChange}
        options={[
          { value: 'workspaces', label: t('adminBilling.section.workspaces') },
          { value: 'billing', label: t('adminBilling.section.billing') },
        ]}
      />
    </div>
  );
}

const ACCOUNT_STATE: Record<BillingAccountStatus, BillingState> = {
  [BillingAccountStatus.UNSPECIFIED]: BillingState.UNSPECIFIED,
  [BillingAccountStatus.INACTIVE]: BillingState.INACTIVE,
  [BillingAccountStatus.ACTIVE]: BillingState.ACTIVE,
  [BillingAccountStatus.STOPPED]: BillingState.STOPPED,
  [BillingAccountStatus.SUSPENDED]: BillingState.SUSPENDED,
  [BillingAccountStatus.CLOSED]: BillingState.UNSPECIFIED,
};

/** The pill for an account: arrears when active with debt. */
const accountState = (a: AdminBillingAccount): BillingState =>
  a.status === BillingAccountStatus.ACTIVE && minorOf(a.debt) > 0n ? BillingState.IN_ARREARS : ACCOUNT_STATE[a.status];

const planOf = (p: Plan): Plan => (p === Plan.ENTERPRISE ? Plan.ENTERPRISE : Plan.TEAM);

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

const AccountCard = memo(function AccountCard({ a, selected, onSelect }: { a: AdminBillingAccount; selected: boolean; onSelect: (id: string) => void }): ReactNode {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(a.accountId)}
      data-testid="admin-billing-account"
      className={cx(
        'flex w-full flex-col gap-0.5 rounded-[var(--radius-card)] px-3 py-2 text-left transition-colors duration-[var(--motion-fast)]',
        selected ? 'bg-accent-strong text-accent-fg' : 'hover:bg-hover',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-semibold" title={a.workspaceName}>
          {a.workspaceName || t('adminBilling.deletedWs')}
        </span>
        <span className={cx('shrink-0 text-body tabular-nums', !selected && minorOf(a.balance) < 0n && 'text-danger-text')}>{formatMoney(a.balance)}</span>
      </span>
      <span className={cx('flex min-w-0 items-center gap-2 text-caption', selected ? 'text-accent-fg' : 'text-muted')}>
        <span className="min-w-0 flex-1 truncate">{a.ownerEmail}</span>
        <span className="shrink-0">{t(accountState(a) === BillingState.IN_ARREARS ? 'billing.state.arrears' : STATUS_KEY[a.status])}</span>
      </span>
    </button>
  );
});

const STATUS_KEY: Record<BillingAccountStatus, MessageKey> = {
  [BillingAccountStatus.UNSPECIFIED]: 'billing.state.inactive',
  [BillingAccountStatus.INACTIVE]: 'billing.state.inactive',
  [BillingAccountStatus.ACTIVE]: 'billing.state.active',
  [BillingAccountStatus.STOPPED]: 'billing.state.stopped',
  [BillingAccountStatus.SUSPENDED]: 'billing.state.suspended',
  [BillingAccountStatus.CLOSED]: 'adminBilling.closed',
};

function NavButton({ icon, label, active, onClick, testId }: { icon: ReactNode; label: string; active: boolean; onClick: () => void; testId?: string }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      data-testid={testId}
      // Phone: compact pills in one wrapping row, so the accounts list keeps its height in the top half.
      className={cx(
        'flex h-8 w-full items-center gap-2 rounded-[var(--radius-card)] px-3 text-left text-body mobile:h-9 mobile:w-auto mobile:rounded-full mobile:px-3',
        active ? 'bg-accent-strong text-accent-fg' : 'hover:bg-hover mobile:bg-hover',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** The left column of the billing section: search, accounts, and the cross-account pages. */
export function AdminBillingSide({ view, onView }: { view: BillingView; onView: (v: BillingView) => void }): ReactNode {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const list = useQuery({ queryKey: KEY.accounts(dq), queryFn: ({ signal }) => adminBilling.accounts({ q: dq }, signal), placeholderData: keepPreviousData, retry: false });
  const items = list.data?.accounts ?? [];
  const selected = view?.kind === 'account' ? view.id : null;
  const select = useCallback((id: string) => onView({ kind: 'account', id }), [onView]);
  return (
    <>
      <label className="relative flex items-center">
        <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted" aria-hidden />
        <input
          type="search"
          aria-label={t('adminBilling.search')}
          placeholder={t('adminBilling.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="selectable h-7 w-full min-w-0 rounded-full border border-line bg-elev pl-7 pr-3 text-body text-fg shadow-[var(--shadow-card)] placeholder:text-muted mobile:tap-h [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
      <div className="flex flex-col gap-0.5 mobile:flex-row mobile:flex-wrap mobile:gap-1.5">
        <NavButton icon={<Inbox className="size-4 shrink-0" aria-hidden />} label={t('adminBilling.nav.requests')} active={view?.kind === 'requests'} onClick={() => onView({ kind: 'requests' })} testId="admin-billing-nav-requests" />
        <NavButton icon={<Tags className="size-4 shrink-0" aria-hidden />} label={t('adminBilling.nav.prices')} active={view?.kind === 'prices'} onClick={() => onView({ kind: 'prices' })} testId="admin-billing-nav-prices" />
        <NavButton icon={<Activity className="size-4 shrink-0" aria-hidden />} label={t('adminBilling.nav.events')} active={view?.kind === 'events'} onClick={() => onView({ kind: 'events' })} testId="admin-billing-nav-events" />
      </div>
      <div role="listbox" aria-label={t('adminBilling.accounts')} className="-mx-0.5 flex min-h-0 flex-1 mobile:min-h-[120px] flex-col gap-1 overflow-y-auto border-t border-line px-0.5 pb-1 pt-2" data-testid="admin-billing-list">
        {list.isLoading ? <Spinner className="mx-auto mt-6" /> : null}
        {list.isError && !recentAuthRequired(list.error) ? <p className="px-2 py-3 text-body text-danger-text">{billingErrorText(list.error)}</p> : null}
        {list.isSuccess && items.length === 0 ? <p className="px-2 py-3 text-body text-muted">{t('adminBilling.none')}</p> : null}
        {items.map((a) => (
          <AccountCard key={a.accountId} a={a} selected={a.accountId === selected} onSelect={select} />
        ))}
      </div>
    </>
  );
}

function PaneHeader({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }): ReactNode {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line pl-6 pr-3 mobile:pl-4">
      <h2 className="flex min-w-0 items-center gap-2 text-headline font-semibold">
        <span className="truncate">{title}</span>
        {children}
      </h2>
      <CloseButton label={t('settings.close')} onClick={onClose} />
    </div>
  );
}

function Scroll({ children, testId }: { children: ReactNode; testId?: string }): ReactNode {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 mobile:px-4" data-testid={testId}>
      <div className="mx-auto flex max-w-[640px] flex-col gap-6">{children}</div>
    </div>
  );
}

/** The right pane of the billing section. */
export function AdminBillingPane({ view, onClose, notice }: { view: BillingView; onClose: () => void; notice: ReactNode }): ReactNode {
  if (view?.kind === 'account') return <AccountDetail key={view.id} id={view.id} onClose={onClose} notice={notice} />;
  if (view?.kind === 'requests') return <RequestsPage onClose={onClose} notice={notice} />;
  if (view?.kind === 'prices') return <PricesPage onClose={onClose} notice={notice} />;
  if (view?.kind === 'events') return <EventsPage onClose={onClose} notice={notice} />;
  return (
    <>
      <PaneHeader title={t('adminBilling.section.billing')} onClose={onClose} />
      {notice}
      <div className="grid flex-1 place-items-center">{notice ? null : <Empty>{t('adminBilling.pick')}</Empty>}</div>
    </>
  );
}

// ---------------------------------------------------------------- account

type Dialog =
  | { kind: 'credit' }
  | { kind: 'reverse'; entry: LedgerEntry }
  | { kind: 'refund'; payment: AdminBillingPayment; refundable: bigint; request?: AdminBillingRefundRequest }
  | { kind: 'hold' }
  | { kind: 'discount' }
  | { kind: 'reconcile' }
  | { kind: 'release'; refund: AdminBillingRefund }
  | null;

function AccountDetail({ id, onClose, notice }: { id: string; onClose: () => void; notice: ReactNode }): ReactNode {
  const qc = useQueryClient();
  const acc = useQuery({ queryKey: KEY.account(id), queryFn: ({ signal }) => adminBilling.account(id, signal), retry: false });
  const payments = useQuery({ queryKey: KEY.payments(id), queryFn: ({ signal }) => adminBilling.payments({ accountId: id }, signal), retry: false });
  const refunds = useQuery({ queryKey: KEY.refunds(id), queryFn: ({ signal }) => adminBilling.refunds({ accountId: id }, signal), retry: false });
  const disputes = useQuery({ queryKey: KEY.disputes(id), queryFn: ({ signal }) => adminBilling.disputes({ accountId: id }, signal), retry: false });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [openedAt] = useState(nowMs);
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['admin', 'billing'] });
  }, [qc]);
  const reverseAction = useCallback(
    (e: LedgerEntry) =>
      e.kind === LedgerEntryKind.ADMIN_CREDIT ? (
        <Button size="sm" variant="ghost" className="h-5 px-1.5" onClick={() => setDialog({ kind: 'reverse', entry: e })} data-testid="admin-billing-reverse">
          {t('adminBilling.reverse')}
        </Button>
      ) : null,
    [],
  );
  const details = acc.data;
  const disputeList = (disputes.data?.disputes ?? []).map((d) => d.dispute);
  const refundList = (refunds.data?.refunds ?? []).map((r) => r.refund);
  const a = details?.account;
  if (!details || !a) {
    return (
      <>
        <PaneHeader title={t('adminBilling.section.billing')} onClose={onClose} />
        {notice}
        <div className="grid flex-1 place-items-center">{recentAuthRequired(acc.error) ? null : acc.isError ? <Empty>{billingErrorText(acc.error)}</Empty> : <Spinner />}</div>
      </>
    );
  }
  const cur = a.balance?.currency || 'USD';
  const holdUntil = a.holdUntil ? timestampDate(a.holdUntil) : null;
  const held = !!holdUntil && holdUntil.getTime() > openedAt;
  return (
    <>
      <PaneHeader title={a.workspaceName || t('adminBilling.deletedWs')} onClose={onClose}>
        <StatePill state={accountState(a)} />
        <PlanPill plan={planOf(a.plan)} />
      </PaneHeader>
      {notice}
      <Scroll testId="admin-billing-detail">
        <Card title={t('adminBilling.card.account')}>
          <div className="flex flex-wrap items-end justify-between gap-3 px-3 pb-2 pt-3">
            <div className="flex flex-col">
              <span className="text-caption text-muted">{t('billing.balance')}</span>
              <MoneyText m={a.balance} className="text-[26px] font-semibold leading-tight" />
            </div>
            {minorOf(a.debt) > 0n ? (
              <div className="flex flex-col items-end mobile:items-start">
                <span className="text-caption text-muted">{t('billing.debt')}</span>
                <MoneyText m={a.debt} danger className="text-body font-semibold" />
              </div>
            ) : null}
          </div>
          <Row label={t('admin.row.owner')}>
            <span className="max-w-72 truncate text-body text-muted">{a.ownerEmail}</span>
          </Row>
          <Row label={t('adminBilling.row.market')}>
            <span className="text-body text-muted">
              {a.market} · {cur}
            </span>
          </Row>
          <Row label={t('billing.people')}>
            <span className="text-body tabular-nums text-muted">{plural('billing.nPeople', a.billableMembers)}</span>
          </Row>
          {a.suspendAt ? (
            <Row label={t('adminBilling.row.suspendAt')}>
              <span className="text-body text-muted">{fmt.dateTime(timestampDate(a.suspendAt), 'short')}</span>
            </Row>
          ) : null}
          {a.nextDueAt ? (
            <Row label={t('billing.nextDue')}>
              <span className="text-body text-muted">{fmt.dateTime(timestampDate(a.nextDueAt), 'short')}</span>
            </Row>
          ) : null}
          {minorOf(details.freeAdvance) > 0n ? (
            <Row label={t('adminBilling.row.freeAdvance')}>
              <MoneyText m={details.freeAdvance} className="text-body text-muted" />
            </Row>
          ) : null}
          {minorOf(details.pendingRefunds) > 0n ? (
            <Row label={t('adminBilling.row.pendingRefunds')}>
              <MoneyText m={details.pendingRefunds} className="text-body text-warn" />
            </Row>
          ) : null}
          <Row label={t('adminBilling.row.discount')}>
            <span className="text-body tabular-nums text-muted">{a.discountBps ? `${fmt.number(a.discountBps / 100)} %` : '—'}</span>
          </Row>
          <Row label={t('adminBilling.row.hold')}>
            <span className={cx('text-body', held || a.disputeHold ? 'text-warn' : 'text-muted')}>
              {[held ? t('adminBilling.holdUntil', { when: fmt.dateTime(holdUntil, 'short') }) : '', a.disputeHold ? t('adminBilling.disputeHold') : ''].filter(Boolean).join(' · ') || '—'}
            </span>
          </Row>
          <Row label={t('adminBilling.row.created')}>
            <span className="text-body text-muted">
              {a.createdAt ? fmt.shortDate(timestampDate(a.createdAt)) : '—'} · {t('adminBilling.revision', { n: String(a.revision) })}
            </span>
          </Row>
          <div className="flex flex-wrap gap-2 px-3 py-3" data-testid="admin-billing-actions">
            <Button size="sm" onClick={() => setDialog({ kind: 'credit' })} data-testid="admin-billing-credit">
              {t('adminBilling.credit')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'discount' })}>
              {t('adminBilling.discount')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'hold' })}>
              {held ? t('adminBilling.holdChange') : t('adminBilling.hold')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'reconcile' })}>
              {t('adminBilling.reconcile')}
            </Button>
          </div>
        </Card>

        <section className="flex flex-col gap-1.5">
          <h3 className="px-1 text-caption font-semibold text-muted">{t('billing.history.payments')}</h3>
          <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]" data-testid="admin-billing-payments">
            {payments.isLoading ? <Spinner className="mx-auto my-3" /> : null}
            {payments.data?.payments.length === 0 ? <p className="px-3 py-3 text-body text-muted">{t('billing.history.noPayments')}</p> : null}
            {payments.data?.payments.map((p) => {
              if (!p.payment) return null;
              const refundable = refundableMinor(p.payment, disputeList, refundList);
              return (
                <PaymentRow
                  key={p.payment.id}
                  p={p.payment}
                  extra={
                    refundable > 0n ? (
                      <Button size="sm" variant="destructive" onClick={() => setDialog({ kind: 'refund', payment: p, refundable })} data-testid="admin-billing-refund">
                        {t('adminBilling.refund')}
                      </Button>
                    ) : null
                  }
                />
              );
            })}
          </div>
        </section>

        {(refunds.data?.refunds.length ?? 0) > 0 || (disputes.data?.disputes.length ?? 0) > 0 ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="px-1 text-caption font-semibold text-muted">{t('adminBilling.card.refunds')}</h3>
            <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
              {refunds.data?.refunds.map((r) =>
                r.refund ? (
                  <SimpleRow
                    key={r.refund.id}
                    title={`${t('billing.kind.refund')} ${formatMoney(r.refund.amount)}`}
                    status={r.needsReviewSince ? t('adminBilling.refund.needsReview') : t(REFUND_STATUS[r.refund.status])}
                    danger={!!r.needsReviewSince}
                    sub={[r.refund.createdAt ? fmt.dateTime(timestampDate(r.refund.createdAt), 'short') : '', r.refund.reason, r.providerRefundId].filter(Boolean).join(' · ')}
                    extra={
                      r.needsReviewSince ? (
                        <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'release', refund: r })} data-testid="admin-billing-release">
                          {t('adminBilling.release')}
                        </Button>
                      ) : null
                    }
                  />
                ) : null,
              )}
              {disputes.data?.disputes.map((d) =>
                d.dispute ? (
                  <SimpleRow
                    key={d.dispute.id}
                    title={`${t('billing.kind.dispute')} ${formatMoney(d.dispute.amount)}`}
                    status={t(DISPUTE_STATUS[d.dispute.status])}
                    danger={d.dispute.status === DisputeStatus.OPEN}
                    sub={[d.dispute.createdAt ? fmt.dateTime(timestampDate(d.dispute.createdAt), 'short') : '', d.providerDisputeId].filter(Boolean).join(' · ')}
                  />
                ) : null,
              )}
            </div>
          </section>
        ) : null}

        <section className="flex flex-col gap-1.5">
          <h3 className="px-1 text-caption font-semibold text-muted">{t('billing.history.ledger')}</h3>
          <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body">
            <LedgerTable queryKey={KEY.ledger(id)} fetchPage={(cursor, signal) => adminBilling.ledger(id, cursor, signal)} action={reverseAction} />
          </div>
        </section>
      </Scroll>
      <AccountDialogs a={a} dialog={dialog} currency={cur} onDone={refresh} onClose={() => setDialog(null)} />
    </>
  );
}

const REFUND_STATUS: Record<RefundStatus, MessageKey> = {
  [RefundStatus.UNSPECIFIED]: 'adminBilling.refund.pending',
  [RefundStatus.PENDING]: 'adminBilling.refund.pending',
  [RefundStatus.REQUIRES_ACTION]: 'adminBilling.refund.action',
  [RefundStatus.SUCCEEDED]: 'adminBilling.refund.succeeded',
  [RefundStatus.FAILED]: 'adminBilling.refund.failed',
  [RefundStatus.CANCELED]: 'adminBilling.refund.canceled',
};

const DISPUTE_STATUS: Record<DisputeStatus, MessageKey> = {
  [DisputeStatus.UNSPECIFIED]: 'adminBilling.dispute.open',
  [DisputeStatus.OPEN]: 'adminBilling.dispute.open',
  [DisputeStatus.WON]: 'adminBilling.dispute.won',
  [DisputeStatus.LOST]: 'adminBilling.dispute.lost',
  [DisputeStatus.WITHDRAWN]: 'adminBilling.dispute.withdrawn',
};

const SimpleRow = memo(function SimpleRow({ title, status, sub, error, danger, extra }: { title: string; status?: string; sub?: string; error?: string; danger?: boolean; extra?: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-card-line)] px-3 py-2 last:border-b-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2 text-body">
          <span className="truncate tabular-nums font-medium">{title}</span>
          {status ? <span className={cx('shrink-0 text-caption', danger ? 'text-danger-text' : 'text-muted')}>{status}</span> : null}
        </span>
        {sub ? (
          <span className="truncate text-caption text-faint" title={sub}>
            {sub}
          </span>
        ) : null}
        {error ? <span className="selectable break-words text-caption text-danger-text">{error}</span> : null}
      </span>
      {extra}
    </div>
  );
});

function AccountDialogs({ a, dialog, currency, onDone, onClose }: { a: AdminBillingAccount; dialog: Dialog; currency: string; onDone: () => void; onClose: () => void }): ReactNode {
  const [discount, setDiscount] = useState(() => String(a.discountBps / 100));
  const [holdDays, setHoldDays] = useState('3');
  const [release, setRelease] = useState(false);
  if (!dialog) return null;
  const money = (m: bigint | null) => ({ minor: m ?? 0n, currency });
  if (dialog.kind === 'credit')
    return (
      <MoneyActionDialog
        title={t('adminBilling.creditTitle')}
        text={t('adminBilling.creditText', { name: a.workspaceName })}
        action={t('adminBilling.credit')}
        currency={currency}
        amount
        run={(x: MoneyActionArgs) => adminBilling.manualCredit(a.accountId, { amount: money(x.amount), reason: x.reason, requestId: x.requestId, expectedRevision: a.revision, preview: x.preview })}
        onDone={onDone}
        onClose={onClose}
      />
    );
  if (dialog.kind === 'reverse')
    return (
      <MoneyActionDialog
        title={t('adminBilling.reverseTitle')}
        text={t('adminBilling.reverseText', { amount: formatMoney(dialog.entry.amount), reason: dialog.entry.reason || '—' })}
        action={t('adminBilling.reverse')}
        currency={currency}
        amount={false}
        run={(x) => adminBilling.reverseCredit(a.accountId, dialog.entry.id, { reason: x.reason, requestId: x.requestId, expectedRevision: a.revision, preview: x.preview })}
        onDone={onDone}
        onClose={onClose}
      />
    );
  if (dialog.kind === 'refund') return <RefundDialog payment={dialog.payment} refundable={dialog.refundable} request={dialog.request} currency={currency} onDone={onDone} onClose={onClose} />;
  if (dialog.kind === 'discount') {
    const bps = Math.round(Number(discount.replace(',', '.')) * 100);
    return (
      <MoneyActionDialog
        title={t('adminBilling.discountTitle')}
        text={t('adminBilling.discountText')}
        action={t('common.save')}
        currency={currency}
        amount={false}
        preview={false}
        extra={
          <Field label={t('adminBilling.discountPct')} error={!Number.isFinite(bps) || bps < 0 || bps > 10000 ? t('adminBilling.discountInvalid') : null}>
            <Input inputMode="decimal" className="w-28 tabular-nums mobile:w-full" value={discount} onChange={(e) => setDiscount(e.target.value)} />
          </Field>
        }
        run={(x) => {
          if (!Number.isFinite(bps) || bps < 0 || bps > 10000) return Promise.reject(new Error(t('adminBilling.discountInvalid')));
          return adminBilling.discount(a.accountId, { discountBps: bps, reason: x.reason, requestId: x.requestId, expectedRevision: a.revision });
        }}
        onDone={onDone}
        onClose={onClose}
      />
    );
  }
  if (dialog.kind === 'hold') {
    const days = Number(holdDays);
    return (
      <MoneyActionDialog
        title={t('adminBilling.holdTitle')}
        text={t('adminBilling.holdText')}
        action={release ? t('adminBilling.holdRelease') : t('adminBilling.hold')}
        currency={currency}
        amount={false}
        preview={false}
        extra={
          <>
            <Row label={t('adminBilling.holdRelease')}>
              <Toggle label={t('adminBilling.holdRelease')} checked={release} onChange={setRelease} />
            </Row>
            {release ? null : (
              <Field label={t('adminBilling.holdDays')}>
                <Select value={holdDays} onChange={(e) => setHoldDays(e.target.value)} aria-label={t('adminBilling.holdDays')}>
                  {['1', '3', '7', '14', '30'].map((d) => (
                    <option key={d} value={d}>
                      {plural('adminBilling.nDays', Number(d))}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        }
        run={(x) => adminBilling.hold(a.accountId, { ...(release ? {} : { holdUntil: timestampFromMs(nowMs() + days * 86_400_000) }), reason: x.reason, requestId: x.requestId })}
        onDone={onDone}
        onClose={onClose}
      />
    );
  }
  if (dialog.kind === 'release') {
    const refundId = dialog.refund.refund?.id ?? '';
    return (
      <MoneyActionDialog
        title={t('adminBilling.releaseTitle')}
        text={t('adminBilling.releaseText', { amount: formatMoney(dialog.refund.refund?.amount) })}
        action={t('adminBilling.release')}
        currency={currency}
        amount={false}
        preview={false}
        destructive
        run={(x) => adminBilling.reconcile(a.accountId, { reason: x.reason, requestId: x.requestId, releaseRefundIds: [refundId] })}
        onDone={onDone}
        onClose={onClose}
      />
    );
  }
  return (
    <MoneyActionDialog
      title={t('adminBilling.reconcileTitle')}
      text={t('adminBilling.reconcileText')}
      action={t('adminBilling.reconcile')}
      currency={currency}
      amount={false}
      preview={false}
      run={(x) => adminBilling.reconcile(a.accountId, { reason: x.reason, requestId: x.requestId })}
      onDone={onDone}
      onClose={onClose}
    />
  );
}

function RefundDialog({
  payment,
  refundable,
  request,
  currency,
  extra,
  onDone,
  onClose,
}: {
  payment: AdminBillingPayment;
  /** refundableMinor of the payment: the dialog never offers more. */
  refundable: bigint;
  request?: AdminBillingRefundRequest | undefined;
  currency: string;
  extra?: ReactNode;
  onDone: () => void;
  onClose: () => void;
}): ReactNode {
  const want = minorOf(request?.request?.amount);
  return (
    <MoneyActionDialog
      title={t('adminBilling.refundTitle')}
      text={t('adminBilling.refundText', { amount: formatMoney(payment.payment?.amount), id: payment.providerPaymentId })}
      action={t('adminBilling.refund')}
      currency={currency}
      amount
      maxAmount={refundable}
      initialAmount={want > 0n && want <= refundable ? want : refundable}
      extra={extra}
      run={(x) =>
        adminBilling.refund(payment.payment?.id ?? '', {
          amount: { minor: x.amount ?? 0n, currency },
          reason: x.reason,
          requestId: x.requestId,
          preview: x.preview,
          ...(request?.request ? { refundRequestId: request.request.id } : {}),
        })
      }
      onDone={onDone}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------- refund requests

function RequestsPage({ onClose, notice }: { onClose: () => void; notice: ReactNode }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY.requests, queryFn: ({ signal }) => adminBilling.refundRequests({ open: true }, signal), retry: false });
  const [deciding, setDeciding] = useState<AdminBillingRefundRequest | null>(null);
  const [rejecting, setRejecting] = useState<AdminBillingRefundRequest | null>(null);
  const list = q.data?.requests ?? [];
  const done = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['admin', 'billing'] });
  }, [qc]);
  return (
    <>
      <PaneHeader title={t('adminBilling.nav.requests')} onClose={onClose} />
      {notice}
      <Scroll testId="admin-billing-requests">
        <p className="px-1 text-caption text-muted">{t('adminBilling.requestsHint')}</p>
        <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
          {q.isLoading ? <Spinner className="mx-auto my-3" /> : null}
          {q.isError && !recentAuthRequired(q.error) ? <p className="px-3 py-3 text-body text-danger-text">{billingErrorText(q.error)}</p> : null}
          {q.isSuccess && list.length === 0 ? <p className="px-3 py-3 text-body text-muted">{t('adminBilling.requestsNone')}</p> : null}
          {list.map((r) =>
            r.request ? (
              <RefundRequestRow
                key={r.request.id}
                r={r.request}
                extra={
                  <span className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(r)} data-testid="admin-billing-reject">
                      {t('adminBilling.reject')}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setDeciding(r)} data-testid="admin-billing-decide">
                      {t('adminBilling.decide')}
                    </Button>
                  </span>
                }
              />
            ) : null,
          )}
        </div>
      </Scroll>
      {deciding ? <DecideDialog r={deciding} onClose={() => setDeciding(null)} onDone={done} /> : null}
      {rejecting ? <RejectDialog r={rejecting} onClose={() => setRejecting(null)} onDone={done} /> : null}
    </>
  );
}

/** Rejects an owner's refund request: no money moves, the reason goes to the audit log. */
function RejectDialog({ r, onClose, onDone }: { r: AdminBillingRefundRequest; onClose: () => void; onDone: () => void }): ReactNode {
  const id = r.request?.id ?? '';
  return (
    <MoneyActionDialog
      title={t('adminBilling.rejectTitle')}
      text={t('adminBilling.rejectText', { amount: formatMoney(r.request?.amount) })}
      action={t('adminBilling.reject')}
      currency={r.request?.amount?.currency || 'USD'}
      amount={false}
      preview={false}
      destructive
      run={(x) => adminBilling.decideRefundRequest(id, rejectRefundRequest(x))}
      onDone={onDone}
      onClose={onClose}
    />
  );
}

/** Executes an owner's refund request as a refund of one of the account's payments. */
function DecideDialog({ r, onClose, onDone }: { r: AdminBillingRefundRequest; onClose: () => void; onDone: () => void }): ReactNode {
  const payments = useQuery({ queryKey: KEY.payments(r.accountId), queryFn: ({ signal }) => adminBilling.payments({ accountId: r.accountId }, signal), retry: false });
  const disputes = useQuery({ queryKey: KEY.disputes(r.accountId), queryFn: ({ signal }) => adminBilling.disputes({ accountId: r.accountId }, signal), retry: false });
  const refunds = useQuery({ queryKey: KEY.refunds(r.accountId), queryFn: ({ signal }) => adminBilling.refunds({ accountId: r.accountId }, signal), retry: false });
  const disputeList = (disputes.data?.disputes ?? []).map((d) => d.dispute);
  const refundList = (refunds.data?.refunds ?? []).map((x) => x.refund);
  const options = (payments.data?.payments ?? [])
    .map((p) => ({ p, refundable: refundableMinor(p.payment, disputeList, refundList) }))
    .filter((o) => o.refundable > 0n);
  const [pid, setPid] = useState('');
  const chosen = options.find((o) => o.p.payment?.id === pid) ?? options[0];
  const currency = r.request?.amount?.currency || 'USD';
  if (payments.isLoading || disputes.isLoading || refunds.isLoading) return null;
  if (!chosen) {
    return (
      <Modal open onClose={onClose} title={t('adminBilling.decide')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
        <p className="text-body text-muted">{payments.isError ? billingErrorText(payments.error) : t('adminBilling.noRefundable')}</p>
      </Modal>
    );
  }
  const picker =
    options.length > 1 ? (
      <Field label={t('adminBilling.pickPayment')}>
        <Select aria-label={t('adminBilling.pickPayment')} value={chosen.p.payment?.id ?? ''} onChange={(e) => setPid(e.target.value)}>
          {options.map(({ p, refundable }) => (
            <option key={p.payment?.id} value={p.payment?.id}>
              {`${formatMoney(p.payment?.amount)} · ${p.payment?.succeededAt ? fmt.shortDate(timestampDate(p.payment.succeededAt)) : ''} · ${t('adminBilling.refundable', { amount: formatMinor(refundable, currency) })}`}
            </option>
          ))}
        </Select>
      </Field>
    ) : null;
  return <RefundDialog key={chosen.p.payment?.id} payment={chosen.p} refundable={chosen.refundable} request={r} currency={currency} extra={picker} onDone={onDone} onClose={onClose} />;
}

// ---------------------------------------------------------------- prices

function PricesPage({ onClose, notice }: { onClose: () => void; notice: ReactNode }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY.prices, queryFn: ({ signal }) => adminBilling.prices(signal), retry: false });
  const [market, setMarket] = useState('global');
  const [plan, setPlan] = useState<'TEAM' | 'ENTERPRISE'>('TEAM');
  const currency = market === 'ru' ? 'RUB' : 'USD';
  const [openedAt] = useState(nowMs);
  // The server wants effective_from >= now + 10 d; a date input is a UTC midnight, so the first
  // allowed day is the one after now + 10 d.
  const minDate = new Date(openedAt + PRICE_LEAD_DAYS * 86_400_000);
  const minInput = new Date(openedAt + (PRICE_LEAD_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
  const [raw, setRaw] = useState('');
  const [from, setFrom] = useState(minInput);
  const [open, setOpen] = useState(false);
  const unit = parseMajor(raw, currency);
  const fromDate = from ? new Date(`${from}T00:00:00Z`) : null;
  const tooSoon = !fromDate || fromDate.getTime() < minDate.getTime();
  const prices = [...(q.data?.prices ?? [])].sort((x, y) => Number((y.effectiveFrom?.seconds ?? 0n) - (x.effectiveFrom?.seconds ?? 0n)));
  return (
    <>
      <PaneHeader title={t('adminBilling.nav.prices')} onClose={onClose} />
      {notice}
      <Scroll testId="admin-billing-prices">
        <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
          {q.isLoading ? <Spinner className="mx-auto my-3" /> : null}
          {prices.map((p) => {
            const future = p.effectiveFrom ? timestampDate(p.effectiveFrom).getTime() > openedAt : false;
            return (
              <SimpleRow
                key={p.id}
                title={`${t(planOf(p.plan) === Plan.ENTERPRISE ? 'plan.name.enterprise' : 'plan.name.team')} · ${formatMoney(p.unit)}`}
                status={future ? t('adminBilling.priceFuture') : undefined}
                sub={[p.market, p.sku, p.effectiveFrom ? t('adminBilling.priceFrom', { when: fmt.shortDate(timestampDate(p.effectiveFrom)) }) : ''].filter(Boolean).join(' · ')}
              />
            );
          })}
        </div>
        <Card title={t('adminBilling.priceNew')} footer={t('adminBilling.priceHint', { days: PRICE_LEAD_DAYS })}>
          <Row label={t('adminBilling.row.market')}>
            <Select className="w-36" value={market} onChange={(e) => setMarket(e.target.value)} aria-label={t('adminBilling.row.market')}>
              <option value="global">global · USD</option>
              <option value="ru">ru · RUB</option>
            </Select>
          </Row>
          <Row label={t('plan.row.plan')}>
            <Segmented<'TEAM' | 'ENTERPRISE'>
              label={t('plan.row.plan')}
              value={plan}
              onChange={setPlan}
              options={[
                { value: 'TEAM', label: t('plan.name.team') },
                { value: 'ENTERPRISE', label: t('plan.name.enterprise') },
              ]}
            />
          </Row>
          <Row label={t('adminBilling.priceUnit', { currency })}>
            <Input inputMode="decimal" className="w-28 tabular-nums" aria-label={t('adminBilling.priceUnit', { currency })} value={raw} onChange={(e) => setRaw(e.target.value)} />
          </Row>
          <Row label={t('adminBilling.priceFromLabel')} hint={tooSoon ? t('adminBilling.priceTooSoon', { date: fmt.shortDate(minDate) }) : undefined}>
            <Input type="date" min={minInput} className="w-40 [color-scheme:inherit]" aria-label={t('adminBilling.priceFromLabel')} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Row>
          <div className="flex justify-end px-3 py-3">
            <Button size="sm" disabled={unit === null || unit <= 0n || tooSoon} onClick={() => setOpen(true)} data-testid="admin-billing-price-create">
              {t('adminBilling.priceCreate')}
            </Button>
          </div>
        </Card>
      </Scroll>
      {open && unit !== null && fromDate ? (
        <MoneyActionDialog
          title={t('adminBilling.priceNew')}
          text={t('adminBilling.priceConfirm', { plan: t(plan === 'ENTERPRISE' ? 'plan.name.enterprise' : 'plan.name.team'), unit: formatMinor(unit, currency), when: fmt.shortDate(fromDate) })}
          action={t('adminBilling.priceCreate')}
          currency={currency}
          amount={false}
          preview={false}
          run={(x) => adminBilling.createPrice({ market, plan: Plan[plan], unit: { minor: unit, currency }, effectiveFrom: timestampFromDate(fromDate), reason: x.reason, requestId: x.requestId })}
          onDone={() => {
            setRaw('');
            void qc.invalidateQueries({ queryKey: KEY.prices });
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- provider events

const EventRow = memo(function EventRow({ e }: { e: AdminProviderEvent }): ReactNode {
  return (
    <SimpleRow
      title={e.kind}
      status={e.error ? t('adminBilling.eventFailed', { n: e.attempts }) : e.processedAt ? t('adminBilling.eventOk') : t('adminBilling.eventPending')}
      danger={!!e.error}
      sub={[e.receivedAt ? fmt.dateTime(timestampDate(e.receivedAt), 'short') : '', e.provider, e.eventId, e.objectId, e.livemode ? 'live' : 'test'].filter(Boolean).join(' · ')}
      error={e.error}
    />
  );
});

function EventsPage({ onClose, notice }: { onClose: () => void; notice: ReactNode }): ReactNode {
  const [failed, setFailed] = useState(true);
  const q = useQuery({ queryKey: KEY.events(failed), queryFn: ({ signal }) => adminBilling.events({ open: failed }, signal), retry: false });
  const list = q.data?.events ?? [];
  return (
    <>
      <PaneHeader title={t('adminBilling.nav.events')} onClose={onClose} />
      {notice}
      <Scroll testId="admin-billing-events">
        <div className="flex items-center justify-between gap-3 px-1">
          <span className="text-caption text-muted">{t('adminBilling.eventsOnlyFailed')}</span>
          <Toggle label={t('adminBilling.eventsOnlyFailed')} checked={failed} onChange={setFailed} />
        </div>
        <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
          {q.isLoading ? <Spinner className="mx-auto my-3" /> : null}
          {q.isSuccess && list.length === 0 ? <p className="px-3 py-3 text-body text-muted">{t('adminBilling.eventsNone')}</p> : null}
          {list.map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
        </div>
      </Scroll>
    </>
  );
}

// ---------------------------------------------------------------- workspace card (enable)

/** In the workspaces section's detail: enable billing (creates the inactive account) or open it. */
export function AdminBillingWorkspaceCard({ workspaceId, name, state, onOpen }: { workspaceId: string; name: string; state: BillingState; onOpen: () => void }): ReactNode {
  const qc = useQueryClient();
  const [plan, setPlan] = useState<'TEAM' | 'ENTERPRISE'>('TEAM');
  const [open, setOpen] = useState(false);
  const enabled = state !== BillingState.UNSPECIFIED;
  return (
    <Card title={t('adminBilling.ws.title')} footer={enabled ? undefined : t('adminBilling.ws.hint')}>
      {enabled ? (
        <Row label={t('adminBilling.ws.state')}>
          <StatePill state={state} />
          <Button size="sm" variant="secondary" onClick={onOpen}>
            {t('adminBilling.ws.open')}
          </Button>
        </Row>
      ) : (
        <>
          <Row label={t('plan.row.plan')}>
            <Segmented<'TEAM' | 'ENTERPRISE'>
              label={t('plan.row.plan')}
              value={plan}
              onChange={setPlan}
              options={[
                { value: 'TEAM', label: t('plan.name.team') },
                { value: 'ENTERPRISE', label: t('plan.name.enterprise') },
              ]}
            />
          </Row>
          <div className="flex justify-end px-3 py-3">
            <Button size="sm" onClick={() => setOpen(true)} data-testid="admin-billing-enable">
              {t('adminBilling.ws.enable')}
            </Button>
          </div>
        </>
      )}
      {open ? (
        <MoneyActionDialog
          title={t('adminBilling.ws.enableTitle')}
          text={t('adminBilling.ws.enableText', { name, plan: t(plan === 'ENTERPRISE' ? 'plan.name.enterprise' : 'plan.name.team') })}
          action={t('adminBilling.ws.enable')}
          currency="USD"
          amount={false}
          preview={false}
          run={(x) => adminBilling.enable(workspaceId, { market: 'global', plan: Plan[plan], reason: x.reason, requestId: x.requestId })}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ['admin'] });
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Card>
  );
}
