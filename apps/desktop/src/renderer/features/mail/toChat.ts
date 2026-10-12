import { MAIL_RAW_MAX, type MailMessage } from '../../../shared/mail';
import { plural, t } from '../../i18n';
import { log } from '../../lib/log';
import { can, roomPerms } from '../../lib/permissions';
import { sendMessage, type OutgoingFile } from '../../services/chat';
import { ensureDm } from '../../services/dms';
import { HOME } from '../../stores/dms';
import { mailApi, useMail } from '../../stores/mail';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useToasts } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { rolesOf, useWorkspaces } from '../../stores/workspaces';
import type { ForwardItem } from '../chat/forwardModel';
import { chatText, emlName } from './chatText';

/**
 * «Отправить в чат…» (owner 12.10): one chat message per picked chat — a short card (subject,
 * sender, date, the start of the text) and the raw message as `<Тема>.eml`, so the recipient can
 * open the original in their mail app. Through the chat's own send path (optimistic, uploads with
 * progress); the server checks the rights, the client only leaves the file out where attaching is
 * not allowed (with a note in the text).
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
  let file: OutgoingFile | null = null;
  let tooBig = msg.size > MAIL_RAW_MAX;
  if (!tooBig) {
    try {
      const raw = await api.messages.raw(messageId);
      file = { file: new Blob([raw as BlobPart], { type: 'message/rfc822' }), name: emlName(msg.subject) };
    } catch (e) {
      log.warn('mail to chat: raw source', e);
      tooBig = true;
    }
  }
  if (tooBig) useToasts.getState().push('info', t('mbox.chat.tooBig'));
  let last: { ws: string; room: string; name: string } | null = null;
  let failed = 0;
  for (const target of targets) {
    try {
      const roomId = target.kind === 'room' ? target.roomId : await ensureDm(target.userId);
      const ws = useRooms.getState().byId[roomId]?.workspaceId ?? '';
      const attach = !!file && canAttach(roomId);
      const content = file && !attach ? `${text}\n\n${t('mbox.chat.noAttach')}` : text;
      await sendMessage(ws, roomId, content, attach && file ? [file] : [], undefined);
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
