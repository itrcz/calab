import { WorkspaceRole, type User, type WorkspaceMember } from '@calaba/protocol';
import { isBlocked, selectBlocked, useBlocks } from '../../stores/blocks';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';

/**
 * «Написать» for a member of this workspace (ADR-0020): not myself, and neither of us a guest —
 * guest accounts have no DMs and the server lets full members (not the guest role) of a common
 * workspace write to each other. The server re-checks (403 / 404).
 */
export function canDmWith(me: User | undefined, myRole: WorkspaceRole | undefined, target: WorkspaceMember | undefined): boolean {
  if (!me || me.isGuest || !target?.user || me.id === target.user.id || target.user.isGuest) return false;
  return myRole !== WorkspaceRole.GUEST && target.role !== WorkspaceRole.GUEST;
}

/** canDmWith, reactive (primitive selectors). */
export function useCanDm(workspaceId: string, userId: string): boolean {
  const me = useSession((s) => s.me?.user);
  const myRole = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const target = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]);
  return canDmWith(me, myRole, target);
}

/** canDmWith, read at the moment of the action (keyboard). */
export function canDmNow(workspaceId: string, userId: string): boolean {
  const ws = useWorkspaces.getState().byId[workspaceId];
  return canDmWith(useSession.getState().me?.user, ws?.role, ws?.members[userId]);
}

/**
 * «Позвонить» (ADR-0034): whom I may write to, and a person — never a bot (the server answers
 * 403 BOT_NOT_ALLOWED). With a workspace: that membership; without (a DM, ⌘K): any shared one.
 */
export function canCallWith(me: User | undefined, myRole: WorkspaceRole | undefined, target: WorkspaceMember | undefined): boolean {
  return canDmWith(me, myRole, target) && target?.user?.isBot !== true && me?.isBot !== true;
}

/** canCallWith in any of my workspaces (or in `workspaceId`), at the moment of the action. */
export function canCallNow(userId: string, workspaceId?: string): boolean {
  if (isBlocked(userId)) return false; // ADR-0154: no calls with a person I blocked
  const me = useSession.getState().me?.user;
  const byId = useWorkspaces.getState().byId;
  const entries = workspaceId ? [byId[workspaceId]] : Object.values(byId);
  return entries.some((e) => e !== undefined && canCallWith(me, e.role, e.members[userId]));
}

/** canCallNow, reactive: a boolean selector (re-renders only when the answer flips). */
export function useCanCall(userId: string, workspaceId?: string): boolean {
  const me = useSession((s) => s.me?.user);
  const blocked = useBlocks(selectBlocked(userId)); // ADR-0154: no calls with a person I blocked
  const can = useWorkspaces((s) => {
    const entries = workspaceId ? [s.byId[workspaceId]] : Object.values(s.byId);
    return entries.some((e) => e !== undefined && canCallWith(me, e.role, e.members[userId]));
  });
  return can && !blocked;
}
