import { useDraggable, useDroppable } from '@dnd-kit/core';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { ArrowLeft, ChevronRight, FileText, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { Button, IconButton, Input, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { fmt } from '../../lib/format';
import { canStructure, canWrite, childKey, filterPages, TOP, trashKey, type DropZone } from '../../lib/wiki/tree';
import { createPage, deleteForever, emptyTrash, loadChildren, loadTrash, openWikiPage, restorePage, searchPages } from '../../services/wiki';
import { myUserId } from '../../stores/session';
import { useWiki } from '../../stores/wiki';
import { useWikiUi } from '../../stores/wikiUi';
import { preloadWikiDoc } from './lazy';

/**
 * The tree column of «Вики» (ADR-0096 §9, docs/08 «Вики»): the title filter and «+ страница» on
 * top, the pages as collapsible nodes (children loaded when a node opens), «Корзина» at the
 * bottom; the trash replaces the tree in the same column. Rows are `memo` and read their page by
 * id; a node subscribes to its own children's ids — an event re-renders the rows it touches.
 * Rows are dnd-kit draggables and drop targets (WikiScreen owns the DndContext): the top and
 * bottom quarters of a row put the page before / after it, the middle inside it.
 */

/** The row under a dragged page and the zone (a row reads only whether it is the one). */
export const useWikiDrag = create<{
  overId: string | null;
  zone: DropZone | null;
  set: (overId: string | null, zone: DropZone | null) => void;
}>()((set) => ({
  overId: null,
  zone: null,
  set: (overId, zone) => set((s) => (s.overId === overId && s.zone === zone ? s : { overId, zone })),
}));

const INDENT = 14;

export function WikiTree({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }): ReactNode {
  const trash = useWikiUi((s) => !!s.trashOf[workspaceId]);
  return trash ? <TrashColumn workspaceId={workspaceId} /> : <TreeColumn workspaceId={workspaceId} canCreate={canCreate} />;
}

function TreeColumn({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }): ReactNode {
  useLocale();
  const query = useWikiUi((s) => s.query);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line px-2.5">
        <span className="min-w-0 flex-1">
          <Input
            type="search"
            icon={<Search className="size-3.5" aria-hidden />}
            value={query}
            onChange={(e) => useWikiUi.getState().setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                useWikiUi.getState().setQuery('');
              }
            }}
            placeholder={t('wiki.search')}
            aria-label={t('wiki.search')}
            className="h-8 rounded-full"
            data-testid="wiki-search"
          />
        </span>
        {canCreate ? (
          <IconButton label={t('wiki.newPage')} onClick={() => void createPage(workspaceId, TOP)} data-testid="wiki-new-page">
            <Plus className="size-4" aria-hidden />
          </IconButton>
        ) : null}
      </div>
      <nav className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 py-1.5" aria-label={t('wiki.tree')} data-testid="wiki-tree" onPointerEnter={preloadWikiDoc}>
        {query.trim() ? <SearchResults workspaceId={workspaceId} query={query} /> : <ChildList workspaceId={workspaceId} parentId={TOP} depth={0} />}
      </nav>
      <div className="shrink-0 border-t border-line p-1.5">
        <button
          type="button"
          onClick={() => useWikiUi.getState().openTrash(workspaceId, true)}
          className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-row)] px-2 text-body text-muted hover:bg-hover hover:text-fg"
          data-testid="wiki-open-trash"
        >
          <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
          {t('wiki.trash')}
        </button>
      </div>
    </>
  );
}

/** The children of a page (or the top level), loaded when first shown. */
const ChildList = memo(function ChildList({ workspaceId, parentId, depth }: { workspaceId: string; parentId: string; depth: number }): ReactNode {
  const key = childKey(workspaceId, parentId);
  const ids = useWiki(useShallow((s) => s.lists[key] ?? EMPTY));
  const loaded = useWiki((s) => !!s.lists[key]);
  const failed = useWiki((s) => s.load[key] === 'error');
  useEffect(() => {
    if (!loaded) void loadChildren(workspaceId, parentId);
  }, [loaded, workspaceId, parentId]);
  if (!loaded) {
    return failed ? null : (
      <div className="flex h-8 items-center" style={{ paddingLeft: 8 + depth * INDENT }}>
        <Spinner className="size-3.5" />
      </div>
    );
  }
  if (!ids.length) {
    return depth === 0 ? (
      <p className="px-2 py-3 text-caption text-muted">{t('wiki.emptyTree')}</p>
    ) : (
      <p className="flex h-7 items-center text-caption text-faint" style={{ paddingLeft: 30 + depth * INDENT }}>
        {t('wiki.noSubpages')}
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {ids.map((id) => (
        <TreeNode key={id} workspaceId={workspaceId} id={id} depth={depth} />
      ))}
    </ul>
  );
});

const EMPTY: readonly string[] = [];

const TreeNode = memo(function TreeNode({ workspaceId, id, depth }: { workspaceId: string; id: string; depth: number }): ReactNode {
  const title = useWiki((s) => s.pages[id]?.title ?? '');
  const icon = useWiki((s) => s.pages[id]?.icon ?? '');
  const hasChildren = useWiki((s) => !!s.pages[id]?.hasChildren || (s.lists[childKey(workspaceId, id)]?.length ?? 0) > 0);
  const writable = useWiki((s) => canWrite(s.pages[id]?.myBits ?? 0n));
  const movable = useWiki((s) => {
    const p = s.pages[id];
    return !!p && canStructure(p, myUserId());
  });
  const expanded = useWikiUi((s) => !!s.expanded[id]);
  const active = useWikiUi((s) => s.pageOf[workspaceId] === id);
  const zone = useWikiDrag((s) => (s.overId === id ? s.zone : null));
  const drag = useDraggable({ id, disabled: !movable });
  const drop = useDroppable({ id: `wiki:${id}`, data: { pageId: id } });
  const ref = useCallback(
    (el: HTMLElement | null) => {
      drag.setNodeRef(el);
      drop.setNodeRef(el);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dnd-kit's setters are stable
    [],
  );
  const toggle = (): void => useWikiUi.getState().setExpanded(id, !expanded);
  return (
    <li className="flex flex-col">
      {/* The row is a drag handle and a drop target; the page opens from its title button (no nested controls). */}
      <div
        ref={ref}
        {...drag.listeners}
        className={cx(
          'group relative flex h-8 items-center gap-1 rounded-[var(--radius-row)] pr-1 text-body',
          active ? 'bg-active text-fg' : 'text-fg hover:bg-hover',
          drag.isDragging && 'opacity-40',
          zone === 'inside' && 'bg-hover ring-2 ring-inset ring-accent',
        )}
        style={{ paddingLeft: 4 + depth * INDENT }}
        data-testid="wiki-node"
        data-active={active || undefined}
      >
        {zone === 'before' || zone === 'after' ? (
          <span className={cx('pointer-events-none absolute right-1 h-0.5 rounded-full bg-accent', zone === 'before' ? '-top-px' : '-bottom-px')} style={{ left: 4 + depth * INDENT }} aria-hidden />
        ) : null}
        <button
          type="button"
          tabIndex={hasChildren ? 0 : -1}
          aria-expanded={hasChildren ? expanded : undefined}
          onClick={toggle}
          onPointerDown={(e) => e.stopPropagation()}
          className={cx('grid size-5 shrink-0 place-items-center rounded-[4px] text-faint hover:bg-active hover:text-fg', !hasChildren && 'invisible')}
          aria-label={expanded ? t('wiki.collapse') : t('wiki.expand')}
          data-testid="wiki-node-toggle"
        >
          <ChevronRight className={cx('size-3.5 transition-transform duration-[var(--motion-fast)]', expanded && 'rotate-90')} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => openWikiPage(workspaceId, id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' && hasChildren && !expanded) toggle();
            else if (e.key === 'ArrowLeft' && expanded) toggle();
          }}
          aria-current={active ? 'page' : undefined}
          className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-row)] text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
          data-testid="wiki-node-open"
        >
          <span className="grid size-5 shrink-0 place-items-center text-[15px] leading-none" aria-hidden>
            {icon || <FileText className="size-4 text-muted" strokeWidth={1.75} />}
          </span>
          <span className={cx('min-w-0 flex-1 truncate', !title && 'text-muted')}>{title || t('wiki.untitled')}</span>
        </button>
        {writable ? (
          <IconButton
            size="sm"
            tip={false}
            label={t('wiki.addSubpage')}
            className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void createPage(workspaceId, id)}
            data-testid="wiki-node-add"
          >
            <Plus className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {expanded ? <ChildList workspaceId={workspaceId} parentId={id} depth={depth + 1} /> : null}
    </li>
  );
});

/** The drag chip under the pointer. */
export function DragChip({ id }: { id: string }): ReactNode {
  const title = useWiki((s) => s.pages[id]?.title ?? '');
  const icon = useWiki((s) => s.pages[id]?.icon ?? '');
  return (
    <div className="mat-popover flex h-8 max-w-64 items-center gap-2 rounded-[var(--radius-row)] px-2.5 text-body shadow-[var(--shadow-popover)]">
      <span aria-hidden>{icon || <FileText className="size-4 text-muted" strokeWidth={1.75} />}</span>
      <span className="truncate">{title || t('wiki.untitled')}</span>
    </div>
  );
}

// ---------------------------------------------------------------- search

/** The filter: loaded pages whose title matches, then the server's hits (title and text) not shown yet. */
function SearchResults({ workspaceId, query }: { workspaceId: string; query: string }): ReactNode {
  const local = useWiki(useShallow((s) => filterPages(s.pages, workspaceId, query)));
  const [remote, setRemote] = useState<Array<{ id: string; title: string; icon: string }>>([]);
  const [busy, setBusy] = useState(false);
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      searchPages(workspaceId, q, ctl.signal).then(
        (r) => {
          setRemote(r);
          setBusy(false);
        },
        () => setBusy(false),
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [workspaceId, q]);
  const shown = new Set(local);
  const extra = q.length < 2 ? [] : remote.filter((r) => !shown.has(r.id));
  return (
    <div className="flex flex-col" data-testid="wiki-search-results">
      {local.map((id) => (
        <ResultRow key={id} workspaceId={workspaceId} id={id} />
      ))}
      {extra.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => openWikiPage(workspaceId, r.id)}
          className="flex h-8 items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-body hover:bg-hover"
          data-testid="wiki-search-hit"
        >
          <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
            {r.icon || <FileText className="size-4 text-muted" strokeWidth={1.75} />}
          </span>
          <span className="min-w-0 flex-1 truncate">{r.title || t('wiki.untitled')}</span>
        </button>
      ))}
      {busy ? (
        <div className="flex h-8 items-center px-2">
          <Spinner className="size-3.5" />
        </div>
      ) : !local.length && !extra.length ? (
        <p className="px-2 py-3 text-caption text-muted">{t('wiki.searchEmpty')}</p>
      ) : null}
    </div>
  );
}

const ResultRow = memo(function ResultRow({ workspaceId, id }: { workspaceId: string; id: string }): ReactNode {
  const title = useWiki((s) => s.pages[id]?.title ?? '');
  const icon = useWiki((s) => s.pages[id]?.icon ?? '');
  const active = useWikiUi((s) => s.pageOf[workspaceId] === id);
  return (
    <button
      type="button"
      onClick={() => openWikiPage(workspaceId, id)}
      className={cx('flex h-8 items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-body', active ? 'bg-active' : 'hover:bg-hover')}
      data-testid="wiki-search-row"
    >
      <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
        {icon || <FileText className="size-4 text-muted" strokeWidth={1.75} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{title || t('wiki.untitled')}</span>
    </button>
  );
});

// ---------------------------------------------------------------- trash

function TrashColumn({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  const key = trashKey(workspaceId);
  const ids = useWiki(useShallow((s) => s.lists[key] ?? EMPTY));
  const loaded = useWiki((s) => !!s.lists[key]);
  useEffect(() => {
    void loadTrash(workspaceId);
  }, [workspaceId]);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton label={t('wiki.backToWiki')} onClick={() => useWikiUi.getState().openTrash(workspaceId, false)} data-testid="wiki-trash-back">
          <ArrowLeft className="size-4" aria-hidden />
        </IconButton>
        <h2 className="min-w-0 flex-1 truncate text-headline font-semibold">{t('wiki.trash')}</h2>
        {ids.length ? (
          <Button variant="secondary" size="sm" onClick={() => void emptyTrash(workspaceId)} data-testid="wiki-empty-trash">
            {t('wiki.emptyTrashShort')}
          </Button>
        ) : null}
      </div>
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5" data-testid="wiki-trash">
        {!loaded ? (
          <div className="grid h-12 place-items-center">
            <Spinner />
          </div>
        ) : ids.length ? (
          ids.map((id) => <TrashRow key={id} workspaceId={workspaceId} id={id} />)
        ) : (
          <p className="px-2 py-3 text-caption text-muted">{t('wiki.trashEmpty')}</p>
        )}
      </div>
    </>
  );
}

const TrashRow = memo(function TrashRow({ workspaceId, id }: { workspaceId: string; id: string }): ReactNode {
  const page = useWiki((s) => s.pages[id]);
  const active = useWikiUi((s) => s.pageOf[workspaceId] === id);
  if (!page) return null;
  const mine = canStructure(page, myUserId());
  const at = page.trashedAt ? timestampDate(page.trashedAt) : null;
  return (
    <div className={cx('group flex h-11 items-center gap-1 rounded-[var(--radius-row)] pr-1', active ? 'bg-active' : 'hover:bg-hover')} data-testid="wiki-trash-row">
      <button
        type="button"
        onClick={() => useWikiUi.getState().openPage(workspaceId, id)}
        aria-current={active ? 'page' : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-row)] pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
          {page.icon || <FileText className="size-4 text-muted" strokeWidth={1.75} />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body">{page.title || t('wiki.untitled')}</span>
          {at ? <span className="truncate text-caption text-muted">{t('wiki.trashedAt', { date: fmt.listTime(at) })}</span> : null}
        </span>
      </button>
      {mine ? (
        <span className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <IconButton
            size="sm"
            label={t('wiki.restore')}
            onClick={() => void restorePage(id)}
            data-testid="wiki-trash-restore"
          >
            <RotateCcw className="size-3.5" aria-hidden />
          </IconButton>
          <IconButton
            size="sm"
            danger
            label={t('wiki.deleteForever')}
            onClick={() => void deleteForever(id)}
            data-testid="wiki-trash-delete"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </IconButton>
        </span>
      ) : null}
    </div>
  );
});
