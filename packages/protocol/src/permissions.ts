import { Permission, WorkspaceRole } from './gen/calaba/v1/permissions_pb.js';
import { PermissionTargetType, type RoomPermissionOverride } from './gen/calaba/v1/room_pb.js';
import type { Board, Task } from './gen/calaba/v1/boards_pb.js';
import type { DiskPermissionEntry } from './gen/calaba/v1/disk_pb.js';
import type { WikiPermissionEntry } from './gen/calaba/v1/wiki_pb.js';

/**
 * Permission bits as bigint (uint64 on the wire). Values come from the generated
 * `Permission` enum (proto/calaba/v1/permissions.proto) — see docs/04-data-model.md, ADR-0008.
 */
export const PERMISSION_BITS = {
  VIEW_ROOM: BigInt(Permission.VIEW_ROOM),
  SEND_MESSAGES: BigInt(Permission.SEND_MESSAGES),
  ATTACH_FILES: BigInt(Permission.ATTACH_FILES),
  MANAGE_MESSAGES: BigInt(Permission.MANAGE_MESSAGES),
  CONNECT: BigInt(Permission.CONNECT),
  SPEAK: BigInt(Permission.SPEAK),
  STREAM: BigInt(Permission.STREAM),
  MUTE_MEMBERS: BigInt(Permission.MUTE_MEMBERS),
  MANAGE_ROOM: BigInt(Permission.MANAGE_ROOM),
  MANAGE_WORKSPACE: BigInt(Permission.MANAGE_WORKSPACE),
  ADMINISTRATOR: BigInt(Permission.ADMINISTRATOR),
  MOVE_MEMBERS: BigInt(Permission.MOVE_MEMBERS),
  MANAGE_NICKNAMES: BigInt(Permission.MANAGE_NICKNAMES),
  MENTION_EVERYONE: BigInt(Permission.MENTION_EVERYONE),
  VIDEO: BigInt(Permission.VIDEO),
  MANAGE_ROLES: BigInt(Permission.MANAGE_ROLES),
  MANAGE_STICKERS: BigInt(Permission.MANAGE_STICKERS),
  VIEW_BOARD: BigInt(Permission.VIEW_BOARD),
  CREATE_TASKS: BigInt(Permission.CREATE_TASKS),
  EDIT_TASKS: BigInt(Permission.EDIT_TASKS),
  MANAGE_BOARD: BigInt(Permission.MANAGE_BOARD),
  INVITE_MEMBERS: BigInt(Permission.INVITE_MEMBERS),
  INVITE_GUESTS: BigInt(Permission.INVITE_GUESTS),
  CREATE_TEMP_ROOMS: BigInt(Permission.CREATE_TEMP_ROOMS),
  // ADR-0046: outbound phone calls; room-level too, nobody by default, never guests (server).
  PLACE_CALLS: BigInt(Permission.PLACE_CALLS),
  // ADR-0048: workspace-level bits split off MANAGE_WORKSPACE (overrides never carry them).
  CREATE_BOARDS: BigInt(Permission.CREATE_BOARDS),
  MANAGE_MEMBERS: BigInt(Permission.MANAGE_MEMBERS),
  MANAGE_BOTS: BigInt(Permission.MANAGE_BOTS),
  MANAGE_INTEGRATIONS: BigInt(Permission.MANAGE_INTEGRATIONS),
  VIEW_JOURNALS: BigInt(Permission.VIEW_JOURNALS),
  MANAGE_EVENTS: BigInt(Permission.MANAGE_EVENTS),
  // Bit 31: the int32 proto enum holds it as a negative number; read it as unsigned.
  MANAGE_RECORDINGS: BigInt.asUintN(32, BigInt(Permission.MANAGE_RECORDINGS)),
} as const;

/**
 * Billing bits (ADR-0087), Go: perm.BillingView / BillingTopup / BillingManage. Bits from 1 << 32
 * on cannot be proto enum values (int32): listed in the comment of enum Permission. They live on
 * roles but stand apart from PERMISSION_BITS: ADMINISTRATOR does not include them (ALL_PERMISSIONS
 * stops at bit 31), overrides never touch them, only the workspace owner grants or assigns them;
 * the owner always has all three, guests and bots never. Read them through billingPermissions.
 */
export const BILLING_BITS = {
  /** The badge state and the «Тариф» settings: balance, history, plan, receipts. */
  VIEW: 1n << 32n,
  /** Manual top-up through a hosted payment page (own card / SBP). Implies VIEW. */
  TOPUP: 1n << 33n,
  /** Plan changes, one-click top-up, auto-topup, saved methods, payer, refund requests. Implies VIEW + TOPUP. */
  MANAGE: 1n << 34n,
} as const;

export type BillingPermissionName = keyof typeof BILLING_BITS;

/** The three billing bits (Go: perm.Billing). */
export const BILLING_PERMISSIONS: PermissionBits = BILLING_BITS.VIEW | BILLING_BITS.TOPUP | BILLING_BITS.MANAGE;

/**
 * The one billing rule (ADR-0087; Go: perm.BillingOf): the workspace owner has all three, a guest
 * (highest built-in role GUEST) nothing, anyone else the billing bits of their roles (ADMINISTRATOR
 * gives none) closed under MANAGE → TOPUP → VIEW. The owner is recognized by the built-in owner
 * role unless `owner` is given; a guest by the built-in guest role without a member one unless
 * `guest` is given.
 */
export function billingPermissions(
  roles: readonly Pick<RoleBits, 'permissions' | 'builtin'>[],
  opts: { owner?: boolean | undefined; guest?: boolean | undefined } = {},
): PermissionBits {
  if (opts.owner ?? holdsOwnerRole(roles)) return BILLING_PERMISSIONS;
  if (opts.guest ?? guestOnly(roles)) return 0n;
  let b = rawPermissions(roles) & BILLING_PERMISSIONS;
  if (b & BILLING_BITS.MANAGE) b |= BILLING_BITS.TOPUP;
  if (b & BILLING_BITS.TOPUP) b |= BILLING_BITS.VIEW;
  return b;
}

/**
 * The three bits of one tree section (the Disk, the Wiki): the workspace-level VIEW / WRITE /
 * MANAGE on roles, per-node overrides of VIEW and WRITE (Go: perm.TreeBits).
 */
export interface TreeBits {
  readonly VIEW: PermissionBits;
  readonly WRITE: PermissionBits;
  readonly MANAGE: PermissionBits;
}

const treeAll = (b: TreeBits): PermissionBits => b.VIEW | b.WRITE | b.MANAGE;
const treeOverride = (b: TreeBits): PermissionBits => b.VIEW | b.WRITE;

/**
 * The workspace-level rule of a tree section (Go: perm.TreeOf): guests nothing; ADMINISTRATOR or
 * MANAGE all three; anyone else (bots included: a bot is a member like a person, ADR-0094/0096
 * addendum 2026-10-14) the section's bits of their roles. A guest is recognized by the built-in
 * guest role without a member one unless `guest` is given.
 */
export function treePermissions(
  bits: TreeBits,
  roles: readonly Pick<RoleBits, 'permissions' | 'builtin'>[],
  opts: { guest?: boolean | undefined } = {},
): PermissionBits {
  if (opts.guest ?? guestOnly(roles)) return 0n;
  const raw = rawPermissions(roles);
  if (raw & (PERMISSION_BITS.ADMINISTRATOR | bits.MANAGE)) return treeAll(bits);
  return raw & treeAll(bits);
}

/** One node on the way from the top to the checked node, as far as the viewer is concerned. */
export interface TreeLevel {
  /** The node's «Только выбранные» (DiskItem.restricted, WikiPage.restricted). */
  restricted?: boolean | undefined;
  /** The viewer owns this node (ownerId). */
  owner?: boolean | undefined;
  /** The node's role overrides by role id. */
  roleOverrides?: Readonly<Record<string, OverrideBits>> | ReadonlyMap<string, OverrideBits> | undefined;
  /** The node's override of the viewer. */
  userOverride?: OverrideBits | undefined;
}

/**
 * The one tree node rule shared by the Disk (ADR-0094 §2) and the Wiki (ADR-0096 §2); Go:
 * perm.ComputeTree. `chain` runs from the topmost ancestor down to the node (empty = the top of
 * the section). MANAGE or ADMINISTRATOR: all three bits, restricted nodes included. Otherwise the
 * start is the roles' VIEW | WRITE (none for guests) and at every level, top down: a restricted
 * node drops what the roles and the ancestors gave; each role's override lowest position first
 * (ignored for guests), then the viewer's own; the owner of the level
 * always has VIEW | WRITE. Overrides touch VIEW | WRITE only. Without VIEW nothing. The server
 * sends my_bits; this only predicts the UI.
 */
export function treeItemPermissions(
  bits: TreeBits,
  roles: readonly RoleBits[],
  chain: readonly TreeLevel[],
  opts: { guest?: boolean | undefined } = {},
): PermissionBits {
  const guest = opts.guest ?? guestOnly(roles);
  const ws = treePermissions(bits, roles, { guest });
  if (ws & bits.MANAGE) return treeAll(bits);
  const ov = treeOverride(bits);
  const ordered = [...roles].sort((a, b) => a.position - b.position);
  let p = ws & ov;
  for (const l of chain) {
    if (l.restricted) p = 0n;
    if (!guest) {
      for (const r of ordered) {
        const o = overrideOf(l.roleOverrides, r.id);
        if (o) {
          p &= ~(o.deny & ov);
          p |= o.allow & ov;
        }
      }
    }
    if (l.userOverride) {
      p &= ~(l.userOverride.deny & ov);
      p |= l.userOverride.allow & ov;
    }
    if (l.owner) p |= ov;
  }
  return p & bits.VIEW ? p : 0n;
}

/**
 * A TreeLevel from a node's stored overrides (DiskPermissionsResponse / WikiPermissionsResponse
 * entries) for `userId`.
 */
export function treeLevel(
  node: { restricted: boolean; ownerId: string },
  entries: readonly OverrideEntry[],
  userId: string,
): TreeLevel {
  const roleOverrides = new Map<string, OverrideBits>();
  for (const e of entries) {
    if (e.targetType === PermissionTargetType.ROLE && !roleOverrides.has(e.targetId)) roleOverrides.set(e.targetId, e);
  }
  return {
    restricted: node.restricted,
    owner: node.ownerId !== '' && node.ownerId === userId,
    roleOverrides,
    userOverride: entries.find((e) => e.targetType === PermissionTargetType.USER && e.targetId === userId),
  };
}

/** A stored override row of a tree node (DiskPermissionEntry, WikiPermissionEntry). */
export type OverrideEntry = Pick<DiskPermissionEntry | WikiPermissionEntry, 'targetType' | 'targetId' | 'allow' | 'deny'>;

/**
 * Disk bits (ADR-0094 §2), Go: perm.DiskView / DiskWrite / DiskManage. Like the billing bits they
 * cannot be proto enum values (listed in the comment of enum Permission) and stay out of
 * ALL_PERMISSIONS (room and board rules never see them), but ADMINISTRATOR includes them
 * (diskPermissions). Guests get nothing from their roles, only from a personal allow on an item;
 * bots are members like people. Per-item overrides carry VIEW and WRITE only (DISK_OVERRIDE_PERMISSIONS).
 */
export const DISK_BITS = {
  /** See the Disk and every item that is not restricted. Member default. */
  VIEW: 1n << 35n,
  /** Create folders, upload; rename, move and trash one's own items. Member default. */
  WRITE: 1n << 36n,
  /** Any item, the trash retention, empty the whole trash, anyone's public link. Implies VIEW + WRITE. */
  MANAGE: 1n << 37n,
} as const satisfies TreeBits;

/** The three disk bits (Go: perm.Disk). */
export const DISK_PERMISSIONS: PermissionBits = DISK_BITS.VIEW | DISK_BITS.WRITE | DISK_BITS.MANAGE;

/** Bits a disk item override may allow or deny (Go: perm.DiskOverride): «Просмотр» / «Правка». */
export const DISK_OVERRIDE_PERMISSIONS: PermissionBits = DISK_BITS.VIEW | DISK_BITS.WRITE;

/** The workspace-level disk rule (Go: perm.DiskOf): treePermissions over DISK_BITS. */
export function diskPermissions(
  roles: readonly Pick<RoleBits, 'permissions' | 'builtin'>[],
  opts: { guest?: boolean | undefined } = {},
): PermissionBits {
  return treePermissions(DISK_BITS, roles, opts);
}

/** One item on the way from the root to the checked item. */
export type DiskLevel = TreeLevel;

/**
 * The one disk item rule (ADR-0094 §2; Go: perm.ComputeDiskItem): treeItemPermissions over
 * DISK_BITS. `chain` runs from the topmost ancestor down to the item (empty = the root).
 */
export function diskItemPermissions(
  roles: readonly RoleBits[],
  chain: readonly DiskLevel[],
  opts: { guest?: boolean | undefined } = {},
): PermissionBits {
  return treeItemPermissions(DISK_BITS, roles, chain, opts);
}

/** A DiskLevel from an item's stored overrides (DiskPermissionsResponse.entries) for `userId`. */
export function diskLevel(
  item: { restricted: boolean; ownerId: string },
  entries: readonly OverrideEntry[],
  userId: string,
): DiskLevel {
  return treeLevel(item, entries, userId);
}

/**
 * Wiki bits (ADR-0096 §2), Go: perm.WikiView / WikiWrite / WikiManage. The same rules as the disk
 * bits: outside ALL_PERMISSIONS, in ADMINISTRATOR, never for guests through roles,
 * per-page overrides carry VIEW and WRITE only (WIKI_OVERRIDE_PERMISSIONS). WRITE on a page edits
 * its content and adds subpages; the structure needs the owner or MANAGE (wikiStructureAllowed).
 */
export const WIKI_BITS = {
  /** See the Wiki and every page that is not restricted. Member default. */
  VIEW: 1n << 38n,
  /** Create pages; edit the content of and add subpages to any page one can write. Member default. */
  WRITE: 1n << 39n,
  /** The structure of any page, the trash retention, empty the whole trash, anyone's public link. Implies VIEW + WRITE. */
  MANAGE: 1n << 40n,
} as const satisfies TreeBits;

/** The three wiki bits (Go: perm.Wiki). */
export const WIKI_PERMISSIONS: PermissionBits = WIKI_BITS.VIEW | WIKI_BITS.WRITE | WIKI_BITS.MANAGE;

/** Bits a wiki page override may allow or deny (Go: perm.WikiOverride): «Просмотр» / «Правка». */
export const WIKI_OVERRIDE_PERMISSIONS: PermissionBits = WIKI_BITS.VIEW | WIKI_BITS.WRITE;

/** The workspace-level wiki rule (Go: perm.WikiOf): treePermissions over WIKI_BITS. */
export function wikiPermissions(
  roles: readonly Pick<RoleBits, 'permissions' | 'builtin'>[],
  opts: { guest?: boolean | undefined } = {},
): PermissionBits {
  return treePermissions(WIKI_BITS, roles, opts);
}

/**
 * The one wiki page rule (ADR-0096 §2; Go: perm.ComputeWikiPage): treeItemPermissions over
 * WIKI_BITS. `chain` runs from the top-level ancestor down to the page (empty = the top level).
 */
export function wikiPagePermissions(
  roles: readonly RoleBits[],
  chain: readonly TreeLevel[],
  opts: { guest?: boolean | undefined } = {},
): PermissionBits {
  return treeItemPermissions(WIKI_BITS, roles, chain, opts);
}

/**
 * The structural rule of a wiki page (ADR-0096 §2; Go: perm.WikiStructureAllowed): rename, icon,
 * cover, move, trash, restore, delete, access and the public link need VIEW on the page (`bits`,
 * WikiPage.myBits) and either its ownership or WIKI_MANAGE. WRITE alone edits the content and
 * adds subpages.
 */
export function wikiStructureAllowed(bits: PermissionBits, owner: boolean): boolean {
  return (bits & WIKI_BITS.VIEW) !== 0n && (owner || (bits & WIKI_BITS.MANAGE) !== 0n);
}

export type PermissionName = keyof typeof PERMISSION_BITS;

/**
 * Bits the restricted mode takes from everyone in the workspace («тариф не активен», ADR-0086
 * amendment), the owner and ADMINISTRATOR included: writing and attaching, screen share and camera
 * (voice is audio only), inviting members and guests, new temporary rooms, phone calls, new tasks
 * and boards. Go: perm.PlanInactiveDenied.
 */
export const PLAN_INACTIVE_DENIED: PermissionBits =
  PERMISSION_BITS.SEND_MESSAGES |
  PERMISSION_BITS.ATTACH_FILES |
  PERMISSION_BITS.STREAM |
  PERMISSION_BITS.VIDEO |
  PERMISSION_BITS.INVITE_MEMBERS |
  PERMISSION_BITS.INVITE_GUESTS |
  PERMISSION_BITS.CREATE_TEMP_ROOMS |
  PERMISSION_BITS.PLACE_CALLS |
  PERMISSION_BITS.CREATE_TASKS |
  PERMISSION_BITS.CREATE_BOARDS;

/**
 * The one restricted-mode rule over computed room / board / workspace bits (Go: perm.PlanInactive;
 * vectors `planInactive`). Apply it on top of computePermissions when the workspace's
 * Workspace.billing.state is LAPSED; DMs and notes have no workspace and are not affected. The
 * server enforces the mode itself (its route table and the voice grants): this only hides and
 * disables UI.
 */
export function planInactivePermissions(bits: PermissionBits): PermissionBits {
  return bits & ~PLAN_INACTIVE_DENIED;
}

export type PermissionBits = bigint;

export const ALL_PERMISSIONS: PermissionBits = Object.values(PERMISSION_BITS).reduce((a, b) => a | b, 0n);

const {
  VIEW_ROOM,
  SEND_MESSAGES,
  ATTACH_FILES,
  CONNECT,
  SPEAK,
  STREAM,
  VIDEO,
  ADMINISTRATOR,
  VIEW_BOARD,
  CREATE_TASKS,
  CREATE_TEMP_ROOMS,
} = PERMISSION_BITS;

/**
 * Bits of task boards (ADR-0042): board overrides touch only them, room overrides never do
 * (Go: perm.BoardOnly).
 */
export const BOARD_ONLY_PERMISSIONS: PermissionBits =
  VIEW_BOARD | CREATE_TASKS | PERMISSION_BITS.EDIT_TASKS | PERMISSION_BITS.MANAGE_BOARD;

/** The seven bits of ADR-0048 (Go: perm.RolesV2); migration 00052 gave them to MANAGE_WORKSPACE roles. */
export const ROLES_V2_PERMISSIONS: PermissionBits =
  PERMISSION_BITS.CREATE_BOARDS |
  PERMISSION_BITS.MANAGE_MEMBERS |
  PERMISSION_BITS.MANAGE_BOTS |
  PERMISSION_BITS.MANAGE_INTEGRATIONS |
  PERMISSION_BITS.VIEW_JOURNALS |
  PERMISSION_BITS.MANAGE_EVENTS |
  PERMISSION_BITS.MANAGE_RECORDINGS;

/**
 * Workspace-level bits: neither room nor board overrides grant or take them (Go:
 * perm.WorkspaceOnly). ADMINISTRATOR, MANAGE_WORKSPACE, MANAGE_NICKNAMES, MANAGE_ROLES,
 * MANAGE_STICKERS, CREATE_TEMP_ROOMS (ADR-0044) and the ADR-0048 bits.
 */
export const WORKSPACE_ONLY_PERMISSIONS: PermissionBits =
  ADMINISTRATOR |
  PERMISSION_BITS.MANAGE_WORKSPACE |
  PERMISSION_BITS.MANAGE_NICKNAMES |
  PERMISSION_BITS.MANAGE_ROLES |
  PERMISSION_BITS.MANAGE_STICKERS |
  CREATE_TEMP_ROOMS |
  ROLES_V2_PERMISSIONS;

/**
 * Bits room overrides may touch (INVITE_MEMBERS and INVITE_GUESTS included, ADR-0043; PLACE_CALLS,
 * ADR-0046): all but the workspace-level ones and the board bits, which apply to boards only;
 * computePermissions ignores the rest in room overrides (Go: perm.RoomOnly).
 */
export const ROOM_ONLY_PERMISSIONS: PermissionBits =
  ALL_PERMISSIONS & ~(WORKSPACE_ONLY_PERMISSIONS | BOARD_ONLY_PERMISSIONS);

/** Initial permissions of the built-in roles (the member / guest roles are editable since ADR-0026). */
export const ROLE_DEFAULTS: Record<WorkspaceRole, PermissionBits> = {
  [WorkspaceRole.UNSPECIFIED]: 0n,
  [WorkspaceRole.OWNER]: ADMINISTRATOR,
  [WorkspaceRole.ADMIN]: ADMINISTRATOR,
  [WorkspaceRole.MEMBER]:
    VIEW_ROOM |
    SEND_MESSAGES |
    ATTACH_FILES |
    CONNECT |
    SPEAK |
    STREAM |
    VIDEO |
    VIEW_BOARD |
    CREATE_TASKS |
    CREATE_TEMP_ROOMS |
    // ADR-0094: migration 00088 gave them to the existing member roles.
    DISK_BITS.VIEW |
    DISK_BITS.WRITE |
    // ADR-0096: migration 00090.
    WIKI_BITS.VIEW |
    WIKI_BITS.WRITE,
  // Guests see only rooms with an explicit VIEW_ROOM allow override.
  [WorkspaceRole.GUEST]: CONNECT | SPEAK,
};

/**
 * Fixed permissions of both participants of a direct message (ADR-0020). Roles and
 * overrides do not apply. Reading history = VIEW_ROOM, reactions need SEND_MESSAGES,
 * editing/deleting own messages is the author's right; pinning is allowed to both
 * participants by room type (no MANAGE_MESSAGES: no moderation in DMs).
 */
export const DM_PERMISSIONS: PermissionBits = VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES;

/** Fixed positions of the built-in roles (ADR-0026); custom roles sit in between (2..). */
export const BUILTIN_ROLE_POSITION: Record<WorkspaceRole, number> = {
  [WorkspaceRole.UNSPECIFIED]: -1,
  [WorkspaceRole.OWNER]: 1001,
  [WorkspaceRole.ADMIN]: 1000,
  [WorkspaceRole.MEMBER]: 1,
  [WorkspaceRole.GUEST]: 0,
};

/**
 * A role as far as permissions are concerned; the generated `Role` fits it
 * (id, position, permissions). Higher position = more senior.
 */
export interface RoleBits {
  id: string;
  position: number;
  permissions: PermissionBits;
  /** Built-in role key (generated Role.builtin); the holder of OWNER is the workspace owner. */
  builtin?: WorkspaceRole | undefined;
}

/** Structural allow/deny pair; the generated PermissionOverride / RoomPermissionOverride fit it. */
export interface OverrideBits {
  allow: PermissionBits;
  deny: PermissionBits;
}

export interface ComputePermissionsInput {
  /**
   * The member's roles (ADR-0026), any order: workspace bits are their OR, their room
   * overrides (`roleOverrides`, by role id) apply lowest position first.
   */
  roles?: readonly RoleBits[] | undefined;
  roleOverrides?: Readonly<Record<string, OverrideBits>> | ReadonlyMap<string, OverrideBits> | undefined;
  /**
   * Pre-ADR-0026 form, used when `roles` is not given: one built-in role with its default
   * permissions and its override (`roleOverride`).
   */
  role?: WorkspaceRole | undefined;
  /** Override for the user's (legacy) built-in role in this room. */
  roleOverride?: OverrideBits | undefined;
  /** Override for this specific user in this room (takes precedence over the role override). */
  userOverride?: OverrideBits | undefined;
  /** Set for a DM room (Room.type DM): the fixed DM set for a participant, role/overrides ignored. */
  dm?: { participant: boolean } | undefined;
  /**
   * Room.restricted (ADR-0029, ADR-0048): ADMINISTRATOR gives no bypass — admins count as plain
   * members of the room — and VIEW_ROOM comes only from an allow override on the room; the
   * workspace owner (`owner`) has everything.
   */
  restricted?: boolean | undefined;
  /** The user is the workspace owner (Workspace.owner_id; holder of the built-in owner role). */
  owner?: boolean | undefined;
  /**
   * A private temporary room (Room.isPrivate && Room.expiresAt, live or archived; ADR-0078):
   * nobody bypasses it — not ADMINISTRATOR, not the owner — the roles' VIEW_ROOM is dropped and
   * role overrides cannot grant it: only the user's own override does, or being its `creator`.
   */
  privateTemp?: boolean | undefined;
  /** The user created this temporary room (Room.createdBy) and is not a guest (ADR-0044). */
  creator?: boolean | undefined;
  /**
   * Set for a task board (ADR-0042): the overrides are the board's and touch only
   * BOARD_ONLY_PERMISSIONS; a private board (Board.isPrivate) drops the roles' VIEW_BOARD
   * first; without VIEW_BOARD nothing; a guest (highest built-in role GUEST) gets nothing.
   * A restricted board (Board.restricted, ADR-0048; implies private) drops ADMINISTRATOR, the
   * owner (`board.owner`) has everything. The room fields `restricted` / `owner` do not apply.
   * Go: perm.ComputeBoard.
   */
  board?:
    | {
        private: boolean;
        guest?: boolean | undefined;
        restricted?: boolean | undefined;
        owner?: boolean | undefined;
      }
    | undefined;
}

/** The plain OR of the roles' permissions (ADMINISTRATOR not expanded). */
function rawPermissions(roles: readonly Pick<RoleBits, 'permissions'>[]): PermissionBits {
  let perms = 0n;
  for (const r of roles) perms |= r.permissions;
  return perms;
}

/** Workspace-level permissions of a set of roles: their OR; ADMINISTRATOR means everything. */
export function workspacePermissions(roles: readonly Pick<RoleBits, 'permissions'>[]): PermissionBits {
  const perms = rawPermissions(roles);
  return perms & ADMINISTRATOR ? ALL_PERMISSIONS : perms;
}

/** Whether the roles include the built-in owner role: only the workspace owner holds it (ADR-0029). */
export function holdsOwnerRole(roles: readonly Pick<RoleBits, 'builtin'>[]): boolean {
  return roles.some((r) => r.builtin === WorkspaceRole.OWNER);
}

function overrideOf(ovs: ComputePermissionsInput['roleOverrides'], id: string): OverrideBits | undefined {
  if (!ovs) return undefined;
  if (ovs instanceof Map) return ovs.get(id);
  return Object.prototype.hasOwnProperty.call(ovs, id)
    ? (ovs as Readonly<Record<string, OverrideBits>>)[id]
    : undefined;
}

/**
 * The single function computing effective room permissions (docs/04, ADR-0026, ADR-0029, ADR-0048):
 * workspace bits (OR of the roles; ADMINISTRATOR → everything, overrides ignored — except in a
 * restricted room, where the owner gets everything and ADMINISTRATOR and the roles' VIEW_ROOM are
 * dropped: only an allow override lets anyone in), then each role's
 * room override lowest position first (deny, then allow: the most senior role wins), then the
 * user's own override; without VIEW_ROOM nothing. Overrides only touch ROOM_ONLY_PERMISSIONS.
 * A private temporary room (`privateTemp`, ADR-0078) has no bypass at all — not even the owner's:
 * ADMINISTRATOR and the roles' VIEW_ROOM are dropped, role overrides do not grant VIEW_ROOM, only
 * the user's own override does, and the `creator` always has it.
 * Used by the client for UI; mirrored in Go (apps/server/internal/perm). Pure.
 */
export function computePermissions(input: ComputePermissionsInput): PermissionBits {
  if (input.dm) return input.dm.participant ? DM_PERMISSIONS : 0n;
  let roles: readonly RoleBits[];
  let roleOverrides = input.roleOverrides;
  if (input.roles) {
    roles = input.roles;
  } else {
    const role = input.role ?? WorkspaceRole.UNSPECIFIED;
    if (role === WorkspaceRole.UNSPECIFIED) return 0n;
    const id = ROLE_TARGET_ID[role];
    roles = [
      {
        id,
        position: BUILTIN_ROLE_POSITION[role],
        permissions: ROLE_DEFAULTS[role],
      },
    ];
    roleOverrides = input.roleOverride ? { [id]: input.roleOverride } : undefined;
  }
  let perms = rawPermissions(roles);
  if (input.board) {
    if (input.board.guest) return 0n;
    if (input.board.restricted) {
      if (input.board.owner) return ALL_PERMISSIONS;
      perms &= ~(ADMINISTRATOR | VIEW_BOARD);
    } else if (perms & ADMINISTRATOR) {
      return ALL_PERMISSIONS;
    }
    if (input.board.private) perms &= ~VIEW_BOARD;
    return applyOverrides(perms, roles, roleOverrides, input.userOverride, BOARD_ONLY_PERMISSIONS, VIEW_BOARD);
  }
  if (input.privateTemp) {
    perms &= ~(ADMINISTRATOR | VIEW_ROOM);
    return applyOverrides(
      perms,
      roles,
      roleOverrides,
      input.userOverride,
      ROOM_ONLY_PERMISSIONS,
      VIEW_ROOM,
      ROOM_ONLY_PERMISSIONS & ~VIEW_ROOM,
      input.creator ? VIEW_ROOM : 0n,
    );
  }
  if (input.restricted) {
    if (input.owner) return ALL_PERMISSIONS;
    perms &= ~(ADMINISTRATOR | VIEW_ROOM);
  } else if (perms & ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }

  return applyOverrides(perms, roles, roleOverrides, input.userOverride, ROOM_ONLY_PERMISSIONS, VIEW_ROOM);
}

/**
 * Each role's override lowest position first (deny, then allow; limited to `roleMask`), then the
 * user's own (limited to `mask`), then `always` is added; without `view` nothing.
 */
function applyOverrides(
  start: PermissionBits,
  roles: readonly RoleBits[],
  roleOverrides: ComputePermissionsInput['roleOverrides'],
  userOverride: OverrideBits | undefined,
  mask: PermissionBits,
  view: PermissionBits,
  roleMask: PermissionBits = mask,
  always: PermissionBits = 0n,
): PermissionBits {
  let perms = start;
  const ordered = [...roles].sort((a, b) => a.position - b.position);
  for (const r of ordered) {
    const o = overrideOf(roleOverrides, r.id);
    if (o) {
      perms &= ~(o.deny & roleMask);
      perms |= o.allow & roleMask;
    }
  }
  if (userOverride) {
    perms &= ~(userOverride.deny & mask);
    perms |= userOverride.allow & mask;
  }
  perms |= always;
  if (!(perms & view)) return 0n;
  return perms;
}

/**
 * Effective permissions of a member with `roles` on a task board, given Board.permissionOverrides,
 * Board.isPrivate (ADR-0042) and Board.restricted (ADR-0048). `guest`: the member's highest
 * built-in role is GUEST; the owner is recognized by the built-in owner role unless `owner` is given.
 */
export function computeMemberBoardPermissions(
  roles: readonly RoleBits[],
  userId: string,
  overrides: readonly RoomPermissionOverride[],
  isPrivate: boolean,
  guest = false,
  restricted = false,
  owner: boolean = holdsOwnerRole(roles),
): PermissionBits {
  const roleOverrides = new Map<string, OverrideBits>();
  for (const o of overrides) {
    if (o.targetType === PermissionTargetType.ROLE && !roleOverrides.has(o.targetId)) roleOverrides.set(o.targetId, o);
  }
  return computePermissions({
    roles,
    roleOverrides,
    userOverride: overrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId),
    board: { private: isPrivate || restricted, guest, restricted, owner },
  });
}

/**
 * Bits in a task's comment room (Go: perm.TaskRoom): VIEW_BOARD → VIEW_ROOM | SEND_MESSAGES |
 * ATTACH_FILES, EDIT_TASKS adds MANAGE_MESSAGES. Read-only for an archived task and on a board
 * with the feature COMMENTS switched off (`commentsOff`, ADR-0058 §3: Board.disabledFeatures).
 */
export function taskRoomPermissions(board: PermissionBits, archived = false, commentsOff = false): PermissionBits {
  if (!(board & VIEW_BOARD)) return 0n;
  let p = VIEW_ROOM;
  if (!archived && !commentsOff) p |= SEND_MESSAGES | ATTACH_FILES;
  if (board & PERMISSION_BITS.EDIT_TASKS) p |= PERMISSION_BITS.MANAGE_MESSAGES;
  return p;
}

/**
 * The viewer's bits on one task (Go: perm.TaskBits, ADR-0059 §2, ADR-0076 §3). A viewer of the
 * board keeps `board.permissions`; on a task-scoped board (`board.taskScoped`, permissions 0) an
 * assignee of a live task gets VIEW_BOARD | CREATE_TASKS (edits the task like a member their
 * assigned task; never creates tasks — that takes the board's bits), an approver or a watcher
 * VIEW_BOARD (view, comment, subscribe; an approver also votes); anything else 0. Feed the result
 * to taskRoomPermissions for the task's comment room. Shared case table:
 * proto/testdata/task_bits.json.
 */
export function taskPermissions(
  board: Pick<Board, 'permissions' | 'taskScoped'>,
  task: Pick<Task, 'assignees' | 'approvers' | 'watcherIds' | 'archivedAt'>,
  me: string,
): PermissionBits {
  if (board.permissions & VIEW_BOARD) return board.permissions;
  if (!board.taskScoped || task.archivedAt) return 0n; // invitations count on live tasks only
  if (task.assignees.some((a) => a.userId === me)) return VIEW_BOARD | PERMISSION_BITS.CREATE_TASKS;
  if (task.approvers.some((a) => a.userId === me) || task.watcherIds.includes(me)) return VIEW_BOARD;
  return 0n;
}

/** A temporary room as computeMemberRoomPermissions needs it (ADR-0044, ADR-0078). */
export interface TempRoomScope {
  /** Room.isPrivate: only its creator and people with a personal allow see it, admins included. */
  private: boolean;
  /** Room.createdBy ('' when unknown). */
  createdBy: string;
}

/** The temporary-room scope of a room (undefined for a permanent one: no Room.expiresAt). */
export function tempRoomScope(room: {
  isPrivate: boolean;
  expiresAt?: unknown;
  createdBy: string;
}): TempRoomScope | undefined {
  return room.expiresAt ? { private: room.isPrivate, createdBy: room.createdBy } : undefined;
}

/** Whether the member's highest built-in role is GUEST (no built-in role above it among `roles`). */
function guestOnly(roles: readonly Pick<RoleBits, 'builtin'>[]): boolean {
  return (
    roles.some((r) => r.builtin === WorkspaceRole.GUEST) &&
    !roles.some(
      (r) =>
        r.builtin === WorkspaceRole.MEMBER || r.builtin === WorkspaceRole.ADMIN || r.builtin === WorkspaceRole.OWNER,
    )
  );
}

/** The member's roles among the workspace's (WorkspaceMember.roleIds → WorkspaceSnapshot.roles). */
export function memberRoles<R extends RoleBits>(all: readonly R[], roleIds: readonly string[]): R[] {
  const ids = new Set(roleIds);
  return all.filter((r) => ids.has(r.id));
}

/**
 * Effective permissions of a member with `roles` in a room, given Room.permissionOverrides and
 * Room.restricted (ADR-0029). The owner is recognized by the built-in owner role among `roles`
 * unless `owner` is given. `temp`: the room is temporary (Room.expiresAt) — `private` is
 * Room.isPrivate (ADR-0078: no bypass), `createdBy` Room.createdBy; see tempRoomScope.
 */
export function computeMemberRoomPermissions(
  roles: readonly RoleBits[],
  userId: string,
  overrides: readonly RoomPermissionOverride[],
  restricted = false,
  owner: boolean = holdsOwnerRole(roles),
  temp?: TempRoomScope | undefined,
): PermissionBits {
  const roleOverrides = new Map<string, OverrideBits>();
  // First match per target, like Go perm.ComputeIn (the server never stores duplicates).
  for (const o of overrides) {
    if (o.targetType === PermissionTargetType.ROLE && !roleOverrides.has(o.targetId)) roleOverrides.set(o.targetId, o);
  }
  return computePermissions({
    roles,
    roleOverrides,
    userOverride: overrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId),
    restricted,
    owner,
    privateTemp: temp?.private ?? false,
    creator: !!temp?.createdBy && temp.createdBy === userId && !guestOnly(roles),
  });
}

/**
 * Pre-ADR-0026 wire name of a built-in role as RoomPermissionOverride.target_id. The server
 * now stores and returns role ids (still accepting these names in requests).
 */
export const ROLE_TARGET_ID: Record<WorkspaceRole, string> = {
  [WorkspaceRole.UNSPECIFIED]: '',
  [WorkspaceRole.OWNER]: 'owner',
  [WorkspaceRole.ADMIN]: 'admin',
  [WorkspaceRole.MEMBER]: 'member',
  [WorkspaceRole.GUEST]: 'guest',
};

/**
 * Pre-ADR-0026: effective permissions of a user with one built-in role in a room (role
 * targets matched by name). Prefer computeMemberRoomPermissions.
 */
export function computeRoomPermissions(
  role: WorkspaceRole,
  userId: string,
  overrides: readonly RoomPermissionOverride[],
): PermissionBits {
  const roleId = ROLE_TARGET_ID[role];
  return computePermissions({
    role,
    roleOverride: overrides.find((o) => o.targetType === PermissionTargetType.ROLE && o.targetId === roleId),
    userOverride: overrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId),
  });
}

export function has(perms: PermissionBits, p: PermissionBits): boolean {
  return (perms & p) === p;
}
