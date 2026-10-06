import type {
  Badge,
  Presence,
  Role,
  User,
  VoiceState,
  Workspace,
  WorkspaceBackground,
  WorkspaceMember,
  WorkspaceSnapshot,
} from '@calaba/protocol';
import { WorkspaceRole } from '@calaba/protocol';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../i18n';
import { customLook, legacyRoles, rolesOfMember, sortRoles } from '../lib/roles';

export interface WorkspaceEntry {
  ws: Workspace;
  role: WorkspaceRole;
  members: Record<string, WorkspaceMember>;
  /**
   * All roles of the workspace, highest position first (ADR-0026). An older server sends none:
   * the four built-ins with their legacy ids («member»…) stand in (lib/roles legacyRoles).
   */
  roles: Role[];
  /** The badge library (docs/09 #82) by id, in the server's order; members[].badgeId refer to it. */
  badges: Record<string, Badge>;
  /** Camera backgrounds of the workspace (ADR-0035) by id, in the server's order. */
  backgrounds: Record<string, WorkspaceBackground>;
  /** userId → aggregated voice state (docs/05, "multiple devices"). */
  voice: Record<string, VoiceState>;
}

interface WorkspacesState {
  byId: Record<string, WorkspaceEntry>;
  order: string[];
  /** Presence is per user, shared across workspaces. */
  presences: Record<string, Presence>;
  /** Profiles of everyone we share a workspace with. */
  users: Record<string, User>;
  reset: () => void;
  applySnapshot: (s: WorkspaceSnapshot) => void;
  remove: (workspaceId: string) => void;
  updateWorkspace: (ws: Workspace) => void;
  upsertMember: (m: WorkspaceMember) => void;
  /** My own member record changed (WORKSPACE_MEMBER_UPDATE): the entry's built-in role follows it. */
  setMyRole: (workspaceId: string, role: WorkspaceRole) => void;
  upsertRole: (r: Role) => void;
  /** ROLE_DELETE: the role goes, and with it from every member's role_ids. */
  removeRole: (workspaceId: string, roleId: string) => void;
  /** GET …/roles, PUT …/roles/order: the whole list. */
  setRoles: (workspaceId: string, roles: readonly Role[]) => void;
  /** BADGE_CREATE / BADGE_UPDATE. */
  upsertBadge: (b: Badge) => void;
  /** BADGE_DELETE: the badge goes, and from every member that still shows it. */
  removeBadge: (workspaceId: string, badgeId: string) => void;
  /** BACKGROUND_CREATE / BACKGROUND_UPDATE. */
  upsertBackground: (b: WorkspaceBackground) => void;
  /** BACKGROUND_DELETE. */
  removeBackground: (workspaceId: string, backgroundId: string) => void;
  removeMember: (workspaceId: string, userId: string) => void;
  setPresence: (p: Presence) => void;
  setVoiceState: (v: VoiceState) => void;
  /** ROOM_DELETE (deleted or no longer visible): nobody is shown in that room any more. */
  clearRoomVoice: (workspaceId: string, roomId: string) => void;
  upsertUser: (u: User) => void;
}

/**
 * Contacts (ADR-0077) arrive only where the server may show them, judged per workspace: a User
 * without email says nothing about them (a guest's view of the same person in another workspace,
 * an event that does not carry them). Such a copy keeps the contacts already known; a User with
 * email replaces them (a cleared phone included). Who sees them is decided when shown
 * (features/people/contacts.ts).
 */
export function keepContacts(prev: User | undefined, next: User): User {
  if (next.email || !prev || (!prev.email && !prev.phone)) return next;
  return { ...next, email: prev.email, emailVerified: prev.emailVerified, phone: prev.phone };
}

/**
 * A user object lives in `users` and, per workspace, inside `members[id].user` (READY snapshots);
 * the member list renders the latter, so a profile / custom status change has to reach both.
 */
const withUser = (s: WorkspacesState, next: User): Partial<WorkspacesState> => {
  const u = keepContacts(s.users[next.id], next);
  const byId = { ...s.byId };
  let touched = false;
  for (const [wsId, e] of Object.entries(byId)) {
    const m = e.members[u.id];
    if (!m || m.user === u) continue;
    byId[wsId] = { ...e, members: { ...e.members, [u.id]: { ...m, user: u } } };
    touched = true;
  }
  return { users: { ...s.users, [u.id]: u }, ...(touched ? { byId } : {}) };
};

const withEntry = (
  s: WorkspacesState,
  id: string,
  fn: (e: WorkspaceEntry) => WorkspaceEntry,
): Partial<WorkspacesState> => {
  const e = s.byId[id];
  return e ? { byId: { ...s.byId, [id]: fn(e) } } : {};
};

export const useWorkspaces = create<WorkspacesState>()((set) => ({
  byId: {},
  order: [],
  presences: {},
  users: {},
  reset: () => set({ byId: {}, order: [], presences: {}, users: {} }),
  applySnapshot: (snap) =>
    set((s) => {
      const ws = snap.workspace;
      if (!ws) return {};
      const members: Record<string, WorkspaceMember> = {};
      const users = { ...s.users };
      for (const m of snap.members) {
        if (!m.user) continue;
        const u = keepContacts(users[m.user.id], m.user);
        members[u.id] = u === m.user ? m : { ...m, user: u };
        users[u.id] = u;
      }
      const voice: Record<string, VoiceState> = {};
      for (const v of snap.voiceStates) if (v.roomId) voice[v.userId] = v;
      const presences = { ...s.presences };
      for (const p of snap.presences) presences[p.userId] = p;
      const order = s.order.includes(ws.id) ? s.order : [...s.order, ws.id];
      const roles = snap.roles.length > 0 ? sortRoles(snap.roles) : legacyRoles(ws.id);
      const badges: Record<string, Badge> = {};
      for (const b of snap.badges) badges[b.id] = b;
      const backgrounds: Record<string, WorkspaceBackground> = {};
      for (const b of snap.backgrounds) backgrounds[b.id] = b;
      return { byId: { ...s.byId, [ws.id]: { ws, role: snap.role, members, roles, badges, backgrounds, voice } }, order, presences, users };
    }),
  remove: (id) =>
    set((s) => {
      const byId = { ...s.byId };
      delete byId[id];
      return { byId, order: s.order.filter((x) => x !== id) };
    }),
  updateWorkspace: (ws) => set((s) => withEntry(s, ws.id, (e) => ({ ...e, ws }))),
  upsertMember: (m) =>
    set((s) => {
      if (!m.user) return {};
      const user = keepContacts(s.users[m.user.id], m.user);
      const member = user === m.user ? m : { ...m, user };
      return {
        ...withEntry(s, m.workspaceId, (e) => ({ ...e, members: { ...e.members, [user.id]: member } })),
        users: { ...s.users, [user.id]: user },
      };
    }),
  setMyRole: (wsId, role) => set((s) => withEntry(s, wsId, (e) => (e.role === role ? e : { ...e, role }))),
  upsertRole: (r) =>
    set((s) => withEntry(s, r.workspaceId, (e) => ({ ...e, roles: sortRoles([...e.roles.filter((x) => x.id !== r.id), r]) }))),
  removeRole: (wsId, roleId) =>
    set((s) =>
      withEntry(s, wsId, (e) => {
        const members: Record<string, WorkspaceMember> = {};
        for (const [id, m] of Object.entries(e.members)) {
          members[id] = m.roleIds.includes(roleId) ? { ...m, roleIds: m.roleIds.filter((x) => x !== roleId) } : m;
        }
        return { ...e, members, roles: e.roles.filter((r) => r.id !== roleId) };
      }),
    ),
  setRoles: (wsId, roles) => set((s) => withEntry(s, wsId, (e) => ({ ...e, roles: sortRoles(roles) }))),
  upsertBadge: (b) => set((s) => withEntry(s, b.workspaceId, (e) => ({ ...e, badges: { ...e.badges, [b.id]: b } }))),
  removeBadge: (wsId, badgeId) =>
    set((s) =>
      withEntry(s, wsId, (e) => {
        if (!(badgeId in e.badges)) return e;
        const badges = { ...e.badges };
        delete badges[badgeId];
        let members = e.members;
        for (const [id, m] of Object.entries(e.members)) {
          if (m.badgeId !== badgeId) continue;
          if (members === e.members) members = { ...e.members };
          members[id] = { ...m, badgeId: '' };
        }
        return { ...e, members, badges };
      }),
    ),
  upsertBackground: (b) => set((s) => withEntry(s, b.workspaceId, (e) => ({ ...e, backgrounds: { ...e.backgrounds, [b.id]: b } }))),
  removeBackground: (wsId, id) =>
    set((s) =>
      withEntry(s, wsId, (e) => {
        if (!(id in e.backgrounds)) return e;
        const backgrounds = { ...e.backgrounds };
        delete backgrounds[id];
        return { ...e, backgrounds };
      }),
    ),
  removeMember: (wsId, userId) =>
    set((s) =>
      withEntry(s, wsId, (e) => {
        const members = { ...e.members };
        delete members[userId];
        const voice = { ...e.voice };
        delete voice[userId];
        return { ...e, members, voice };
      }),
    ),
  // PRESENCE_UPDATE also carries the custom status (docs/05): the member list, profile and
  // header read it from `users`, so keep that copy in sync (set / edited / cleared / expired).
  setPresence: (p) =>
    set((s) => {
      const u = s.users[p.userId];
      const stale =
        u && (u.statusText !== p.statusText || u.statusEmoji !== p.statusEmoji || (u.statusExpiresAt?.seconds ?? 0n) !== (p.statusExpiresAt?.seconds ?? 0n));
      return {
        presences: { ...s.presences, [p.userId]: p },
        ...(stale ? withUser(s, { ...u, statusText: p.statusText, statusEmoji: p.statusEmoji, statusExpiresAt: p.statusExpiresAt }) : {}),
      };
    }),
  setVoiceState: (v) =>
    set((s) =>
      withEntry(s, v.workspaceId, (e) => {
        const voice = { ...e.voice };
        if (v.roomId) voice[v.userId] = v;
        else delete voice[v.userId];
        return { ...e, voice };
      }),
    ),
  clearRoomVoice: (wsId, roomId) =>
    set((s) =>
      withEntry(s, wsId, (e) => {
        if (!Object.values(e.voice).some((v) => v.roomId === roomId)) return e;
        const voice: Record<string, VoiceState> = {};
        for (const [id, v] of Object.entries(e.voice)) if (v.roomId !== roomId) voice[id] = v;
        return { ...e, voice };
      }),
    ),
  upsertUser: (u) => set((s) => withUser(s, u)),
}));

/** Display name in a workspace: nickname > profile name. */
export function memberName(wsId: string | null, userId: string): string {
  const st = useWorkspaces.getState();
  const m = wsId ? st.byId[wsId]?.members[userId] : undefined;
  return m?.nickname || m?.user?.displayName || st.users[userId]?.displayName || t('common.unknownUser');
}

/** Reactive memberName(): re-renders when the nickname or profile name changes. */
export function useMemberName(wsId: string | null, userId: string): string {
  return useWorkspaces((st) => {
    const m = wsId ? st.byId[wsId]?.members[userId] : undefined;
    return m?.nickname || m?.user?.displayName || st.users[userId]?.displayName || t('common.unknownUser');
  });
}

/**
 * Guest of this workspace (ADR-0016) → «Гость» badge. By role, not only User.is_guest: a
 * registered user who came by a room link is a guest too, and «Сделать участником» keeps
 * the account's is_guest (no password yet) while the role becomes member — no badge then.
 */
export function isGuest(m: WorkspaceMember | undefined): boolean {
  return m?.role === WorkspaceRole.GUEST;
}

const NO_ROLES: Role[] = [];

/** The member's roles, highest first (ADR-0026); [] for an unknown member. Not reactive. */
export function rolesOf(entry: WorkspaceEntry | undefined, userId: string): Role[] {
  const m = entry?.members[userId];
  return entry && m ? rolesOfMember(entry.roles, m) : NO_ROLES;
}

/** Reactive rolesOf(): the same array while the roles (by identity) stay the same. */
export function useMemberRoles(wsId: string | null | undefined, userId: string): Role[] {
  return useWorkspaces(useShallow((st) => rolesOf(wsId ? st.byId[wsId] : undefined, userId)));
}

/**
 * The custom role that colours the member's name (lib/roles customLook: none for owner /
 * admins); a store object, so a stable selector result.
 */
export function useRoleLook(wsId: string | null | undefined, userId: string): Role | undefined {
  return useWorkspaces((st) => customLook(rolesOf(wsId ? st.byId[wsId] : undefined, userId)));
}

/**
 * The member's badge (docs/09 #82) — a store object (stable selector result), undefined for none,
 * a DM (no workspace) or a badge not (yet) in the library. Rows subscribe by id: a change of
 * another member or of the workspace does not re-render them.
 */
export function useMemberBadge(wsId: string | null | undefined, userId: string): Badge | undefined {
  return useWorkspaces((st) => memberBadge(wsId ? st.byId[wsId] : undefined, userId));
}

/** Non-reactive useMemberBadge(). */
export function memberBadge(entry: WorkspaceEntry | undefined, userId: string): Badge | undefined {
  const id = entry?.members[userId]?.badgeId;
  return id ? entry.badges[id] : undefined;
}

const NO_BADGES: Badge[] = [];

/** The library in the server's order (settings, the badge select); the same array while it is unchanged. */
export function useBadgeList(wsId: string): Badge[] {
  return useWorkspaces(useShallow((st) => {
    const b = st.byId[wsId]?.badges;
    return b ? Object.values(b) : NO_BADGES;
  }));
}

const NO_BACKGROUNDS: WorkspaceBackground[] = [];

/** Camera backgrounds of the workspace (ADR-0035) in the server's order; the same array while unchanged. */
export function useBackgroundList(wsId: string | null | undefined): WorkspaceBackground[] {
  return useWorkspaces(
    useShallow((st) => {
      const b = wsId ? st.byId[wsId]?.backgrounds : undefined;
      return b ? Object.values(b) : NO_BACKGROUNDS;
    }),
  );
}

/** A camera background of any of my workspaces by id (non-reactive). */
export function findBackground(id: string): WorkspaceBackground | undefined {
  for (const e of Object.values(useWorkspaces.getState().byId)) {
    const b = e.backgrounds[id];
    if (b) return b;
  }
  return undefined;
}
