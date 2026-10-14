import type { PermissionBits } from '@calaba/protocol';
import { billingCaps, myBillingBits, type BillingCaps } from '../../../lib/billing/access';
import { billingPaymentsAllowed } from '../../../services/billing';
import { useSession } from '../../../stores/session';
import { rolesOf, useWorkspaces } from '../../../stores/workspaces';

/**
 * My billing bits in workspace `id` (ADR-0087) — a bigint, so the selector re-renders only when the
 * bits change, not on member / presence traffic.
 */
export function useBillingBits(id: string | null | undefined): PermissionBits {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => {
    const e = id ? s.byId[id] : undefined;
    return e ? myBillingBits(e.role, rolesOf(e, me)) : 0n;
  });
}

/** My billing caps here (bits + whether this client shows payment UI at all). */
export function capsOf(bits: PermissionBits): BillingCaps {
  return billingCaps(bits, billingPaymentsAllowed());
}
