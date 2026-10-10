import { BillingResumeMode, BillingState, Plan, WorkspaceRole, type BillingSummary, type WorkspaceMember } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { CirclePause, Snowflake, TriangleAlert } from 'lucide-react';
import { type ReactNode } from 'react';
import { Button, Card, Row } from '../../../components/ui';
import { plural, t } from '../../../i18n';
import { billingPlan, cabinetPhase, forecastOf, otherPlan, tsMs, type CabinetPhase } from '../../../lib/billing/model';
import { formatMoney, minorOf } from '../../../lib/billing/money';
import { fmt } from '../../../lib/format';
import { countText } from '../../../lib/plan';
import { useBilling } from '../../../stores/billing';
import { useWorkspaces } from '../../../stores/workspaces';
import { PlanPill } from '../PlanTab';
import type { QuoteAction } from './QuoteDialog';
import { Countdown, MoneyText, Note, PLAN_NAME, StatePill, forecastText } from './parts';

/**
 * «Баланс» of the owner cabinet (ADR-0080 §13): signed balance, the debt with its deadline (a leaf
 * countdown), the daily cost (billable people × price), the forecast, the plan, and the two member
 * counts that differ: people to pay (no guests, no bots) vs members by the plan limit (bots count).
 */

/** Seats by the plan's members limit: everyone but guests, bots included (ADR-0024). */
const limitSeats = (members: Record<string, WorkspaceMember> | undefined): number => {
  let n = 0;
  for (const m of Object.values(members ?? {})) if (m.role !== WorkspaceRole.GUEST) n++;
  return n;
};

/** Primitive selectors: presence / voice changes of the workspace re-render nothing here. */
function MembersByLimit({ workspaceId }: { workspaceId: string }): ReactNode {
  const used = useWorkspaces((s) => limitSeats(s.byId[workspaceId]?.members));
  const limit = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.members ?? 0);
  return <span className="text-body tabular-nums text-muted">{limit > 0 ? t('billing.ofLimit', { used: fmt.number(used), limit: countText(limit) }) : fmt.number(used)}</span>;
}

export function BalanceCard({
  workspaceId,
  summary: s,
  state,
  payments,
  topup,
  manage,
  onTopup,
  onQuote,
}: {
  workspaceId: string;
  summary: BillingSummary;
  state: BillingState;
  /** Payment UI offered on this client (not in the iOS shell). */
  payments: boolean;
  /** BILLING_TOPUP here: «Пополнить» (ADR-0087). */
  topup: boolean;
  /** BILLING_MANAGE here: activate, change, stop, resume. */
  manage: boolean;
  onTopup: () => void;
  onQuote: (a: QuoteAction) => void;
}): ReactNode {
  const phase = cabinetPhase(s, state);
  const debt = minorOf(s.debt);
  const suspendAt = tsMs(s.suspendAt);
  const forecast = forecastOf(s);
  const plan = billingPlan(s.plan);
  // ADR-0086 «Индивидуальный тариф»: its own name and price; a plan a superadmin assigned is not
  // changed or stopped here (top-ups and a paid resume after a debt still are). Its price rows are
  // not shown in the iOS shell (ADR-0087 §10: name and status only).
  const custom = s.plan === Plan.CUSTOM;
  const customName = useWorkspaces((st) => (custom ? (st.byId[workspaceId]?.ws.plan?.displayName ?? '') : ''));
  const assigned = useBilling((st) => !!st.byWs[workspaceId]?.data?.adminAssigned);
  const nextAt = tsMs(s.nextPriceAt);
  return (
    <Card title={t('billing.title')} footer={s.discountBps > 0 ? t('billing.discount', { pct: fmt.number(s.discountBps / 100) }) : undefined}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-3 pb-2 pt-3" data-testid="billing-balance">
        <div className="flex min-w-0 flex-col">
          <span className="text-caption text-muted">{t('billing.balance')}</span>
          <MoneyText m={s.balance} className="text-[26px] font-semibold leading-tight" />
        </div>
        <div className="flex items-center gap-2">
          <StatePill state={state} />
          <PlanPill plan={custom ? Plan.CUSTOM : plan} name={customName} />
        </div>
      </div>

      {debt > 0n ? (
        <Row label={t('billing.debt')} hint={suspendAt && phase !== 'suspended' ? t('billing.debtHint', { when: fmt.dateTime(new Date(suspendAt), 'long') }) : undefined}>
          <span className="flex flex-col items-end gap-0.5 mobile:items-start">
            <MoneyText m={s.debt} danger className="text-body font-semibold" />
            {suspendAt && phase !== 'suspended' ? (
              <span className="flex items-center gap-1 text-caption text-warn">
                <TriangleAlert className="size-3" aria-hidden />
                <Countdown at={suspendAt} testId="billing-countdown" />
              </span>
            ) : null}
          </span>
        </Row>
      ) : null}

      {custom && s.unitPrice && payments ? (
        <Row label={t('customPlan.price')} hint={t('customPlan.priceHint')}>
          <span className="text-body font-semibold tabular-nums" data-testid="billing-custom-price">
            {formatMoney(s.unitPrice)}
          </span>
        </Row>
      ) : null}
      {s.nextUnitPrice && nextAt && payments ? (
        <Row label={t('customPlan.nextPriceLabel')} hint={t('customPlan.nextPriceHint')}>
          <span className="text-body tabular-nums" data-testid="billing-next-price">
            {t('customPlan.nextPrice', { date: fmt.dateTime(new Date(nextAt), 'short'), price: formatMoney(s.nextUnitPrice) })}
          </span>
        </Row>
      ) : null}
      <Row label={t('billing.daily')} hint={s.unitPrice ? t('billing.dailyHint', { n: s.billableMembers, price: formatMoney(s.unitPrice) }) : undefined}>
        <span className="text-body tabular-nums">{phase === 'active' || phase === 'arrears' ? formatMoney(s.dailyCost) : '—'}</span>
      </Row>
      {forecast.kind !== 'none' ? (
        <Row label={t('billing.forecast')} hint={t('billing.forecastHint')}>
          <span className="text-body tabular-nums">{forecast.kind === 'days' ? forecastText(forecast.days) : t('billing.forecast.lessThanDay')}</span>
        </Row>
      ) : null}
      {s.nextDueAt && (phase === 'active' || phase === 'arrears') ? (
        <Row label={t('billing.nextDue')}>
          <span className="text-body text-muted">{fmt.dateTime(timestampDate(s.nextDueAt), 'short')}</span>
        </Row>
      ) : null}
      <Row label={t('billing.people')} hint={t('billing.peopleHint')}>
        <span className="text-body tabular-nums">{plural('billing.nPeople', s.billableMembers)}</span>
      </Row>
      <Row label={t('billing.byLimit')} hint={t('billing.byLimitHint')}>
        <MembersByLimit workspaceId={workspaceId} />
      </Row>

      {s.hold ? (
        <Note icon={<Snowflake className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />} testId="billing-hold">
          {t('billing.hold')}
        </Note>
      ) : null}
      <PhaseNote phase={phase} />

      {!payments ? (
        <Note testId="billing-payments-elsewhere">{t('billing.paymentsElsewhere')}</Note>
      ) : manage ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-3" data-testid="billing-actions">
          <Actions phase={phase} plan={plan} assigned={assigned} onTopup={onTopup} onQuote={onQuote} />
        </div>
      ) : (
        <>
          {topup && phase !== 'closed' ? (
            <div className="flex flex-wrap items-center gap-2 px-3 py-3" data-testid="billing-actions">
              <Button onClick={onTopup} data-testid="billing-topup-open">
                {t('billing.topup.open')}
              </Button>
            </div>
          ) : null}
          <Note testId="billing-access-note">{t(topup ? 'billing.access.topup' : 'billing.access.view')}</Note>
        </>
      )}
    </Card>
  );
}

function PhaseNote({ phase }: { phase: CabinetPhase }): ReactNode {
  if (phase === 'inactive') return <Note>{t('billing.note.inactive')}</Note>;
  if (phase === 'stopped') return <Note icon={<CirclePause className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />}>{t('billing.note.stopped')}</Note>;
  if (phase === 'arrears')
    return (
      <Note tone="warn" icon={<TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />}>
        {t('billing.note.arrears')}
      </Note>
    );
  if (phase === 'suspended')
    return (
      <Note tone="danger" icon={<CirclePause className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}>
        {t('billing.note.suspended')}
      </Note>
    );
  if (phase === 'closed') return <Note>{t('billing.note.closed')}</Note>;
  return null;
}

function Actions({
  phase,
  plan,
  assigned,
  onTopup,
  onQuote,
}: {
  phase: CabinetPhase;
  plan: ReturnType<typeof billingPlan>;
  /** A superadmin assigned the plan (ADR-0086): no change or stop here, the server refuses them. */
  assigned: boolean;
  onTopup: () => void;
  onQuote: (a: QuoteAction) => void;
}): ReactNode {
  if (phase === 'closed') return null;
  const topup = (
    <Button onClick={onTopup} data-testid="billing-topup-open">
      {t('billing.topup.open')}
    </Button>
  );
  if (assigned && (phase === 'active' || phase === 'arrears')) return topup;
  if (phase === 'inactive')
    return (
      <>
        <Button onClick={() => onQuote({ kind: 'activate' })} data-testid="billing-activate">
          {t('billing.activate', { plan: t(PLAN_NAME[plan]) })}
        </Button>
        <Button variant="secondary" onClick={onTopup}>
          {t('billing.topup.open')}
        </Button>
      </>
    );
  if (phase === 'suspended')
    return (
      <>
        <Button onClick={() => onQuote({ kind: 'resume', mode: BillingResumeMode.PAID })} data-testid="billing-resume-paid">
          {t('billing.resumePaid')}
        </Button>
        <Button variant="secondary" onClick={() => onQuote({ kind: 'resume', mode: BillingResumeMode.FREE })} data-testid="billing-resume-free">
          {t('billing.resumeFree')}
        </Button>
        <Button variant="ghost" onClick={onTopup}>
          {t('billing.topup.open')}
        </Button>
      </>
    );
  if (phase === 'stopped')
    return (
      <>
        <Button onClick={() => onQuote({ kind: 'resume', mode: BillingResumeMode.PAID })}>{t('billing.resume')}</Button>
        <Button variant="secondary" onClick={onTopup}>
          {t('billing.topup.open')}
        </Button>
      </>
    );
  // An upgrade only without debt (lead plan «v1 cut»): in arrears Business is not offered.
  const next = otherPlan(plan);
  const canChange = phase !== 'arrears' || next === Plan.TEAM;
  return (
    <>
      {topup}
      {canChange ? (
        <Button variant="secondary" onClick={() => onQuote({ kind: 'change', plan: next })} data-testid="billing-change-plan">
          {t('billing.changeTo', { plan: t(PLAN_NAME[next]) })}
        </Button>
      ) : null}
      <Button variant="ghost" className="ml-auto mobile:ml-0" onClick={() => onQuote({ kind: 'stop' })} data-testid="billing-stop">
        {t('billing.stop')}
      </Button>
    </>
  );
}
