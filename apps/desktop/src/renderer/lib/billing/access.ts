import { BILLING_BITS, BILLING_PERMISSIONS, WorkspaceRole, billingPermissions, type PermissionBits, type Role } from '@calaba/protocol';

/*
 * Who may do what with billing on this client (ADR-0087): the role bits BILLING_VIEW / TOPUP /
 * MANAGE through billingPermissions (packages/protocol, the server's perm.BillingOf); the
 * workspace owner has all three. The client only hides UI — every route checks its bit.
 */

/** What the billing UI offers me. `payHere`: this client may show payment UI at all (not the iOS shell). */
export interface BillingCaps {
  /** Balance, history, plan, receipts, payer and saved methods read-only. */
  view: boolean;
  /** «Пополнить» through the hosted payment page (own card / SBP). */
  topup: boolean;
  /** Plan changes, one-click top-up, auto-topup, saved methods, payer, refund requests. */
  manage: boolean;
}

export const NO_BILLING: BillingCaps = { view: false, topup: false, manage: false };

/** My billing bits in a workspace: `myRole` (WorkspaceEntry.role), `myRoles` (rolesOf). */
export function myBillingBits(myRole: WorkspaceRole | undefined, myRoles: readonly Pick<Role, 'permissions' | 'builtin'>[]): PermissionBits {
  if (myRole === WorkspaceRole.OWNER) return BILLING_PERMISSIONS;
  if (myRole === undefined || myRole === WorkspaceRole.UNSPECIFIED) return 0n;
  return billingPermissions(myRoles, { owner: false, guest: myRole === WorkspaceRole.GUEST });
}

/**
 * The caps for bits on a client that may (`payHere`) or may not show payment UI: without it
 * (the iOS shell, App Store rules) only VIEW is left — read-only amounts, no actions.
 */
export function billingCaps(bits: PermissionBits, payHere: boolean): BillingCaps {
  const has = (b: PermissionBits): boolean => (bits & b) === b;
  return {
    view: has(BILLING_BITS.VIEW),
    topup: payHere && has(BILLING_BITS.TOPUP),
    manage: payHere && has(BILLING_BITS.MANAGE),
  };
}
