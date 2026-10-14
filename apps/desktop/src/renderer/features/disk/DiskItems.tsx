import { useDraggable, useDroppable } from '@dnd-kit/core';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { DiskItem } from '@calaba/protocol';
import { RotateCcw, SearchX, Trash2, Upload } from 'lucide-react';
import { createContext, memo, useCallback, useContext, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { hasFiles } from '../../lib/dropState';
import { canWrite, folderKey, isFolder, trashKey, visibleIds } from '../../lib/disk';
import { fmt } from '../../lib/format';
import { collator, loadListing, openItem, renameItem, restoreItems } from '../../services/disk';
import { useDisk } from '../../stores/disk';
import { useDiskUi } from '../../stores/diskUi';
import { usePrefs } from '../../stores/prefs';
import { useMemberName } from '../../stores/workspaces';
import { ItemContextMenu, ItemMenuButton } from './ItemMenu';
import { ItemBadges, ItemGlyph, ItemPicture } from './visuals';

/**
 * The listing of the open folder or of the trash (ADR-0094 §8, docs/08 «Диск»): tiles 160 px or a
 * list (name · owner · changed · size), the trash as a list with «Удалил · Удалено» and
 * «Восстановить». Re-renders (CLAUDE.md): the listing reads the shown ids (useShallow, sorted and
 * filtered in the selector); every tile / row is `memo` and reads its own item by id, its owner's
 * name and «selected» / «renaming» as primitives — an upsert or a click re-renders one or two
 * tiles. Mouse drags of items (dnd-kit, 6 px) go to a folder tile or a crumb (DiskScreen owns the
 * DndContext); a system file drag onto a folder tile uploads into it (`DropTarget`).
 */

/** The folder tile a system file drag is over (a stable ref — the context never changes). */
export const DropTarget = createContext<RefObject<string | null>>({ current: null });

/** The shown ids, in order: a ref for «Открыть» (the Lightbox's ←/→ over the listing). */
const Shown = createContext<RefObject<readonly string[]>>({ current: [] });

export function DiskListing({ workspaceId, folderId, trash }: { workspaceId: string; folderId: string; trash: boolean }): ReactNode {
  const key = trash ? trashKey(workspaceId) : folderKey(workspaceId, folderId);
  const sort = usePrefs((s) => (trash ? 'updated' : s.diskSort));
  const view = usePrefs((s) => (trash ? 'list' : s.diskView));
  const query = useDiskUi((s) => s.query);
  const ids = useDisk(useShallow((s) => (trash ? trashOrder(s.lists[key], s.items, query) : visibleIds(s.lists[key], s.items, sort, query, collator()))));
  const loaded = useDisk((s) => !!s.lists[key]);
  const load = useDisk((s) => s.load[key]);
  const shownRef = useRef<readonly string[]>(ids);
  useEffect(() => {
    shownRef.current = ids;
  }, [ids]);

  if (!loaded) {
    return load === 'error' ? (
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
    );
  }
  if (!ids.length) {
    return (
      <Center testId="disk-empty">
        {query.trim() ? (
          <>
            <SearchX className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
            <p>{t('disk.empty.search')}</p>
          </>
        ) : trash ? (
          <>
            <Trash2 className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
            <p className="font-medium text-fg">{t('disk.empty.trash')}</p>
            <p>{t('disk.empty.trashHint')}</p>
          </>
        ) : (
          <>
            <Upload className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
            <p className="font-medium text-fg">{folderId ? t('disk.empty.folder') : t('disk.empty.root')}</p>
            <p>{t('disk.empty.hint')}</p>
          </>
        )}
      </Center>
    );
  }
  return (
    <Shown.Provider value={shownRef}>
      {trash ? (
        <TrashList ids={ids} />
      ) : view === 'list' ? (
        <List ids={ids} workspaceId={workspaceId} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,160px)] gap-2 px-4 pb-6 pt-3" role="list" aria-label={t('disk.section')} data-testid="disk-tiles">
          {ids.map((id) => (
            <Tile key={id} id={id} />
          ))}
        </div>
      )}
    </Shown.Provider>
  );
}

/** The trash: the newest deletion first (the server's order), filtered by the search. */
export function trashOrder(ids: readonly string[] | undefined, items: Readonly<Record<string, DiskItem>>, query: string): string[] {
  if (!ids) return [];
  const q = query.trim().toLocaleLowerCase();
  const ms = (i: DiskItem): number => (i.trashedAt ? timestampDate(i.trashedAt).getTime() : 0);
  return ids
    .map((id) => items[id])
    .filter((i): i is DiskItem => !!i && (!q || i.name.toLocaleLowerCase().includes(q)))
    .sort((a, b) => ms(b) - ms(a))
    .map((i) => i.id);
}

export function Center({ children, testId }: { children: ReactNode; testId?: string }): ReactNode {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center text-body text-muted" data-testid={testId}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- shared item behaviour

/**
 * Selection, open, keyboard and drag wiring of a tile / row. Dragging needs WRITE on the item
 * (the server checks the target too); a folder is also a drop target for items and system files.
 */
function useItemDnd(item: DiskItem | undefined, renaming: boolean) {
  const id = item?.id ?? '';
  const folder = !!item && isFolder(item) && !item.trashedAt;
  const { setNodeRef: setDragNode, listeners, isDragging } = useDraggable({ id, disabled: !item || !!item.trashedAt || renaming || !canWrite(item.myBits), data: { name: item?.name ?? '' } });
  const { setNodeRef: setDropNode, isOver } = useDroppable({ id: `folder:${id}`, disabled: !folder, data: { folderId: id } });
  const dropTargetRef = useContext(DropTarget);
  const [fileOver, setFileOver] = useState(false);
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      setDragNode(el);
      setDropNode(el);
    },
    [setDragNode, setDropNode],
  );
  const fileHandlers = folder
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e.dataTransfer.types)) return;
          dropTargetRef.current = id;
          setFileOver(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          if (dropTargetRef.current === id) dropTargetRef.current = null;
          setFileOver(false);
        },
        onDrop: () => setFileOver(false),
      }
    : {};
  return { setRef, listeners, isDragging, over: isOver || fileOver, fileHandlers };
}

function useItemActions(id: string) {
  const shown = useContext(Shown);
  const open = (): void => {
    const it = useDisk.getState().items[id];
    if (it && !it.trashedAt) openItem(it, shown.current);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      open();
    } else if (e.key === 'F2' || (e.key === 'Enter' && e.metaKey)) {
      const it = useDisk.getState().items[id];
      if (it && canWrite(it.myBits) && !it.trashedAt) useDiskUi.getState().setRenaming(id);
    }
  };
  return {
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      useDiskUi.getState().select(id);
    },
    onDoubleClick: open,
    onKeyDown,
  };
}

/** The name as an input (Finder: Enter saves, Esc cancels, leaving the field saves). */
export function RenameField({ item, className }: { item: DiskItem; className?: string }): ReactNode {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // The name without its extension is selected (as in Finder).
    const dot = isFolder(item) ? -1 : item.name.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : item.name.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);
  const finish = (save: boolean): void => {
    if (done.current) return;
    done.current = true;
    const v = ref.current?.value ?? '';
    useDiskUi.getState().setRenaming(null);
    if (save) void renameItem(item.id, v);
  };
  return (
    <input
      ref={ref}
      defaultValue={item.name}
      maxLength={255}
      aria-label={t('disk.rename')}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className={cx('min-w-0 rounded-[6px] border border-accent bg-elev px-1.5 text-body text-fg outline-none', className)}
      data-testid="disk-rename"
    />
  );
}

const itemMeta = (item: DiskItem): string => (isFolder(item) ? t('disk.folder') : fmt.size(item.file?.size ?? 0n));
const changed = (item: DiskItem): string => (item.updatedAt ? fmt.listTime(timestampDate(item.updatedAt)) : '');

// ---------------------------------------------------------------- tiles

const Tile = memo(function Tile({ id }: { id: string }): ReactNode {
  const item = useDisk((s) => s.items[id]);
  const selected = useDiskUi((s) => s.selected === id);
  const renaming = useDiskUi((s) => s.renaming === id);
  const { setRef, listeners, isDragging, over, fileHandlers } = useItemDnd(item, renaming);
  const actions = useItemActions(id);
  if (!item) return null;
  return (
    <ItemContextMenu id={id}>
      <div
        ref={setRef}
        role="listitem"
        tabIndex={0}
        data-selected={selected || undefined}
        aria-label={item.name}
        {...listeners}
        {...actions}
        {...fileHandlers}
        className={cx(
          'group/tile relative flex w-[160px] cursor-default flex-col gap-1.5 rounded-[10px] p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]',
          selected ? 'bg-active' : 'hover:bg-hover',
          over && 'bg-hover ring-2 ring-accent',
          isDragging && 'opacity-40',
        )}
        data-testid="disk-tile"
        data-kind={isFolder(item) ? 'folder' : 'file'}
      >
        <div className="relative h-[112px] w-full overflow-hidden rounded-[8px] bg-[var(--color-fill)]">
          <ItemPicture item={item} />
          <ItemBadges item={item} className="absolute bottom-1.5 left-1.5 rounded-full bg-[var(--color-popover-solid)] px-1.5 py-0.5" />
        </div>
        {renaming ? (
          <RenameField item={item} className="h-6 w-full text-center" />
        ) : (
          <span className="line-clamp-2 break-words px-0.5 text-center text-body font-medium leading-[18px] text-fg" title={item.name}>
            {item.name}
          </span>
        )}
        <span className="truncate text-center text-caption text-muted">{itemMeta(item)}</span>
        <ItemMenuButton
          id={id}
          name={item.name}
          className={cx('absolute right-2.5 top-2.5 bg-[var(--color-popover-solid)] shadow-[var(--shadow-card)] opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100', selected && 'opacity-100')}
        />
      </div>
    </ItemContextMenu>
  );
});

// ---------------------------------------------------------------- list

const COLS = 'grid grid-cols-[minmax(0,1fr)_160px_96px_88px_32px] items-center gap-3';

function List({ ids }: { ids: readonly string[]; workspaceId: string }): ReactNode {
  return (
    <div role="table" aria-label={t('disk.section')} className="flex flex-col px-3 pb-6" data-testid="disk-list">
      <div role="row" className={cx(COLS, 'sticky top-0 z-[1] h-8 border-b border-line bg-[var(--color-feed)] px-2 text-caption font-medium text-muted')}>
        <span role="columnheader">{t('disk.col.name')}</span>
        <span role="columnheader">{t('disk.col.owner')}</span>
        <span role="columnheader">{t('disk.col.changed')}</span>
        <span role="columnheader" className="text-right">
          {t('disk.col.size')}
        </span>
        <span aria-hidden />
      </div>
      {ids.map((id) => (
        <Row key={id} id={id} />
      ))}
    </div>
  );
}

const Row = memo(function Row({ id }: { id: string }): ReactNode {
  const item = useDisk((s) => s.items[id]);
  const selected = useDiskUi((s) => s.selected === id);
  const renaming = useDiskUi((s) => s.renaming === id);
  const owner = useMemberName(item?.workspaceId ?? null, item?.ownerId ?? '');
  const { setRef, listeners, isDragging, over, fileHandlers } = useItemDnd(item, renaming);
  const actions = useItemActions(id);
  if (!item) return null;
  return (
    <ItemContextMenu id={id}>
      <div
        ref={setRef}
        role="row"
        tabIndex={0}
        data-selected={selected || undefined}
        {...listeners}
        {...actions}
        {...fileHandlers}
        className={cx(
          COLS,
          'group/row h-9 cursor-default rounded-[var(--radius-row)] px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)]',
          selected ? 'bg-active' : 'hover:bg-hover',
          over && 'bg-hover ring-2 ring-inset ring-accent',
          isDragging && 'opacity-40',
        )}
        data-testid="disk-row"
      >
        <span role="cell" className="flex min-w-0 items-center gap-2">
          <ItemGlyph item={item} className="size-5 shrink-0" />
          {renaming ? (
            <RenameField item={item} className="h-6 flex-1" />
          ) : (
            <span className="min-w-0 truncate" title={item.name}>
              {item.name}
            </span>
          )}
          <ItemBadges item={item} />
        </span>
        <span role="cell" className="truncate text-muted">
          {item.ownerId ? owner : '—'}
        </span>
        <span role="cell" className="truncate tabular-nums text-muted">
          {changed(item)}
        </span>
        <span role="cell" className="truncate text-right tabular-nums text-muted">
          {isFolder(item) ? '—' : fmt.size(item.file?.size ?? 0n)}
        </span>
        <span role="cell" className="flex justify-end">
          <ItemMenuButton id={id} name={item.name} className={cx('opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100', selected && 'opacity-100')} />
        </span>
      </div>
    </ItemContextMenu>
  );
});

// ---------------------------------------------------------------- trash

const TRASH_COLS = 'grid grid-cols-[minmax(0,1fr)_150px_96px_80px_auto] items-center gap-3';

function TrashList({ ids }: { ids: readonly string[] }): ReactNode {
  return (
    <div role="table" aria-label={t('disk.trash')} className="flex flex-col px-3 pb-6" data-testid="disk-trash">
      <div role="row" className={cx(TRASH_COLS, 'sticky top-0 z-[1] h-8 border-b border-line bg-[var(--color-feed)] px-2 text-caption font-medium text-muted')}>
        <span role="columnheader">{t('disk.col.name')}</span>
        <span role="columnheader">{t('disk.col.trashedBy')}</span>
        <span role="columnheader">{t('disk.col.trashedAt')}</span>
        <span role="columnheader" className="text-right">
          {t('disk.col.size')}
        </span>
        <span aria-hidden className="w-[148px]" />
      </div>
      {ids.map((id) => (
        <TrashRow key={id} id={id} />
      ))}
    </div>
  );
}

const TrashRow = memo(function TrashRow({ id }: { id: string }): ReactNode {
  const item = useDisk((s) => s.items[id]);
  const selected = useDiskUi((s) => s.selected === id);
  const by = useMemberName(item?.workspaceId ?? null, item?.trashedBy ?? '');
  if (!item) return null;
  const write = canWrite(item.myBits);
  return (
    <ItemContextMenu id={id}>
      <div
        role="row"
        tabIndex={0}
        data-selected={selected || undefined}
        onClick={() => useDiskUi.getState().select(id)}
        className={cx(TRASH_COLS, 'group/row h-9 cursor-default rounded-[var(--radius-row)] px-2 text-body outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)]', selected ? 'bg-active' : 'hover:bg-hover')}
        data-testid="disk-trash-row"
      >
        <span role="cell" className="flex min-w-0 items-center gap-2">
          <ItemGlyph item={item} className="size-5 shrink-0" />
          <span className="min-w-0 truncate" title={item.name}>
            {item.name}
          </span>
        </span>
        <span role="cell" className="truncate text-muted">
          {item.trashedBy ? by : t('disk.sweeper')}
        </span>
        <span role="cell" className="truncate tabular-nums text-muted">
          {item.trashedAt ? fmt.listTime(timestampDate(item.trashedAt)) : ''}
        </span>
        <span role="cell" className="truncate text-right tabular-nums text-muted">
          {isFolder(item) ? '—' : fmt.size(item.file?.size ?? 0n)}
        </span>
        <span role="cell" className="flex w-[148px] items-center justify-end gap-1">
          {write ? (
            <Button size="sm" variant="ghost" onClick={() => void restoreItems([id])} data-testid="disk-restore">
              <RotateCcw className="size-3.5" aria-hidden />
              {t('disk.restore')}
            </Button>
          ) : null}
          <ItemMenuButton id={id} name={item.name} className={cx('opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100', selected && 'opacity-100')} />
        </span>
      </div>
    </ItemContextMenu>
  );
});

/** The drag ghost (DragOverlay): the item's glyph and name on a popover chip. */
export function DragChip({ id }: { id: string }): ReactNode {
  const item = useDisk((s) => s.items[id]);
  if (!item) return null;
  return (
    <div className="mat-popover flex h-8 w-max max-w-[240px] items-center gap-2 rounded-[var(--radius-row)] px-2 text-body text-fg shadow-[var(--shadow-popover)]" data-testid="disk-drag">
      <ItemGlyph item={item} className="size-4 shrink-0" />
      <span className="truncate">{item.name}</span>
    </div>
  );
}

