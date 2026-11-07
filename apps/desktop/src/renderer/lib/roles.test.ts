import { create } from '@bufbuild/protobuf';
import { PERMISSION_BITS, RoleSchema, WorkspaceRole, type Role } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_LEVEL_BITS,
  botsWithRole,
  canAssignRole,
  canCreateRole,
  canDeleteRole,
  canEditRole,
  colorRole,
  customLook,
  editableBits,
  GUEST_BITS,
  legacyRoles,
  parseRoleColor,
  reorderCustom,
  roleActor,
  readableRoleColor,
  roleColorCss,
  roleCounts,
  roleNameError,
  rolesOfMember,
  sortRoles,
  topRole,
  uniqueRoleName,
  warnBotsAdmin,
  withRole,
} from './roles';

const { STREAM, MUTE_MEMBERS, MANAGE_ROLES, MANAGE_WORKSPACE, MANAGE_ROOM, ADMINISTRATOR } = PERMISSION_BITS;

const custom = (id: string, position: number, color = 0, permissions = 0n): Role => create(RoleSchema, { id, name: id, position, color, permissions });
const builtins = legacyRoles('w');
const design = custom('design', 4, 0x0a84ff, STREAM);
const mod = custom('mod', 3, 0x34c759, MUTE_MEMBERS | MANAGE_ROLES | MANAGE_ROOM);
const plain = custom('plain', 2, 0, 0n);
const ALL = sortRoles([...builtins, plain, design, mod]);
const byId = (id: string): Role => {
  const r = ALL.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return r;
};
const rolesOf = (role: WorkspaceRole, ...ids: string[]): Role[] => rolesOfMember(ALL, { role, roleIds: ids });

describe('member roles', () => {
  it('role_ids when sent, else the built-ins implied by the legacy role', () => {
    expect(rolesOf(WorkspaceRole.MEMBER, 'member', 'mod').map((r) => r.id)).toEqual(['mod', 'member']);
    expect(rolesOf(WorkspaceRole.OWNER).map((r) => r.id)).toEqual(['owner', 'member']);
    expect(rolesOf(WorkspaceRole.GUEST).map((r) => r.id)).toEqual(['guest']);
    expect(rolesOfMember(ALL, undefined)).toEqual([]);
  });

  it('sorts highest first; the top role is the highest position', () => {
    expect(ALL.map((r) => r.id)).toEqual(['owner', 'admin', 'design', 'mod', 'plain', 'member', 'guest']);
    expect(topRole(rolesOf(WorkspaceRole.MEMBER, 'member', 'plain', 'mod'))?.id).toBe('mod');
    expect(topRole<Role>([])).toBeUndefined();
  });
});

describe('name colour (the most senior coloured role)', () => {
  it('skips colourless roles, owner / admin keep their own look', () => {
    // plain (2) has no colour: mod (3) colours the name; with design (4) — design.
    expect(colorRole(rolesOf(WorkspaceRole.MEMBER, 'member', 'plain', 'mod'))?.id).toBe('mod');
    expect(customLook(rolesOf(WorkspaceRole.MEMBER, 'member', 'mod', 'design'))?.id).toBe('design');
    expect(customLook(rolesOf(WorkspaceRole.MEMBER, 'member', 'plain'))).toBeUndefined();
    expect(customLook(rolesOf(WorkspaceRole.ADMIN, 'admin', 'member', 'design'))).toBeUndefined();
    expect(customLook(rolesOf(WorkspaceRole.MEMBER, 'member'))).toBeUndefined();
  });

  it('colours as css and back', () => {
    expect(roleColorCss(0x0a84ff)).toBe('#0a84ff');
    expect(roleColorCss(0)).toBe('#000000');
    expect(parseRoleColor('#0A84FF')).toBe(0x0a84ff);
    expect(parseRoleColor('fc0')).toBe(0xffcc00);
    expect(parseRoleColor('blue')).toBeNull();
  });
});

describe('who may do what', () => {
  const owner = roleActor(rolesOf(WorkspaceRole.OWNER));
  const admin = roleActor(rolesOf(WorkspaceRole.ADMIN));
  const moderator = roleActor(rolesOf(WorkspaceRole.MEMBER, 'member', 'mod'));
  const member = roleActor(rolesOf(WorkspaceRole.MEMBER));

  it('manage / create / edit / delete: roles below my top one, the owner any', () => {
    expect(canCreateRole(owner) && canCreateRole(admin) && canCreateRole(moderator)).toBe(true);
    expect(canCreateRole(member)).toBe(false);
    expect(canEditRole(admin, design)).toBe(true);
    expect(canEditRole(admin, byId('admin'))).toBe(false);
    expect(canEditRole(owner, byId('admin'))).toBe(true);
    expect(canEditRole(moderator, plain)).toBe(true);
    expect(canEditRole(moderator, mod)).toBe(false);
    expect(canEditRole(moderator, design)).toBe(false);
    expect(canDeleteRole(owner, byId('member'))).toBe(false);
    expect(canDeleteRole(admin, design)).toBe(true);
  });

  it('editable bits: none on owner / admin, the guest set on guest, a non-admin only its own minus role / workspace management', () => {
    expect(editableBits(owner, byId('admin'))).toBe(0n);
    expect(editableBits(admin, byId('guest'))).toBe(GUEST_BITS);
    const all = editableBits(admin, design);
    expect(all & ADMINISTRATOR).toBe(0n);
    expect(all & MANAGE_ROLES).toBe(MANAGE_ROLES);
    const mine = editableBits(moderator, plain);
    expect(mine & MUTE_MEMBERS).toBe(MUTE_MEMBERS);
    expect(mine & MANAGE_ROLES).toBe(0n);
    expect(mine & MANAGE_WORKSPACE).toBe(0n);
    expect(editableBits(moderator, design)).toBe(0n);
  });

  it('assign: admin only by the owner, custom roles below me and within my permissions, the target below me', () => {
    const memberTop = 1;
    expect(canAssignRole(owner, byId('admin'), memberTop, false)).toBe(true);
    expect(canAssignRole(admin, byId('admin'), memberTop, false)).toBe(false);
    expect(canAssignRole(admin, byId('member'), memberTop, false)).toBe(false);
    expect(canAssignRole(admin, design, memberTop, false)).toBe(true);
    // Moderator (3): plain (2, no bits) yes; design (4) no; a target at 4 no; itself yes.
    expect(canAssignRole(moderator, plain, memberTop, false)).toBe(true);
    expect(canAssignRole(moderator, design, memberTop, false)).toBe(false);
    expect(canAssignRole(moderator, plain, 4, false)).toBe(false);
    expect(canAssignRole(moderator, plain, 3, true)).toBe(true);
    // … but not a role carrying a permission it lacks.
    expect(canAssignRole(moderator, custom('x', 2, 0, STREAM | MANAGE_WORKSPACE), memberTop, false)).toBe(false);
    expect(canAssignRole(member, plain, 0, false)).toBe(false);
  });

  it('the complete role set with one role toggled', () => {
    expect(withRole(['member', 'mod'], 'design', true)).toEqual(['member', 'mod', 'design']);
    expect(withRole(['member', 'mod'], 'mod', false)).toEqual(['member']);
    expect(withRole(['member', 'mod'], 'mod', true)).toEqual(['member', 'mod']);
  });
});

describe('the role form', () => {
  it('name: 1..32 characters after trimming, unique ignoring case', () => {
    expect(roleNameError('  ', ALL)).toBe('empty');
    expect(roleNameError('x'.repeat(33), ALL)).toBe('long');
    expect(roleNameError('x'.repeat(32), ALL)).toBeNull();
    expect(roleNameError('MOD', ALL)).toBe('taken');
    expect(roleNameError('mod', ALL, 'mod')).toBeNull();
    expect(uniqueRoleName('mod', ALL)).toBe('mod 2');
    expect(uniqueRoleName('New role', ALL)).toBe('New role');
  });

  it('order: dragging a custom role onto another', () => {
    expect(reorderCustom(ALL, 'plain', 'design')).toEqual(['plain', 'design', 'mod']);
    expect(reorderCustom(ALL, 'design', 'plain')).toEqual(['mod', 'plain', 'design']);
    expect(reorderCustom(ALL, 'design', 'design')).toBeNull();
    expect(reorderCustom(ALL, 'design', 'member')).toBeNull();
  });

  it('member counts per role', () => {
    const c = roleCounts(ALL, [
      { role: WorkspaceRole.OWNER, roleIds: [] },
      { role: WorkspaceRole.MEMBER, roleIds: ['member', 'design'] },
      { role: WorkspaceRole.MEMBER, roleIds: ['member', 'design', 'mod'] },
    ]);
    expect(c.get('design')).toBe(2);
    expect(c.get('member')).toBe(3);
    expect(c.get('owner')).toBe(1);
    expect(c.get('plain')).toBeUndefined();
  });
});

describe('bots holding administrative roles (ADR-0051)', () => {
  const all = [...builtins, custom('ops', 5, 0, MANAGE_ROOM)];
  const bot = (roleIds: string[]) => ({ role: WorkspaceRole.MEMBER, roleIds, user: { isBot: true } });
  const person = (roleIds: string[]) => ({ role: WorkspaceRole.MEMBER, roleIds, user: { isBot: false } });

  it('counts the bots of a role, built-ins implied', () => {
    const members = [bot(['member', 'ops']), bot(['member']), person(['member', 'ops'])];
    expect(botsWithRole(all, members, 'ops')).toBe(1);
    expect(botsWithRole(all, members, 'member')).toBe(2);
    expect(botsWithRole(all, [bot([])], 'member')).toBe(1);
  });

  it('warns on administrative bits only, and only with bots', () => {
    expect(warnBotsAdmin(MANAGE_ROOM, 1)).toBe(true);
    expect(warnBotsAdmin(PERMISSION_BITS.INVITE_MEMBERS | STREAM, 2)).toBe(true);
    expect(warnBotsAdmin(MANAGE_ROOM, 0)).toBe(false);
    expect(warnBotsAdmin(STREAM | PERMISSION_BITS.SEND_MESSAGES | PERMISSION_BITS.MANAGE_BOTS, 3)).toBe(false);
    expect(ADMIN_LEVEL_BITS & ADMINISTRATOR).toBe(0n);
  });
});

describe('readableRoleColor (CBF-154)', () => {
  const lum = (css: string): number => {
    const n = parseInt(css.slice(1), 16);
    const l = (c: number): number => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * l((n >> 16) & 255) + 0.7152 * l((n >> 8) & 255) + 0.0722 * l(n & 255);
  };
  const cr = (css: string, surface: number): number => (Math.max(lum(css), surface) + 0.05) / (Math.min(lum(css), surface) + 0.05);
  const LIGHT = lum('#e1e1e4');
  const DARK = lum('#3e3e43');
  it.each([0xffffff, 0xffeb99, 0xffcc00, 0x0a84ff, 0x8e8e93, 0x000000, 0x5a1a8a])('%s passes 4.5:1 in both themes', (c) => {
    expect(cr(readableRoleColor(c, 'light'), LIGHT)).toBeGreaterThanOrEqual(4.5);
    expect(cr(readableRoleColor(c, 'dark'), DARK)).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps a passing colour and keeps the hue', () => {
    expect(readableRoleColor(0xffcc00, 'dark')).toBe('#ffcc00');
    expect(readableRoleColor(0x0058b0, 'light')).toBe('#0058b0');
    const y = parseInt(readableRoleColor(0xffeb99, 'light').slice(1), 16);
    expect((y >> 16) & 255).toBeGreaterThan(y & 255);
  });
});
