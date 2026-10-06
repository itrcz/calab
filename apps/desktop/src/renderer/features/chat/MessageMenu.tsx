import { RoomType, type FileMeta, type PermissionBits } from '@calaba/protocol';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Copy, CornerUpLeft, Download, Forward, Link2, ListPlus, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { can, mayPin } from '../../lib/permissions';
import { firstLink, parseMarkdown } from '../../lib/markdown/parse';
import { deleteMessage, setEmbedsHidden, setPinned, toggleReaction } from '../../services/chat';
import { openForward } from '../../services/forward';
import { platform } from '../../platform';
import { useRooms } from '../../stores/rooms';
import { useBoards, workspaceBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';
import { boardForMessage } from '../boards/CreateTaskDialog';
import { CREATE_TASKS, hasBit } from '../boards/model';
import type { ChatMessage } from '../../stores/messages';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useChatView } from './chatView';
import { QUICK_REACTIONS } from './emoji';
import { canToggleReaction } from './reactionLimit';

/** macOS menu look (opaque popover, 28 px rows, accent highlight). */
export const menuBox = 'mat-popover anim-in z-[var(--z-popover)] min-w-56 rounded-[var(--radius-card)] p-1';
export const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-[5px] px-2 text-body text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-strong data-[highlighted]:text-accent-fg';

/** Text selected inside this message, if any (copy copies the selection first, like Telegram). */
function selectionWithin(key: string): string {
  const sel = window.getSelection();
  const text = sel?.toString() ?? '';
  if (!text || !sel?.anchorNode) return '';
  const el = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement;
  return el?.closest(`[data-message-id="${CSS.escape(key)}"]`) ? text : '';
}

/**
 * The menu never grows over the composer: its bottom boundary is the composer's top edge (plus a
 * gap), so near the bottom it opens upward from the pointer (Radix shifts it inside the boundary).
 */
function menuPadding(): { top: number; right: number; bottom: number; left: number } {
  const composer = document.querySelector('[data-testid="composer"]');
  const top = composer ? composer.getBoundingClientRect().top : window.innerHeight;
  return { top: 8, right: 8, left: 8, bottom: Math.max(8, window.innerHeight - top + 8) };
}

/** «Скачать картинку»: the original, the way every attachment is saved (desktop: ~/Downloads; web: <a download>). */
function downloadImage(f: FileMeta): void {
  void platform.files.download({ fileId: f.id, name: f.name }).then(
    () => toast.success(t('chat.downloaded', { name: f.name })),
    (e: unknown) => toast.fail(e, t('err.ctx.download')),
  );
}

/** Right click / long press on a bubble (docs/09 #38); also «Ещё…» of the hover bar (MessageActions.tsx). */
export function MessageMenu({ c, own, roomId, perms, image }: { c: ChatMessage; own: boolean; roomId: string; perms: PermissionBits; image?: FileMeta }): ReactNode {
  const m = c.msg;
  const canSend = can(perms, 'SEND_MESSAGES');
  const canManage = can(perms, 'MANAGE_MESSAGES');
  // Pinning: MANAGE_MESSAGES, or either participant of a DM (docs/04).
  const canPin = mayPin(perms, useRooms.getState().byId[roomId]);
  const canDelete = own || canManage;
  const pinned = !!m.pinnedAt;
  // A hidden link preview can be brought back by whoever may hide it (the menu renders only open).
  const canShowEmbed = m.embedsHidden && (own || canManage) && !!firstLink(parseMarkdown(m.content));

  const copy = (): void => {
    const text = selectionWithin(c.key) || m.content;
    void navigator.clipboard.writeText(text).then(() => toast.success(t('chat.copied')));
  };
  const remove = async (): Promise<void> => {
    if (await confirmAction(t('chat.deleteTitle'), t('chat.deleteText'), t('common.delete'))) await deleteMessage(roomId, m.id);
  };

  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={menuBox} aria-label={t('chat.menu')} collisionPadding={menuPadding()}>
        {canSend ? (
          <>
            {/* Phone card (≤ 360 px): eight 44 px targets edge to edge; the narrowest phones (card < 352 px) drop the last one. */}
            <div className="flex items-center gap-0.5 px-0.5 pb-1 pt-0.5 mobile:-mx-1.5 mobile:justify-between mobile:gap-0 mobile:px-0" role="group" aria-label={t('chat.react')}>
              {QUICK_REACTIONS.map((e, i) => {
                const mine = m.reactions.some((r) => r.emoji === e && r.me);
                // Past the per-user limit (docs/09 #27): dimmed; a pick shows the hint instead.
                const blocked = !canToggleReaction(m.reactions, e);
                return (
                  <ContextMenu.Item
                    key={e}
                    aria-label={e}
                    aria-disabled={blocked || undefined}
                    onSelect={() => {
                      if (!blocked) useChatView.getState().pushRecent(e);
                      void toggleReaction(roomId, m, e);
                    }}
                    className={cx(
                      'grid size-8 cursor-default place-items-center rounded-full text-title outline-none transition-transform mobile:size-11 duration-[var(--motion-fast)] data-[highlighted]:scale-110 data-[highlighted]:bg-hover',
                      mine && 'bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)]',
                      blocked && 'opacity-40',
                      i === QUICK_REACTIONS.length - 1 && 'mobile:max-[383px]:hidden',
                    )}
                  >
                    {e}
                  </ContextMenu.Item>
                );
              })}
            </div>
            <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />
            <ContextMenu.Item className={menuItem} onSelect={() => useUi.getState().setReply(roomId, m.id)}>
              <CornerUpLeft className="size-4" aria-hidden /> {t('chat.reply')}
            </ContextMenu.Item>
          </>
        ) : null}
        {m.content ? (
          <ContextMenu.Item className={menuItem} onSelect={copy}>
            <Copy className="size-4" aria-hidden /> {t('chat.copy')}
          </ContextMenu.Item>
        ) : null}
        {image ? (
          <ContextMenu.Item className={menuItem} onSelect={() => downloadImage(image)} data-testid="message-download-image">
            <Download className="size-4" aria-hidden /> {t('chat.downloadImage')}
          </ContextMenu.Item>
        ) : null}
        <ContextMenu.Item className={menuItem} onSelect={() => openForward(roomId, m.id)} data-testid="message-forward">
          <Forward className="size-4" aria-hidden /> {t('chat.forward')}
        </ContextMenu.Item>
        {m.content && c.status === 'sent' ? <CreateTaskItem roomId={roomId} messageId={m.id} text={m.content} /> : null}
        {canPin ? (
          <ContextMenu.Item className={menuItem} onSelect={() => void setPinned(m, !pinned)}>
            {pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}
            {pinned ? t('chat.unpin') : t('chat.pin')}
          </ContextMenu.Item>
        ) : null}
        {canShowEmbed ? (
          <ContextMenu.Item className={menuItem} onSelect={() => void setEmbedsHidden(m, false)}>
            <Link2 className="size-4" aria-hidden /> {t('chat.embedShow')}
          </ContextMenu.Item>
        ) : null}
        {own && !m.sticker && !m.forward ? (
          <ContextMenu.Item className={menuItem} onSelect={() => useUi.getState().setEditing(c.key)}>
            <Pencil className="size-4" aria-hidden /> {t('chat.edit')}
          </ContextMenu.Item>
        ) : null}
        {canDelete ? (
          <>
            <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />
            <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
              <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
            </ContextMenu.Item>
          </>
        ) : null}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

/**
 * «Создать задачу» (ADR-0042 §5): a workspace room's message → the create dialog with its first
 * line as the title and `from_message_id` (the server adds the quote and the link). Shown when
 * the viewer may create tasks on some board of the room's workspace.
 */
function CreateTaskItem({ roomId, messageId, text }: { roomId: string; messageId: string; text: string }): ReactNode {
  const wsId = useRooms((s) => {
    const r = s.byId[roomId];
    return r && r.type !== RoomType.TASK ? r.workspaceId : '';
  });
  const can = useBoards((s) => (wsId ? workspaceBoards(s.boards, wsId).some((b) => hasBit(b.permissions, CREATE_TASKS)) : false));
  if (!can) return null;
  return (
    <ContextMenu.Item
      className={menuItem}
      onSelect={() => useBoardsUi.getState().openCreate({ boardId: boardForMessage(wsId), fromMessage: { id: messageId, text } })}
      data-testid="message-create-task"
    >
      <ListPlus className="size-4" aria-hidden /> {t('boards.fromMessage')}
    </ContextMenu.Item>
  );
}
