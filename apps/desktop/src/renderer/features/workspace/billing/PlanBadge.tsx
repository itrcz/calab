import { BillingState, Plan, WorkspaceRole } from '@calaba/protocol';
import { CirclePause, TriangleAlert } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { cx } from '../../../components/ui';
import { t } from '../../../i18n';
import { badgeShown, badgeView, selfServeOf } from '../../../lib/billing/plans';
import { PLAN_LABEL, planKind } from '../../../lib/plan';
import { billingMock, loadBilling, openPlans } from '../../../services/billing';
import { useBilling } from '../../../stores/billing';
import { useContextWorkspace } from '../../../stores/sections';
import { useSession } from '../../../stores/session';
import { HOME } from '../../../stores/dms';
import { useWorkspaces } from '../../../stores/workspaces';
import { useBillingState } from './BillingPaywall';

/**
 * The plan badge beside the open workspace's name (ADR-0080, docs/08 «Тариф»): «Free» / «Team» /
 * «Business», plus «долг» / «приостановлено» when it needs attention; a click opens «Тариф и
 * оплата». Only where billing exists for this workspace: Workspace.billing (every member) or an
 * owner who may start billing (READY.billing_self_serve, then GET …/billing self_serve). Billing off
 * on the server, no account and no self-serve — nothing at all and no request; the header stays as it was.
 * A leaf: primitive selectors only (plan kind, state, two booleans) — a presence / voice / member
 * change re-renders nothing here; the owner's GET runs once per workspace (stores/billing).
 */
export function PlanBadge({ phone = false }: { phone?: boolean }): ReactNode {
  const workspaceId = useContextWorkspace();
  const id = workspaceId && workspaceId !== HOME ? workspaceId : '';
  const owner = useWorkspaces((s) => (id ? s.byId[id]?.role === WorkspaceRole.OWNER : false));
  const plan = useWorkspaces((s) => (id ? planKind(s.byId[id]?.ws.plan) : Plan.FREE));
  const state = useBillingState(id || null);
  const selfServe = useBilling((s) => (owner ? selfServeOf(s.byWs[id]?.data) : false));
  const serverSelfServe = useSession((s) => s.billingSelfServe);
  // Only the owner of a workspace without Workspace.billing on a self-serve server asks (once; a
  // 501 / 404 answer is remembered): with billing off (READY.billing_self_serve unset) — no request.
  const ask = !!id && ((owner && serverSelfServe && state === BillingState.UNSPECIFIED) || billingMock());
  useEffect(() => {
    if (ask && !useBilling.getState().byWs[id]) void loadBilling(id);
  }, [ask, id]);
  if (!id || !badgeShown(state, selfServe)) return null;
  const v = badgeView(plan, state);
  const note = v.note === 'debt' ? t('billing.badge.debt') : v.note === 'suspended' ? t('billing.badge.suspended') : v.note === 'inactive' && owner ? t('billing.badge.inactive') : '';
  const name = t(PLAN_LABEL[v.plan]);
  const label = t('billing.badge.label', { plan: note ? `${name}, ${note}` : name });
  return (
    <button
      type="button"
      onClick={() => openPlans(id)}
      aria-label={label}
      title={label}
      data-testid="plan-badge"
      data-plan={Plan[v.plan]}
      data-tone={v.tone}
      className={cx(
        'no-drag inline-flex shrink-0 items-center gap-1 rounded-full px-2 font-semibold transition-[filter,background-color] duration-[var(--motion-fast)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]',
        phone ? 'h-6 text-caption bar-hit' : 'ml-1 h-5 text-caption',
        v.tone === 'paid'
          ? 'bg-accent-strong text-accent-fg'
          : v.tone === 'danger'
            ? 'bg-danger-fill text-white'
            : v.tone === 'warn'
              ? 'bg-warn-surface text-fg ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-warn)_45%,transparent)]'
              : 'bg-[var(--color-fill-hover)] text-fg hover:bg-active',
      )}
    >
      {v.tone === 'danger' ? <CirclePause className="size-3" aria-hidden /> : v.tone === 'warn' ? <TriangleAlert className="size-3 text-warn" aria-hidden /> : null}
      <span>{name}</span>
      {note ? <span className={cx('font-normal', phone && 'mobile:hidden')}>· {note}</span> : null}
    </button>
  );
}
