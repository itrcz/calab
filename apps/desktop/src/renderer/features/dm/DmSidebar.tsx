import * as ContextMenu from '@radix-ui/react-context-menu';
import { Archive, ArchiveRestore, ChevronDown, MessageCirclePlus, Search } from 'lucide-react';
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { CreateButton } from '../../components/CreateButton';
import { StatusEmoji } from '../../components/StatusEmoji';
import { Button, CountBadge, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt, useTimeFormat } from '../../lib/format';
import { useMobile } from '../../lib/mobile';
import { openDm, setDmArchived } from '../../services/dms';
import { shareOrigin } from '../../services/links';
import { HOME, splitDms, useDms, type DmEntry } from '../../stores/dms';
import { isUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import type { DropAction, DropTarget } from '../../lib/messageDrag';
import { useChatDrop } from '../chat/useChatDrop';
import { NotesSection } from '../notes/NotesSection';
import { applyChatDrop } from '../notes/dropActions';
import { usePreviewParts } from '../chat/mentionText';
import { PreviewRuns } from '../chat/PreviewRuns';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { ColumnHeader, ColumnTitle, GROUP_LABEL, GroupChevron, ROW_HOVER, ROW_SELECTED } from '../shell/ColumnHeader';
import { confirmDeleteDm } from './dmActions';
import { BotBadge } from '../people/MemberBits';
import { SWIPE_ACTION_PX, useRowSwipe } from './rowSwipe';

/**
 * «Личные» column (ADR-0020, Discord Home): «Найти или начать беседу» on top, then the DMs by
 * last activity — avatar with presence, name, the last message and its time, the unread count —
 * and at the bottom the collapsed «Архив — N» (docs/09 #51). Same material, width and island
 * padding as the room column (docs/08, Layout).
 */
export function DmSidebar(): ReactNode {
  const byRoom = useDms((s) => s.byRoom);
  const preview = useDms((s) => s.preview);
  const current = useUi((s) => (s.activeWorkspaceId === HOME ? (s.lastRoom[HOME] ?? '') : ''));
  const { main: list, archived } = useMemo(() => splitDms(byRoom, preview, current), [byRoom, preview, current]);
  const open = useUi((s) => s.openDialog);
  const guest = useSession((s) => s.me?.user?.isGuest ?? false);
  const mobile = useMobile();

  return (
    <aside className={cx('island-fade flex w-[var(--sidebar-width)] shrink-0 flex-col', mobile ? 'mat-content' : 'mat-sidebar mat-sidebar-window')} aria-label={t('dm.list')}>
      {mobile ? (
        // Phone: the tab root has its title and «+» (MobileShell); this is the search field.
        <div className="flex h-16 shrink-0 items-center border-b border-line px-2.5">
          <button
            type="button"
            onClick={() => open({ kind: 'new-dm' })}
            className="flex tap-h w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-hover px-2.5 text-left text-body text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg"
          >
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t('dm.find')}</span>
          </button>
        </div>
      ) : (
        // Desktop (ADR-0074 §3; owner 07.10): the column header pattern — «Личные» large, search, «+».
        <ColumnHeader title={<ColumnTitle>{t('mobile.tabDms')}</ColumnTitle>}>
          <CreateButton label={t('dm.new')} data-testid="section-create-dm" onClick={() => open({ kind: 'new-dm' })} />
        </ColumnHeader>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pt-1 mobile:pt-2" style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}>
        {/* «Заметки» (ADR-0039): my shelves above the DMs; guest accounts have none. */}
        {guest ? null : <NotesSection />}
        <div className="group/cat flex h-9 items-center pr-1 pt-2 mobile:h-11 mobile:pr-0 mobile:pt-0">
          <h2 className={cx('min-w-0 flex-1 truncate pl-2', GROUP_LABEL)}>{t('dm.list')}</h2>
        </div>
        {list.length === 0 && archived.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 py-8 text-center text-body text-muted" data-testid="dm-empty">
            <p>{t('dm.empty')}</p>
            <p className="text-caption">{t('dm.emptyHint')}</p>
            <Button size="sm" onClick={() => open({ kind: 'new-dm' })}>
              <MessageCirclePlus className="size-3.5" aria-hidden /> {t('dm.new')}
            </Button>
          </div>
        ) : (
          <ul className="mt-0.5 flex flex-col gap-px" data-testid="dm-list">
            {list.map((e) => (
              <DmRow key={e.roomId} entry={e} />
            ))}
          </ul>
        )}
        {archived.length > 0 ? <ArchiveSection list={archived} /> : null}
      </div>
    </aside>
  );
}

/** «Архив — N» (docs/09 #51): collapsed by default; a DM returns by its menu or a new message. */
function ArchiveSection({ list }: { list: DmEntry[] }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const mobile = useMobile();
  const label = t('dm.archiveSection', { n: list.length });
  return (
    <section className="mt-2" aria-label={label} data-testid="dm-archive">
      <div className="group/cat flex h-9 items-center pr-1 pt-2 mobile:h-11 mobile:pt-0">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className={cx(
            'flex h-7 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-row)] pl-2 text-left transition-colors duration-[var(--motion-fast)] hover:text-fg mobile:h-11 mobile:pl-1.5',
            GROUP_LABEL,
          )}
        >
          {mobile ? (
            <ChevronDown className={cx('size-3 shrink-0 transition-transform duration-[var(--motion-fast)]', !expanded && '-rotate-90')} strokeWidth={2.25} aria-hidden />
          ) : null}
          <span className="truncate">{label}</span>
          {mobile ? null : <GroupChevron collapsed={!expanded} />}
        </button>
      </div>
      {expanded ? (
        <ul className="mt-0.5 flex flex-col gap-px" data-testid="dm-archive-list">
          {list.map((e) => (
            <DmRow key={e.roomId} entry={e} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const DmRow = memo(function DmRow({ entry }: { entry: DmEntry }): ReactNode {
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
          // Desktop (owner, 07.10): 48 px, radius 8, the column's row plates; the phone keeps its row.
          phone ? 'h-[46px] rounded-[var(--radius-row)]' : 'h-12 rounded-[var(--radius-card)]',
          over
            ? 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] shadow-[inset_0_0_0_1px_var(--color-accent)]'
            : active
              ? ROW_SELECTED
              : phone
                ? 'hover:bg-hover'
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
            className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-0.5 overflow-hidden rounded-r-[var(--radius-row)] bg-accent-strong px-1 text-center text-micro font-medium text-accent-fg"
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
            'flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-row)] pl-2 pr-2 text-left',
            !swipe.dragging && 'transition-[margin] duration-[var(--motion-fast)]',
          )}
        >
          <Avatar userId={peerId} name={name} fileId={avatar || undefined} size={32} presence />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cx('min-w-0 truncate text-list leading-5', bright ? 'text-fg' : 'text-muted group-hover/row:text-fg', unread && !active && 'font-semibold')} title={name}>
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
              <span className="shrink-0 text-micro text-faint">{time}</span>
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className={cx('min-w-0 flex-1 truncate text-caption leading-4', unread && !active ? 'text-fg' : 'text-muted')}>{line}</span>
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
