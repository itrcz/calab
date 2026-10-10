import { BILLING_BITS, BillingState, Plan } from '@calaba/protocol';
import { CirclePause, TriangleAlert } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t } from '../../../i18n';
import { badgeShown, badgeView, selfServeOf } from '../../../lib/billing/plans';
import { planDisplayName, planKind } from '../../../lib/plan';
import { billingMock, loadBilling, openPlanSettings } from '../../../services/billing';
import { useBilling } from '../../../stores/billing';
import { useContextWorkspace } from '../../../stores/sections';
import { useSession } from '../../../stores/session';
import { HOME } from '../../../stores/dms';
import { useWorkspaces } from '../../../stores/workspaces';
import { useBillingBits } from './access';
import { useBillingState } from './BillingPaywall';

/**
 * The plan badge beside the open workspace's name (ADR-0080, docs/08 «Тариф»): «Free» / «Team» /
 * «Business», plus «долг» / «приостановлено» when it needs attention; a click opens settings →
 * «Тариф» (owner, 10.10; «Сменить тариф» there opens the plans). Only where billing exists for
 * this workspace: Workspace.billing (every member) or a BILLING_MANAGE holder who may start billing
 * (READY.billing_self_serve, then GET …/billing self_serve). Billing off on the server, no account
 * and no self-serve — nothing at all and no request; the header stays as it was.
 * ADR-0087: without BILLING_VIEW the plan name only («долг» is money) — the suspension still shows,
 * it closes the workspace for everyone. An outline, never a fill (owner 10.10: a filled accent pill
 * drew too much attention): neutral border and secondary text; debt / suspension — the warn / danger
 * border, no fill; hover and focus stay subtle.
 * A leaf: primitive selectors only (plan kind, state, bits, a boolean) — a presence / voice / member
 * change re-renders nothing here; the GET runs once per workspace (stores/billing).
 */
export function PlanBadge({ phone = false }: { phone?: boolean }): ReactNode {
  const workspaceId = useContextWorkspace();
  const id = workspaceId && workspaceId !== HOME ? workspaceId : '';
  const bits = useBillingBits(id);
  const view = (bits & BILLING_BITS.VIEW) !== 0n;
  const manage = (bits & BILLING_BITS.MANAGE) !== 0n;
  const plan = useWorkspaces((s) => (id ? planKind(s.byId[id]?.ws.plan) : Plan.FREE));
  // ADR-0086: a custom plan shows the name a superadmin gave it (a primitive: the string).
  const customName = useWorkspaces((s) => (id ? (s.byId[id]?.ws.plan?.displayName ?? '') : ''));
  const state = useBillingState(id || null);
  const selfServe = useBilling((s) => (manage ? selfServeOf(s.byWs[id]?.data) : false));
  const serverSelfServe = useSession((s) => s.billingSelfServe);
  // Only a MANAGE holder of a workspace without Workspace.billing on a self-serve server asks (once;
  // a 501 / 404 answer is remembered): with billing off (READY.billing_self_serve unset) — no request.
  const ask = !!id && ((manage && serverSelfServe && state === BillingState.UNSPECIFIED) || billingMock());
  useEffect(() => {
    if (ask && !useBilling.getState().byWs[id]) void loadBilling(id);
  }, [ask, id]);
  if (!id || !badgeShown(state, selfServe)) return null;
  // Without BILLING_VIEW a debt is not shown (money); the suspension is (everyone is closed out).
  const v = badgeView(plan, !view && state === BillingState.IN_ARREARS ? BillingState.UNSPECIFIED : state);
  const note = v.note === 'debt' ? t('billing.badge.debt') : v.note === 'suspended' ? t('billing.badge.suspended') : v.note === 'inactive' && manage ? t('billing.badge.inactive') : '';
  const name = planDisplayName(v.plan, customName);
  const label = t('billing.badge.label', { plan: note ? `${name}, ${note}` : name });
  return (
    <button
      type="button"
      onClick={() => openPlanSettings(id)}
      aria-label={label}
      title={label}
      data-testid="plan-badge"
      data-plan={Plan[v.plan]}
      data-tone={v.tone}
      className={cx(
        // An outline: a 1 px border, no fill; hover — the faint system fill, focus — the focus ring.
        'no-drag inline-flex shrink-0 items-center gap-1 rounded-full border bg-transparent px-2 font-semibold transition-[color,background-color] duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]',
        phone ? 'h-6 text-caption bar-hit' : 'ml-1 h-5 text-caption',
        v.tone === 'danger'
          ? 'border-danger text-danger-text'
          : v.tone === 'warn'
            ? // Yellow text fails contrast on light surfaces: the warn border and icon carry the tone.
              'border-warn text-fg'
            : 'border-line text-muted hover:text-fg',
      )}
    >
      {v.tone === 'danger' ? <CirclePause className="size-3 text-danger" aria-hidden /> : v.tone === 'warn' ? <TriangleAlert className="size-3 text-warn" aria-hidden /> : null}
      <span className="max-w-48 truncate mobile:max-w-32">{name}</span>
      {note ? <span className={cx('font-normal', phone && 'mobile:hidden')}>· {note}</span> : null}
    </button>
  );
}
