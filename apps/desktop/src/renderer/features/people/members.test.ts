import { create } from '@bufbuild/protobuf';
import {
  PERMISSION_BITS,
  PermissionTargetType,
  PresenceSchema,
  PresenceStatus,
  RoleSchema,
  RoomPermissionOverrideSchema,
  RoomSchema,
  RoomType,
  UserSchema,
  VoiceStateSchema,
  WorkspaceMemberSchema,
  WorkspaceRole,
  type Room,
  type WorkspaceMember,
} from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { legacyRoles, rolesOfMember } from '../../lib/roles';
import { canEditMemberBirthday, canRemoveMember, canSetMemberBadge, groupMembers, hasAnyAction, memberActions, type MenuContext } from './members';

const member = (id: string, name: string, role: WorkspaceRole, nickname = '', isGuest = false): WorkspaceMember =>
  create(WorkspaceMemberSchema, { workspaceId: 'w', role, nickname, user: create(UserSchema, { id, displayName: name, isGuest }) });

const room = (id: string, type = RoomType.VOICE, overrides: Room['permissionOverrides'] = []): Room =>
  create(RoomSchema, { id, workspaceId: 'w', type, name: id, permissionOverrides: overrides });

const voice = (userId: string, roomId: string, muted = false) => create(VoiceStateSchema, { workspaceId: 'w', userId, roomId, muted });

describe('groupMembers', () => {
  const owner = member('o', 'Яна', WorkspaceRole.OWNER);
  const admin = member('a', 'Борис', WorkspaceRole.ADMIN);
  const m1 = member('m1', 'Вера', WorkspaceRole.MEMBER);
  const m2 = member('m2', 'Зоя', WorkspaceRole.MEMBER, 'Аня');
  const guest = member('g', 'Анатолий', WorkspaceRole.GUEST, '', true);
  const p = (userId: string, status: PresenceStatus) => create(PresenceSchema, { userId, status });

  it('splits online / offline and sorts by role, then (nick)name', () => {
    const g = groupMembers([guest, m1, m2, admin, owner], {
      o: p('o', PresenceStatus.ONLINE),
      m1: p('m1', PresenceStatus.IDLE),
      m2: p('m2', PresenceStatus.DND),
      g: p('g', PresenceStatus.ONLINE),
      a: p('a', PresenceStatus.OFFLINE),
    });
    expect(g.online.map((m) => m.user?.id)).toEqual(['o', 'm2', 'm1']);
    expect(g.offline.map((m) => m.user?.id)).toEqual(['a']);
    // ADR-0098 §3: guests are a section of their own
    expect(g.guests.map((m) => m.user?.id)).toEqual(['g']);
    expect(g.guestsOnline.has('g')).toBe(true);
  });

  it('counts people in voice as online and skips members without a user', () => {
    const g = groupMembers([m1, create(WorkspaceMemberSchema, { role: WorkspaceRole.MEMBER })], {}, { m1: voice('m1', 'r1') });
    expect(g.online).toHaveLength(1);
    expect(g.offline).toHaveLength(0);
  });

  it('puts bots in their own section by name, whatever their presence (ADR-0031)', () => {
    const bot = (id: string, name: string) =>
      create(WorkspaceMemberSchema, { workspaceId: 'w', role: WorkspaceRole.MEMBER, user: create(UserSchema, { id, displayName: name, isBot: true }) });
    const g = groupMembers([bot('b2', 'Погода'), m1, bot('b1', 'Деплой')], { b2: p('b2', PresenceStatus.ONLINE), m1: p('m1', PresenceStatus.ONLINE) });
    expect(g.bots.map((m) => m.user?.id)).toEqual(['b1', 'b2']);
    expect(g.online.map((m) => m.user?.id)).toEqual(['m1']);
    expect(g.offline).toHaveLength(0);
  });
});

describe('memberActions', () => {
  const call = room('call');
  const meeting = room('meeting');
  const text = room('general', RoomType.TEXT);
  const base = (over: Partial<MenuContext>): MenuContext => ({
    meId: 'me',
    myRole: WorkspaceRole.ADMIN,
    target: member('t', 'Target', WorkspaceRole.MEMBER),
    targetVoice: undefined,
    myVoiceRoomId: null,
    rooms: [call, meeting, text],
    allowSelfNickname: true,
    ...over,
  });

  it('admin on a member in voice: everything, move targets = other voice rooms', () => {
    const a = memberActions(base({ targetVoice: voice('t', 'call'), myVoiceRoomId: 'call' }));
    expect(a).toMatchObject({ volume: true, serverMute: true, disconnect: true, rename: true, kick: true, promote: false, removeGuest: false });
    expect(a.moveTargets.map((r) => r.id)).toEqual(['meeting']);
  });

  it('server mute: a moderator can lift it; the user\'s own mute is not a moderator mute', () => {
    const muted = { ...voice('t', 'call'), serverMuted: true };
    const a = memberActions(base({ targetVoice: muted, myVoiceRoomId: 'call' }));
    expect(a).toMatchObject({ alreadyMuted: true, serverUnmute: true });
    const self = memberActions(base({ targetVoice: { ...voice('t', 'call'), muted: true }, myVoiceRoomId: 'call' }));
    expect(self).toMatchObject({ alreadyMuted: false, serverUnmute: false, serverMute: true });
    const member = memberActions(base({ myRole: WorkspaceRole.MEMBER, targetVoice: muted, myVoiceRoomId: 'call' }));
    expect(member.serverUnmute).toBe(false);
  });

  it('member: only volume in the same room; nothing when not in voice', () => {
    const a = memberActions(base({ myRole: WorkspaceRole.MEMBER, targetVoice: voice('t', 'call'), myVoiceRoomId: 'call' }));
    expect(a).toMatchObject({ volume: true, serverMute: false, disconnect: false, rename: false, kick: false });
    expect(a.moveTargets).toEqual([]);
    expect(hasAnyAction(memberActions(base({ myRole: WorkspaceRole.MEMBER })))).toBe(false);
  });

  it('camera: «Не показывать видео» for a camera in my room; «Выключить камеру» for a moderator', () => {
    const cam = { ...voice('t', 'call'), camera: true };
    expect(memberActions(base({ targetVoice: cam, myVoiceRoomId: 'call' }))).toMatchObject({ hideVideo: true, stopCamera: true });
    const plain = memberActions(base({ myRole: WorkspaceRole.MEMBER, targetVoice: cam, myVoiceRoomId: 'call' }));
    expect(plain).toMatchObject({ hideVideo: true, stopCamera: false });
    // Another room: nothing to hide (not subscribed anyway); the moderator can still stop it.
    expect(memberActions(base({ targetVoice: cam, myVoiceRoomId: 'meeting' }))).toMatchObject({ hideVideo: false, stopCamera: true });
    expect(memberActions(base({ targetVoice: voice('t', 'call'), myVoiceRoomId: 'call' }))).toMatchObject({ hideVideo: false, stopCamera: false });
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.MEMBER), targetVoice: { ...cam, userId: 'me' }, myVoiceRoomId: 'call' }))).toMatchObject({ hideVideo: false, stopCamera: false });
  });

  it('roles (ADR-0026): checkboxes for the roles I may give; only the owner grants / revokes admin', () => {
    const design = create(RoleSchema, { id: 'r-design', name: 'Design', position: 3, permissions: PERMISSION_BITS.STREAM });
    const mod = create(RoleSchema, { id: 'r-mod', name: 'Moderator', position: 2, permissions: PERMISSION_BITS.MUTE_MEMBERS | PERMISSION_BITS.MANAGE_ROLES });
    const roles = [...legacyRoles('w'), design, mod];
    const ids = (a: ReturnType<typeof memberActions>): Array<[string, boolean, boolean]> | null =>
      a.roles?.map((x) => [x.role.id, x.on, x.enabled]) ?? null;
    // Admin: custom roles yes, admin no (only the owner) — the admin row is left out as the target lacks it.
    expect(ids(memberActions(base({ roles })))).toEqual([
      ['r-design', false, true],
      ['r-mod', false, true],
    ]);
    // Owner: admin too; a held role shows checked.
    const withDesign = create(WorkspaceMemberSchema, { ...member('t', 'T', WorkspaceRole.MEMBER), roleIds: ['member', 'r-design'] });
    expect(ids(memberActions(base({ roles, myRole: WorkspaceRole.OWNER, target: withDesign })))).toEqual([
      ['admin', false, true],
      ['r-design', true, true],
      ['r-mod', false, true],
    ]);
    // An admin target: an admin may not touch them (not below), the owner may.
    expect(memberActions(base({ roles, target: member('t', 'A', WorkspaceRole.ADMIN) })).roles).toBeNull();
    expect(ids(memberActions(base({ roles, myRole: WorkspaceRole.OWNER, target: member('t', 'A', WorkspaceRole.ADMIN) })))?.[0]).toEqual(['admin', true, true]);
    // A plain member: no MANAGE_ROLES → nothing; with Moderator (MANAGE_ROLES, position 2): only roles below 2 — none.
    expect(memberActions(base({ roles, myRole: WorkspaceRole.MEMBER })).roles).toBeNull();
    expect(memberActions(base({ roles, myRole: WorkspaceRole.MEMBER, myRoleIds: ['member', 'r-mod'] })).roles).toBeNull();
    // A guest can get custom roles, but not admin.
    expect(ids(memberActions(base({ roles, myRole: WorkspaceRole.OWNER, target: member('t', 'G', WorkspaceRole.GUEST, '', true) })))?.map((x) => x[0])).toEqual(['r-design', 'r-mod']);
    // Legacy server (only built-ins): an admin has nothing to give, the owner gives admin.
    expect(memberActions(base({})).roles).toBeNull();
    expect(ids(memberActions(base({ myRole: WorkspaceRole.OWNER })))).toEqual([['admin', false, true]]);
  });

  it('volume only for someone in my voice room; «Заглушить» for anyone but me', () => {
    expect(memberActions(base({ targetVoice: voice('t', 'meeting'), myVoiceRoomId: 'call' })).volume).toBe(false);
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER })).localMute).toBe(true);
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.MEMBER) })).localMute).toBe(false);
  });

  it('own nickname follows allow_self_nickname; admins always', () => {
    const me = member('me', 'Me', WorkspaceRole.MEMBER);
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER, target: me })).rename).toBe(true);
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER, target: me, allowSelfNickname: false })).rename).toBe(false);
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.ADMIN), allowSelfNickname: false })).rename).toBe(true);
  });

  it('guests: promote / remove instead of kick', () => {
    const a = memberActions(base({ target: member('t', 'G', WorkspaceRole.GUEST, '', true) }));
    expect(a).toMatchObject({ promote: true, removeGuest: true, kick: false });
  });

  it('only the owner removes admins; nobody removes the owner or themselves', () => {
    const adminT = member('t', 'A', WorkspaceRole.ADMIN);
    expect(memberActions(base({ target: adminT })).kick).toBe(false);
    expect(memberActions(base({ myRole: WorkspaceRole.OWNER, target: adminT })).kick).toBe(true);
    expect(memberActions(base({ myRole: WorkspaceRole.OWNER, target: member('t', 'O', WorkspaceRole.OWNER) })).kick).toBe(false);
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.ADMIN) })).kick).toBe(false);
  });

  it('ban (docs/09 #32): the same rule as kick, guests included', () => {
    const adminT = member('t', 'A', WorkspaceRole.ADMIN);
    expect(memberActions(base({ target: member('t', 'M', WorkspaceRole.MEMBER) })).ban).toBe(true);
    expect(memberActions(base({ target: member('t', 'G', WorkspaceRole.GUEST, '', true) })).ban).toBe(true);
    expect(memberActions(base({ target: adminT })).ban).toBe(false);
    expect(memberActions(base({ myRole: WorkspaceRole.OWNER, target: adminT })).ban).toBe(true);
    expect(memberActions(base({ myRole: WorkspaceRole.OWNER, target: member('t', 'O', WorkspaceRole.OWNER) })).ban).toBe(false);
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.ADMIN) })).ban).toBe(false);
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER, target: member('t', 'M', WorkspaceRole.MEMBER) })).ban).toBe(false);
  });

  it('room overrides: MOVE_MEMBERS granted per room limits the submenu to those rooms', () => {
    const grant = [
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: 'me', allow: PERMISSION_BITS.MOVE_MEMBERS, deny: 0n }),
    ];
    const a = memberActions(
      base({ myRole: WorkspaceRole.MEMBER, rooms: [room('call', RoomType.VOICE, grant), room('meeting', RoomType.VOICE, grant), room('locked')], targetVoice: voice('t', 'call') }),
    );
    expect(a.moveTargets.map((r) => r.id)).toEqual(['meeting']);
    expect(a.serverMute).toBe(false);
  });

  it('voice moderation hierarchy (rtc.outranks): admins only by the owner, the owner by nobody', () => {
    const inCall = (t: WorkspaceMember) => ({ target: t, targetVoice: voice(t.user?.id ?? '', 'call'), myVoiceRoomId: 'call' });
    const adminT = member('t', 'A', WorkspaceRole.ADMIN);
    // An admin on another admin: no mute / disconnect / stop camera (the server answers 403), but
    // a move (docs/09 #54).
    const a = memberActions(base({ ...inCall(adminT), targetVoice: { ...voice('t', 'call'), camera: true } }));
    expect(a).toMatchObject({ serverMute: false, disconnect: false, stopCamera: false, volume: true });
    expect(a.moveTargets.map((r) => r.id)).toEqual(['meeting']);
    // The owner may.
    const o = memberActions(base({ myRole: WorkspaceRole.OWNER, ...inCall(adminT) }));
    expect(o).toMatchObject({ serverMute: true, disconnect: true });
    expect(o.moveTargets.map((r) => r.id)).toEqual(['meeting']);
    // Nobody mutes / disconnects the owner; an admin moves them.
    const own = memberActions(base({ ...inCall(member('t', 'O', WorkspaceRole.OWNER)) }));
    expect(own).toMatchObject({ serverMute: false, disconnect: false });
    expect(own.moveTargets.map((r) => r.id)).toEqual(['meeting']);
    // A room moderator among members acts on members, not on admins.
    const grant = [
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: 'me', allow: PERMISSION_BITS.MUTE_MEMBERS | PERMISSION_BITS.MOVE_MEMBERS, deny: 0n }),
    ];
    const rooms = [room('call', RoomType.VOICE, grant), room('meeting', RoomType.VOICE, grant)];
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER, rooms, ...inCall(member('t', 'M', WorkspaceRole.MEMBER)) }))).toMatchObject({ disconnect: true });
    const onAdmin = memberActions(base({ myRole: WorkspaceRole.MEMBER, rooms, ...inCall(adminT) }));
    expect(onAdmin).toMatchObject({ disconnect: false });
    expect(onAdmin.moveTargets).toEqual([]);
    const onOwner = memberActions(base({ myRole: WorkspaceRole.MEMBER, rooms, ...inCall(member('t', 'O', WorkspaceRole.OWNER)) }));
    expect(onOwner.moveTargets).toEqual([]);
  });

  it('move targets: only rooms the moved member may connect to (server moveMember)', () => {
    const priv = room('secret', RoomType.VOICE, [
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: PERMISSION_BITS.VIEW_ROOM }),
    ]);
    const noConnect = room('stage', RoomType.VOICE, [
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: 't', allow: 0n, deny: PERMISSION_BITS.CONNECT }),
    ]);
    const a = memberActions(base({ rooms: [call, meeting, priv, noConnect], targetVoice: voice('t', 'call') }));
    // I (admin) see and may move into all of them; the member cannot enter «secret» or «stage».
    expect(a.moveTargets.map((r) => r.id)).toEqual(['meeting']);
  });

  it('kick / ban / role select follow the ADR-0026 hierarchy (workspaces.outranks)', () => {
    const mgr = create(RoleSchema, { id: 'r-mgr', name: 'Managers', position: 3, permissions: PERMISSION_BITS.MANAGE_MEMBERS });
    const senior = create(RoleSchema, { id: 'r-senior', name: 'Senior', position: 4, permissions: 0n });
    const junior = create(RoleSchema, { id: 'r-junior', name: 'Junior', position: 2, permissions: 0n });
    const roles = [...legacyRoles('w'), senior, mgr, junior];
    const asMgr = { roles, myRole: WorkspaceRole.MEMBER, myRoleIds: ['member', 'r-mgr'] };
    const withRoles = (ids: string[]) => create(WorkspaceMemberSchema, { ...member('t', 'T', WorkspaceRole.MEMBER), roleIds: ['member', ...ids] });
    // A custom role with MANAGE_MEMBERS (ADR-0048; a custom role's included — not only admins).
    expect(memberActions(base({ ...asMgr, target: withRoles([]) }))).toMatchObject({ kick: true, ban: true });
    // MANAGE_WORKSPACE alone no longer kicks, bans or promotes (ADR-0048: no implication).
    const ws = create(RoleSchema, { id: 'r-ws', name: 'Settings', position: 3, permissions: PERMISSION_BITS.MANAGE_WORKSPACE });
    const asWs = { roles: [...legacyRoles('w'), ws], myRole: WorkspaceRole.MEMBER, myRoleIds: ['member', 'r-ws'] };
    expect(memberActions(base({ ...asWs, target: withRoles([]) }))).toMatchObject({ kick: false, ban: false });
    expect(memberActions(base({ ...asWs, target: member('t', 'G', WorkspaceRole.GUEST, '', true) }))).toMatchObject({ removeGuest: false, promote: false });
    expect(memberActions(base({ ...asMgr, target: withRoles(['r-junior']) }))).toMatchObject({ kick: true, ban: true });
    // Target at or above my top role: no.
    expect(memberActions(base({ ...asMgr, target: withRoles(['r-mgr']) }))).toMatchObject({ kick: false, ban: false });
    expect(memberActions(base({ ...asMgr, target: withRoles(['r-senior']) }))).toMatchObject({ kick: false, ban: false });
    // Guests below: remove / promote.
    expect(memberActions(base({ ...asMgr, target: member('t', 'G', WorkspaceRole.GUEST, '', true) }))).toMatchObject({ removeGuest: true, promote: true });
    // An admin is above any custom role: the admin removes the senior member, the manager does not remove the admin.
    expect(memberActions(base({ roles, target: withRoles(['r-senior']) })).kick).toBe(true);
    expect(memberActions(base({ ...asMgr, target: member('t', 'A', WorkspaceRole.ADMIN) })).kick).toBe(false);
  });

  it('canRemoveMember: never oneself, the owner, or without MANAGE_MEMBERS', () => {
    const all = legacyRoles('w');
    const r = (role: WorkspaceRole) => rolesOfMember(all, { role, roleIds: [] });
    expect(canRemoveMember(r(WorkspaceRole.OWNER), r(WorkspaceRole.ADMIN), { role: WorkspaceRole.ADMIN }, false)).toBe(true);
    expect(canRemoveMember(r(WorkspaceRole.OWNER), r(WorkspaceRole.OWNER), { role: WorkspaceRole.OWNER }, true)).toBe(false);
    expect(canRemoveMember(r(WorkspaceRole.ADMIN), r(WorkspaceRole.OWNER), { role: WorkspaceRole.OWNER }, false)).toBe(false);
    expect(canRemoveMember(r(WorkspaceRole.ADMIN), r(WorkspaceRole.MEMBER), { role: WorkspaceRole.MEMBER }, false)).toBe(true);
    expect(canRemoveMember(r(WorkspaceRole.MEMBER), r(WorkspaceRole.GUEST), { role: WorkspaceRole.GUEST }, false)).toBe(false);
  });

  it('canEditMemberBirthday (docs/09 #77): MANAGE_NICKNAMES + hierarchy; never bots, guests or oneself', () => {
    const nick = create(RoleSchema, { id: 'r-nick', name: 'HR', position: 3, permissions: PERMISSION_BITS.MANAGE_NICKNAMES });
    const senior = create(RoleSchema, { id: 'r-senior', name: 'Senior', position: 4, permissions: 0n });
    const all = [...legacyRoles('w'), senior, nick];
    const r = (role: WorkspaceRole, ...ids: string[]) => rolesOfMember(all, { role, roleIds: ids });
    const t = (role: WorkspaceRole, isBot = false) => ({ role, user: create(UserSchema, { id: 't', isBot, isGuest: role === WorkspaceRole.GUEST }) });
    // The owner: anyone but bots / guests / themself.
    expect(canEditMemberBirthday(r(WorkspaceRole.OWNER), r(WorkspaceRole.ADMIN), t(WorkspaceRole.ADMIN), false)).toBe(true);
    expect(canEditMemberBirthday(r(WorkspaceRole.OWNER), r(WorkspaceRole.OWNER), t(WorkspaceRole.OWNER), true)).toBe(false);
    expect(canEditMemberBirthday(r(WorkspaceRole.OWNER), r(WorkspaceRole.MEMBER), t(WorkspaceRole.MEMBER, true), false)).toBe(false);
    expect(canEditMemberBirthday(r(WorkspaceRole.OWNER), r(WorkspaceRole.GUEST), t(WorkspaceRole.GUEST), false)).toBe(false);
    // An admin: members, not the owner.
    expect(canEditMemberBirthday(r(WorkspaceRole.ADMIN), r(WorkspaceRole.MEMBER), t(WorkspaceRole.MEMBER), false)).toBe(true);
    expect(canEditMemberBirthday(r(WorkspaceRole.ADMIN), r(WorkspaceRole.OWNER), t(WorkspaceRole.OWNER), false)).toBe(false);
    // A custom role with MANAGE_NICKNAMES: only below it.
    expect(canEditMemberBirthday(r(WorkspaceRole.MEMBER, 'r-nick'), r(WorkspaceRole.MEMBER), t(WorkspaceRole.MEMBER), false)).toBe(true);
    expect(canEditMemberBirthday(r(WorkspaceRole.MEMBER, 'r-nick'), r(WorkspaceRole.MEMBER, 'r-senior'), t(WorkspaceRole.MEMBER), false)).toBe(false);
    expect(canEditMemberBirthday(r(WorkspaceRole.MEMBER, 'r-nick'), r(WorkspaceRole.ADMIN), t(WorkspaceRole.ADMIN), false)).toBe(false);
    // Without the right: no.
    expect(canEditMemberBirthday(r(WorkspaceRole.MEMBER), r(WorkspaceRole.MEMBER), t(WorkspaceRole.MEMBER), false)).toBe(false);
    // memberActions.birthday (the profile) follows it.
    expect(memberActions(base({})).birthday).toBe(true);
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER })).birthday).toBe(false);
  });

  it('canSetMemberBadge (docs/09 #82): MANAGE_NICKNAMES + hierarchy (oneself too, guests too); never bots', () => {
    const nick = create(RoleSchema, { id: 'r-nick', name: 'HR', position: 3, permissions: PERMISSION_BITS.MANAGE_NICKNAMES });
    const senior = create(RoleSchema, { id: 'r-senior', name: 'Senior', position: 4, permissions: 0n });
    const all = [...legacyRoles('w'), senior, nick];
    const r = (role: WorkspaceRole, ...ids: string[]) => rolesOfMember(all, { role, roleIds: ids });
    const t = (isBot = false) => ({ user: create(UserSchema, { id: 't', isBot }) });
    expect(canSetMemberBadge(r(WorkspaceRole.OWNER), r(WorkspaceRole.ADMIN), t(), false)).toBe(true);
    expect(canSetMemberBadge(r(WorkspaceRole.OWNER), r(WorkspaceRole.OWNER), t(), true)).toBe(true);
    expect(canSetMemberBadge(r(WorkspaceRole.OWNER), r(WorkspaceRole.MEMBER), t(true), false)).toBe(false);
    expect(canSetMemberBadge(r(WorkspaceRole.ADMIN), r(WorkspaceRole.GUEST), t(), false)).toBe(true);
    expect(canSetMemberBadge(r(WorkspaceRole.ADMIN), r(WorkspaceRole.OWNER), t(), false)).toBe(false);
    expect(canSetMemberBadge(r(WorkspaceRole.MEMBER, 'r-nick'), r(WorkspaceRole.MEMBER), t(), false)).toBe(true);
    expect(canSetMemberBadge(r(WorkspaceRole.MEMBER, 'r-nick'), r(WorkspaceRole.MEMBER, 'r-senior'), t(), false)).toBe(false);
    expect(canSetMemberBadge(r(WorkspaceRole.MEMBER), r(WorkspaceRole.MEMBER), t(), true)).toBe(false);
  });

  it('room MUTE_MEMBERS grant: disconnect only; server mute/unmute need it workspace-wide', () => {
    const grant = [
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: 'me', allow: PERMISSION_BITS.MUTE_MEMBERS, deny: 0n }),
    ];
    const a = memberActions(base({ myRole: WorkspaceRole.MEMBER, rooms: [room('call', RoomType.VOICE, grant)], targetVoice: { ...voice('t', 'call'), serverMuted: true } }));
    expect(a.disconnect).toBe(true);
    expect(a.serverMute).toBe(false);
    expect(a.serverUnmute).toBe(false);
  });
});
