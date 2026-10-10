import { BILLING_BITS, Plan, WorkspaceRole, type PlanLimits, type WorkspaceMember } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Row, cx } from '../../components/ui';
import { t } from '../../i18n';
import { audioTierLabel } from '../../lib/audioTierLabel';
import { fmt } from '../../lib/format';
import { PLAN_LABEL, atLimit, contactHref, countText, planKind, planUsage, storageText, videoLimitText } from '../../lib/plan';
import { platform } from '../../platform';
import { openPlanContact, planContact, planOffersAllowed } from '../../services/plan';
import { loadWorkspaceStickers } from '../../services/stickers';
import { useSession } from '../../stores/session';
import { useStickers } from '../../stores/stickers';
import { useWorkspaces } from '../../stores/workspaces';
import { BillingSection } from './billing/BillingSection';
import { PlansDialog } from './billing/PlansDialog';
import { useBillingBits } from './billing/access';
import { billingPaymentsAllowed } from '../../services/billing';
import { AdminAssignedNote } from './billing/Violations';
import { useBilling } from '../../stores/billing';

/** Members that take a seat: everyone but guests (bots count, ADR-0024). */
const seats = (members: Record<string, WorkspaceMember> | undefined): number => {
  let n = 0;
  for (const m of Object.values(members ?? {})) if (m.role !== WorkspaceRole.GUEST) n++;
  return n;
};

/**
 * The plan's members limit of a workspace against its seats (owner 28.09: free = 50): `full`
 * locks the invite controls. Primitive selectors only: a presence or voice change re-renders nothing.
 */
export function useMembersCap(workspaceId: string): { full: boolean; limit: number } {
  const limit = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.members ?? 0);
  const used = useWorkspaces((s) => (limit > 0 ? seats(s.byId[workspaceId]?.members) : 0));
  return { full: atLimit(used, limit), limit };
}

/**
 * Why a create / invite control is off (a plan limit reached): a warning line with «Связаться»
 * when a contact is configured (docs/08 «Тариф»).
 */
export function PlanFullNote({ text, testId }: { text: string; testId?: string }): ReactNode {
  const contact = planContact();
  return (
    <p role="note" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-caption text-muted" data-testid={testId}>
      <TriangleAlert className="size-3.5 shrink-0 text-warn" aria-hidden />
      <span>{text}</span>
      {contact ? (
        <button type="button" className="font-medium text-accent-text hover:underline" onClick={openPlanContact}>
          {t('plan.contactShort')}
        </button>
      ) : null}
    </p>
  );
}

/** Plan name as a pill (docs/08 «Тариф»): Free neutral, Team / Enterprise accent, Custom green. */
export function PlanPill({ plan, className }: { plan: Plan; className?: string }): ReactNode {
  const kind = plan === Plan.UNSPECIFIED ? Plan.FREE : plan;
  return (
    <span
      data-plan={Plan[kind]}
      className={cx(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-caption font-semibold',
        kind === Plan.TEAM || kind === Plan.ENTERPRISE ? 'bg-accent-strong text-accent-fg' : kind === Plan.CUSTOM ? 'bg-ok-fill text-white' : 'bg-[var(--color-fill-hover)] text-fg',
        className,
      )}
    >
      {t(PLAN_LABEL[kind])}
    </span>
  );
}

/** «Истёк» next to the pill: the free limits apply until the plan is renewed. */
export function ExpiredBadge(): ReactNode {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-warn)_18%,transparent)] px-2 text-caption font-semibold text-fg">
      <TriangleAlert className="size-3 text-warn" aria-hidden />
      {t('plan.expiredBadge')}
    </span>
  );
}

/** How full a counter is: a 4 px bar, amber from 90 %. */
function Meter({ used, limit }: { used: number; limit: number }): ReactNode {
  if (limit <= 0) return null;
  const share = Math.min(1, used / limit);
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-[var(--color-fill-hover)]" aria-hidden>
      <span className={cx('block h-full rounded-full', share >= 0.9 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.max(2, share * 100)}%` }} />
    </span>
  );
}

interface LimitRow {
  label: string;
  used: ReactNode;
  max: string;
  meter?: { used: number; limit: number };
}

function limitRows(limits: PlanLimits | undefined, usage: ReturnType<typeof planUsage>, storageUsed: bigint, packs: number | undefined): LimitRow[] {
  const l = limits;
  const storageLimitBytes = Number(l?.storageMb ?? 0n) * 1024 * 1024;
  const counted = (label: string, used: number, limit: number): LimitRow => ({ label, used: fmt.number(used), max: countText(limit), meter: { used, limit } });
  return [
    { label: t('plan.limit.roomMembers'), used: fmt.number(usage.roomPeak), max: countText(l?.roomMembers ?? 0) },
    counted(t('plan.limit.members'), usage.members, l?.members ?? 0),
    { label: t('plan.limit.audio'), used: '—', max: l?.audioTierMaxKbps ? audioTierLabel(l.audioTierMaxKbps) : t('plan.unlimited') },
    { label: t('plan.limit.streams'), used: fmt.number(usage.streamPeak), max: countText(l?.streamsPerRoom ?? 0) },
    { label: t('plan.limit.stream'), used: '—', max: videoLimitText(l?.streamMaxPreset ?? 0, l?.streamMaxFps ?? 0) },
    { label: t('plan.limit.camera'), used: '—', max: videoLimitText(l?.cameraMaxPreset ?? 0, l?.cameraMaxFps ?? 0) },
    counted(t('plan.limit.bots'), usage.bots, l?.bots ?? 0),
    { label: t('plan.limit.boards'), used: '—', max: countText(l?.boards ?? 0) },
    { label: t('plan.limit.caldav'), used: '—', max: t(l?.caldavDisabled ? 'plan.caldav.no' : 'plan.caldav.yes') },
    { label: t('music.mode'), used: '—', max: t(l?.musicianDisabled ? 'plan.caldav.no' : 'plan.caldav.yes') },
    // ADR-0058 §5: checklists (Team and above), the board webhook (Business).
    { label: t('admin.limit.checklists'), used: '—', max: t(l?.checklistsDisabled ? 'plan.caldav.no' : 'plan.caldav.yes') },
    { label: t('admin.limit.boardWebhooks'), used: '—', max: t(l?.boardWebhooksDisabled ? 'plan.caldav.no' : 'plan.caldav.yes') },
    { label: t('admin.limit.automations'), used: '—', max: t(l?.automationsDisabled ? 'plan.caldav.no' : 'plan.caldav.yes') },
    // ADR-0046 (owner, 02.10): telephony SIP is Business only.
    { label: t('admin.limit.telephony'), used: '—', max: t(l?.telephonyDisabled ? 'plan.caldav.no' : 'plan.caldav.yes') },
    packs === undefined
      ? { label: t('plan.limit.stickerPacks'), used: '—', max: countText(l?.stickerPacks ?? 0) }
      : counted(t('plan.limit.stickerPacks'), packs, l?.stickerPacks ?? 0),
    {
      label: t('plan.limit.storage'),
      used: fmt.size(storageUsed),
      max: storageText(l?.storageMb ?? 0n),
      meter: { used: Number(storageUsed), limit: storageLimitBytes },
    },
  ];
}

/**
 * «Сменить тариф» (owner, 10.10): the plans comparison opens over settings from here — the plan
 * badge leads to this tab. A plan a superadmin assigned is not changed by self-serve (ADR-0086):
 * the note with «Написать в поддержку» instead. BILLING_MANAGE only (ADR-0087; the owner has it),
 * never in the iOS shell (App Store rules); primitive selectors.
 */
function PlanSwitch({ workspaceId }: { workspaceId: string }): ReactNode {
  const owner = (useBillingBits(workspaceId) & BILLING_BITS.MANAGE) !== 0n && billingPaymentsAllowed();
  const assigned = useBilling((s) => !!s.byWs[workspaceId]?.data?.adminAssigned);
  const canSwitch = useBilling((s) => {
    const d = s.byWs[workspaceId]?.data;
    return !!d && (!!d.summary || d.selfServe) && d.offers.length > 0;
  });
  const [open, setOpen] = useState(false);
  if (!owner) return null;
  if (assigned) return <AdminAssignedNote />;
  if (!canSwitch) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-3">
      <Button onClick={() => setOpen(true)} data-testid="plan-switch">
        {t('billing.switchPlan')}
      </Button>
      {open ? <PlansDialog workspaceId={workspaceId} welcome={false} inSettings onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/**
 * Workspace settings → «Тариф» (ADR-0024, docs/08 «Тариф»): every member sees the plan, its term,
 * the limits against the live usage and the contact for buying; nothing here is editable (the
 * plan changes only through the superadmin or, later, a payment).
 */
export function PlanTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const contact = useSession((s) => (planOffersAllowed() ? contactHref(s.planContact) : null));
  const packs = useStickers((s) => s.byWorkspace[workspaceId]?.length);
  // Balance billing manages the plan (ADR-0080): the cabinet above replaces «Связаться для покупки».
  const billingCabinet = useBilling((s) => !!s.byWs[workspaceId]?.data?.summary);
  const billingManaged = useWorkspaces((s) => !!s.byId[workspaceId]?.ws.billing?.state) || billingCabinet;
  useEffect(() => {
    void loadWorkspaceStickers(workspaceId);
  }, [workspaceId]);
  const plan = entry?.ws.plan;
  if (!entry || !plan) return null;
  const kind = planKind(plan);
  const until = plan.validUntil ? timestampDate(plan.validUntil) : null;
  const usage = planUsage(
    Object.values(entry.voice),
    Object.values(entry.members).map((m) => ({ guest: m.role === WorkspaceRole.GUEST, bot: !!m.user?.isBot })),
  );
  const rows = limitRows(plan.limits, usage, entry.ws.storageUsedBytes, packs);
  const pricing = planOffersAllowed() ? import.meta.env.VITE_PRICING_URL : undefined;
  return (
    <>
      <Card title={t('plan.card.current')}>
        <Row label={t('plan.row.plan')}>
          {plan.expired ? <ExpiredBadge /> : null}
          <PlanPill plan={kind} />
        </Row>
        <Row label={t('plan.row.validUntil')}>
          <span className={cx('text-body', plan.expired ? 'text-danger-text' : 'text-muted')}>{until ? fmt.date(until) : t('plan.noExpiry')}</span>
        </Row>
        {plan.expired && until ? (
          <p role="note" className="flex items-start gap-2 px-3 py-2 text-body">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
            {t('plan.expired', { date: fmt.date(until) })}
          </p>
        ) : null}
        <PlanSwitch workspaceId={workspaceId} />
      </Card>
      {/* Balance billing (ADR-0080 v5): the owner's cabinet / the members' stub; nothing without an account. */}
      <BillingSection workspaceId={workspaceId} />

      <section className="flex flex-col gap-1.5" data-settings-row>
        <h3 className="px-1 text-caption font-semibold text-muted" data-settings-label>
          {t('plan.card.limits')}
        </h3>
        {/* A macOS-like table: header row in secondary text, hairlines between rows, numbers right-aligned. */}
        <div role="table" aria-label={t('plan.card.limits')} className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body" data-testid="plan-limits">
          <div role="row" className="grid grid-cols-[minmax(0,1fr)_128px_148px] gap-3 border-b mobile:hidden border-[var(--color-card-line)] px-3 py-1.5 text-caption font-medium text-muted">
            <span role="columnheader">{t('plan.col.limit')}</span>
            <span role="columnheader" className="text-right">
              {t('plan.col.used')}
            </span>
            <span role="columnheader" className="text-right">
              {t('plan.col.max')}
            </span>
          </div>
          {rows.map((r) => {
            const noUse = r.used === '—';
            return (
              // Phone: the label on its own line (it never truncates), the values under it.
              <div key={r.label} role="row" className="grid min-h-10 grid-cols-[minmax(0,1fr)_128px_148px] items-center gap-3 border-b border-[var(--color-card-line)] px-3 py-2 last:border-b-0 mobile:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] mobile:gap-y-1">
                <span role="cell" className="min-w-0 truncate mobile:col-span-2 mobile:whitespace-normal" data-settings-label>
                  {r.label}
                </span>
                <span role="cell" className={cx('text-right tabular-nums text-muted mobile:text-left', noUse && 'mobile:hidden')}>
                  {r.used}
                  {r.meter ? <Meter used={r.meter.used} limit={r.meter.limit} /> : null}
                </span>
                <span role="cell" className={cx('text-right tabular-nums', noUse && 'mobile:col-span-2 mobile:text-left')}>
                  {r.max}
                </span>
              </div>
            );
          })}
        </div>
        <p className="px-1 text-caption text-faint">{t('plan.limitsFooter')}</p>
      </section>

      {(contact || pricing) && !billingManaged ? (
        <Card title={t('plan.card.buy')}>
          <div className="flex flex-col items-start gap-3 px-3 py-3">
            <p className="text-body text-muted">{kind === Plan.FREE || plan.expired ? t('plan.teamPitch') : t('plan.paidPitch')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {contact ? <Button onClick={openPlanContact}>{t('plan.contact')}</Button> : null}
              {pricing ? (
                <Button variant="ghost" onClick={() => void platform.app.openExternal(pricing)}>
                  {t('plan.more')}
                  <ExternalLink className="size-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );
}
