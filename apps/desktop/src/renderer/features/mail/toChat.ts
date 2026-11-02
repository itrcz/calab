import type { MailMessage } from '../../../shared/mail';
import { plural, t } from '../../i18n';
import { log } from '../../lib/log';
import { can, roomPerms } from '../../lib/permissions';
import { MAX_ATTACHMENTS, MAX_CONTENT, sendMessage, type OutgoingFile } from '../../services/chat';
import { ensureDm } from '../../services/dms';
import { HOME } from '../../stores/dms';
import { mailApi, useMail } from '../../stores/mail';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useToasts } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { rolesOf, useWorkspaces } from '../../stores/workspaces';
import type { ForwardItem } from '../chat/forwardModel';
import { chatAttachments, chatText, planAttachments } from './chatText';

/**
 * The chat's file upload limit per file (server `MAX_FILE_SIZE_MB`, default 1024; a workspace may
 * override it, ADR-0155 — the server's 413 stays the authority).
 */
const UPLOAD_MAX = 1024 * 1024 * 1024;

/**
 * «Отправить в чат…» (owner 12.10, fixed 14.10): one chat message per picked chat — a short header
 * (subject, sender, date) and the plain text of the mail, plus the mail's real attachments (no
 * `cid:` furniture, never an .eml). Through the chat's own send path (optimistic, uploads with
 * progress); the server checks the rights, the client only leaves the files out where attaching is
 * not allowed (with a note in the text). Files that do not fit the limits are listed in a toast.
 */

async function messageOf(id: string): Promise<MailMessage> {
  const have = useMail.getState().bodies[id];
  if (have) return have;
  const api = mailApi();
  if (!api) throw new Error('no mail api');
  return api.messages.get(id);
}

/** May I attach files in this room? DMs: yes; a workspace room: ATTACH_FILES (the server checks again). */
function canAttach(roomId: string): boolean {
  const room = useRooms.getState().byId[roomId];
  if (!room?.workspaceId) return true;
  const me = useSession.getState().me?.user?.id ?? '';
  return can(roomPerms(rolesOf(useWorkspaces.getState().byId[room.workspaceId], me), me, room), 'ATTACH_FILES');
}

/** Sends the message to the picked chats; reports with one toast. */
export async function sendMailToChats(messageId: string, targets: readonly ForwardItem[]): Promise<void> {
  const api = mailApi();
  if (!api || !targets.length) return;
  let msg: MailMessage;
  try {
    msg = await messageOf(messageId);
  } catch (e) {
    log.warn('mail to chat: message', e);
    useToasts.getState().push('error', t('mbox.err.notFound'));
    return;
  }
  const text = chatText(msg);
  const { take, skipped } = planAttachments(chatAttachments(msg), MAX_ATTACHMENTS, UPLOAD_MAX);
  const files: OutgoingFile[] = [];
  const lost = skipped.map((a) => a.name);
  for (const a of take) {
    try {
      const bytes = await api.messages.attachment(msg.id, a.id);
      files.push({ file: new Blob([bytes as BlobPart], { type: a.mime || 'application/octet-stream' }), name: a.name });
    } catch (e) {
      log.warn('mail to chat: attachment', e);
      lost.push(a.name);
    }
  }
  if (lost.length) useToasts.getState().push('info', t('mbox.chat.skipped', { names: lost.join(', ') }));
  let last: { ws: string; room: string; name: string } | null = null;
  let failed = 0;
  for (const target of targets) {
    try {
      const roomId = target.kind === 'room' ? target.roomId : await ensureDm(target.userId);
      const ws = useRooms.getState().byId[roomId]?.workspaceId ?? '';
      const attach = files.length > 0 && canAttach(roomId);
      const content = files.length && !attach ? `${text}\n\n${t('mbox.chat.noAttach')}`.slice(0, MAX_CONTENT) : text;
      await sendMessage(ws, roomId, content, attach ? files : [], undefined);
      last = { ws, room: roomId, name: target.name };
    } catch (e) {
      log.warn('mail to chat: send', e);
      failed++;
    }
  }
  if (last) {
    const to = last;
    const label = targets.length - failed > 1 ? plural('mbox.chat.sentMany', targets.length - failed) : t('mbox.chat.sent', { name: to.name });
    useToasts.getState().push('success', label, { label: t('mbox.chat.open'), run: () => useUi.getState().openRoom(to.ws || HOME, to.room) });
  }
  if (failed) useToasts.getState().push('error', t('mbox.chat.failed'));
}
