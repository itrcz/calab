import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { DISK_BITS, diskPermissions, WorkspaceRole, type DiskItem } from '@calaba/protocol';
import { Check, Ellipsis, Gauge, History, Search, Trash2, Users } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bar, BAR_GROUP } from '../../components/Bar';
import { DiskIdleIcon } from '../../assets/nav/icons';
import { MediaImg } from '../../components/MediaImg';
import { CreateSlot, HeaderIcon, PhoneHeader, PhoneSearchButton } from '../../components/PhoneHeader';
import { Button, IconButton, Input, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { canShare, canWrite, DISK_SORTS, folderKey, isFolder, trashKey, visibleIds, type DiskSort, type DiskView } from '../../lib/disk';
import { fmt } from '../../lib/format';
import { collator, emptyTrash, loadListing, loadPath, openItem, openPhoneDisk } from '../../services/disk';
import { useDisk, useDiskUploads } from '../../stores/disk';
import { useDiskUi } from '../../stores/diskUi';
import { usePrefs } from '../../stores/prefs';
import { myUserId } from '../../stores/session';
import { useMemberName, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
import { DiskDialogs } from './Dialogs';
import { CreateMenu } from './DiskBar';
import { Center, RenameField, trashOrder } from './DiskItems';
import { UploadRow } from './DiskScreen';
import { ItemContextMenu, ItemMenuButton } from './ItemMenu';
import { ItemBadges, ItemGlyph, ItemPicture } from './visuals';

/**
 * «Диск» on the phone (ADR-0094 §8, docs/08 «Диск»): the tab root lists the workspace root, a
 * folder and the trash are pushed screens (`{kind:'disk'}`, lib/phoneNav.ts) with the standard
 * headers. Rows 56 px (or two-column tiles), a tap opens, the «⋯» 44 px target and a long press
 * open the item's card (ItemMenu: the same entries as the desktop; Radix menus are centred cards
 * on the phone, lib/phoneMenus.ts). The dialogs are the desktop's. Only the top screen is
 * mounted; rows / tiles are `memo` and read their item by id. No timers.
 */
export function PhoneDisk({ workspaceId, folderId, trash, root }: { workspaceId: string; folderId: string; trash: boolean; root: boolean }): ReactNode {
  const roles = useMemberRoles(workspaceId, myUserId());
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  const wsBits = diskPermissions(roles, { guest });
  const folderBits = useDisk((s) => (folderId ? (s.items[folderId]?.myBits ?? 0n) : wsBits));
  const write = canWrite(folderBits);
  const manage = (wsBits & DISK_BITS.MANAGE) !== 0n;
  const name = useDisk((s) => (folderId ? (s.items[folderId]?.name ?? s.paths[folderId]?.at(-1)?.name ?? '') : ''));
  const shareFolder = useDisk((s) => {
    const it = folderId ? s.items[folderId] : undefined;
    return !!it && canShare(it, myUserId());
  });
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void loadListing(workspaceId, folderId, trash);
    if (!trash) void loadPath(folderId);
  }, [workspaceId, folderId, trash]);
  // The search belongs to the screen: a fresh one on every push / pop.
  useEffect(() => {
    useDiskUi.getState().setQuery('');
    useDiskUi.getState().select(null);
    return () => useDiskUi.getState().setQuery('');
  }, [folderId, trash]);

  const title = trash ? t('disk.trash') : root ? t('mobile.tabDisk') : name;
  const toggleSearch = (): void => setSearching((v) => !v);
  // Standard order «⋯ · поиск · +» (docs/08): the magnifier and the «+» slot are at the same x as on every root.
  const actions = (
    <>
      <MoreMenu workspaceId={workspaceId} folderId={folderId} trash={trash} write={write} manage={manage} shareFolder={shareFolder} />
      {root ? (
        <PhoneSearchButton onClick={toggleSearch} active={searching} label={t('disk.search')} />
      ) : (
        <IconButton tip={false} bar label={t('disk.search')} active={searching} onClick={toggleSearch} data-testid="phone-disk-search">
          <Search className="size-5" aria-hidden />
        </IconButton>
      )}
      {/* No «+» in the trash / a read-only folder: its slot stays, so the magnifier keeps its place (docs/08). */}
      {!trash && write ? <CreateMenu workspaceId={workspaceId} folderId={folderId} /> : root ? <CreateSlot /> : <span aria-hidden className="size-9 shrink-0" data-testid="create-slot" />}
    </>
  );

  return (
    <section className="mat-content relative flex min-h-0 flex-1 flex-col" aria-label={t('disk.section')} data-testid={root ? 'phone-disk' : 'phone-disk-folder'}>
      {root ? (
        <Bar>
          <HeaderIcon><DiskIdleIcon className="size-5" /></HeaderIcon>
          <h1 className="min-w-0 flex-1 truncate text-headline font-semibold">{title}</h1>
          <div className={BAR_GROUP}>{actions}</div>
        </Bar>
      ) : (
        <PhoneHeader title={title}>{actions}</PhoneHeader>
      )}
      {searching ? <SearchField onClose={() => setSearching(false)} /> : null}
      <PhoneListing workspaceId={workspaceId} folderId={folderId} trash={trash} root={root} />
      <PhoneUploads workspaceId={workspaceId} />
      <DiskDialogs workspaceId={workspaceId} />
    </section>
  );
}

function SearchField({ onClose }: { onClose: () => void }): ReactNode {
  const query = useDiskUi((s) => s.query);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="shrink-0 px-4 pb-2">
      <Input
        ref={ref}
        type="search"
        icon={<Search className="size-4" aria-hidden />}
        value={query}
        onChange={(e) => useDiskUi.getState().setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            useDiskUi.getState().setQuery('');
            onClose();
          }
        }}
        placeholder={t('disk.search')}
        aria-label={t('disk.search')}
        className="rounded-full"
        data-testid="phone-disk-search-field"
      />
    </div>
  );
}

// ---------------------------------------------------------------- «⋯»

const SORT_LABEL: Record<DiskSort, 'disk.sort.name' | 'disk.sort.updated' | 'disk.sort.size'> = {
  name: 'disk.sort.name',
  updated: 'disk.sort.updated',
  size: 'disk.sort.size',
};
const VIEWS: Array<{ value: DiskView; label: 'disk.view.tiles' | 'disk.view.list' }> = [
  { value: 'tiles', label: 'disk.view.tiles' },
  { value: 'list', label: 'disk.view.list' },
];

const MoreMenu = memo(function MoreMenu({
  workspaceId,
  folderId,
  trash,
  write,
  manage,
  shareFolder,
}: {
  workspaceId: string;
  folderId: string;
  trash: boolean;
  write: boolean;
  manage: boolean;
  shareFolder: boolean;
}): ReactNode {
  const view = usePrefs((s) => s.diskView);
  const sort = usePrefs((s) => s.diskSort);
  const ui = useDiskUi.getState;
  const item = (icon: ReactNode, label: string, run: () => void, testId: string, danger = false): ReactNode => (
    <Dropdown.Item className={cx(menuItem, danger && 'text-danger-text')} onSelect={run} data-testid={testId}>
      {icon}
      {label}
    </Dropdown.Item>
  );
  const ic = (I: typeof Gauge): ReactNode => <I className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />;
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton tip={false} bar label={t('disk.moreMenu')} data-testid="phone-disk-more">
          <Ellipsis className="size-5" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'min-w-56')} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="phone-disk-more-menu">
          {trash ? (
            write ? item(ic(Trash2), t('disk.emptyTrash'), () => void emptyTrash(workspaceId), 'disk-empty-trash', true) : null
          ) : (
            <>
              <Dropdown.Label className={menuLabel}>{t('disk.view')}</Dropdown.Label>
              <Dropdown.RadioGroup value={view} onValueChange={(v) => usePrefs.getState().setPrefs({ diskView: v as DiskView })}>
                {VIEWS.map((o) => (
                  <Dropdown.RadioItem key={o.value} value={o.value} className={menuItem} data-testid={`phone-disk-view-${o.value}`}>
                    <span className="min-w-0 flex-1">{t(o.label)}</span>
                    {o.value === view ? <Check className="size-4 shrink-0" aria-hidden /> : null}
                  </Dropdown.RadioItem>
                ))}
              </Dropdown.RadioGroup>
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Label className={menuLabel}>{t('disk.sort')}</Dropdown.Label>
              <Dropdown.RadioGroup value={sort} onValueChange={(v) => usePrefs.getState().setPrefs({ diskSort: v as DiskSort })}>
                {DISK_SORTS.map((s) => (
                  <Dropdown.RadioItem key={s} value={s} className={menuItem} data-testid={`phone-disk-sort-${s}`}>
                    <span className="min-w-0 flex-1">{t(SORT_LABEL[s])}</span>
                    {s === sort ? <Check className="size-4 shrink-0" aria-hidden /> : null}
                  </Dropdown.RadioItem>
                ))}
              </Dropdown.RadioGroup>
              <Dropdown.Separator className={menuSeparator} />
              {folderId && shareFolder ? item(ic(Users), t('disk.access'), () => ui().openDialog({ kind: 'access', itemId: folderId }), 'disk-open-access') : null}
              {item(ic(Trash2), t('disk.trash'), () => openPhoneDisk({ kind: 'disk', folderId: '', trash: true }), 'disk-open-trash')}
              {manage ? item(ic(History), t('disk.diskHistory'), () => ui().openDialog({ kind: 'disk-history', wsId: workspaceId }), 'disk-open-history') : null}
              {item(ic(Gauge), t('disk.usage.title'), () => ui().openDialog({ kind: 'usage', wsId: workspaceId }), 'disk-open-usage')}
            </>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
});

// ---------------------------------------------------------------- listing

function PhoneListing({ workspaceId, folderId, trash, root }: { workspaceId: string; folderId: string; trash: boolean; root: boolean }): ReactNode {
  const key = trash ? trashKey(workspaceId) : folderKey(workspaceId, folderId);
  const sort = usePrefs((s) => (trash ? 'updated' : s.diskSort));
  const view = usePrefs((s) => (trash ? 'list' : s.diskView));
  const query = useDiskUi((s) => s.query);
  const ids = useDisk(useShallow((s) => (trash ? trashOrder(s.lists[key], s.items, query) : visibleIds(s.lists[key], s.items, sort, query, collator()))));
  const loaded = useDisk((s) => !!s.lists[key]);
  const load = useDisk((s) => s.load[key]);
  const shown = useRef<readonly string[]>(ids);
  useEffect(() => {
    shown.current = ids;
  }, [ids]);
  // Stable: the rows are memo.
  const open = useCallback((id: string): void => {
    const it = useDisk.getState().items[id];
    if (it && !it.trashedAt) openItem(it, shown.current);
  }, []);

  const scroll = cx('min-h-0 flex-1 overflow-y-auto overscroll-contain', !root && 'pb-[var(--safe-bottom,0px)]');
  if (!loaded) {
    return (
      <div className={cx(scroll, 'flex flex-col')}>
        {load === 'error' ? (
          <Center>
            <p>{t('disk.err.load')}</p>
            <Button variant="secondary" onClick={() => void loadListing(workspaceId, folderId, trash)}>
              {t('common.retry')}
            </Button>
          </Center>
        ) : (
          <Center>
            <Spinner />
          </Center>
        )}
      </div>
    );
  }
  if (!ids.length) {
    return (
      <div className={cx(scroll, 'flex flex-col')}>
        <Center testId="disk-empty">
          <p className="font-medium text-fg">{query.trim() ? t('disk.empty.search') : trash ? t('disk.empty.trash') : folderId ? t('disk.empty.folder') : t('disk.empty.root')}</p>
          {query.trim() ? null : <p>{trash ? t('disk.empty.trashHint') : t('disk.empty.hint')}</p>}
        </Center>
      </div>
    );
  }
  return (
    <div className={scroll} data-testid="phone-disk-area">
      {view === 'tiles' && !trash ? (
        <div className="grid grid-cols-2 gap-3 px-4 pb-6 pt-1" role="list" aria-label={t('disk.section')} data-testid="phone-disk-tiles">
          {ids.map((id) => (
            <PhoneTile key={id} id={id} onOpen={open} />
          ))}
        </div>
      ) : (
        <div role="list" aria-label={t('disk.section')} className="pb-6" data-testid="phone-disk-list">
          {ids.map((id) => (
            <PhoneRow key={id} id={id} trash={trash} onOpen={open} />
          ))}
        </div>
      )}
    </div>
  );
}

const sizeOf = (item: DiskItem): string => (isFolder(item) ? '' : fmt.size(item.file?.size ?? 0n));

/** 40 px leading visual: the thumbnail, else the type glyph. */
function RowIcon({ item }: { item: DiskItem }): ReactNode {
  const thumb = !isFolder(item) && item.file?.thumbnailUrl ? item.file.id : '';
  if (thumb) {
    return (
      <span className="size-10 shrink-0 overflow-hidden rounded-[8px] bg-[var(--color-fill)]">
        <MediaImg path={thumbnailPath(thumb)} alt="" loading="lazy" decoding="async" draggable={false} className="block size-full object-cover" />
      </span>
    );
  }
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-[var(--color-fill)]">
      <ItemGlyph item={item} className="size-6" />
    </span>
  );
}

const PhoneRow = memo(function PhoneRow({ id, trash, onOpen }: { id: string; trash: boolean; onOpen: (id: string) => void }): ReactNode {
  const item = useDisk((s) => s.items[id]);
  const renaming = useDiskUi((s) => s.renaming === id);
  const owner = useMemberName(item?.workspaceId ?? null, (trash ? item?.trashedBy : item?.ownerId) ?? '');
  if (!item) return null;
  const when = trash ? item.trashedAt : item.updatedAt;
  const who = trash ? (item.trashedBy ? owner : t('disk.sweeper')) : item.ownerId ? owner : '';
  const line = [who, when ? fmt.listTime(timestampDate(when)) : '', sizeOf(item)].filter(Boolean).join(' · ');
  return (
    <ItemContextMenu id={id}>
      <div role="listitem" aria-label={item.name} className="flex h-14 items-center gap-1 pl-4 pr-1" data-testid="disk-row" data-kind={isFolder(item) ? 'folder' : 'file'}>
        {renaming ? (
          <>
            <RowIcon item={item} />
            <RenameField item={item} className="ml-3 h-10 flex-1" />
          </>
        ) : (
          <button type="button" onClick={() => (trash ? undefined : onOpen(id))} className="tap-hit flex h-14 min-w-0 flex-1 items-center gap-3 text-left" data-testid="disk-row-open">
            <RowIcon item={item} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-list leading-5 text-fg">{item.name}</span>
                <ItemBadges item={item} />
              </span>
              <span className="truncate text-caption leading-4 text-muted">{line}</span>
            </span>
          </button>
        )}
        <ItemMenuButton id={id} name={item.name} className="tap-hit shrink-0 text-muted" />
      </div>
    </ItemContextMenu>
  );
});

const PhoneTile = memo(function PhoneTile({ id, onOpen }: { id: string; onOpen: (id: string) => void }): ReactNode {
  const item = useDisk((s) => s.items[id]);
  const renaming = useDiskUi((s) => s.renaming === id);
  if (!item) return null;
  return (
    <ItemContextMenu id={id}>
      <div role="listitem" aria-label={item.name} className="relative flex flex-col gap-1.5" data-testid="disk-tile" data-kind={isFolder(item) ? 'folder' : 'file'}>
        <button type="button" onClick={() => onOpen(id)} className="tap-hit flex min-w-0 flex-col gap-1.5 text-left" data-testid="disk-tile-open">
          <span className="relative block h-[112px] w-full overflow-hidden rounded-[10px] bg-[var(--color-fill)]">
            <ItemPicture item={item} />
            <ItemBadges item={item} className="absolute bottom-1.5 left-1.5 rounded-full bg-[var(--color-popover-solid)] px-1.5 py-0.5" />
          </span>
          {renaming ? null : (
            <>
              <span className="line-clamp-2 break-words px-0.5 text-body font-medium leading-[18px] text-fg">{item.name}</span>
              <span className="truncate px-0.5 text-caption leading-4 text-muted">{isFolder(item) ? t('disk.folder') : sizeOf(item)}</span>
            </>
          )}
        </button>
        {renaming ? <RenameField item={item} className="h-10 w-full" /> : null}
        {/* `.tap-hit` is position: relative (phone CSS): the absolute slot is its own element. */}
        <span className="absolute right-2 top-2 grid">
          <ItemMenuButton id={id} name={item.name} className="tap-hit bg-[var(--color-popover-solid)] text-fg shadow-[var(--shadow-card)]" />
        </span>
      </div>
    </ItemContextMenu>
  );
});

// ---------------------------------------------------------------- uploads

/** The uploads of this workspace: a full-width card above the bottom edge, a row per file. */
function PhoneUploads({ workspaceId }: { workspaceId: string }): ReactNode {
  const ids = useDiskUploads(useShallow((s) => s.order.filter((id) => s.byId[id]?.wsId === workspaceId)));
  if (!ids.length) return null;
  return (
    <div
      className="mat-popover absolute inset-x-3 bottom-3 z-20 flex max-h-[40%] flex-col gap-1 overflow-y-auto rounded-[var(--radius-card)] p-2 shadow-[var(--shadow-popover)]"
      role="status"
      aria-label={t('disk.uploads')}
      data-testid="disk-uploads"
    >
      <span className="px-1 text-caption font-semibold text-muted">{t('disk.uploading', { n: ids.length })}</span>
      {ids.map((id) => (
        <UploadRow key={id} id={id} />
      ))}
    </div>
  );
}
