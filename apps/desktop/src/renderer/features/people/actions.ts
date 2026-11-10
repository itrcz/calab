import { WorkspaceRole, type Role } from '@calaba/protocol';
import { confirmAction, promptAction } from '../../components/Confirm';
import { REASON_MAX } from '../../lib/moderation';
import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { withRole } from '../../lib/roles';
import { memberName, rolesOf, useWorkspaces } from '../../stores/workspaces';

/** Human error text for member actions (docs/09 #16: no raw strings where we know better). */
export function peopleError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.is('ERROR_CODE_ROOM_FULL')) return t('people.err.roomFull');
    // The role guard (ADR-0026 addendum 2026-11-10): the role would let me (or a bot) into a private room or board.
    if (e.is('ERROR_CODE_FORBIDDEN') && e.reason === 'OWNER_ONLY') return t('people.err.rolePrivate');
    if (e.is('ERROR_CODE_FORBIDDEN')) return t('people.err.forbidden');
  }
  return errorText(e);
}

const run = (p: Promise<unknown>): void => void p.catch((e: unknown) => toast.error(peopleError(e)));

export function serverMute(roomId: string, userId: string): void {
  run(api.voice.muteMember(roomId, userId));
}

/** Lifts a moderator mute; the member turns the mic on themself. */
export function serverUnmute(roomId: string, userId: string): void {
  run(api.voice.unmuteMember(roomId, userId));
}

/** Moderator: turn the member's camera off (POST …/stop-camera → VOICE_CAMERA_STOP{MODERATOR}). */
export function stopMemberCamera(workspaceId: string, roomId: string, userId: string): void {
  run(api.voice.stopMemberCamera(roomId, userId).then(() => toast.info(t('video.stoppedMember', { name: memberName(workspaceId, userId) }))));
}

export function disconnectFromVoice(roomId: string, userId: string): void {
  run(api.voice.disconnectMember(roomId, userId));
}

/** POST /api/rooms/{id}/voice/{userId}/move (docs/09 #32); the room list updates from VOICE_STATE_UPDATE. */
export function moveMember(workspaceId: string, fromRoomId: string, userId: string, toRoomId: string): void {
  run(
    api.voice.moveMember(fromRoomId, userId, toRoomId).then(() => {
      const room = useRooms.getState().byId[toRoomId]?.name ?? '';
      toast.info(t('people.moved', { name: memberName(workspaceId, userId), room }));
    }),
  );
}

/** «Роли ›»: PATCH …/members/{userId} {role} (only the owner grants / revokes admin). */
export function setMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): void {
  run(
    api.workspaces.updateMember(workspaceId, userId, { role }).then((r) => {
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
    }),
  );
}

/** The profile dialog (docs/09 #20); `note` = «Добавить заметку»: the note field focused. */
/**
 * Give / take one role (ADR-0026, «Роли ›», profile chips): PUT …/members/{uid}/roles with the
 * member's complete set. An older server (no role_ids) knows only admin ↔ member (legacy PATCH).
 */
export function toggleMemberRole(workspaceId: string, userId: string, role: Role, on: boolean): Promise<void> {
  const entry = useWorkspaces.getState().byId[workspaceId];
  const m = entry?.members[userId];
  if (!entry || !m) return Promise.resolve();
  const p =
    m.roleIds.length === 0
      ? role.builtin === WorkspaceRole.ADMIN
        ? api.workspaces.updateMember(workspaceId, userId, { role: on ? WorkspaceRole.ADMIN : WorkspaceRole.MEMBER })
        : Promise.reject(new Error('custom roles need a newer server'))
      : api.workspaces.setMemberRoles(workspaceId, userId, withRole(rolesOf(entry, userId).map((r) => r.id), role.id, on));
  return p.then(
    (r) => {
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
    },
    (e: unknown) => toast.error(peopleError(e)),
  );
}

export function openProfile(workspaceId: string, userId: string, note = false): void {
  useUi.getState().openDialog({ kind: 'profile', workspaceId, userId, note });
}

/** «Копировать ID» (support, bug reports). */
export function copyUserId(userId: string): void {
  void navigator.clipboard.writeText(userId).then(
    () => toast.info(t('people.menu.idCopied')),
    () => toast.error(t('people.menu.idCopyFailed')),
  );
}

export function promoteGuest(workspaceId: string, userId: string): void {
  run(
    api.workspaces.promoteGuest(workspaceId, userId).then((r) => {
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
      toast.info(t('people.promoted', { name: memberName(workspaceId, userId) }));
    }),
  );
}

/** Kick a member / remove a guest (DELETE …/members/{userId}); irreversible → confirmation. */
export async function removeMember(workspaceId: string, userId: string, guest: boolean): Promise<void> {
  const name = memberName(workspaceId, userId);
  const ok = guest
    ? await confirmAction(t('people.menu.removeGuest'), t('people.removeGuestConfirm', { name }), t('common.delete'))
    : await confirmAction(t('ws.kick'), t('ws.kickConfirm', { name }), t('ws.kick'));
  if (!ok) return;
  run(api.workspaces.removeMember(workspaceId, userId).then(() => useWorkspaces.getState().removeMember(workspaceId, userId)));
}

/**
 * «Забанить…» (docs/09 #32): a reason (optional) → POST …/bans. Unlike «Исключить» the user
 * cannot come back until unbanned (settings → «Забаненные»).
 */
export async function banMember(workspaceId: string, userId: string): Promise<void> {
  const name = memberName(workspaceId, userId);
  const reason = await promptAction(t('ban.title', { name }), t('ban.text'), t('ban.action'), {
    label: t('ban.reason'),
    placeholder: t('ban.reasonPh'),
    maxLength: REASON_MAX,
  });
  if (reason === null) return;
  run(
    api.workspaces.ban(workspaceId, userId, reason).then(() => {
      useWorkspaces.getState().removeMember(workspaceId, userId);
      toast.info(t('ban.done', { name }));
    }),
  );
}
