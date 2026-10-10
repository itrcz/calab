import {
  BILLING_BITS,
  BillingQuotePurpose,
  BillingState,
  PaymentMethodKind,
  Plan,
  WorkspaceRole,
  type BillingPlanOffer,
  type BillingQuote,
  type BillingSummary,
  type PlanLimitViolation,
  type PlanLimits,
  type WorkspaceMember,
} from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, CircleCheck, CirclePause, CreditCard, Mail, Minus, Plus, QrCode, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Button, Input, Modal, Segmented, Spinner, cx } from '../../../components/ui';
import { plural, t, useLocale, type MessageKey } from '../../../i18n';
import { useMobile } from '../../../lib/mobile';
import { audioTierLabel } from '../../../lib/audioTierLabel';
import { IDLE, checkoutReducer, nowMs } from '../../../lib/billing/checkout';
import { billingErrorText, billingStale } from '../../../lib/billing/errors';
import { adminAssignedError, violationsOf } from '../../../lib/billing/violations';
import { MARKET_LABEL, MARKET_SELLER, choosableMarkets, contactOnly, methodLabel, offersOf, providerTag, quoteMarket, screenMarket, type Market } from '../../../lib/billing/market';
import { currencyOf, offeredMethods, requestId, topupLimits } from '../../../lib/billing/model';
import { formatMinor, formatMoney, minorOf } from '../../../lib/billing/money';
import {
  IDENTITY_FEATURES,
  TIERS,
  clampSeats,
  currentTier,
  defaultSeats,
  forSale,
  monthOf,
  offerOf,
  planStep,
  screenPhase,
  seatsRange,
  seatsTopup,
  type IdentityFeature,
  type PlanStep,
  type PlanTier,
  type ScreenPhase,
} from '../../../lib/billing/plans';
import { PLAN_LABEL, countText, planDisplayName, storageText, workspacePlanName } from '../../../lib/plan';
import { fmt } from '../../../lib/format';
import { billingMock, billingPaymentsAllowed, loadBilling, openCheckout, ownerBilling, reloadBilling } from '../../../services/billing';
import { openPlanContact, planContact } from '../../../services/plan';
import { useBilling } from '../../../stores/billing';
import { usePrefs } from '../../../stores/prefs';
import { useSession } from '../../../stores/session';
import { useUi } from '../../../stores/ui';
import { useWorkspaces } from '../../../stores/workspaces';
import { useBillingBits } from './access';
import { useBillingState } from './BillingPaywall';
import { ChangeNet, QuoteDialog } from './QuoteDialog';
import { AdminAssignedNote, ViolationList } from './Violations';
import { CheckoutProgress, useCheckoutPoll } from './TopupDialog';
import { MoneyText, Note, StatePill, SumLine } from './parts';

/**
 * «Тариф и оплата» (ADR-0080, owner 10.10: «сложно дойти до оплаты»): Free / Team / Business side
 * by side with the server's price per person per day and the plan's weighty limits, the current one
 * marked, and one path to pay — choose a plan → seats (Team 5, Business 10, never below the team)
 * with the price recalculated as you type → a payment method (the server's list, v1 Stripe card) →
 * «Оплатить»: the hosted checkout tops the balance up (the card is saved for auto-topup), and on
 * return the plan is activated from the balance (quote → activate / change-plan). Members see the
 * plan read-only. Opened by the plan badge and right after creating a workspace (`welcome`).
 * The rest of the cabinet (history, auto-topup, payer) stays in settings → «Тариф».
 */

type Paid = Plan.TEAM | Plan.ENTERPRISE;
type Chosen = { plan: Paid; purpose: BillingQuotePurpose.ACTIVATE | BillingQuotePurpose.CHANGE_PLAN };

/** People to pay for by the members list (no guests, no bots): the seats floor before the server's count is known. */
const billableOf = (members: Record<string, WorkspaceMember> | undefined): number => {
  let n = 0;
  for (const m of Object.values(members ?? {})) if (m.role !== WorkspaceRole.GUEST && !m.user?.isBot) n++;
  return n;
};

function openCabinet(workspaceId: string): void {
  useUi.getState().openDialog({ kind: 'workspace-settings', workspaceId, tab: 'plan' });
}

export function PlansDialog({
  workspaceId,
  welcome,
  inSettings = false,
  onClose,
}: {
  workspaceId: string;
  welcome: boolean;
  /** Opened by «Сменить тариф» in settings → «Тариф» (owner, 10.10): the cabinet is right behind it. */
  inSettings?: boolean;
  onClose: () => void;
}): ReactNode {
  const toCabinet = useCallback(() => (inSettings ? onClose() : openCabinet(workspaceId)), [inSettings, onClose, workspaceId]);
  // ADR-0087: plan changes are BILLING_MANAGE (the owner has it); in the iOS shell nobody sees
  // prices or pay paths (App Store rules) — the read-only view with a neutral line instead.
  const manage = (useBillingBits(workspaceId) & BILLING_BITS.MANAGE) !== 0n;
  const payHere = billingPaymentsAllowed();
  const owner = manage && payHere;
  const name = useWorkspaces((s) => s.byId[workspaceId]?.ws.name ?? '');
  const state = useBillingState(workspaceId);
  const entry = useBilling((s) => s.byWs[workspaceId]);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [stopping, setStopping] = useState(false);
  // The restricted mode's way out (ADR-0086 amendment): resume FREE once the workspace fits Free.
  const [toFree, setToFree] = useState(false);
  // ADR-0083: the market is the owner's choice before the first payment (remembered per user on
  // this device), preselected by the UI language only while both markets are open.
  const userId = useSession((s) => s.me?.user?.id ?? '');
  const remembered = usePrefs((s) => s.billingMarket[userId]);
  const locale = useLocale();
  // Phone: no lead-in text under the title — the plans and their buttons get the room (the cards say «за человека в сутки»).
  const mobile = useMobile();
  const chooseMarket = useCallback(
    (m: Market) => {
      const p = usePrefs.getState();
      p.setPrefs({ billingMarket: { ...p.billingMarket, [userId]: m } });
    },
    [userId],
  );
  // A fresh summary each time the screen opens (a MANAGE holder; members only in a billing workspace).
  useEffect(() => {
    if (owner || billingMock()) void loadBilling(workspaceId);
  }, [owner, workspaceId]);

  const title = welcome ? t('billing.plans.welcomeTitle') : t('billing.plans.title');
  if (!owner) return <MemberView workspaceId={workspaceId} state={state} elsewhere={manage && !payHere} onClose={onClose} />;

  const data = entry?.data ?? null;
  const loading = !data && (!entry || entry.load === 'loading');
  const usable = !!data && (!!data.summary || data.selfServe);
  let body: ReactNode;
  let footer: ReactNode = (
    <Button variant="secondary" onClick={onClose}>
      {t('common.close')}
    </Button>
  );
  if (loading) body = <Spinner className="mx-auto my-8" />;
  else if (!usable) {
    body =
      entry?.load === 'error' ? (
        <div className="flex flex-wrap items-center gap-3 py-2">
          <p className="min-w-0 flex-1 text-body text-danger-text">{entry.error ?? t('err.generic')}</p>
          <Button size="sm" variant="secondary" onClick={() => void loadBilling(workspaceId)}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <p className="py-2 text-body text-muted">{t('billing.plans.unavailable')}</p>
      );
  } else if (data.summary?.plan === Plan.CUSTOM) {
    // ADR-0086 «Индивидуальный тариф»: its terms, read-only — a superadmin changes them.
    body = <CustomPlanView workspaceId={workspaceId} summary={data.summary} offer={offerOf(data.offers, Plan.CUSTOM)} state={data.status?.state ?? state} />;
  } else if (chosen) {
    const market = screenMarket(data, remembered, locale);
    return (
      <PayStep
        workspaceId={workspaceId}
        chosen={chosen}
        offers={offersOf(data.offers, market)}
        market={quoteMarket(data, market)}
        onBack={() => setChosen(null)}
        onClose={onClose}
      />
    );
  } else {
    const phase = screenPhase(data);
    const market = screenMarket(data, remembered, locale);
    body = (
      <PlanGrid
        workspaceId={workspaceId}
        summary={data.summary}
        offers={offersOf(data.offers, market)}
        market={market}
        markets={choosableMarkets(data)}
        onMarket={chooseMarket}
        contact={contactOnly(data)}
        phase={phase}
        state={data.status?.state ?? state}
        onChoose={(step) => {
          if (step.kind === 'pay') setChosen({ plan: step.plan, purpose: step.purpose });
          else if (step.kind === 'stop') setStopping(true);
          else if (step.kind === 'toFree') setToFree(true);
          else if (step.kind === 'blocked' && step.why === 'suspended') toCabinet();
        }}
      />
    );
    footer = (
      <>
        {data.summary && !inSettings ? (
          <Button variant="ghost" className="mr-auto mobile:mr-0" onClick={toCabinet} data-testid="plans-details">
            {t('billing.plans.details')}
          </Button>
        ) : null}
        <Button variant={welcome ? 'primary' : 'secondary'} onClick={onClose} data-testid={welcome ? 'plans-start-free' : undefined}>
          {welcome ? t('billing.plans.startFree') : t('common.close')}
        </Button>
      </>
    );
  }
  return (
    <>
      <Modal open initialFocus="body" onClose={onClose} wide title={title} description={mobile ? undefined : welcome ? t('billing.plans.welcomeText', { name }) : t('billing.plans.text')} footer={footer}>
        <div className="pb-1" data-testid="billing-plans">
          {body}
        </div>
      </Modal>
      {stopping ? <QuoteDialog workspaceId={workspaceId} action={{ kind: 'stop' }} onClose={() => setStopping(false)} onTopup={() => setStopping(false)} /> : null}
      {toFree ? <QuoteDialog workspaceId={workspaceId} action={{ kind: 'toFree' }} onClose={() => setToFree(false)} onTopup={() => setToFree(false)} /> : null}
    </>
  );
}

/**
 * Without BILLING_MANAGE: the plan and the state, «управляет владелец или тот, кому он дал право»,
 * the limits in settings. `elsewhere`: a MANAGE holder in the iOS shell — the neutral «Управление
 * оплатой доступно в веб-версии и на компьютере», no link (App Store anti-steering).
 */
function MemberView({ workspaceId, state, elsewhere, onClose }: { workspaceId: string; state: BillingState; elsewhere: boolean; onClose: () => void }): ReactNode {
  const plan = useWorkspaces((s) => workspacePlanName(s.byId[workspaceId]?.ws.plan));
  const suspended = state === BillingState.SUSPENDED;
  return (
    <Modal
      open
      initialFocus="body"
      onClose={onClose}
      title={t('billing.plans.title')}
      footer={
        <>
          <Button variant="secondary" onClick={() => openCabinet(workspaceId)}>
            {t('billing.plans.limits')}
          </Button>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-1" data-testid="billing-plans-member">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-headline font-semibold">{plan}</span>
          <StatePill state={state} />
        </div>
        <Note tone={suspended ? 'danger' : 'muted'} icon={suspended ? <CirclePause className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden /> : undefined}>
          {elsewhere ? t('billing.paymentsElsewhere') : suspended ? t('billing.member.suspended') : t('billing.plans.member')}
        </Note>
      </div>
    </Modal>
  );
}

/**
 * The custom plan (ADR-0086 «Индивидуальный тариф»): the name and description a superadmin gave it,
 * the account's own price per person per day (and a scheduled new one), what the team pays a day,
 * the plan's limits — read-only, with the note that a superadmin changes it. Static props; the
 * name is a primitive selector.
 */
function CustomPlanView({ workspaceId, summary, offer, state }: { workspaceId: string; summary: BillingSummary; offer: BillingPlanOffer | undefined; state: BillingState }): ReactNode {
  const name = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.displayName ?? '');
  const description = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.description ?? '');
  const planLimits = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits);
  const unit = summary.unitPrice;
  const cur = unit?.currency ?? '';
  const people = summary.billableMembers;
  const lines = highlights(Plan.FREE, offer?.limits ?? planLimits);
  const nextAt = summary.nextPriceAt ? timestampMs(summary.nextPriceAt) : 0;
  return (
    <div className="flex flex-col gap-3" data-testid="plans-custom">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body" data-testid="plans-balance">
        <span className="text-muted">{t('billing.balance')}</span>
        <MoneyText m={summary.balance} className="font-semibold" />
        <StatePill state={state} />
      </div>
      <section aria-current="true" data-plan="CUSTOM" data-testid="plan-card" className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-focus)] bg-[var(--color-card)] p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate text-headline font-semibold">{planDisplayName(Plan.CUSTOM, name)}</h3>
          <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-accent-strong px-2 text-caption font-semibold text-accent-fg">{t('billing.plans.current')}</span>
        </div>
        {description ? <p className="text-body text-muted">{description}</p> : null}
        {unit ? (
          <div className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-title font-semibold tabular-nums">{formatMoney(unit)}</span>
              <span className="text-caption text-muted">{t('billing.plans.perSeatDay')}</span>
            </span>
            <span className="text-caption text-muted">{t('billing.plans.perMonth', { amount: formatMinor(monthOf(unit.minor), cur) })}</span>
            {people > 0 ? <span className="text-caption text-muted">{t('billing.plans.forTeam', { n: people, amount: formatMinor(unit.minor * BigInt(people), cur) })}</span> : null}
            {summary.nextUnitPrice && nextAt ? (
              <span className="text-caption text-muted" data-testid="plans-custom-next">
                {t('customPlan.nextPrice', { date: fmt.dateTime(new Date(nextAt), 'short'), price: formatMoney(summary.nextUnitPrice) })}
              </span>
            ) : null}
          </div>
        ) : null}
        {lines.length ? (
          <ul className="flex flex-col gap-1.5 text-body">
            {lines.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <Note>{t('customPlan.note')}</Note>
    </div>
  );
}

// ---------------------------------------------------------------- the plans side by side

const IDENTITY_KEY: Record<IdentityFeature, MessageKey> = {
  sso: 'billing.plans.f.sso',
  directory: 'billing.plans.f.directory',
  oauth: 'billing.plans.f.oauth',
};

/** The weighty lines of a plan (owner 10.10): people, storage, room size, quality, identity, gated features. */
function highlights(tier: PlanTier, l: PlanLimits | undefined): string[] {
  const out: string[] = [];
  if (l) {
    out.push(t('billing.plans.f.members', { n: countText(l.members) }));
    out.push(t('billing.plans.f.storage', { size: storageText(l.storageMb) }));
    out.push(t('billing.plans.f.room', { n: countText(l.roomMembers) }));
    out.push(l.audioTierMaxKbps ? t('billing.plans.f.audio', { tier: audioTierLabel(l.audioTierMaxKbps) }) : t('billing.plans.f.mediaFree'));
    out.push(t('billing.plans.f.bots', { n: countText(l.bots) }));
  }
  for (const f of IDENTITY_FEATURES[tier]) out.push(t(IDENTITY_KEY[f]));
  if (l) {
    if (!l.telephonyDisabled) out.push(t('billing.plans.f.telephony'));
    if (!l.caldavDisabled) out.push(t('billing.plans.f.caldav'));
    if (!l.automationsDisabled) out.push(t('billing.plans.f.automations'));
  }
  return out;
}

function PlanGrid({
  workspaceId,
  summary,
  offers,
  market,
  markets,
  onMarket,
  contact,
  phase,
  state,
  onChoose,
}: {
  workspaceId: string;
  summary: BillingSummary | undefined;
  offers: readonly BillingPlanOffer[];
  market: Market;
  /** Markets to choose between (both open, nothing paid yet); one or none: no switch. */
  markets: readonly Market[];
  onMarket: (m: Market) => void;
  /** No acquirer takes new clients: paid plans by «contact us». */
  contact: boolean;
  phase: ScreenPhase;
  state: BillingState;
  onChoose: (s: PlanStep) => void;
}): ReactNode {
  const billable = useWorkspaces((s) => billableOf(s.byId[workspaceId]?.members));
  const accountPlan = summary?.plan ?? Plan.TEAM;
  const current = currentTier(phase, accountPlan);
  const payments = billingPaymentsAllowed();
  const people = summary?.billableMembers ?? billable;
  // ADR-0086: a plan the workspace does not fit — «Почему нельзя» shows the server's violations under the cards.
  const [why, setWhy] = useState<PlanTier | null>(null);
  const whyOffer = why === null ? undefined : offerOf(offers, why);
  return (
    <div className="flex flex-col gap-3">
      {summary ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body" data-testid="plans-balance">
          <span className="text-muted">{t('billing.balance')}</span>
          <MoneyText m={summary.balance} className="font-semibold" />
          <StatePill state={state} />
        </div>
      ) : null}
      {phase === 'suspended' ? (
        <Note tone="danger" icon={<CirclePause className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}>
          {t('billing.plans.suspended')}
        </Note>
      ) : phase === 'arrears' ? (
        <Note tone="warn" icon={<TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />}>
          {t('billing.note.arrears')}
        </Note>
      ) : phase === 'lapsed' ? (
        <Note tone="warn" icon={<TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />}>
          {t('billing.note.lapsed')}
        </Note>
      ) : null}
      {markets.length > 1 && !contact ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="plans-market">
          <Segmented<Market>
            label={t('billing.market.label')}
            value={market}
            onChange={onMarket}
            options={markets.map((m) => ({ value: m, label: t(MARKET_LABEL[m]) }))}
          />
          <span className="text-caption text-muted">{t('billing.market.fixedHint')}</span>
        </div>
      ) : null}
      {!contact && (markets.length > 1 || market === 'ru') ? (
        <p className="text-caption text-muted" data-testid="plans-seller">
          {t(MARKET_SELLER[market])}
        </p>
      ) : null}
      {contact && payments ? <Note>{t('billing.plans.contactHint')}</Note> : null}
      <div className="grid grid-cols-3 gap-3 mobile:grid-cols-1" role="list" aria-label={t('billing.plans.title')}>
        {TIERS.map((tier) => (
          <PlanCard
            key={tier}
            tier={tier}
            offer={offerOf(offers, tier)}
            current={tier === current}
            step={planStep(phase, accountPlan, tier)}
            people={people}
            payments={payments && forSale(offers, tier)}
            contact={contact}
            onChoose={onChoose}
            onWhy={setWhy}
          />
        ))}
      </div>
      {why !== null && whyOffer?.violations.length ? <ViolationList key={why} workspaceId={workspaceId} plan={t(PLAN_LABEL[why])} violations={whyOffer.violations} reveal /> : null}
      {!payments ? <Note>{t('billing.paymentsElsewhere')}</Note> : null}
    </div>
  );
}

function PlanCard({
  tier,
  offer,
  current,
  step,
  people,
  payments,
  contact,
  onChoose,
  onWhy,
}: {
  tier: PlanTier;
  offer: BillingPlanOffer | undefined;
  current: boolean;
  step: PlanStep;
  people: number;
  payments: boolean;
  contact: boolean;
  onChoose: (s: PlanStep) => void;
  onWhy: (tier: PlanTier) => void;
}): ReactNode {
  const unit = offer?.unitPrice;
  const cur = unit?.currency ?? '';
  const lines = highlights(tier, offer?.limits);
  const mobile = useMobile();
  const [open, setOpen] = useState(false);
  const paid = tier !== Plan.FREE;
  // The server says the workspace does not fit this plan now (ADR-0086): no way to choose it.
  // Stopping is always allowed (ADR-0086 amendment): its dialog warns about the restricted mode instead.
  const notFit = (step.kind === 'pay' || step.kind === 'toFree') && !!offer?.violations.length;
  let action: ReactNode;
  if (step.kind === 'current') {
    action = (
      <span className="inline-flex h-7 items-center gap-1 text-body font-medium text-muted">
        <Check className="size-4" aria-hidden />
        {t('billing.plans.currentBtn')}
      </span>
    );
  } else if (step.kind === 'blocked') {
    action = step.why === 'debtUpgrade' ? <span className="text-caption text-muted">{t('billing.plans.debtFirst')}</span> : null;
  } else if (notFit) {
    action = (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 text-caption text-fg">
          <TriangleAlert className="size-3.5 text-warn" aria-hidden />
          {t('billing.transition.notFit')}
        </span>
        <Button size="sm" variant="secondary" onClick={() => onWhy(tier)} data-testid={`plans-why-${Plan[tier]}`}>
          {t('billing.transition.why')}
        </Button>
      </span>
    );
  } else if (!payments) {
    action = paid && !unit ? <span className="text-caption text-muted">{t('billing.plans.notForSale')}</span> : null;
  } else if (contact && step.kind === 'pay') {
    // ADR-0083: no acquirer takes new clients — the paid plans by contacting us.
    action = planContact() ? (
      <Button variant="secondary" onClick={openPlanContact} data-testid={`plans-contact-${Plan[tier]}`}>
        <Mail className="size-3.5" aria-hidden />
        {t('billing.plans.contact')}
      </Button>
    ) : null;
  } else if (step.kind === 'stop' || step.kind === 'toFree') {
    action = (
      <Button variant="secondary" onClick={() => onChoose(step)} data-testid="plans-to-free">
        {t('billing.plans.toFree')}
      </Button>
    );
  } else {
    action = (
      <Button onClick={() => onChoose(step)} data-testid={`plans-choose-${Plan[tier]}`}>
        {step.purpose === BillingQuotePurpose.CHANGE_PLAN ? t('billing.plans.switch', { plan: t(PLAN_LABEL[tier]) }) : t('billing.plans.choose', { plan: t(PLAN_LABEL[tier]) })}
      </Button>
    );
  }
  return (
    <section
      role="listitem"
      aria-current={current ? 'true' : undefined}
      data-plan={Plan[tier]}
      data-testid="plan-card"
      // Phone: the current plan first and Free (a step down) last, so «Выбрать …» of the next paid plan is on the first screen.
      className={cx('flex flex-col gap-3 rounded-[var(--radius-card)] border bg-[var(--color-card)] p-4', current ? 'border-[var(--color-focus)] mobile:order-first' : 'border-line', !paid && !current && 'mobile:order-last')}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-headline font-semibold">{t(PLAN_LABEL[tier])}</h3>
        {current ? <span className="inline-flex h-5 items-center rounded-full bg-accent-strong px-2 text-caption font-semibold text-accent-fg">{t('billing.plans.current')}</span> : null}
      </div>
      <div className="flex min-h-[64px] flex-col gap-0.5 mobile:min-h-0">
        {!paid ? (
          <>
            <span className="text-title font-semibold">{t('billing.plans.free')}</span>
            <span className="text-caption text-muted mobile:hidden">{t('billing.plans.freeNote')}</span>
          </>
        ) : unit ? (
          <>
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-title font-semibold tabular-nums">{formatMoney(unit)}</span>
              <span className="text-caption text-muted">{t('billing.plans.perSeatDay')}</span>
            </span>
            <span className="text-caption text-muted">{t('billing.plans.perMonth', { amount: formatMinor(monthOf(unit.minor), cur) })}</span>
            {people > 0 ? <span className="text-caption text-muted">{t('billing.plans.forTeam', { n: people, amount: formatMinor(unit.minor * BigInt(people), cur) })}</span> : null}
          </>
        ) : (
          <span className="text-body text-muted">{t('billing.plans.notForSale')}</span>
        )}
      </div>
      {/* The action right under the price: in view without scrolling the plan list (docs/08). The «your plan» mark duplicates the pill on a phone. */}
      {action ? <div className={cx('flex min-h-7 items-center mobile:[&>button]:w-full', step.kind === 'current' && 'mobile:hidden')}>{action}</div> : null}
      {lines.length ? (
        <>
          {mobile ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="-mx-1 inline-flex h-8 items-center gap-1 self-start rounded-[var(--radius-control)] px-1 text-body text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              {t('billing.plans.includes')}
              <ChevronDown className={cx('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          ) : null}
          {!mobile || open ? (
            <ul className="flex flex-1 flex-col gap-1.5 text-body">
              {lines.map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- the pay path

type PayPhase = 'form' | 'checkout' | 'activating' | 'done';

async function applyPlan(ws: string, c: Chosen, q: BillingQuote, reqId: string): Promise<void> {
  const base = { quoteId: q.quoteId, requestId: reqId, expectedRevision: q.revision, plan: c.plan };
  if (c.purpose === BillingQuotePurpose.ACTIVATE) await ownerBilling.activate(ws, base);
  else await ownerBilling.changePlan(ws, base);
}

/**
 * Seats → method → «Оплатить» → (hosted checkout, card saved) → the plan activated from the balance.
 * The quote (POST …/quote) comes first: for a workspace without an account it starts one
 * (self-serve) and says what the action needs now; the seats only size the top-up (a prepaid
 * month for the planned team — the server charges the actual people each 24 h).
 */
function PayStep({
  workspaceId,
  chosen,
  offers,
  market,
  onBack,
  onClose,
}: {
  workspaceId: string;
  chosen: Chosen;
  offers: readonly BillingPlanOffer[];
  /** The owner's market choice, sent with the ACTIVATE quote before the first payment (ADR-0083). */
  market: Market | undefined;
  onBack: () => void;
  onClose: () => void;
}): ReactNode {
  const quoteReq = useMemo(
    () => ({ purpose: chosen.purpose, plan: chosen.plan, ...(market && chosen.purpose === BillingQuotePurpose.ACTIVATE ? { market } : {}) }),
    [chosen.purpose, chosen.plan, market],
  );
  const quote = useQuery({
    queryKey: ['billing', workspaceId, 'plan-quote', chosen.purpose, chosen.plan, market ?? ''],
    queryFn: () => ownerBilling.quote(workspaceId, quoteReq),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const summary = useBilling((s) => s.byWs[workspaceId]?.data?.summary);
  const membersBillable = useWorkspaces((s) => billableOf(s.byId[workspaceId]?.members));
  // A self-serve quote created the account, or moved it to the chosen market: read its summary
  // (methods, balance, people) again.
  const created = !!quote.data && (!summary || (!!market && summary.market !== market));
  useEffect(() => {
    if (created) reloadBilling(workspaceId);
  }, [created, workspaceId]);

  const offer = offerOf(offers, chosen.plan);
  const unitMoney = quote.data?.unitPrice ?? offer?.unitPrice;
  const currency = currencyOf(summary) || unitMoney?.currency || 'USD';
  const range = seatsRange(summary?.billableMembers ?? membersBillable, offer?.limits?.members ?? 0);
  // null = untouched: the default follows the range (the server's count of people may arrive later).
  const [typed, setSeatsRaw] = useState<string | null>(null);
  const seatsRaw = typed ?? String(defaultSeats(chosen.plan, range));
  const seats = clampSeats(Number(seatsRaw), range);

  const methods = summary ? offeredMethods(summary) : [];
  const [methodId, setMethodId] = useState('');
  const method = methods.find((m) => m.id === methodId) ?? methods[0];
  const lim = topupLimits(method, currency);
  const q = quote.data;
  const topup = seatsTopup(
    { seats, unit: minorOf(unitMoney), debt: minorOf(q?.debt ?? summary?.debt), balance: minorOf(summary?.balance), toPay: minorOf(q?.toPay) },
    lim,
    currency,
  );
  // Save the card for auto-topup (T7) when the method can and none is saved yet.
  const saveCard = !!method?.autoTopupCapable && !summary?.autoTopup?.paymentMethodId;

  const [phase, setPhase] = useState<PayPhase>('form');
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<readonly PlanLimitViolation[]>([]);
  const quoteBlocked = violationsOf(quote.error);
  const violations = blocked.length ? blocked : quoteBlocked;
  const [flow, dispatch] = useReducer(checkoutReducer, IDLE);
  const topupReq = useRef(requestId());
  const actReq = useRef(requestId());
  useCheckoutPoll(workspaceId, flow, dispatch);

  /** A fresh quote, then the action; a stale quote is fetched once more. */
  const activate = useCallback(async (): Promise<void> => {
    setPhase('activating');
    setError(null);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fresh = await ownerBilling.quote(workspaceId, quoteReq);
        if (minorOf(fresh.toPay) > 0n) {
          setError(t('billing.pay.stillShort'));
          setPhase('form');
          void quote.refetch();
          return;
        }
        if (fresh.expiresAt && timestampMs(fresh.expiresAt) <= nowMs()) continue;
        await applyPlan(workspaceId, chosen, fresh, actReq.current);
        reloadBilling(workspaceId);
        setPhase('done');
        return;
      } catch (e) {
        if (billingStale(e) && attempt === 0) {
          actReq.current = requestId();
          continue;
        }
        // ADR-0086: the commit re-checks the limits (someone joined since the quote).
        const v = violationsOf(e);
        if (v.length) setBlocked(v);
        else setError(billingErrorText(e));
        setPhase('form');
        void quote.refetch();
        return;
      }
    }
    setPhase('form');
  }, [workspaceId, chosen, quoteReq, quote]);

  // The money is on the balance: activate right away (the person experiences one path).
  const credited = flow.phase === 'done' && flow.outcome === 'credited';
  const startedAfterCredit = useRef(false);
  useEffect(() => {
    if (!credited || startedAfterCredit.current) return;
    startedAfterCredit.current = true;
    reloadBilling(workspaceId);
    void activate();
  }, [credited, activate, workspaceId]);

  const pay = async (): Promise<void> => {
    setError(null);
    if (topup.amount <= 0n) {
      void activate();
      return;
    }
    if (!method) return;
    startedAfterCredit.current = false;
    // A new click is a new top-up (the seats may have changed; an ended checkout is not reused);
    // a double click cannot happen — the button is busy, then replaced by the progress.
    if (flow.phase !== 'idle') topupReq.current = requestId();
    dispatch({ type: 'reset' });
    dispatch({ type: 'create' });
    setPhase('checkout');
    try {
      const r = await ownerBilling.topup(workspaceId, { methodId: method.id, amount: { minor: topup.amount, currency }, requestId: topupReq.current, saveMethod: saveCard });
      dispatch({ type: 'created', checkoutId: r.checkoutId, url: r.url, now: nowMs() });
      openCheckout(r.url);
    } catch (e) {
      dispatch({ type: 'createFailed', message: billingErrorText(e, t('billing.topup.failed')) });
      topupReq.current = requestId();
      setError(billingErrorText(e, t('billing.topup.failed')));
      setPhase('form');
    }
  };

  const planName = t(PLAN_LABEL[chosen.plan]);
  const title = chosen.purpose === BillingQuotePurpose.CHANGE_PLAN ? t('billing.pay.titleChange', { plan: planName }) : t('billing.pay.title', { plan: planName });
  const checkoutEnded = flow.phase === 'done' && flow.outcome !== 'credited';
  const ready = !!q && !!summary && (topup.amount <= 0n || !!method) && !violations.length;

  let footer: ReactNode;
  if (phase === 'done') footer = <Button onClick={onClose}>{t('billing.topup.close')}</Button>;
  else if (phase === 'checkout' && !checkoutEnded)
    footer = (
      <Button variant="secondary" onClick={onClose}>
        {t('billing.topup.later')}
      </Button>
    );
  else
    footer = (
      <>
        <Button variant="secondary" onClick={onBack} disabled={phase === 'activating'}>
          {t('billing.pay.back')}
        </Button>
        <Button busy={phase === 'activating' || (phase === 'checkout' && flow.phase === 'creating')} disabled={!ready} onClick={() => void pay()} data-testid="plans-pay">
          {topup.amount > 0n ? t('billing.pay.pay', { amount: formatMinor(topup.amount, currency) }) : t('billing.pay.start', { plan: planName })}
        </Button>
      </>
    );

  return (
    <Modal open initialFocus="body" onClose={onClose} medium title={title} description={t('billing.pay.how')} footer={footer}>
      <div className="flex flex-col gap-4 pb-1" data-testid="plans-pay-step">
        {phase === 'done' ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center" role="status" data-testid="plans-done">
            <CircleCheck className="size-8 text-ok" aria-hidden />
            <p className="text-headline font-semibold">{t('billing.pay.done', { plan: planName })}</p>
            <p className="text-body text-muted">{t('billing.pay.doneHint')}</p>
          </div>
        ) : phase === 'activating' ? (
          <div className="flex flex-col items-center gap-3 py-6" role="status">
            <Spinner className="size-6" />
            <p className="text-body">{t('billing.pay.activating')}</p>
          </div>
        ) : phase === 'checkout' && !checkoutEnded ? (
          <>
            <CheckoutProgress flow={flow} onRecheck={() => dispatch({ type: 'recheck', now: nowMs() })} />
            <p className="text-center text-caption text-muted">{t('billing.pay.later')}</p>
          </>
        ) : (
          <>
            {quote.isLoading || (q && !summary) ? <Spinner className="mx-auto my-4" /> : null}
            {violations.length ? (
              <ViolationList workspaceId={workspaceId} plan={planName} violations={violations} />
            ) : adminAssignedError(quote.error) ? (
              <AdminAssignedNote />
            ) : quote.isError ? (
              <p className="text-body text-danger-text">{billingErrorText(quote.error)}</p>
            ) : null}
            {checkoutEnded ? <CheckoutProgress flow={flow} onRecheck={() => undefined} /> : null}
            {q && summary && !violations.length ? (
              <>
                <SeatsField value={seatsRaw} range={range} onChange={setSeatsRaw} />
                {/* Two separate things (owner, 10.10): the top-up sized for the planned team, and what is charged today for the people actually here. */}
                <div className="flex flex-col" data-testid="plans-pay-lines">
                  <SumLine label={t('billing.pay.topupLine')} strong>
                    {topup.amount > 0n ? formatMinor(topup.amount, currency) : t('billing.pay.noTopup')}
                  </SumLine>
                  <p className="pb-2 text-caption text-muted">
                    {plural('billing.pay.topupHint', seats)}
                    {minorOf(q.debt) > 0n ? ` · ${t('billing.quote.debt')} ${formatMoney(q.debt)}` : ''}
                    {minorOf(summary.balance) > 0n ? ` · ${t('billing.pay.onBalance')} ${formatMoney(summary.balance, { signed: true })}` : ''}
                  </p>
                  <SumLine label={t('billing.pay.todayLine')} strong>
                    {formatMoney(q.charge)}
                  </SumLine>
                  <p className="text-caption text-muted">{plural('billing.pay.todayHint', q.seats)}</p>
                  {chosen.purpose === BillingQuotePurpose.CHANGE_PLAN && summary.plan !== Plan.UNSPECIFIED ? <ChangeNet q={q} from={summary.plan} to={chosen.plan} /> : null}
                </div>
                {topup.amount > 0n ? (
                  <MethodList methods={methods} value={method?.id ?? ''} onChange={setMethodId} />
                ) : null}
                {topup.amount > 0n && saveCard ? <p className="text-caption text-faint">{t('billing.pay.saveCard')}</p> : null}
                {topup.amount > 0n ? <p className="text-caption text-faint">{t('billing.topup.hosted')}</p> : null}
              </>
            ) : null}
            {error ? (
              <p role="alert" className="text-caption text-danger-text">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

/** Seats: typed or ±1; the price follows each keystroke (computed here from the server's price, no request). */
function SeatsField({ value, range, onChange }: { value: string; range: { min: number; max: number }; onChange: (v: string) => void }): ReactNode {
  const n = clampSeats(Number(value), range);
  const step = (d: number): void => onChange(String(clampSeats(n + d, range)));
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="plans-seats" className="text-caption font-medium text-muted">
        {t('billing.pay.seatsPlan')}
      </label>
      <div className="flex items-center gap-2">
        <Button variant="secondary" aria-label={t('billing.pay.seatsLess')} disabled={n <= range.min} onClick={() => step(-1)}>
          <Minus className="size-3.5" aria-hidden />
        </Button>
        <Input
          id="plans-seats"
          inputMode="numeric"
          className="w-24 text-center tabular-nums"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
          onBlur={() => onChange(String(n))}
          data-testid="plans-seats"
        />
        <Button variant="secondary" aria-label={t('billing.pay.seatsMore')} disabled={n >= range.max} onClick={() => step(1)}>
          <Plus className="size-3.5" aria-hidden />
        </Button>
        <span className="text-caption text-muted">{t('billing.pay.seatsRange', { min: range.min, max: countText(range.max) })}</span>
      </div>
    </div>
  );
}


/** The methods the server offers for this account (registry capability matrix): a radio list, so more acquirers plug in. */
function MethodList({ methods, value, onChange }: { methods: ReturnType<typeof offeredMethods>; value: string; onChange: (id: string) => void }): ReactNode {
  if (methods.length === 0) return <p className="text-body text-muted">{t('billing.topup.noMethods')}</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-muted">{t('billing.topup.method')}</span>
      <div role="radiogroup" aria-label={t('billing.topup.method')} className="flex flex-col gap-1.5" data-testid="plans-methods">
        {methods.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={value === m.id}
            onClick={() => onChange(m.id)}
            className={cx(
              'flex min-h-10 items-center gap-2.5 rounded-[var(--radius-card)] border px-3 py-2 text-left text-body mobile:tap-min-h',
              value === m.id ? 'border-[var(--color-focus)] bg-[var(--color-card)]' : 'border-line hover:bg-hover',
            )}
          >
            {m.kind === PaymentMethodKind.SBP ? <QrCode className="size-4 shrink-0 text-muted" aria-hidden /> : <CreditCard className="size-4 shrink-0 text-muted" aria-hidden />}
            <span className="min-w-0 flex-1">{t(methodLabel(m))}</span>
            {providerTag(m.provider) ? <span className="text-caption text-faint">{providerTag(m.provider)}</span> : null}
            {value === m.id ? <Check className="size-4 shrink-0 text-accent-text" aria-hidden /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
