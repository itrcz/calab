import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { WorkspaceRole } from './gen/calaba/v1/permissions_pb.js';
import { PermissionTargetType, RoomPermissionOverrideSchema } from './gen/calaba/v1/room_pb.js';
import { TaskApproverSchema, TaskAssigneeSchema } from './gen/calaba/v1/boards_pb.js';
import { TimestampSchema } from '@bufbuild/protobuf/wkt';
import {
  ALL_PERMISSIONS,
  PERMISSION_BITS,
  ROLE_DEFAULTS,
  ROOM_ONLY_PERMISSIONS,
  BOARD_ONLY_PERMISSIONS,
  ROLES_V2_PERMISSIONS,
  WORKSPACE_ONLY_PERMISSIONS,
  taskPermissions,
  taskRoomPermissions,
  computeMemberBoardPermissions,
  computeMemberRoomPermissions,
  computePermissions,
  computeRoomPermissions,
  memberRoles,
  workspacePermissions,
  type OverrideBits,
} from './permissions.js';

interface Vector {
  name: string;
  role?: 'owner' | 'admin' | 'member' | 'guest';
  roomType?: 'dm';
  participant?: boolean;
  roleOverride?: { allow: number; deny: number };
  userOverride?: { allow: number; deny: number };
  // ADR-0026: the member's roles and the room's overrides by role id.
  roles?: { id: string; position: number; permissions: number }[];
  roleOverrides?: Record<string, { allow: number; deny: number }>;
  expectedWorkspace?: number;
  // ADR-0029: a restricted room and whether the member is the workspace owner.
  restricted?: boolean;
  owner?: boolean;
  // ADR-0042: a board vector.
  board?: { private: boolean; guest?: boolean; restricted?: boolean; owner?: boolean };
  // ADR-0042 / ADR-0058 §3: a task room vector (taskRoomPermissions from the board bits).
  taskRoom?: { board: number; archived: boolean; commentsOff: boolean };
  expected: number;
}

const roles = {
  owner: WorkspaceRole.OWNER,
  admin: WorkspaceRole.ADMIN,
  member: WorkspaceRole.MEMBER,
  guest: WorkspaceRole.GUEST,
} as const;

const toOv = (o?: { allow: number; deny: number }): OverrideBits | undefined =>
  o ? { allow: BigInt(o.allow), deny: BigInt(o.deny) } : undefined;

// Shared with Go (apps/server/internal/perm). Keep both implementations in sync.
const vectors = JSON.parse(
  readFileSync(new URL('../../../proto/testdata/permissions.json', import.meta.url), 'utf8'),
) as Vector[];

const toRoles = (rs: NonNullable<Vector['roles']>) =>
  rs.map((r) => ({
    id: r.id,
    position: r.position,
    permissions: BigInt(r.permissions),
  }));

describe('computePermissions (shared vectors)', () => {
  for (const v of vectors) {
    it(v.name, () => {
      if (v.taskRoom) {
        expect(taskRoomPermissions(BigInt(v.taskRoom.board), v.taskRoom.archived, v.taskRoom.commentsOff)).toBe(
          BigInt(v.expected),
        );
        return;
      }
      if (v.board) {
        const roles = toRoles(v.roles ?? []);
        const roleOverrides = Object.fromEntries(
          Object.entries(v.roleOverrides ?? {}).map(([id, o]) => [id, toOv(o) as OverrideBits]),
        );
        expect(
          computePermissions({
            roles,
            roleOverrides,
            userOverride: toOv(v.userOverride),
            board: { ...v.board, private: v.board.private || (v.board.restricted ?? false) },
          }),
        ).toBe(BigInt(v.expected));
        const overrides = [
          ...Object.entries(v.roleOverrides ?? {}).map(([id, o]) =>
            create(RoomPermissionOverrideSchema, {
              targetType: PermissionTargetType.ROLE,
              targetId: id,
              allow: BigInt(o.allow),
              deny: BigInt(o.deny),
            }),
          ),
          ...(v.userOverride
            ? [
                create(RoomPermissionOverrideSchema, {
                  targetType: PermissionTargetType.USER,
                  targetId: 'u1',
                  allow: BigInt(v.userOverride.allow),
                  deny: BigInt(v.userOverride.deny),
                }),
              ]
            : []),
        ];
        expect(
          computeMemberBoardPermissions(
            roles,
            'u1',
            overrides,
            v.board.private,
            v.board.guest ?? false,
            v.board.restricted ?? false,
            v.board.owner ?? false,
          ),
        ).toBe(BigInt(v.expected));
        return;
      }
      if (v.roles) {
        const roles = toRoles(v.roles);
        const roleOverrides = Object.fromEntries(
          Object.entries(v.roleOverrides ?? {}).map(([id, o]) => [id, toOv(o) as OverrideBits]),
        );
        expect(
          computePermissions({
            roles,
            roleOverrides,
            userOverride: toOv(v.userOverride),
            restricted: v.restricted,
            owner: v.owner,
          }),
        ).toBe(BigInt(v.expected));
        // The same through Room.permissionOverrides.
        const overrides = [
          ...Object.entries(v.roleOverrides ?? {}).map(([id, o]) =>
            create(RoomPermissionOverrideSchema, {
              targetType: PermissionTargetType.ROLE,
              targetId: id,
              allow: BigInt(o.allow),
              deny: BigInt(o.deny),
            }),
          ),
          ...(v.userOverride
            ? [
                create(RoomPermissionOverrideSchema, {
                  targetType: PermissionTargetType.USER,
                  targetId: 'u1',
                  allow: BigInt(v.userOverride.allow),
                  deny: BigInt(v.userOverride.deny),
                }),
              ]
            : []),
        ];
        expect(computeMemberRoomPermissions(roles, 'u1', overrides, v.restricted, v.owner ?? false)).toBe(
          BigInt(v.expected),
        );
        // The owner is recognized by the built-in owner role as well.
        const withBuiltin = roles.map((r) =>
          r.id === 'owner' && v.owner ? { ...r, builtin: WorkspaceRole.OWNER } : r,
        );
        expect(computeMemberRoomPermissions(withBuiltin, 'u1', overrides, v.restricted)).toBe(BigInt(v.expected));
        if (v.expectedWorkspace !== undefined) expect(workspacePermissions(roles)).toBe(BigInt(v.expectedWorkspace));
        return;
      }
      expect(
        computePermissions({
          role: v.role ? roles[v.role] : WorkspaceRole.UNSPECIFIED,
          roleOverride: toOv(v.roleOverride),
          userOverride: toOv(v.userOverride),
          dm: v.roomType === 'dm' ? { participant: v.participant ?? false } : undefined,
        }),
      ).toBe(BigInt(v.expected));
    });
  }
});

describe('computeRoomPermissions', () => {
  it('picks the matching role and user overrides', () => {
    const overrides = [
      create(RoomPermissionOverrideSchema, {
        targetType: PermissionTargetType.ROLE,
        targetId: 'member',
        deny: PERMISSION_BITS.VIEW_ROOM,
      }),
      create(RoomPermissionOverrideSchema, {
        targetType: PermissionTargetType.USER,
        targetId: 'u1',
        allow: PERMISSION_BITS.VIEW_ROOM,
      }),
    ];
    expect(computeRoomPermissions(WorkspaceRole.MEMBER, 'u2', overrides)).toBe(0n);
    expect(computeRoomPermissions(WorkspaceRole.MEMBER, 'u1', overrides)).toBe(ROLE_DEFAULTS[WorkspaceRole.MEMBER]);
    expect(computeRoomPermissions(WorkspaceRole.ADMIN, 'u3', overrides)).toBe(ALL_PERMISSIONS);
  });
});

describe('roles (ADR-0026)', () => {
  it('memberRoles picks the member roles; MANAGE_ROLES is part of ALL_PERMISSIONS', () => {
    const all = [
      { id: 'a', position: 1000, permissions: PERMISSION_BITS.ADMINISTRATOR },
      {
        id: 'm',
        position: 1,
        permissions: ROLE_DEFAULTS[WorkspaceRole.MEMBER],
      },
    ];
    expect(memberRoles(all, ['m']).map((r) => r.id)).toEqual(['m']);
    expect(workspacePermissions(memberRoles(all, ['m', 'a']))).toBe(ALL_PERMISSIONS);
    expect(ALL_PERMISSIONS & PERMISSION_BITS.MANAGE_ROLES).toBe(PERMISSION_BITS.MANAGE_ROLES);
    expect(ALL_PERMISSIONS).toBe(4294967295n);
    // ADR-0048: workspace-level, in no default role, never settable per room or board.
    expect(ROLES_V2_PERMISSIONS).toBe(0xfe000000n);
    expect(PERMISSION_BITS.MANAGE_RECORDINGS).toBe(2147483648n);
    expect(ROOM_ONLY_PERMISSIONS & ROLES_V2_PERMISSIONS).toBe(0n);
    expect(BOARD_ONLY_PERMISSIONS & ROLES_V2_PERMISSIONS).toBe(0n);
    expect(ROLE_DEFAULTS[WorkspaceRole.MEMBER] & ROLES_V2_PERMISSIONS).toBe(0n);
    expect(WORKSPACE_ONLY_PERMISSIONS & ROLES_V2_PERMISSIONS).toBe(ROLES_V2_PERMISSIONS);
    // ADR-0046: settable per room, not in any default role.
    expect(PERMISSION_BITS.PLACE_CALLS).toBe(16777216n);
    expect(ROOM_ONLY_PERMISSIONS & PERMISSION_BITS.PLACE_CALLS).toBe(PERMISSION_BITS.PLACE_CALLS);
    expect(ROLE_DEFAULTS[WorkspaceRole.MEMBER] & PERMISSION_BITS.PLACE_CALLS).toBe(0n);
    expect(ROLE_DEFAULTS[WorkspaceRole.GUEST] & PERMISSION_BITS.PLACE_CALLS).toBe(0n);
    // ADR-0044: workspace-level, in the member default, never settable per room.
    expect(PERMISSION_BITS.CREATE_TEMP_ROOMS).toBe(8388608n);
    expect(ROOM_ONLY_PERMISSIONS & PERMISSION_BITS.CREATE_TEMP_ROOMS).toBe(0n);
    expect(ROLE_DEFAULTS[WorkspaceRole.MEMBER] & PERMISSION_BITS.CREATE_TEMP_ROOMS).toBe(PERMISSION_BITS.CREATE_TEMP_ROOMS);
    expect(ROLE_DEFAULTS[WorkspaceRole.GUEST] & PERMISSION_BITS.CREATE_TEMP_ROOMS).toBe(0n);
    const invite = PERMISSION_BITS.INVITE_MEMBERS | PERMISSION_BITS.INVITE_GUESTS;
    expect(invite).toBe(6291456n);
    expect(ROOM_ONLY_PERMISSIONS & invite).toBe(invite); // ADR-0043: settable per room
    expect(ROOM_ONLY_PERMISSIONS & PERMISSION_BITS.MANAGE_STICKERS).toBe(0n);
    expect(ROOM_ONLY_PERMISSIONS & BOARD_ONLY_PERMISSIONS).toBe(0n);
  });
  it('task rooms follow the board (ADR-0042)', () => {
    const { VIEW_BOARD, EDIT_TASKS, VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES, MANAGE_MESSAGES } = PERMISSION_BITS;
    expect(taskRoomPermissions(0n)).toBe(0n);
    expect(taskRoomPermissions(VIEW_BOARD)).toBe(VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES);
    expect(taskRoomPermissions(VIEW_BOARD | EDIT_TASKS)).toBe(
      VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES | MANAGE_MESSAGES,
    );
    expect(taskRoomPermissions(VIEW_BOARD, true)).toBe(VIEW_ROOM);
    expect(taskRoomPermissions(VIEW_BOARD | EDIT_TASKS, false, true)).toBe(VIEW_ROOM | MANAGE_MESSAGES);
    expect(vectors.filter((v) => v.taskRoom).length).toBeGreaterThanOrEqual(8);
  });
  // ADR-0059 §2, ADR-0076 §3: the shared case table of perm.TestTaskBits in Go.
  it('task bits for task-scoped boards (ADR-0059, ADR-0076)', () => {
    const me = 'u1';
    const task = (assignee: boolean, approver: boolean, watcher: boolean, archived = false) => ({
      assignees: assignee ? [create(TaskAssigneeSchema, { userId: me })] : [create(TaskAssigneeSchema, { userId: 'u2' })],
      approvers: approver ? [create(TaskApproverSchema, { userId: me })] : [],
      watcherIds: watcher ? ['u3', me] : ['u3'],
      archivedAt: archived ? create(TimestampSchema, { seconds: 1n }) : undefined,
    });
    const table = JSON.parse(readFileSync(new URL('../../../proto/testdata/task_bits.json', import.meta.url), 'utf8')) as {
      cases: { name: string; bits: number; scoped: boolean; assignee: boolean; approver: boolean; watcher: boolean; want: number }[];
    };
    expect(table.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of table.cases) {
      const board = { permissions: BigInt(c.bits), taskScoped: c.scoped };
      expect(taskPermissions(board, task(c.assignee, c.approver, c.watcher), me), c.name).toBe(BigInt(c.want));
    }
    // An archived task: the invitation no longer counts (the server passes live flags only).
    expect(taskPermissions({ permissions: 0n, taskScoped: true }, task(true, true, true, true), me)).toBe(0n);
    expect(taskRoomPermissions(taskPermissions({ permissions: 0n, taskScoped: true }, task(true, false, false), me))).toBe(
      PERMISSION_BITS.VIEW_ROOM | PERMISSION_BITS.SEND_MESSAGES | PERMISSION_BITS.ATTACH_FILES,
    );
    // A watcher comments and reads, never moderates.
    expect(taskRoomPermissions(taskPermissions({ permissions: 0n, taskScoped: true }, task(false, false, true), me))).toBe(
      PERMISSION_BITS.VIEW_ROOM | PERMISSION_BITS.SEND_MESSAGES | PERMISSION_BITS.ATTACH_FILES,
    );
  });
});
