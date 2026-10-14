import { create } from '@bufbuild/protobuf';
import { BILLING_BITS, BILLING_PERMISSIONS, PERMISSION_BITS, RoleSchema, WorkspaceRole, type Role } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { billingEditableBits, billingOn, canAssignRole, canDeleteRole, legacyRoles, roleActor, rolesOfMember, toggleBilling } from '../roles';
import { billingCaps, myBillingBits } from './access';

/* ADR-0087 on the client: billing bits of a member, what the billing UI offers, the role editor's billing group. */

const { VIEW, TOPUP, MANAGE } = BILLING_BITS;
const builtins = legacyRoles('w');
const custom = (id: string, position: number, permissions: bigint): Role => create(RoleSchema, { id, workspaceId: 'w', name: id, position, permissions });
const as = (role: WorkspaceRole, ...extra: Role[]): Role[] => [...rolesOfMember(builtins, { role, roleIds: [] }), ...extra];

describe('myBillingBits', () => {
  it('the owner has all three; admins and default members none', () => {
    expect(myBillingBits(WorkspaceRole.OWNER, as(WorkspaceRole.OWNER))).toBe(BILLING_PERMISSIONS);
    expect(myBillingBits(WorkspaceRole.ADMIN, as(WorkspaceRole.ADMIN))).toBe(0n);
    expect(myBillingBits(WorkspaceRole.MEMBER, as(WorkspaceRole.MEMBER))).toBe(0n);
  });
  it('a role gives its bit and what it implies; guests never', () => {
    expect(myBillingBits(WorkspaceRole.MEMBER, as(WorkspaceRole.MEMBER, custom('v', 2, VIEW)))).toBe(VIEW);
    expect(myBillingBits(WorkspaceRole.MEMBER, as(WorkspaceRole.MEMBER, custom('t', 2, TOPUP)))).toBe(VIEW | TOPUP);
    expect(myBillingBits(WorkspaceRole.ADMIN, as(WorkspaceRole.ADMIN, custom('m', 2, MANAGE)))).toBe(BILLING_PERMISSIONS);
    expect(myBillingBits(WorkspaceRole.GUEST, as(WorkspaceRole.GUEST, custom('m', 2, MANAGE)))).toBe(0n);
    expect(myBillingBits(undefined, [])).toBe(0n);
  });
});

describe('billingCaps', () => {
  it('follows the bits where payment UI is allowed', () => {
    expect(billingCaps(VIEW, true)).toEqual({ view: true, topup: false, manage: false });
    expect(billingCaps(VIEW | TOPUP, true)).toEqual({ view: true, topup: true, manage: false });
    expect(billingCaps(BILLING_PERMISSIONS, true)).toEqual({ view: true, topup: true, manage: true });
  });
  it('the iOS shell keeps read-only VIEW and no actions', () => {
    expect(billingCaps(BILLING_PERMISSIONS, false)).toEqual({ view: true, topup: false, manage: false });
    expect(billingCaps(0n, false)).toEqual({ view: false, topup: false, manage: false });
  });
});

describe('the role editor: billing group', () => {
  const owner = roleActor(as(WorkspaceRole.OWNER));
  const admin = roleActor(as(WorkspaceRole.ADMIN));
  const fin = custom('fin', 2, MANAGE | PERMISSION_BITS.MUTE_MEMBERS);
  const memberRole = builtins.find((r) => r.builtin === WorkspaceRole.MEMBER);
  const guestRole = builtins.find((r) => r.builtin === WorkspaceRole.GUEST);
  const adminRole = builtins.find((r) => r.builtin === WorkspaceRole.ADMIN);
  if (!memberRole || !guestRole || !adminRole) throw new Error('built-ins');

  it('only the owner toggles billing bits, never on owner / admin / guest roles', () => {
    expect(billingEditableBits(owner, fin)).toBe(BILLING_PERMISSIONS);
    expect(billingEditableBits(owner, memberRole)).toBe(BILLING_PERMISSIONS);
    expect(billingEditableBits(owner, guestRole)).toBe(0n);
    expect(billingEditableBits(owner, adminRole)).toBe(0n);
    expect(billingEditableBits(admin, fin)).toBe(0n);
  });
  it('switching keeps the implications: on adds the lower bits, off removes the higher ones', () => {
    expect(toggleBilling(0n, 'BILLING_MANAGE', true)).toBe(BILLING_PERMISSIONS);
    expect(toggleBilling(0n, 'BILLING_TOPUP', true)).toBe(VIEW | TOPUP);
    expect(toggleBilling(BILLING_PERMISSIONS, 'BILLING_TOPUP', false)).toBe(VIEW);
    expect(toggleBilling(BILLING_PERMISSIONS | 8n, 'BILLING_VIEW', false)).toBe(8n);
    expect(billingOn(MANAGE, 'BILLING_VIEW')).toBe(true);
    expect(billingOn(VIEW, 'BILLING_TOPUP')).toBe(false);
  });
  it('roles with billing bits are assigned and deleted by the owner only', () => {
    expect(canAssignRole(owner, fin, 1, false)).toBe(true);
    expect(canAssignRole(admin, fin, 1, false)).toBe(false);
    expect(canAssignRole(admin, custom('x', 2, PERMISSION_BITS.MUTE_MEMBERS), 1, false)).toBe(true);
    expect(canDeleteRole(owner, fin)).toBe(true);
    expect(canDeleteRole(admin, fin)).toBe(false);
  });
});
