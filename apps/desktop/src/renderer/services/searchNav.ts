import { timestampMs } from '@bufbuild/protobuf/wkt';
import { RoomType, type SearchFileRef, type SearchHit, type SearchTranscriptRef } from '@calaba/protocol';
import { t } from '../i18n';
import { useChatView } from '../features/chat/chatView';
import { useBoards } from '../stores/boards';
import { HOME } from '../stores/dms';
import { useRooms } from '../stores/rooms';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { loadTask, openTaskAnywhere } from './boards';
import { openInTab, wantsTab, type TabClickEvent } from './taskTab';
import { openEventOccurrence } from './calendar';
import { openCanvasHit } from './canvas';
import { openDiskHit } from './disk';
import { openWikiHit } from './wiki';

/**
 * Ctrl/⌘ on a task or a task comment hit: the task as a background tab, the search stays where it
 * is. True when it did; other hits ignore the key (and the phone has no tabs): `openHit` then.
 */
export function openHitInTab(h: SearchHit, e: TabClickEvent): boolean {
  const r = h.ref;
  if (!wantsTab(e)) return false;
  if (r.case === 'task') openInTab(r.value.taskId, h.workspaceId, r.value.boardId);
  else if (r.case === 'taskComment') void openTaskTab(r.value.taskId);
  else return false;
  return true;
}

/**
 * Where a search hit leads (ADR-0062 §4): a message — its room, scrolled to it; a task comment —
 * the task's panel scrolled to the comment; a task — its panel; an event — its card on the
 * matched occurrence; a file — the image viewer with «Показать в чате» (other files: the message
 * carrying it); a note — the shelf, scrolled to it; a transcript — the recording's transcript at
 * the segment; a wiki page — the wiki on that page; a canvas — the Canvas section on it (a folder: its path expanded in the tree); a Disk item — the Disk at its folder with it
 * selected (services/disk.ts openDiskHit). Nothing here writes a feed store: the target view
 * loads what it needs.
 */
export function openHit(h: SearchHit): void {
  const r = h.ref;
  switch (r.case) {
    case 'message':
    case 'note':
      openMessage(r.value.roomId, r.value.messageId);
      return;
    case 'taskComment':
      void openTaskComment(r.value.taskId, r.value.roomId, r.value.messageId);
      return;
    case 'task':
      openTaskAnywhere({ id: r.value.taskId, workspaceId: h.workspaceId, boardId: r.value.boardId });
      return;
    case 'event':
      void openEventOccurrence(r.value.eventId, r.value.occurrenceStart ? timestampMs(r.value.occurrenceStart) : h.at ? timestampMs(h.at) : Date.now());
      return;
    case 'file':
      openFile(r.value, h.title);
      return;
    case 'transcript':
      openTranscript(r.value, h.at ? timestampMs(h.at) : Date.now());
      return;
    case 'wiki':
      openWikiHit(h.workspaceId, r.value.pageId);
      return;
    case 'canvas':
      void openCanvasHit(h.workspaceId, r.value);
      return;
    case 'disk':
      void openDiskHit(h.workspaceId, r.value);
      return;
  }
}

/** A message of any room: a task room's comment opens its task, a DM / notes shelf opens in «Личные». */
export function openMessage(roomId: string, messageId: string): void {
  const room = useRooms.getState().byId[roomId];
  if (room?.type === RoomType.TASK) {
    const taskId = useBoards.getState().roomTask[roomId];
    if (taskId) {
      void openTaskComment(taskId, roomId, messageId);
      return;
    }
  }
  if (!room) {
    toast.info(t('chat.messageGone'));
    return;
  }
  const dm = room.type === RoomType.DM || room.type === RoomType.NOTES;
  useUi.getState().openRoom(dm ? HOME : room.workspaceId, roomId);
  useChatView.getState().requestJump(roomId, messageId);
}

/** A task's tab by id alone (a comment hit): loads the task when the store has not got it. */
async function openTaskTab(taskId: string): Promise<void> {
  const task = useBoards.getState().tasks[taskId] ?? (await loadTask(taskId));
  if (!task) {
    toast.info(t('boards.err.notFound'));
    return;
  }
  openInTab(task.id, task.workspaceId, task.boardId);
}

async function openTaskComment(taskId: string, roomId: string, messageId: string): Promise<void> {
  const task = useBoards.getState().tasks[taskId] ?? (await loadTask(taskId));
  if (!task) {
    toast.info(t('boards.err.notFound'));
    return;
  }
  openTaskAnywhere(task);
  // The task panel's activity takes the request (features/boards/TaskPanel.tsx).
  useChatView.getState().requestJump(roomId, messageId);
}

function isImage(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(mime);
}

function openFile(f: SearchFileRef, name: string): void {
  if (!isImage(f.mime)) {
    openMessage(f.roomId, f.messageId);
    return;
  }
  useUi.getState().openDialog({
    kind: 'image',
    images: [{ fileId: f.fileId, name, width: 0, height: 0 }],
    index: 0,
    inChat: { roomId: f.roomId, messageId: f.messageId },
  });
}

function openTranscript(tr: SearchTranscriptRef, startedAt: number): void {
  const room = useRooms.getState().byId[tr.roomId];
  if (!room) {
    toast.info(t('chat.messageGone'));
    return;
  }
  const dm = room.type === RoomType.DM || room.type === RoomType.NOTES;
  useUi.getState().openRoom(dm ? HOME : room.workspaceId, room.id);
  useUi.getState().openDialog({ kind: 'transcript', roomId: tr.roomId, recordingId: tr.recordingId, messageId: tr.messageId, offsetMs: Number(tr.offsetMs), startedAt });
}
