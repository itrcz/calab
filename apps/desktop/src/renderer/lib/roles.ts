import { create } from '@bufbuild/protobuf';
import {
  ALL_PERMISSIONS,
  BILLING_BITS,
  BILLING_PERMISSIONS,
  BUILTIN_ROLE_POSITION,
  PERMISSION_BITS,
  ROLE_DEFAULTS,
  ROLE_TARGET_ID,
  RoleSchema,
  WorkspaceRole,
  memberRoles,
  workspacePermissions,
  type PermissionBits,
  type PermissionName,
  type Role,
  type RoleBits,
} from '@calaba/protocol';

/*
 * Workspace roles on the client (ADR-0026, docs/04 «Роли»): pure helpers — the member's roles,
 * the most senior / coloured one, who may edit or assign what. The client only hides UI; the
 * server re-checks every rule.
 */

const { ADMINISTRATOR, MANAGE_MEMBERS, MANAGE_ROLES, MANAGE_WORKSPACE } = PERMISSION_BITS;

/** Highest position first (the order of READY `roles[]` and of every list). */
export function sortRoles<R extends Pick<Role, 'position' | 'id'>>(roles: readonly R[]): R[] {
  return [...roles].sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
}

/**
 * The four built-in roles as a pre-ADR-0026 server implies them (no READY `roles[]`): ids are
 * the legacy override names («member»…), default permissions.
 */
export function legacyRoles(workspaceId: string): Role[] {
  return [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.GUEST].map((b) =>
    create(RoleSchema, {
      id: ROLE_TARGET_ID[b],
      workspaceId,
      name: ROLE_TARGET_ID[b],
      position: BUILTIN_ROLE_POSITION[b],
      permissions: ROLE_DEFAULTS[b],
      builtin: b,
    }),
  );
}

/** Built-in roles implied by the legacy single role (docs/04: owner → owner + member …). */
const IMPLIED: Record<WorkspaceRole, WorkspaceRole[]> = {
  [WorkspaceRole.UNSPECIFIED]: [],
  [WorkspaceRole.OWNER]: [WorkspaceRole.OWNER, WorkspaceRole.MEMBER],
  [WorkspaceRole.ADMIN]: [WorkspaceRole.ADMIN, WorkspaceRole.MEMBER],
  [WorkspaceRole.MEMBER]: [WorkspaceRole.MEMBER],
  [WorkspaceRole.GUEST]: [WorkspaceRole.GUEST],
};

/**
 * The member's roles among the workspace's, highest first. `role_ids` when the server sends
 * them; otherwise (an older server) the built-ins implied by the legacy `role`.
 */
export function rolesOfMember(
  all: readonly Role[],
  member: { role: WorkspaceRole; roleIds: readonly string[] } | undefined,
): Role[] {
  if (!member) return [];
  if (member.roleIds.length > 0) return memberRoles(all, member.roleIds);
  const implied = new Set(IMPLIED[member.role]);
  return all.filter((r) => implied.has(r.builtin));
}

/** The most senior role (highest position), if any. */
export function topRole<R extends RoleBits>(roles: readonly R[]): R | undefined {
  let best: R | undefined;
  for (const r of roles) if (!best || r.position > best.position) best = r;
  return best;
}

/** Name colour source (Discord): the most senior of the member's roles that has a colour. */
export function colorRole(roles: readonly Role[]): Role | undefined {
  return topRole(roles.filter((r) => r.color !== 0));
}

/**
 * The custom role that colours a name (docs/08 «Роли»): none for the owner / admins (their
 * crown / shield and tokens win), else the most senior coloured role when it is a custom one.
 */
export function customLook(roles: readonly Role[]): Role | undefined {
  if (roles.some((r) => r.builtin === WorkspaceRole.OWNER || r.builtin === WorkspaceRole.ADMIN)) return undefined;
  const c = colorRole(roles);
  return c && c.builtin === WorkspaceRole.UNSPECIFIED ? c : undefined;
}

/** 0xRRGGBB → «#rrggbb». */
export function roleColorCss(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** «#rrggbb» (or «rrggbb», «#rgb») → 0xRRGGBB; null when it is no colour. */
export function parseRoleColor(s: string): number | null {
  let h = s.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/i.test(h) ? parseInt(h, 16) : null;
}

/** The role palette (12 swatches, Discord-like; the system colours of docs/08 where they fit). */
export const ROLE_PALETTE: readonly number[] = [
  0x0a84ff, 0x30b0c7, 0x34c759, 0x1f8b4c, 0xffcc00, 0xff9f0a, 0xff453a, 0xff2d55, 0xbf5af2, 0x5e5ce6, 0xa2845e, 0x8e8e93,
];

// ---------------------------------------------------------------- permission matrix

/** Bits a guest role may carry (docs/04; the server keeps GUEST within them). */
export const GUEST_BITS: PermissionBits =
  PERMISSION_BITS.VIEW_ROOM |
  PERMISSION_BITS.SEND_MESSAGES |
  PERMISSION_BITS.ATTACH_FILES |
  PERMISSION_BITS.CONNECT |
  PERMISSION_BITS.SPEAK |
  PERMISSION_BITS.STREAM |
  PERMISSION_BITS.VIDEO;

export type PermGroupId =
  | 'workspace'
  | 'members'
  | 'invites'
  | 'rooms'
  | 'voice'
  | 'moderation'
  | 'calendar'
  | 'boards'
  | 'recordings'
  | 'telephony'
  | 'integrations'
  | 'journals';

/**
 * The role card's matrix by function (ADR-0048 §3, «Контракт для клиента»): Пространство ·
 * Участники · Приглашения (ADR-0043) · Комнаты · Голос · Модерация · Календарь · Доски · Записи ·
 * Телефония (ADR-0046: PLACE_CALLS, nobody by default) · Интеграции и боты ·
 * Журналы. ADMINISTRATOR is never grantable and is not listed.
 */
export const ROLE_PERM_GROUPS: ReadonlyArray<{ id: PermGroupId; perms: readonly PermissionName[] }> = [
  { id: 'workspace', perms: ['MANAGE_WORKSPACE', 'MANAGE_ROLES', 'MANAGE_STICKERS'] },
  { id: 'members', perms: ['MANAGE_MEMBERS', 'MANAGE_NICKNAMES'] },
  { id: 'invites', perms: ['INVITE_MEMBERS', 'INVITE_GUESTS'] },
  { id: 'rooms', perms: ['VIEW_ROOM', 'MANAGE_ROOM', 'CREATE_TEMP_ROOMS', 'SEND_MESSAGES', 'ATTACH_FILES', 'MENTION_EVERYONE'] },
  { id: 'voice', perms: ['CONNECT', 'SPEAK', 'VIDEO', 'STREAM'] },
  { id: 'moderation', perms: ['MANAGE_MESSAGES', 'MUTE_MEMBERS', 'MOVE_MEMBERS'] },
  { id: 'calendar', perms: ['MANAGE_EVENTS'] },
  { id: 'boards', perms: ['CREATE_BOARDS', 'VIEW_BOARD', 'CREATE_TASKS', 'EDIT_TASKS', 'MANAGE_BOARD'] },
  { id: 'recordings', perms: ['MANAGE_RECORDINGS'] },
  // ADR-0046: nobody by default (calls cost money); never a guest.
  { id: 'telephony', perms: ['PLACE_CALLS'] },
  { id: 'integrations', perms: ['MANAGE_BOTS', 'MANAGE_INTEGRATIONS'] },
  { id: 'journals', perms: ['VIEW_JOURNALS'] },
];

/**
 * Administrative bits (ADR-0051): a bot token whose roles carry any of them acts as an admin
 * through the Bot API, so the role card warns when such a role is held by bots. MANAGE_BOTS is
 * not one: it gives a bot nothing.
 */
export const ADMIN_LEVEL_BITS: PermissionBits =
  PERMISSION_BITS.MANAGE_WORKSPACE |
  PERMISSION_BITS.MANAGE_ROLES |
  PERMISSION_BITS.MANAGE_MEMBERS |
  PERMISSION_BITS.MANAGE_NICKNAMES |
  PERMISSION_BITS.MANAGE_ROOM |
  PERMISSION_BITS.MANAGE_MESSAGES |
  PERMISSION_BITS.MANAGE_EVENTS |
  PERMISSION_BITS.MANAGE_RECORDINGS |
  PERMISSION_BITS.MANAGE_INTEGRATIONS |
  PERMISSION_BITS.MANAGE_BOARD |
  PERMISSION_BITS.INVITE_MEMBERS |
  PERMISSION_BITS.INVITE_GUESTS |
  PERMISSION_BITS.VIEW_JOURNALS;

/** Bots holding `roleId` (built-ins implied as in rolesOfMember). */
export function botsWithRole(
  all: readonly Role[],
  members: Iterable<{ role: WorkspaceRole; roleIds: readonly string[]; user?: { isBot: boolean } | undefined }>,
  roleId: string,
): number {
  let n = 0;
  for (const m of members) if (m.user?.isBot && rolesOfMember(all, m).some((r) => r.id === roleId)) n++;
  return n;
}

/** The role card's warning (ADR-0051): administrative bits on a role that bots hold. */
export const warnBotsAdmin = (bits: PermissionBits, bots: number): boolean => bots > 0 && (bits & ADMIN_LEVEL_BITS) !== 0n;

/** Who holds a bit by default (the second half of each bit's hint): guests too, members, or admins only. */
export type PermDefault = 'guests' | 'members' | 'admins';

export function permDefault(name: PermissionName): PermDefault {
  const bit = PERMISSION_BITS[name];
  if (ROLE_DEFAULTS[WorkspaceRole.GUEST] & bit) return 'guests';
  if (ROLE_DEFAULTS[WorkspaceRole.MEMBER] & bit) return 'members';
  return 'admins';
}

// ---------------------------------------------------------------- role templates

export type RoleTemplateId = 'empty' | 'moderator' | 'manager' | 'observer';

/**
 * Templates of a new role (ADR-0048 «Контракт для клиента»), on top of the member role that already
 * has the basic rights: Модератор = 14472, Менеджер отдела = 1656750080, Наблюдатель = 131089
 * (viewing only; to take SEND_MESSAGES / SPEAK away the role is denied them in a room — roles are
 * OR-ed, the server changes nothing; the create form says so).
 */
export const ROLE_TEMPLATES: ReadonlyArray<{ id: RoleTemplateId; bits: PermissionBits }> = [
  { id: 'empty', bits: 0n },
  {
    id: 'moderator',
    bits:
      PERMISSION_BITS.MANAGE_MESSAGES |
      PERMISSION_BITS.MUTE_MEMBERS |
      PERMISSION_BITS.MOVE_MEMBERS |
      PERMISSION_BITS.MANAGE_NICKNAMES |
      PERMISSION_BITS.MENTION_EVERYONE,
  },
  {
    id: 'manager',
    bits:
      PERMISSION_BITS.CREATE_BOARDS |
      PERMISSION_BITS.CREATE_TEMP_ROOMS |
      PERMISSION_BITS.INVITE_GUESTS |
      PERMISSION_BITS.MANAGE_EVENTS |
      PERMISSION_BITS.VIEW_JOURNALS,
  },
  { id: 'observer', bits: PERMISSION_BITS.VIEW_ROOM | PERMISSION_BITS.CONNECT | PERMISSION_BITS.VIEW_BOARD },
];

/** A template's bits limited to those I may grant (`editable`, lib/roles editableBits). */
export function templateBits(id: RoleTemplateId, editable: PermissionBits): PermissionBits {
  return (ROLE_TEMPLATES.find((x) => x.id === id)?.bits ?? 0n) & editable;
}

/** Bits of the template I cannot grant (the form says they stay unchecked). */
export function templateClipped(id: RoleTemplateId, editable: PermissionBits): PermissionBits {
  return (ROLE_TEMPLATES.find((x) => x.id === id)?.bits ?? 0n) & ~editable;
}

export const isFullRole = (r: Pick<Role, 'builtin'>): boolean => r.builtin === WorkspaceRole.OWNER || r.builtin === WorkspaceRole.ADMIN;
export const isCustomRole = (r: Pick<Role, 'builtin'>): boolean => r.builtin === WorkspaceRole.UNSPECIFIED;

// ---------------------------------------------------------------- who may do what

/** Me as far as role management goes. */
export interface RoleActor {
  owner: boolean;
  /** ADMINISTRATOR (owner, admins): every permission. */
  admin: boolean;
  /** Workspace-level bits (OR of my roles). */
  perms: PermissionBits;
  /** Position of my most senior role (-1 = none). */
  top: number;
}

export function roleActor(myRoles: readonly Role[]): RoleActor {
  const perms = workspacePermissions(myRoles);
  return {
    owner: myRoles.some((r) => r.builtin === WorkspaceRole.OWNER),
    admin: (perms & ADMINISTRATOR) !== 0n,
    perms,
    top: topRole(myRoles)?.position ?? -1,
  };
}

export const canManageRoles = (a: RoleActor): boolean => (a.perms & MANAGE_ROLES) !== 0n;

/** Giving / taking roles (ADR-0048): MANAGE_MEMBERS or MANAGE_ROLES — the server accepts either. */
export const canAssignRoles = (a: RoleActor): boolean => (a.perms & (MANAGE_ROLES | MANAGE_MEMBERS)) !== 0n;

/** Create: MANAGE_ROLES and a top role above the new one's place (position 2). */
export const canCreateRole = (a: RoleActor): boolean => canManageRoles(a) && (a.owner || a.top > 2);

/** Edit (name / colour / permissions / order / members): roles below my most senior one; the owner — any. */
export function canEditRole(a: RoleActor, r: Pick<Role, 'position'>): boolean {
  return canManageRoles(a) && (a.owner || r.position < a.top);
}

/** A role with billing bits is deleted by the owner only (ADR-0087). */
export const canDeleteRole = (a: RoleActor, r: Pick<Role, 'position' | 'builtin'> & { permissions?: PermissionBits }): boolean =>
  isCustomRole(r) && canEditRole(a, r) && (a.owner || ((r.permissions ?? 0n) & BILLING_PERMISSIONS) === 0n);

/** Name is fixed for the built-ins. */
export const canRenameRole = (a: RoleActor, r: Pick<Role, 'position' | 'builtin'>): boolean => isCustomRole(r) && canEditRole(a, r);

/**
 * Permission bits I may toggle on a role: none on owner / admin (full access, fixed); the guest
 * set on the guest role; a non-admin only bits they hold, never MANAGE_ROLES / MANAGE_WORKSPACE.
 */
export function editableBits(a: RoleActor, r: Pick<Role, 'position' | 'builtin'>): PermissionBits {
  if (isFullRole(r) || !canEditRole(a, r)) return 0n;
  let bits = ALL_PERMISSIONS & ~ADMINISTRATOR;
  if (r.builtin === WorkspaceRole.GUEST) bits &= GUEST_BITS;
  if (!a.admin) bits &= a.perms & ~(MANAGE_ROLES | MANAGE_WORKSPACE);
  return bits;
}

// ---------------------------------------------------------------- billing bits (ADR-0087)

export type BillingPermName = 'BILLING_VIEW' | 'BILLING_TOPUP' | 'BILLING_MANAGE';

/** The «Биллинг» group of the role card, lowest first (each implies the ones above it). */
export const BILLING_PERM_ORDER: readonly BillingPermName[] = ['BILLING_VIEW', 'BILLING_TOPUP', 'BILLING_MANAGE'];

export const BILLING_PERM_BIT: Record<BillingPermName, PermissionBits> = {
  BILLING_VIEW: BILLING_BITS.VIEW,
  BILLING_TOPUP: BILLING_BITS.TOPUP,
  BILLING_MANAGE: BILLING_BITS.MANAGE,
};

/**
 * Billing bits I may toggle on a role: the owner only (ADMINISTRATOR does not include them), on a
 * custom role or the member role (never owner / admin: fixed; never the guest role: guests never pay).
 */
export function billingEditableBits(a: RoleActor, r: Pick<Role, 'position' | 'builtin'>): PermissionBits {
  if (!a.owner || isFullRole(r) || r.builtin === WorkspaceRole.GUEST || !canEditRole(a, r)) return 0n;
  return BILLING_PERMISSIONS;
}

/**
 * The role's bits with billing permission `name` switched: on adds it and what it implies (MANAGE →
 * TOPUP → VIEW), off removes it and what implies it — the stored bits always match what the
 * checkboxes show and what the server computes.
 */
export function toggleBilling(bits: PermissionBits, name: BillingPermName, on: boolean): PermissionBits {
  const i = BILLING_PERM_ORDER.indexOf(name);
  let mask = 0n;
  for (const [j, n] of BILLING_PERM_ORDER.entries()) if (on ? j <= i : j >= i) mask |= BILLING_PERM_BIT[n];
  return on ? bits | mask : bits & ~mask;
}

/** Whether the role's billing bit `name` is on, implications included. */
export function billingOn(bits: PermissionBits, name: BillingPermName): boolean {
  const i = BILLING_PERM_ORDER.indexOf(name);
  return BILLING_PERM_ORDER.some((n, j) => j >= i && (bits & BILLING_PERM_BIT[n]) !== 0n);
}

/**
 * May I give / take `role` to / from a member whose most senior role sits at `targetTop`
 * (docs/04 «Назначение»)? MEMBER / GUEST follow the member itself, OWNER never; ADMIN — the
 * owner only; others: below my top role, within my own permissions (non-admin), and the target
 * below me (or myself). The right itself: MANAGE_MEMBERS or MANAGE_ROLES (ADR-0048).
 */
export function canAssignRole(a: RoleActor, role: Pick<Role, 'position' | 'builtin' | 'permissions'>, targetTop: number, self: boolean): boolean {
  if (!canAssignRoles(a)) return false;
  // ADR-0087: roles with billing bits are the owner's to give and take.
  if ((role.permissions & BILLING_PERMISSIONS) !== 0n && !a.owner) return false;
  if (role.builtin === WorkspaceRole.MEMBER || role.builtin === WorkspaceRole.GUEST || role.builtin === WorkspaceRole.OWNER) return false;
  if (role.builtin === WorkspaceRole.ADMIN) return a.owner && !self;
  if (!a.owner && role.position >= a.top) return false;
  if (!a.admin && (role.permissions & ~a.perms) !== 0n) return false;
  return self || a.owner || targetTop < a.top;
}

/** The member's complete role set with `roleId` added or removed (PUT …/members/{uid}/roles). */
export function withRole(roleIds: readonly string[], roleId: string, on: boolean): string[] {
  const rest = roleIds.filter((id) => id !== roleId);
  return on ? [...rest, roleId] : rest;
}

// ---------------------------------------------------------------- the role form

export const ROLE_NAME_MAX = 32;

export type RoleNameError = 'empty' | 'long' | 'taken' | null;

/** Name check of the role card: 1..32 characters after trimming, unique (case-insensitive) in the workspace. */
export function roleNameError(name: string, others: readonly Pick<Role, 'id' | 'name'>[], selfId = ''): RoleNameError {
  const n = name.trim();
  if (!n) return 'empty';
  // Characters as the server counts them (code points).
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  if ([...n].length > ROLE_NAME_MAX) return 'long';
  const low = n.toLocaleLowerCase();
  if (others.some((r) => r.id !== selfId && r.name.toLocaleLowerCase() === low)) return 'taken';
  return null;
}

/** «Новая роль», «Новая роль 2»…: the first name not taken in the workspace. */
export function uniqueRoleName(base: string, roles: readonly Pick<Role, 'id' | 'name'>[]): string {
  for (let i = 1; ; i++) {
    const n = i === 1 ? base : `${base} ${i}`;
    if (roleNameError(n, roles) === null) return n;
  }
}

/** Members per role (the list's counts), legacy members included (lib/roles rolesOfMember). */
export function roleCounts(all: readonly Role[], members: readonly { role: WorkspaceRole; roleIds: readonly string[] }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of members) for (const r of rolesOfMember(all, m)) out.set(r.id, (out.get(r.id) ?? 0) + 1);
  return out;
}

/**
 * New order of the custom roles after dragging `activeId` onto `overId` (both custom), highest
 * first — the body of PUT …/roles/order. Null when nothing moves.
 */
export function reorderCustom(roles: readonly Role[], activeId: string, overId: string): string[] | null {
  const ids = sortRoles(roles.filter(isCustomRole)).map((r) => r.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  ids.splice(to, 0, ...ids.splice(from, 1));
  return ids;
}
