import {
  AutoTopupAttemptStatus,
  BillingAccountStatus,
  BillingSalesMode,
  BillingState,
  DisputeStatus,
  LedgerEntryKind,
  Plan,
  RefundStatus,
  type AdminBillingAccount,
  type AdminChargeAttempt,
  type AdminBillingPayment,
  type AdminManualRefund,
  type AdminBillingIssue,
  type AdminBillingMutationResult,
  type AdminProviderEvent,
  type LedgerEntry,
} from '@calaba/protocol';
import { timestampDate, timestampFromDate, timestampFromMs } from '@bufbuild/protobuf/wkt';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ChevronLeft, Copy, Landmark, Search, Tags, TriangleAlert } from 'lucide-react';
import { createContext, memo, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, CloseButton, Empty, Field, Input, Modal, Row, Segmented, Select, Spinner, Toggle, cx } from '../../../components/ui';
import { toast } from '../../../stores/toasts';
import { plural, t, type MessageKey } from '../../../i18n';
import { recentAuthRequired } from '../../../lib/api/errors';
import { billingErrorText } from '../../../lib/billing/errors';
import { nowMs } from '../../../lib/billing/checkout';
import { chargebackableMinor, refundableMinor } from '../../../lib/billing/model';
import { refundOutcome } from '../../../lib/billing/adminForm';
import { providerTag } from '../../../lib/billing/market';
import { formatMinor, formatMoney, minorOf, parseMajor } from '../../../lib/billing/money';
import { cardLabel } from '../../../lib/billing/savedTopup';
import { fmt } from '../../../lib/format';
import { adminBilling } from '../../../services/billing';
import { PlanPill } from '../../workspace/PlanTab';
import { LedgerTable, PaymentRow } from '../../workspace/billing/HistoryCard';
import { MoneyText, StatePill } from '../../workspace/billing/parts';
import { CustomPlanCard } from './CustomPlanCard';
import { MoneyActionDialog, type MoneyActionArgs } from './MoneyAction';

/**
 * «Оплата» in the superadmin window (ADR-0080 §13, docs/plans/billing-v1-tasks T6): billing
 * accounts (search by workspace / owner e-mail), an account (balance, ledger, payments, refunds,
 * disputes) with the money actions — manual credit / its reversal, refund of a payment (≤
 * refundable; synchronous: the bank's answer is shown at once, ADR-0083 amendment 2026-10-10),
 * hold, discount, «Сверить» — «Требует внимания» (refunds the bank executed without Calab), price
 * versions (from now + 10 days) and provider events with errors. Every money action: reason +
 * preview + confirm; the window's password notice handles RECENT_AUTH_REQUIRED.
 */

export type AdminSection = 'workspaces' | 'billing';
export type BillingView = { kind: 'account'; id: string } | { kind: 'attention' } | { kind: 'prices' } | { kind: 'events' } | { kind: 'providers' } | null;

const KEY = {
  accounts: (q: string, lapsed: boolean) => ['admin', 'billing', 'accounts', q, lapsed] as const,
  account: (id: string) => ['admin', 'billing', 'account', id] as const,
  ledger: (id: string) => ['admin', 'billing', 'ledger', id] as const,
  payments: (id: string) => ['admin', 'billing', 'payments', id] as const,
  refunds: (id: string) => ['admin', 'billing', 'refunds', id] as const,
  disputes: (id: string) => ['admin', 'billing', 'disputes', id] as const,
  issues: (account: string) => ['admin', 'billing', 'issues', account] as const,
  prices: ['admin', 'billing', 'prices'] as const,
  events: (open: boolean) => ['admin', 'billing', 'events', open] as const,
  providers: ['admin', 'billing', 'providers'] as const,
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

/** The pill for an account: arrears when active with debt, «не активен» when stopped in the restricted mode. */
const accountState = (a: AdminBillingAccount): BillingState =>
  a.status === BillingAccountStatus.ACTIVE && minorOf(a.debt) > 0n
    ? BillingState.IN_ARREARS
    : a.status === BillingAccountStatus.STOPPED && a.lapsed
      ? BillingState.LAPSED
      : ACCOUNT_STATE[a.status];

/** The list's status word: the pill's state wording for arrears and the restricted mode. */
const accountStatusKey = (a: AdminBillingAccount): MessageKey => {
  const st = accountState(a);
  return st === BillingState.IN_ARREARS ? 'billing.state.arrears' : st === BillingState.LAPSED ? 'billing.state.lapsed' : STATUS_KEY[a.status];
};

const planOf = (p: Plan): Plan => (p === Plan.ENTERPRISE || p === Plan.CUSTOM ? p : Plan.TEAM);

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
        'flex w-full shrink-0 flex-col gap-0.5 rounded-[var(--radius-card)] px-3 py-2 text-left transition-colors duration-[var(--motion-fast)]',
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
        <span className="shrink-0 whitespace-nowrap">{t(accountStatusKey(a))}</span>
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
  const [lapsedOnly, setLapsedOnly] = useState(false);
  const list = useQuery({
    queryKey: KEY.accounts(dq, lapsedOnly),
    queryFn: ({ signal }) => adminBilling.accounts({ q: dq, lapsed: lapsedOnly }, signal),
    placeholderData: keepPreviousData,
    retry: false,
  });
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
        <NavButton icon={<TriangleAlert className="size-4 shrink-0" aria-hidden />} label={t('adminBilling.nav.attention')} active={view?.kind === 'attention'} onClick={() => onView({ kind: 'attention' })} testId="admin-billing-nav-attention" />
        <NavButton icon={<Tags className="size-4 shrink-0" aria-hidden />} label={t('adminBilling.nav.prices')} active={view?.kind === 'prices'} onClick={() => onView({ kind: 'prices' })} testId="admin-billing-nav-prices" />
        <NavButton icon={<Activity className="size-4 shrink-0" aria-hidden />} label={t('adminBilling.nav.events')} active={view?.kind === 'events'} onClick={() => onView({ kind: 'events' })} testId="admin-billing-nav-events" />
        <NavButton icon={<Landmark className="size-4 shrink-0" aria-hidden />} label={t('adminBilling.nav.providers')} active={view?.kind === 'providers'} onClick={() => onView({ kind: 'providers' })} testId="admin-billing-nav-providers" />
      </div>
      <Segmented<'all' | 'lapsed'>
        label={t('adminBilling.filter')}
        value={lapsedOnly ? 'lapsed' : 'all'}
        onChange={(v) => setLapsedOnly(v === 'lapsed')}
        options={[
          { value: 'all', label: t('adminBilling.filter.all') },
          { value: 'lapsed', label: t('billing.state.lapsed') },
        ]}
      />
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

/**
 * Phone (≤ 768 px): the list and an account page are separate screens; the pane's header carries a
 * «back» to the list (`mobile:` only — the desktop keeps both columns).
 */
const BackToList = createContext<(() => void) | null>(null);

function PaneHeader({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }): ReactNode {
  const back = useContext(BackToList);
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line pl-6 pr-3 mobile:pl-2">
      {back ? (
        <button
          type="button"
          onClick={back}
          aria-label={t('adminBilling.back')}
          className="hidden size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] mobile:inline-flex"
          data-testid="admin-billing-back"
        >
          <ChevronLeft className="size-5" aria-hidden />
        </button>
      ) : null}
      <h2 className="flex min-w-0 flex-1 items-center gap-2 text-headline font-semibold mobile:flex-wrap mobile:gap-y-0.5">
        <span className="min-w-0 truncate">{title}</span>
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
export function AdminBillingPane({ view, onClose, onBack, notice }: { view: BillingView; onClose: () => void; onBack: () => void; notice: ReactNode }): ReactNode {
  return (
    <BackToList.Provider value={onBack}>
      <BillingPaneBody view={view} onClose={onClose} notice={notice} />
    </BackToList.Provider>
  );
}

function BillingPaneBody({ view, onClose, notice }: { view: BillingView; onClose: () => void; notice: ReactNode }): ReactNode {
  if (view?.kind === 'account') return <AccountDetail key={view.id} id={view.id} onClose={onClose} notice={notice} />;
  if (view?.kind === 'attention') return <AttentionPage onClose={onClose} notice={notice} />;
  if (view?.kind === 'prices') return <PricesPage onClose={onClose} notice={notice} />;
  if (view?.kind === 'events') return <EventsPage onClose={onClose} notice={notice} />;
  if (view?.kind === 'providers') return <ProvidersPage onClose={onClose} notice={notice} />;
  return (
    <>
      <PaneHeader title={t('adminBilling.section.billing')} onClose={onClose} />
      {notice}
      <div className="grid flex-1 place-items-center">{notice ? null : <Empty>{t('adminBilling.pick')}</Empty>}</div>
    </>
  );
}

// ---------------------------------------------------------------- acquirers (ADR-0083)

const MODE_KEY: Record<BillingSalesMode, MessageKey> = {
  [BillingSalesMode.UNSPECIFIED]: 'adminBilling.providers.modeContact',
  [BillingSalesMode.BOTH]: 'adminBilling.providers.modeBoth',
  [BillingSalesMode.RU_ONLY]: 'adminBilling.providers.modeRu',
  [BillingSalesMode.GLOBAL_ONLY]: 'adminBilling.providers.modeGlobal',
  [BillingSalesMode.CONTACT]: 'adminBilling.providers.modeContact',
};

const PROVIDER_NAME: Record<string, string> = { stripe: 'Stripe', tochka: 'Точка' };

/** «Эквайеры»: the configured acquirers and their «принимать новых клиентов» switch (audited, with a reason). */
function ProvidersPage({ onClose, notice }: { onClose: () => void; notice: ReactNode }): ReactNode {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: KEY.providers, queryFn: ({ signal }) => adminBilling.providers(signal), retry: false });
  const [toggle, setToggle] = useState<{ id: string; open: boolean } | null>(null);
  const name = (id: string): string => PROVIDER_NAME[id] ?? id;
  return (
    <>
      <PaneHeader title={t('adminBilling.providers.title')} onClose={onClose} />
      {notice}
      <Scroll testId="admin-billing-providers">
        <Card title={t('adminBilling.providers.title')} footer={t('adminBilling.providers.hint')}>
          {list.isLoading ? <Spinner className="mx-auto my-3" /> : null}
          {list.isError && !recentAuthRequired(list.error) ? <p className="px-3 py-3 text-body text-danger-text">{billingErrorText(list.error)}</p> : null}
          {list.data?.providers.map((p) => (
            <Row key={p.id} label={name(p.id)} hint={t('adminBilling.providers.markets', { markets: p.markets.join(', ') })}>
              <Toggle label={t('adminBilling.providers.acceptNew')} checked={p.acceptNew} onChange={(open) => setToggle({ id: p.id, open })} />
            </Row>
          ))}
          {list.data ? (
            <p className="px-3 py-2 text-caption text-muted" data-testid="admin-billing-providers-mode">
              {t('adminBilling.providers.mode', { mode: t(MODE_KEY[list.data.mode]) })}
            </p>
          ) : null}
        </Card>
      </Scroll>
      {toggle ? (
        <MoneyActionDialog
          title={t(toggle.open ? 'adminBilling.providers.openTitle' : 'adminBilling.providers.closeTitle', { name: name(toggle.id) })}
          text={t(toggle.open ? 'adminBilling.providers.openText' : 'adminBilling.providers.closeText')}
          action={t('common.save')}
          currency="USD"
          amount={false}
          preview={false}
          destructive={!toggle.open}
          run={(x) => adminBilling.setProvider(toggle.id, { acceptNew: toggle.open, reason: x.reason, requestId: x.requestId })}
          onDone={() => void qc.invalidateQueries({ queryKey: KEY.providers })}
          onClose={() => setToggle(null)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- account

type Dialog =
  | { kind: 'credit' }
  | { kind: 'reverse'; entry: LedgerEntry }
  | { kind: 'refund'; payment: AdminBillingPayment; refundable: bigint }
  | { kind: 'hold' }
  | { kind: 'discount' }
  | { kind: 'reconcile' }
  | { kind: 'issue'; issue: AdminBillingIssue; action: 'import' | 'dismiss' }
  | { kind: 'market' }
  | { kind: 'checkCharge'; attemptId: string }
  | { kind: 'chargeback'; payment: AdminBillingPayment; max: bigint }
  | { kind: 'closeDispute'; disputeId: string }
  | null;

function AccountDetail({ id, onClose, notice }: { id: string; onClose: () => void; notice: ReactNode }): ReactNode {
  const qc = useQueryClient();
  const acc = useQuery({ queryKey: KEY.account(id), queryFn: ({ signal }) => adminBilling.account(id, signal), retry: false });
  const payments = useQuery({ queryKey: KEY.payments(id), queryFn: ({ signal }) => adminBilling.payments({ accountId: id }, signal), retry: false });
  const refunds = useQuery({ queryKey: KEY.refunds(id), queryFn: ({ signal }) => adminBilling.refunds({ accountId: id }, signal), retry: false });
  const disputes = useQuery({ queryKey: KEY.disputes(id), queryFn: ({ signal }) => adminBilling.disputes({ accountId: id }, signal), retry: false });
  const issues = useQuery({ queryKey: KEY.issues(id), queryFn: ({ signal }) => adminBilling.issues({ accountId: id }, signal), retry: false });
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
        <PlanPill plan={planOf(a.plan)} name={a.planDisplayName} />
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
            <span className="flex items-center gap-2 text-body text-muted">
              {a.market} · {cur}
              {a.status === BillingAccountStatus.INACTIVE && minorOf(a.balance) === 0n ? (
                <Button size="sm" variant="ghost" className="h-5 px-1.5" onClick={() => setDialog({ kind: 'market' })} data-testid="admin-billing-market">
                  {t('adminBilling.market.change')}
                </Button>
              ) : null}
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
          {details.savedMethods.map((m) => (
            <Row key={m.id} label={t('billing.card.saved')} hint={providerTag(m.provider) || undefined}>
              <span className="text-body tabular-nums text-muted" data-testid="admin-billing-card">
                {cardLabel(m)}
              </span>
            </Row>
          ))}
          {details.lastCharge ? <ChargeRow c={details.lastCharge} onCheck={(attemptId) => setDialog({ kind: 'checkCharge', attemptId })} /> : null}
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

        <CustomPlanCard details={details} onDone={refresh} />

        <section className="flex flex-col gap-1.5">
          <h3 className="px-1 text-caption font-semibold text-muted">{t('billing.history.payments')}</h3>
          <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]" data-testid="admin-billing-payments">
            {payments.isLoading ? <Spinner className="mx-auto my-3" /> : null}
            {payments.data?.payments.length === 0 ? <p className="px-3 py-3 text-body text-muted">{t('billing.history.noPayments')}</p> : null}
            {payments.data?.payments.map((p) => {
              if (!p.payment) return null;
              const refundable = refundableMinor(p.payment, disputeList, refundList);
              const chargeable = chargebackableMinor(p.payment, disputeList);
              return (
                <PaymentRow
                  key={p.payment.id}
                  p={p.payment}
                  extra={
                    refundable > 0n || chargeable > 0n ? (
                      <span className="flex shrink-0 gap-1.5 mobile:order-last mobile:w-full mobile:justify-end">
                        {chargeable > 0n ? (
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'chargeback', payment: p, max: chargeable })} data-testid="admin-billing-chargeback">
                            {t('adminBilling.chargeback')}
                          </Button>
                        ) : null}
                        {refundable > 0n ? (
                          <Button size="sm" variant="destructive" onClick={() => setDialog({ kind: 'refund', payment: p, refundable })} data-testid="admin-billing-refund">
                            {t('adminBilling.refund')}
                          </Button>
                        ) : null}
                      </span>
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
                    status={t(REFUND_STATUS[r.refund.status])}
                    danger={r.refund.status === RefundStatus.PENDING || r.refund.status === RefundStatus.REQUIRES_ACTION}
                    sub={[r.refund.createdAt ? fmt.dateTime(timestampDate(r.refund.createdAt), 'short') : '', r.refund.reason, r.providerRefundId].filter(Boolean).join(' · ')}
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
                    extra={
                      d.dispute.status === DisputeStatus.OPEN && d.providerDisputeId.startsWith(MANUAL_DISPUTE) ? (
                        <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'closeDispute', disputeId: d.dispute?.id ?? '' })} data-testid="admin-billing-dispute-close">
                          {t('adminBilling.dispute.close')}
                        </Button>
                      ) : null
                    }
                  />
                ) : null,
              )}
            </div>
          </section>
        ) : null}

        {(issues.data?.issues.length ?? 0) > 0 ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="px-1 text-caption font-semibold text-muted">{t('adminBilling.nav.attention')}</h3>
            <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]" data-testid="admin-billing-issues">
              {issues.data?.issues.map((i) => (
                <IssueRow key={i.id} issue={i} onAction={(action) => setDialog({ kind: 'issue', issue: i, action })} />
              ))}
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

/** A chargeback recorded by hand (POST …/payments/{id}/chargebacks): only these are closed here. */
const MANUAL_DISPUTE = 'manual:';

const CHARGE_STATUS: Record<AutoTopupAttemptStatus, MessageKey> = {
  [AutoTopupAttemptStatus.UNSPECIFIED]: 'adminBilling.charge.status.open',
  [AutoTopupAttemptStatus.PREPARED]: 'adminBilling.charge.status.open',
  [AutoTopupAttemptStatus.DISPATCHED]: 'adminBilling.charge.status.open',
  [AutoTopupAttemptStatus.REQUIRES_ACTION]: 'adminBilling.charge.status.open',
  [AutoTopupAttemptStatus.UNKNOWN]: 'adminBilling.charge.status.unknown',
  [AutoTopupAttemptStatus.SUCCEEDED]: 'adminBilling.charge.status.succeeded',
  [AutoTopupAttemptStatus.FAILED]: 'adminBilling.charge.status.failed',
};

/** The newest saved-card charge of the account (audit M6): its state and «Проверить списание сейчас». */
const ChargeRow = memo(function ChargeRow({ c, onCheck }: { c: AdminChargeAttempt; onCheck: (attemptId: string) => void }): ReactNode {
  const att = c.attempt;
  if (!att) return null;
  const status = att.status;
  const open = status === AutoTopupAttemptStatus.UNKNOWN || status === AutoTopupAttemptStatus.DISPATCHED || status === AutoTopupAttemptStatus.PREPARED || status === AutoTopupAttemptStatus.REQUIRES_ACTION;
  const sub = [
    t(c.kind === 'manual' ? 'adminBilling.charge.kind.manual' : 'adminBilling.charge.kind.auto'),
    att.createdAt ? fmt.dateTime(timestampDate(att.createdAt), 'short') : '',
    att.failureCode,
    open && c.resolveBy ? t('adminBilling.charge.resolveBy', { when: fmt.dateTime(timestampDate(c.resolveBy), 'short') }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Row label={t('adminBilling.row.charge')} hint={sub}>
      <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1" data-testid="admin-billing-charge">
        <span className={cx('whitespace-nowrap text-body tabular-nums', status === AutoTopupAttemptStatus.UNKNOWN ? 'text-warn' : 'text-muted')}>
          {formatMoney(att.amount)} · {t(CHARGE_STATUS[status])}
        </span>
        {c.checkable ? (
          <Button size="sm" variant="ghost" className="h-5 px-1.5" onClick={() => onCheck(att.id)} data-testid="admin-billing-check-charge">
            {t('adminBilling.charge.check')}
          </Button>
        ) : null}
      </span>
    </Row>
  );
});

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
  const [market, setMarket] = useState<'global' | 'ru'>(a.market === 'ru' ? 'global' : 'ru');
  const [bankRef, setBankRef] = useState('');
  const [outcome, setOutcome] = useState<'won' | 'lost'>('won');
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
  if (dialog.kind === 'refund') return <RefundDialog payment={dialog.payment} refundable={dialog.refundable} currency={currency} onDone={onDone} onClose={onClose} />;
  if (dialog.kind === 'issue') return <IssueDialog issue={dialog.issue} action={dialog.action} onDone={onDone} onClose={onClose} />;
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
  if (dialog.kind === 'market')
    return (
      <MoneyActionDialog
        title={t('adminBilling.market.title')}
        text={t('adminBilling.market.text')}
        action={t('adminBilling.market.change')}
        currency={currency}
        amount={false}
        extra={
          <Segmented<'global' | 'ru'>
            label={t('billing.market.label')}
            value={market}
            onChange={setMarket}
            options={[
              { value: 'global', label: t('billing.market.global') },
              { value: 'ru', label: t('billing.market.ru') },
            ]}
          />
        }
        run={(x) => adminBilling.changeMarket(a.accountId, { market, reason: x.reason, requestId: x.requestId, expectedRevision: a.revision, preview: x.preview })}
        onDone={onDone}
        onClose={onClose}
      />
    );
  if (dialog.kind === 'checkCharge')
    return (
      <MoneyActionDialog
        title={t('adminBilling.charge.checkTitle')}
        text={t('adminBilling.charge.checkText')}
        action={t('adminBilling.charge.check')}
        currency={currency}
        amount={false}
        preview={false}
        run={(x) => adminBilling.checkCharge(a.accountId, dialog.attemptId, { reason: x.reason, requestId: x.requestId })}
        onDone={onDone}
        onClose={onClose}
      />
    );
  if (dialog.kind === 'chargeback') {
    const refOk = bankRef.trim().length >= 3 && bankRef.trim().length <= 100;
    return (
      <MoneyActionDialog
        title={t('adminBilling.chargebackTitle')}
        text={t('adminBilling.chargebackText')}
        action={t('adminBilling.chargeback')}
        currency={currency}
        amount
        maxAmount={dialog.max}
        destructive
        extra={
          <Field label={t('adminBilling.bankReference')} error={bankRef !== '' && !refOk ? t('adminBilling.bankReferenceInvalid') : null}>
            <Input value={bankRef} maxLength={100} onChange={(e) => setBankRef(e.target.value)} data-testid="admin-billing-bank-reference" />
          </Field>
        }
        run={(x) => {
          if (!refOk) return Promise.reject(new Error(t('adminBilling.bankReferenceInvalid')));
          return adminBilling.recordChargeback(dialog.payment.payment?.id ?? '', {
            amount: money(x.amount),
            bankReference: bankRef.trim(),
            reason: x.reason,
            requestId: x.requestId,
            expectedRevision: a.revision,
            preview: x.preview,
          });
        }}
        onDone={onDone}
        onClose={onClose}
      />
    );
  }
  if (dialog.kind === 'closeDispute')
    return (
      <MoneyActionDialog
        title={t('adminBilling.dispute.closeTitle')}
        text={t('adminBilling.dispute.closeText')}
        action={t('adminBilling.dispute.close')}
        currency={currency}
        amount={false}
        preview={false}
        extra={
          <Segmented<'won' | 'lost'>
            label={t('adminBilling.dispute.outcome')}
            value={outcome}
            onChange={setOutcome}
            options={[
              { value: 'won', label: t('adminBilling.dispute.won') },
              { value: 'lost', label: t('adminBilling.dispute.lost') },
            ]}
          />
        }
        run={(x) =>
          adminBilling.closeDispute(dialog.disputeId, { outcome: outcome === 'won' ? DisputeStatus.WON : DisputeStatus.LOST, reason: x.reason, requestId: x.requestId })
        }
        onDone={onDone}
        onClose={onClose}
      />
    );
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

/**
 * A refund of one payment, synchronous (ADR-0083 amendment 2026-10-10): the server calls the bank
 * at once and answers what it did — «Возвращено» (booked now), «Не прошёл», «Ожидает ответа банка»
 * (unknown outcome: the polling settles it), or, for a payment the bank refunds only in its own
 * interface, what to refund there (ManualRefundDialog). A payment the server marks refund_by_hand
 * says so before the attempt.
 */
function RefundDialog({
  payment,
  refundable,
  currency,
  onDone,
  onClose,
}: {
  payment: AdminBillingPayment;
  /** refundableMinor of the payment (paid − refunded − pending): the dialog never offers more. */
  refundable: bigint;
  currency: string;
  onDone: () => void;
  onClose: () => void;
}): ReactNode {
  const [manual, setManual] = useState<AdminManualRefund | null>(null);
  const byHand = payment.refundByHand;
  if (manual) return <ManualRefundDialog m={manual} onClose={onClose} />;
  return (
    <MoneyActionDialog
      title={t('adminBilling.refundTitle')}
      text={t(byHand ? 'adminBilling.refundTextManual' : 'adminBilling.refundText', { amount: formatMoney(payment.payment?.amount), id: payment.providerPaymentId })}
      action={t('adminBilling.refund')}
      currency={currency}
      amount
      maxAmount={refundable}
      initialAmount={refundable}
      extra={
        byHand ? (
          <p role="note" className="rounded-[var(--radius-card)] bg-warn-surface px-3 py-2 text-caption" data-testid="admin-refund-manual">
            {t('adminBilling.refundManual')}
          </p>
        ) : null
      }
      run={async (x) => {
        const r = await adminBilling.refund(payment.payment?.id ?? '', { amount: { minor: x.amount ?? 0n, currency }, reason: x.reason, requestId: x.requestId, preview: x.preview });
        if (!x.preview) announceRefund(r, setManual);
        return r;
      }}
      onDone={onDone}
      onClose={() => {
        // A manual refund keeps the dialog open on its instructions (set just before).
        setManual((m) => {
          if (!m) onClose();
          return m;
        });
      }}
    />
  );
}

/** The bank's answer to a refund, as a toast (or the manual-refund instructions). */
function announceRefund(r: AdminBillingMutationResult, setManual: (m: AdminManualRefund) => void): void {
  if (r.manualRefund) {
    setManual(r.manualRefund);
    return;
  }
  const o = refundOutcome(r);
  if (o === 'done') toast.success(t('adminBilling.refund.done'));
  else if (o === 'refused') toast.error(t('adminBilling.refund.refused'));
  else toast.info(t('adminBilling.refund.waiting'));
}

function CopyLine({ label, value, testId }: { label: string; value: string; testId?: string }): ReactNode {
  return (
    <Row label={label}>
      <span className="flex items-center gap-1.5">
        <span className="selectable tabular-nums text-body" data-testid={testId}>
          {value}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          aria-label={t('adminBilling.copy', { what: label })}
          onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success(t('adminBilling.copied')))}
        >
          <Copy className="size-3.5" aria-hidden />
        </Button>
      </span>
    </Row>
  );
}

/** «Верните вручную в интернет-банке»: what to look up in the bank; the polling books it once done. */
function ManualRefundDialog({ m, onClose }: { m: AdminManualRefund; onClose: () => void }): ReactNode {
  return (
    <Modal open initialFocus="body" onClose={onClose} title={t('adminBilling.manual.title')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="flex flex-col gap-3" data-testid="admin-refund-manual-result">
        <p className="text-body">{t(m.provider === 'tochka' ? 'adminBilling.manual.tochka' : 'adminBilling.manual.other')}</p>
        <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
          <CopyLine label={t('adminBilling.manual.operation')} value={m.operation} testId="admin-refund-manual-operation" />
          {m.charge ? <CopyLine label={t('adminBilling.manual.charge')} value={m.charge} /> : null}
          <CopyLine label={t('adminBilling.amount', { currency: m.amount?.currency ?? '' })} value={formatMoney(m.amount)} />
        </div>
        <p className="text-caption text-muted">{t('adminBilling.manual.after')}</p>
      </div>
    </Modal>
  );
}

const ISSUE_REASON: Record<string, MessageKey> = {
  bank_refund: 'adminBilling.issue.bankRefund',
  currency_mismatch: 'adminBilling.issue.currency',
  exceeds_payments: 'adminBilling.issue.exceeds',
};

/** One «Требует внимания» item: a bank refund booked (information) or one waiting for a decision. */
const IssueRow = memo(function IssueRow({ issue, showAccount = false, onAction }: { issue: AdminBillingIssue; showAccount?: boolean; onAction: (a: 'import' | 'dismiss') => void }): ReactNode {
  const open = issue.status === 'open';
  return (
    <SimpleRow
      title={`${formatMoney(issue.amount)}${showAccount && issue.workspaceName ? ` · ${issue.workspaceName}` : ''}`}
      status={t(ISSUE_REASON[issue.reason] ?? 'adminBilling.issue.other')}
      danger={open}
      sub={[issue.occurredAt ? fmt.dateTime(timestampDate(issue.occurredAt), 'short') : '', issue.providerRef, open ? '' : t(`adminBilling.issue.status.${issue.status === 'dismissed' ? 'dismissed' : 'imported'}`)]
        .filter(Boolean)
        .join(' · ')}
      extra={
        open ? (
          <span className="flex items-center gap-1">
            {issue.reason !== 'currency_mismatch' ? (
              <Button size="sm" variant="secondary" onClick={() => onAction('import')} data-testid="admin-issue-import">
                {t('adminBilling.issue.import')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => onAction('dismiss')} data-testid="admin-issue-dismiss">
              {t('adminBilling.issue.dismiss')}
            </Button>
          </span>
        ) : null
      }
    />
  );
});

function IssueDialog({ issue, action, onDone, onClose }: { issue: AdminBillingIssue; action: 'import' | 'dismiss'; onDone: () => void; onClose: () => void }): ReactNode {
  const imp = action === 'import';
  return (
    <MoneyActionDialog
      title={t(imp ? 'adminBilling.issue.importTitle' : 'adminBilling.issue.dismissTitle')}
      text={t(imp ? 'adminBilling.issue.importText' : 'adminBilling.issue.dismissText', { amount: formatMoney(issue.amount), ref: issue.providerRef })}
      action={t(imp ? 'adminBilling.issue.import' : 'adminBilling.issue.dismiss')}
      currency={issue.amount?.currency || 'USD'}
      amount={false}
      preview={false}
      destructive={imp}
      run={(x) => (imp ? adminBilling.importIssue(issue.id, { reason: x.reason, requestId: x.requestId }) : adminBilling.dismissIssue(issue.id, { reason: x.reason, requestId: x.requestId }))}
      onDone={onDone}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------- «Требует внимания»

/** Every account's bank refunds booked without Calab (why a balance moved) and the open ones. */
function AttentionPage({ onClose, notice }: { onClose: () => void; notice: ReactNode }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY.issues('all'), queryFn: ({ signal }) => adminBilling.issues({}, signal), retry: false });
  const [dialog, setDialog] = useState<{ issue: AdminBillingIssue; action: 'import' | 'dismiss' } | null>(null);
  const list = q.data?.issues ?? [];
  const done = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['admin', 'billing'] });
  }, [qc]);
  return (
    <>
      <PaneHeader title={t('adminBilling.nav.attention')} onClose={onClose} />
      {notice}
      <Scroll testId="admin-billing-attention">
        <p className="px-1 text-caption text-muted">{t('adminBilling.attentionHint')}</p>
        <div className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
          {q.isLoading ? <Spinner className="mx-auto my-3" /> : null}
          {q.isError && !recentAuthRequired(q.error) ? <p className="px-3 py-3 text-body text-danger-text">{billingErrorText(q.error)}</p> : null}
          {q.isSuccess && list.length === 0 ? <p className="px-3 py-3 text-body text-muted">{t('adminBilling.attentionNone')}</p> : null}
          {list.map((i) => (
            <IssueRow key={i.id} issue={i} showAccount onAction={(action) => setDialog({ issue: i, action })} />
          ))}
        </div>
      </Scroll>
      {dialog ? <IssueDialog issue={dialog.issue} action={dialog.action} onDone={done} onClose={() => setDialog(null)} /> : null}
    </>
  );
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
