import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { NotificationLevel } from '@calaba/protocol';
import { Archive, ArchiveRestore, Ban, Bell, BellOff, Ellipsis, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { IconButton, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { setDmArchived } from '../../services/dms';
import { loadBlockedBots, setBotBlocked } from '../../services/bots';
import { useBots } from '../../stores/bots';
import { useWorkspaces } from '../../stores/workspaces';
import { useDms } from '../../stores/dms';
import { roomNotify, useRooms } from '../../stores/rooms';
import { setRoomNotifications } from '../../services/mentions';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { confirmDeleteDm } from './dmActions';

/**
 * «⋯» in the DM header (docs/09 #51): «В архив» / «Вернуть из архива» and «Удалить чат»; with a
 * bot also «Заблокировать бота» / «Разблокировать» (ADR-0031: it can no longer write to me).
 */
export function DmActionsMenu({ roomId, className, notify = false }: { roomId: string; className?: string | undefined; notify?: boolean }): ReactNode {
  const archived = useDms((s) => (s.byRoom[roomId]?.archivedAt ?? 0) > 0);
  const peerId = useDms((s) => s.byRoom[roomId]?.peerId ?? '');
  const bot = useWorkspaces((s) => !!peerId && (s.users[peerId]?.isBot ?? false));
  const blocked = useBots((s) => (s.blocked ? !!s.blocked[peerId] : null));
  const [open, setOpen] = useState(false);
  // Phone (ADR-0073 §1): the bell's two choices as one item — a DM notifies every message or nothing.
  const quiet = useRooms((s) => {
    const n = roomNotify(s.notify[roomId]);
    return n.level === NotificationLevel.NONE || n.mutedUntil !== null;
  });
  useEffect(() => {
    if (bot) void loadBlockedBots();
  }, [bot]);
  const label = t('dm.actions');
  return (
    <Dropdown.Root modal={false} open={open} onOpenChange={setOpen}>
      <Tip label={label}>
        <Dropdown.Trigger asChild>
          <IconButton tip={false} label={label} active={open} className={className} data-testid="dm-actions">
            <Ellipsis className="size-[18px]" />
          </IconButton>
        </Dropdown.Trigger>
      </Tip>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} collisionPadding={16} className={menuBox} aria-label={label}>
          {notify ? (
            <Dropdown.Item className={menuItem} onSelect={() => void setRoomNotifications(roomId, quiet ? NotificationLevel.INHERIT : NotificationLevel.NONE, null)} data-testid="dm-notify-toggle">
              {quiet ? <Bell className="size-4" aria-hidden /> : <BellOff className="size-4" aria-hidden />}
              {t(quiet ? 'mobile.notifyOn' : 'mobile.notifyOff')}
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item className={menuItem} onSelect={() => void setDmArchived(roomId, !archived)}>
            {archived ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
            {t(archived ? 'dm.unarchive' : 'dm.archive')}
          </Dropdown.Item>
          {bot && blocked !== null ? (
            <Dropdown.Item className={cx(menuItem, !blocked && 'text-danger-text')} onSelect={() => void setBotBlocked(peerId, !blocked)} data-testid="dm-bot-block">
              {blocked ? <ShieldCheck className="size-4" aria-hidden /> : <Ban className="size-4" aria-hidden />}
              {t(blocked ? 'bots.unblock' : 'bots.block')}
            </Dropdown.Item>
          ) : null}
          <Dropdown.Separator className={menuSeparator} />
          <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void confirmDeleteDm(roomId)}>
            <Trash2 className="size-4" aria-hidden /> {t('common.delete')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
