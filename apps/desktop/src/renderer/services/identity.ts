import { clearRoomDrafts } from '../features/chat/drafts';
import { clearWorkspaceBoards } from './boards';
import { clearChatRooms } from './chat';
import { useDms } from '../stores/dms';
import { useSession } from '../stores/session';
import { IdentityAccessReason, type WorkspaceIdentityAccess } from '@calaba/protocol';
import { create } from '@bufbuild/protobuf';
import { WorkspaceIdentityAccessSchema } from '@calaba/protocol';
import { useIdentity } from '../stores/identity';
import { useWorkspaces } from '../stores/workspaces';
import { useRooms } from '../stores/rooms';
import { useMessages } from '../stores/messages';
import { useTyping } from '../stores/typing';
import { useReadReceipts } from '../stores/readReceipts';
import { useRoomPreviews } from '../stores/roomPreviews';
import { useInbox } from '../stores/inbox';
import { useCalendar } from '../stores/calendar';
import { useFreeBusy } from '../stores/freebusy';
import { useStickers } from '../stores/stickers';
import { useBots } from '../stores/bots';
import { useSounds } from '../stores/sounds';
import { useWebApps } from '../stores/webApps';
import { useBoards } from '../stores/boards';
import { useVoice } from '../stores/voice';
import { useArchiveView } from '../stores/archiveView';
import { useUi } from '../stores/ui';
import { queryClient } from '../lib/queryClient';
import { platform } from '../platform';
import { identityPathWorkspace, identityRoomLocked, markIdentityBoundary, rememberIdentityResources } from '../lib/api/identityGate';
import { onIdentityDenied } from '../lib/api/client';
import { accessLocked } from '../features/identity/model';
import { pruneGatewaySubscriptions } from './gateway';

export function withoutKeys<T>(map: Readonly<Record<string, T>>, keys: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(map).filter(([id]) => !keys.has(id)));
}
export function applyIdentityAccess(access: WorkspaceIdentityAccess): void {
  const id = access.workspaceId;
  if (!id) return;
  const roomIds = Object.values(useRooms.getState().byId)
    .filter((r) => r.workspaceId === id)
    .map((r) => r.id);
  const archived = useArchiveView.getState().room;
  if (archived?.workspaceId === id) roomIds.push(archived.id);
  for (const task of Object.values(useBoards.getState().tasks)) if (task.workspaceId === id && task.roomId) roomIds.push(task.roomId);
  const resourcePaths: string[] = [];
  const resources = new Set<string>();
  for (const messageRoom of roomIds)
    for (const item of useMessages.getState().rooms[messageRoom]?.items ?? []) {
      resourcePaths.push(`/api/messages/${item.msg.id}`);
      resources.add(item.msg.id);
      for (const file of item.msg.attachments) {
        resourcePaths.push(`/api/files/${file.id}`);
        resources.add(file.id);
      }
    }
  for (const board of Object.values(useBoards.getState().boards))
    if (board.workspaceId === id) {
      resourcePaths.push(`/api/boards/${board.id}`);
      resources.add(board.id);
    }
  for (const task of Object.values(useBoards.getState().tasks))
    if (task.workspaceId === id) {
      resourcePaths.push(`/api/tasks/${task.id}`);
      resources.add(task.id);
    }
  for (const event of Object.values(useCalendar.getState().occ))
    if (event.workspaceId === id) {
      resourcePaths.push(`/api/events/${event.id}`);
      resources.add(event.id);
    }
  rememberIdentityResources(id, resourcePaths);
  const locked = accessLocked(access);
  markIdentityBoundary(id, roomIds, locked);
  useIdentity.getState().setAccess(access);
  if (!locked) return;
  const ids = new Set(roomIds);
  const wsIds = new Set([id]);
  clearRoomDrafts(ids);
  clearChatRooms(ids);
  clearWorkspaceBoards(id);
  useMessages.setState((s) => ({ rooms: withoutKeys(s.rooms, ids), pins: withoutKeys(s.pins, ids) }));
  useTyping.setState((s) => ({ rooms: withoutKeys(s.rooms, ids) }));
  useReadReceipts.setState((s) => ({ byRoom: withoutKeys(s.byRoom, ids) }));
  useRoomPreviews.getState().drop(roomIds); // last-message texts of the room list (ADR-0073 §5)
  useInbox.getState().removeRooms((r) => !ids.has(r));
  useCalendar.setState((s) => ({
    occ: Object.fromEntries(Object.entries(s.occ).filter(([, v]) => v.workspaceId !== id)),
    series: Object.fromEntries(Object.entries(s.series).filter(([, v]) => v.workspaceId !== id)),
    active: withoutKeys(s.active, ids),
    months: Object.fromEntries(Object.entries(s.months).filter(([k]) => !k.startsWith(`${id}|`))),
  }));
  useFreeBusy.setState((s) => ({
    entries: Object.fromEntries(Object.entries(s.entries).filter(([k]) => !k.startsWith(`${id}|`))),
    chunks: Object.fromEntries(Object.entries(s.chunks).filter(([k]) => !k.startsWith(`${id}|`))),
    ...(s.externalWs === id ? { external: {}, externalChunks: {}, externalWs: '' } : {}),
  }));
  useStickers.setState((s) => ({
    installed: s.installed.filter((p) => p.workspaceId !== id),
    available: s.available.filter((p) => p.workspaceId !== id),
    byWorkspace: withoutKeys(s.byWorkspace, wsIds),
  }));
  useBots.setState((s) => ({
    byWorkspace: withoutKeys(s.byWorkspace, wsIds),
    cards: Object.fromEntries(Object.entries(s.cards).filter(([, b]) => b.workspaceId !== id)),
    commands: withoutKeys(s.commands, ids),
  }));
  useSounds.getState().dropWorkspace(id);
  for (const app of Object.values(useWebApps.getState().byId)) if (app.workspaceId === id) void platform.webApps?.forget(app.id);
  useWebApps.getState().dropWorkspace(id);
  for (const board of Object.values(useBoards.getState().boards)) if (board.workspaceId === id) useBoards.getState().removeBoard(board.id);
  if (archived?.workspaceId === id) useArchiveView.getState().close();
  void queryClient.cancelQueries({
    predicate: (q) => q.queryKey.some((v) => typeof v === 'string' && (v === id || ids.has(v) || resources.has(v))),
  });
  queryClient.removeQueries({
    predicate: (q) => q.queryKey.some((v) => typeof v === 'string' && (v === id || ids.has(v) || resources.has(v))),
  });
  // In-memory blob URLs can be held by more than one surface; revoke the protected media cache.
  platform.clearProtectedMedia?.();
  pruneGatewaySubscriptions(ids);
  if (useVoice.getState().workspaceId === id) void import('./voice').then(({ voice }) => voice.leave(false));
  useRooms.getState().removeWorkspace(id);
  useRooms.setState((s) => ({
    readState: withoutKeys(s.readState, ids),
    lastMessage: withoutKeys(s.lastMessage, ids),
    unread: withoutKeys(s.unread, ids),
    mentions: withoutKeys(s.mentions, ids),
    countedUpTo: withoutKeys(s.countedUpTo, ids),
    liveCounted: withoutKeys(s.liveCounted, ids),
    notify: withoutKeys(s.notify, ids),
  }));
  const removedUsers = new Set(Object.keys(useWorkspaces.getState().byId[id]?.members ?? {}));
  const keepUsers = new Set([useSession.getState().me?.user?.id ?? '', ...Object.values(useDms.getState().byRoom).map((d) => d.peerId)]);
  for (const [wsId, entry] of Object.entries(useWorkspaces.getState().byId))
    if (wsId !== id) for (const userId of Object.keys(entry.members)) keepUsers.add(userId);
  for (const userId of keepUsers) removedUsers.delete(userId);
  useWorkspaces.getState().remove(id);
  useWorkspaces.setState((s) => ({ users: withoutKeys(s.users, removedUsers), presences: withoutKeys(s.presences, removedUsers) }));
  const ui = useUi.getState();
  if (ui.activeWorkspaceId === id) {
    ui.openDialog(null);
    ui.closeCalendar();
  }
}
export function installIdentityDenials(): void {
  const expire = (): void => {
    if (document.visibilityState === 'hidden') return;
    for (const access of Object.values(useIdentity.getState().access))
      if (access.reason === IdentityAccessReason.ALLOWED && accessLocked(access))
        applyIdentityAccess({ ...access, reason: IdentityAccessReason.SSO_REQUIRED });
  };
  window.addEventListener('focus', expire);
  document.addEventListener('visibilitychange', expire);
  onIdentityDenied((error, path) => {
    const id = identityPathWorkspace(path);
    if (!id) return;
    const reason =
      error.code === 'ERROR_CODE_DIRECTORY_ACCESS_DENIED'
        ? IdentityAccessReason.DIRECTORY_DENIED
        : error.code === 'ERROR_CODE_RECOVERY_ONLY'
          ? IdentityAccessReason.RECOVERY_ONLY
          : IdentityAccessReason.SSO_REQUIRED;
    applyIdentityAccess({ ...create(WorkspaceIdentityAccessSchema), ...useIdentity.getState().access[id], workspaceId: id, reason });
  });
}
export { identityRoomLocked };
