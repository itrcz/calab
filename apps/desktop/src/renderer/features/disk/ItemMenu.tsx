import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Download, Ellipsis, FolderInput, FolderOpen, History, Link2, Pencil, RotateCcw, Trash2, Users } from 'lucide-react';
import { useState, type ComponentType, type ReactNode } from 'react';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { canShare, canWrite, isFolder } from '../../lib/disk';
import { copyItemLink, deleteForever, downloadItem, openItem, restoreItems, trashItems } from '../../services/disk';
import { useDisk } from '../../stores/disk';
import { useDiskUi } from '../../stores/diskUi';
import { myUserId } from '../../stores/session';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';

/**
 * The item's menu (ADR-0094 §8): the same entries on a right click (ContextMenu) and on the «⋯»
 * of a tile / row (Dropdown). Open, Download, Rename (in place), Move…, Access…, Link…, History,
 * To the trash; in the trash — Restore and Delete forever. Entries follow the item's bits
 * (DiskItem.my_bits; the server decides): no WRITE — no rename / move / trash; access and the
 * link — the owner or DISK_MANAGE. The menu body mounts only while open.
 */
interface Parts {
  Item: ComponentType<{ className?: string; onSelect?: (e: Event) => void; disabled?: boolean; children?: ReactNode; 'data-testid'?: string }>;
  Separator: ComponentType<{ className?: string }>;
  Label: ComponentType<{ className?: string; children?: ReactNode }>;
}
const CTX: Parts = { Item: ContextMenu.Item, Separator: ContextMenu.Separator, Label: ContextMenu.Label };
const DROP: Parts = { Item: Dropdown.Item, Separator: Dropdown.Separator, Label: Dropdown.Label };

function Entries({ id, parts }: { id: string; parts: Parts }): ReactNode {
  const item = useDisk((s) => s.items[id]);
  if (!item) return null;
  const { Item, Separator, Label } = parts;
  const ui = useDiskUi.getState();
  const write = canWrite(item.myBits);
  const share = canShare(item, myUserId());
  const folder = isFolder(item);
  const row = (icon: ReactNode, label: string, run: () => void, opts: { danger?: boolean; testId?: string } = {}): ReactNode => (
    <Item className={cx(menuItem, opts.danger && 'text-danger-text')} onSelect={run} data-testid={opts.testId}>
      {icon}
      {label}
    </Item>
  );
  const ic = (I: typeof Download): ReactNode => <I className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />;
  // The phone's card names its item (the card covers the row): one line, ellipsis.
  const title = (
    <>
      <Label className={cx(menuLabel, 'hidden truncate mobile:block')} data-testid="disk-item-menu-title">{item.name}</Label>
      <Separator className={cx(menuSeparator, 'hidden mobile:block')} />
    </>
  );
  if (item.trashedAt) {
    return (
      <>
        {title}
        {write ? row(ic(RotateCcw), t('disk.restore'), () => void restoreItems([id]), { testId: 'disk-menu-restore' }) : null}
        {write ? <Separator className={menuSeparator} /> : null}
        {write ? row(ic(Trash2), t('disk.deleteForever'), () => void deleteForever(id), { danger: true, testId: 'disk-menu-delete' }) : null}
        {!write ? row(ic(History), t('disk.history'), () => ui.openDialog({ kind: 'history', itemId: id })) : null}
      </>
    );
  }
  return (
    <>
      {title}
      {row(ic(FolderOpen), t('disk.open'), () => openItem(item), { testId: 'disk-menu-open' })}
      {!folder ? row(ic(Download), t('disk.download'), () => downloadItem(item), { testId: 'disk-menu-download' }) : null}
      {write ? row(ic(Pencil), t('disk.rename'), () => ui.setRenaming(id), { testId: 'disk-menu-rename' }) : null}
      {write ? row(ic(FolderInput), t('disk.moveTo'), () => ui.openDialog({ kind: 'move', itemIds: [id] }), { testId: 'disk-menu-move' }) : null}
      <Separator className={menuSeparator} />
      {share ? row(ic(Users), t('disk.access'), () => ui.openDialog({ kind: 'access', itemId: id }), { testId: 'disk-menu-access' }) : null}
      {!folder && share ? row(ic(Link2), t('disk.link'), () => ui.openDialog({ kind: 'link', itemId: id }), { testId: 'disk-menu-link' }) : null}
      {!folder && !share && item.link ? row(ic(Link2), t('disk.link.copy'), () => void copyItemLink(id)) : null}
      {row(ic(History), t('disk.history'), () => ui.openDialog({ kind: 'history', itemId: id }), { testId: 'disk-menu-history' })}
      {write ? <Separator className={menuSeparator} /> : null}
      {write ? row(ic(Trash2), t('disk.toTrash'), () => void trashItems([id]), { danger: true, testId: 'disk-menu-trash' }) : null}
    </>
  );
}

/** Right click on a tile / row: selects it and opens its menu. */
export function ItemContextMenu({ id, children }: { id: string; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu.Root
      modal={false}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) useDiskUi.getState().select(id);
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        {open ? (
          <ContextMenu.Content className={menuBox} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="disk-item-menu">
            <Entries id={id} parts={CTX} />
          </ContextMenu.Content>
        ) : null}
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The «⋯» of a tile / row (shown on hover, while selected and while open). */
export function ItemMenuButton({ id, name, className }: { id: string; name: string; className?: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown.Root modal={false} open={open} onOpenChange={setOpen}>
      <Dropdown.Trigger asChild>
        <IconButton
          size="sm"
          label={t('disk.more', { name })}
          tip={false}
          className={cx(className, open && 'opacity-100')}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          data-testid="disk-item-more"
        >
          <Ellipsis className="size-4" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        {open ? (
          <Dropdown.Content className={menuBox} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="disk-item-menu">
            <Entries id={id} parts={DROP} />
          </Dropdown.Content>
        ) : null}
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
