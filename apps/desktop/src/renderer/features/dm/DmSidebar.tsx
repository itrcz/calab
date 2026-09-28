import * as ContextMenu from '@radix-ui/react-context-menu';
import { Archive, ArchiveRestore, ChevronDown, MessageCirclePlus, Search, Plus } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, Tip, cx } from '../../components/ui';
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
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { usePreviewParts } from '../chat/mentionText';
import { PreviewRuns } from '../chat/PreviewRuns';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
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

  return (
    <aside className="mat-sidebar flex w-[var(--sidebar-width)] shrink-0 flex-col" aria-label={t('dm.list')}>
      <div className="flex h-12 shrink-0 items-center border-b border-line px-2.5">
        <button
          type="button"
          onClick={() => open({ kind: 'new-dm' })}
          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-hover px-2.5 text-left text-body text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg"
        >
          <Search className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('dm.find')}</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pt-2" style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}>
        <div className="group/cat flex h-7 items-center pr-1 pt-1">
          <h2 className="min-w-0 flex-1 truncate pl-2 text-micro font-semibold uppercase tracking-[0.04em] text-muted">{t('dm.list')}</h2>
          <Tip label={t('dm.new')}>
            <button
              type="button"
              onClick={() => open({ kind: 'new-dm' })}
              aria-label={t('dm.new')}
              className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg"
            >
              <Plus className="size-4" aria-hidden />
            </button>
          </Tip>
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
  const label = t('dm.archiveSection', { n: list.length });
  return (
    <section className="mt-2" aria-label={label} data-testid="dm-archive">
      <div className="flex h-7 items-center pr-1 pt-1">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex h-6 min-w-0 flex-1 items-center gap-0.5 rounded-[4px] pl-0.5 text-left text-micro font-semibold uppercase tracking-[0.04em] text-muted transition-colors duration-[var(--motion-fast)] hover:text-fg"
        >
          <ChevronDown className={cx('size-3 shrink-0 transition-transform duration-[var(--motion-fast)]', !expanded && '-rotate-90')} strokeWidth={2.25} aria-hidden />
          <span className="truncate">{label}</span>
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
  const name = useMemberName(null, peerId);
  const avatar = useWorkspaces((s) => s.users[peerId]?.avatarFileId ?? '');
  const bot = useWorkspaces((s) => s.users[peerId]?.isBot ?? false);
  const unread = useRooms((s) => isUnread(roomId, s));
  const count = useRooms((s) => s.mentions[roomId] ?? 0);
  const preview = useDms((s) => s.preview[roomId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const parts = usePreviewParts(null, preview?.content ?? '');
  const line =
    preview === undefined ? '' : preview === null ? t('dm.noMessages') : (
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
  const swipe = useRowSwipe(useMobile());
  const shifted = swipe.offset !== 0;
  return (
    <DmMenu roomId={roomId} unread={unread} archived={archived}>
      <li
        className={cx('group/row relative flex h-[46px] items-center rounded-[var(--radius-row)] transition-colors duration-[var(--motion-fast)]', active ? 'bg-active' : 'hover:bg-hover')}
        {...swipe.handlers}
      >
        {unread && !active ? <span aria-hidden className="absolute -left-1.5 top-1/2 h-2 w-1 -translate-y-1/2 rounded-full bg-fg" /> : null}
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
              <span className={cx('min-w-0 truncate text-list leading-5', !bot && 'flex-1', bright ? 'text-fg' : 'text-muted group-hover/row:text-fg', unread && !active && 'font-semibold')} title={name}>
                {name}
              </span>
              {bot ? (
                <span className="flex min-w-0 flex-1 self-center">
                  <BotBadge />
                </span>
              ) : null}
              <span className="shrink-0 text-micro text-faint">{time}</span>
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className={cx('min-w-0 flex-1 truncate text-caption leading-4', unread && !active ? 'text-fg' : 'text-muted')}>{line}</span>
              {count > 0 ? (
                <span className="shrink-0 rounded-full bg-danger-fill px-1.5 text-micro font-bold leading-4 text-white" aria-hidden>
                  {count > 99 ? '99+' : count}
                </span>
              ) : null}
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
            {t('dm.delete')}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
