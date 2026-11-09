import * as ContextMenu from '../../components/radix/context-menu';
import { Archive, ArchiveRestore } from 'lucide-react';
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { StatusEmoji } from '../../components/StatusEmoji';
import { CountBadge, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt, useTimeFormat } from '../../lib/format';
import { useMobile } from '../../lib/mobile';
import { openDm, setDmArchived } from '../../services/dms';
import { shareOrigin } from '../../services/links';
import { HOME, useDms, type DmEntry } from '../../stores/dms';
import { isUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import type { DropAction, DropTarget } from '../../lib/messageDrag';
import { useChatDrop } from '../chat/useChatDrop';
import { applyChatDrop } from '../notes/dropActions';
import { usePreviewParts } from '../chat/mentionText';
import { PreviewRuns } from '../chat/PreviewRuns';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { ROW_HOVER, ROW_SELECTED } from '../shell/ColumnHeader';
import { confirmDeleteDm } from './dmActions';
import { BotBadge } from '../people/MemberBits';
import { SWIPE_ACTION_PX, useRowSwipe } from '../../lib/rowSwipe';

/** One DM row of the «Личные» column (and of its search's «Чаты»): avatar, name, last message, time, unread. */
export const DmRow = memo(function DmRow({ entry }: { entry: DmEntry }): ReactNode {
  // Memo row: re-render on a language / clock format switch too (ADR-0022, docs/09 #73).
  useLocale();
  useTimeFormat();
  const { roomId, peerId } = entry;
  const active = useUi((s) => s.activeWorkspaceId === HOME && s.lastRoom[HOME] === roomId);
  // A message dragged onto the DM is forwarded to it (docs/05 «Заметки», ADR-0033).
  const dropTarget = useMemo<DropTarget>(() => ({ kind: 'dm', roomId, files: false, canSend: true }), [roomId]);
  const onDrop = useCallback((a: DropAction, files: File[]) => applyChatDrop(a, files, memberName(null, peerId), false), [peerId]);
  const [over, drop] = useChatDrop(dropTarget, onDrop);
  const name = useMemberName(null, peerId);
  const avatar = useWorkspaces((s) => s.users[peerId]?.avatarFileId ?? '');
  const bot = useWorkspaces((s) => s.users[peerId]?.isBot ?? false);
  const unread = useRooms((s) => isUnread(roomId, s));
  const count = useRooms((s) => s.mentions[roomId] ?? 0);
  const preview = useDms((s) => s.preview[roomId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const parts = usePreviewParts(null, preview?.content ?? '');
  const line = over ? (
    <span className="text-accent-text">{t('notes.forwardTo', { name })}</span>
  ) : preview === undefined ? (
    ''
  ) : preview === null ? (
    t('dm.noMessages')
  ) : (
      <>
        {preview.authorId === me ? `${t('dm.you')}: ` : ''}
        {parts.length ? <PreviewRuns parts={parts} /> : preview.attachments ? t('chat.attachment') : ''}
      </>
    );
  const at = preview?.at ?? entry.activity;
  const time = at ? fmt.listTime(new Date(at)) : '';
  const bright = active || unread;
  const archived = entry.archivedAt > 0;
  // Phone (docs/09 #51): swipe left for «Архив» / «Вернуть из архива».
  const phone = useMobile();
  const swipe = useRowSwipe(phone);
  const shifted = swipe.offset !== 0;
  return (
    <DmMenu roomId={roomId} unread={unread} archived={archived}>
      <li
        className={cx(
          'group/row relative flex items-center transition-colors duration-[var(--motion-fast)]',
          // Desktop (owner, 07.10): 48 px, radius 8, the column's row plates. Phone (owner, 13.10): the
          // room row's 68 px chat-list geometry (ADR-0073 §3), full width, no plate.
          phone ? 'h-[68px]' : 'h-12 rounded-[var(--radius-card)]',
          over
            ? 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] shadow-[inset_0_0_0_1px_var(--color-accent)]'
            : active
              ? ROW_SELECTED
              : phone
                ? 'active:bg-hover'
                : ROW_HOVER,
        )}
        data-testid="dm-row"
        data-over={over || undefined}
        {...swipe.handlers}
        {...drop}
      >
        {shifted ? (
          <button
            type="button"
            onClick={() => {
              swipe.close();
              void setDmArchived(roomId, !archived);
            }}
            className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-0.5 overflow-hidden bg-accent-strong px-1 text-center text-micro font-medium text-accent-fg"
            style={{ width: Math.min(-swipe.offset, SWIPE_ACTION_PX) }}
            data-testid="dm-swipe-action"
          >
            {archived ? <ArchiveRestore className="size-4 shrink-0" aria-hidden /> : <Archive className="size-4 shrink-0" aria-hidden />}
            <span className="line-clamp-2">{t(archived ? 'dm.unarchive' : 'dm.archive')}</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => (shifted ? swipe.close() : openDm(roomId))}
          aria-current={active ? 'page' : undefined}
          aria-label={[name, count > 0 ? plural('shell.unreadMentions', count) : unread ? t('ws.unread') : ''].filter(Boolean).join(', ')}
          style={shifted ? { marginRight: -swipe.offset } : undefined}
          className={cx(
            'flex h-full min-w-0 flex-1 items-center text-left',
            phone ? 'select-none gap-3 px-3' : 'gap-2.5 rounded-[var(--radius-row)] pl-2 pr-2',
            !swipe.dragging && 'transition-[margin] duration-[var(--motion-fast)]',
          )}
        >
          <Avatar userId={peerId} name={name} fileId={avatar || undefined} size={phone ? 44 : 32} presence />
          <span className={cx('flex min-w-0 flex-1 flex-col', phone && 'gap-0.5 border-b border-line py-2.5 [li:last-child_&]:border-b-0')}>
            <span className={cx('flex min-w-0 gap-2', phone ? 'h-5 items-center' : 'items-baseline')}>
              <span
                className={cx(
                  'min-w-0 truncate text-list leading-5',
                  phone ? 'text-fg' : bright ? 'text-fg' : 'text-muted group-hover/row:text-fg',
                  unread && !active && 'font-semibold',
                )}
                title={name}
              >
                {name}
              </span>
              {/* grow + shrink-0: the badge / status keeps its width and the name truncates; with min-w-0
                  flex-1 it collapsed to 0 and the emoji was drawn over the time. */}
              {bot ? (
                <span className="flex shrink-0 grow self-center">
                  <BotBadge />
                </span>
              ) : (
                // The peer's custom status, compact (text in the tooltip); the rest of the line stays free.
                <span className="flex shrink-0 grow self-center">
                  <StatusEmoji userId={peerId} />
                </span>
              )}
              <span className={cx('shrink-0 text-micro', phone ? cx('tabular-nums', unread ? 'text-fg' : 'text-faint') : 'text-faint')}>{time}</span>
            </span>
            <span className={cx('flex min-w-0 items-center gap-2', phone && 'h-5')}>
              <span className={cx('min-w-0 flex-1 truncate text-caption', phone ? 'leading-5' : 'leading-4', unread && !active ? 'text-fg' : 'text-muted')}>{line}</span>
              {count > 0 ? <CountBadge count={count} aria-hidden /> : null}
            </span>
          </span>
        </button>
      </li>
    </DmMenu>
  );
});

function DmMenu({ roomId, unread, archived, children }: { roomId: string; unread: boolean; archived: boolean; children: ReactNode }): ReactNode {
  const last = useRooms((s) => s.lastMessage[roomId]);
  const serverUrl = useSession((s) => s.serverUrl);
  const origin = shareOrigin(serverUrl);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuBox}>
          <ContextMenu.Item
            className={menuItem}
            disabled={!last || !unread}
            onSelect={() => {
              if (!last) return;
              useRooms.getState().setRead(roomId, last);
              void api.messages.markRead(roomId, last).catch(() => undefined);
            }}
          >
            {t('dm.markRead')}
          </ContextMenu.Item>
          {origin ? (
            <ContextMenu.Item
              className={menuItem}
              onSelect={() => void navigator.clipboard.writeText(`${origin}/dm/${roomId}`).then(() => toast.success(t('dm.linkCopied')))}
            >
              {t('dm.copyLink')}
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Separator className={menuSeparator} />
          <ContextMenu.Item className={menuItem} onSelect={() => void setDmArchived(roomId, !archived)}>
            {t(archived ? 'dm.unarchive' : 'dm.archive')}
          </ContextMenu.Item>
          <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void confirmDeleteDm(roomId)}>
            {t('common.delete')}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
