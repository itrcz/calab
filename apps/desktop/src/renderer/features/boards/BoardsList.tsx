import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { BoardFeature, type Board } from '@calaba/protocol';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Ellipsis, FileText, FolderInput, FolderPlus, Inbox, Link2, Lock, Pencil, Plus, Settings, Shield, SquareKanban, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { confirmAction } from '../../components/Confirm';
import { Button, CountBadge, Field, Input, Modal, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayCreateBoards } from '../../lib/permissions';
import { boardLayout, layoutTokens } from '../../lib/boards/categories';
import { categoryDropAt, roomDropAt, type Layout, type RoomTarget, type Section, type Slot } from '../../lib/roomOrder';
import {
  boardLink,
  copyText,
  createBoardCategory,
  deleteBoardCategory,
  listArchivedBoards,
  moveBoardCategory,
  moveBoardTo,
  openBoard,
  removeBoard,
  renameBoardCategory,
  restoreBoard,
} from '../../services/boards';
import { DeleteBoardDialog } from './BoardSettings';
import { BoardForms } from './BoardForms';
import { unreadCount, useBoards, workspaceBoards, workspaceCategories } from '../../stores/boards';
import { MY_TASKS, useBoardsUi } from '../../stores/boardsUi';
import { useSession } from '../../stores/session';
import { useMemberRoles } from '../../stores/workspaces';
import { GROUP_LABEL, GroupChevron, ROW_HOVER } from '../shell/ColumnHeader';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { RestrictedMark } from '../workspace/AccessLevel';
import { hasBit, MANAGE_BOARD } from './model';
import { useFeatureOn } from './useBoardView';

/**
 * The room column in boards mode (ADR-0042 §5, ADR-0058 §1): «Мои задачи» on top, the
 * workspace's boards (emoji, name, my open tasks) — first those without a category, then the
 * board categories (collapsible, collapsed state local). Boards are dragged to a new place or
 * into another category with MANAGE_BOARD, categories among themselves with CREATE_BOARDS
 * (accent line, Esc cancels; one request per drop). ⋯ → settings / access / category / link /
 * archive; «+ Доска» and «Новая категория» for CREATE_BOARDS (ADR-0048). The list subscribes to
 * one token array (useShallow): a task event re-renders nothing here.
 */
export function BoardsList({ workspaceId }: { workspaceId: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  // «+ Доска», categories: CREATE_BOARDS (ADR-0048).
  const creator = mayCreateBoards(useMemberRoles(workspaceId, me));
  const activeBoard = useBoardsUi((s) => s.boardOf[workspaceId] ?? '');
  const collapsed = useBoardsUi((s) => s.collapsedCats);
  const tokens = useBoards(useShallow((s) => layoutTokens(boardLayout(workspaceBoards(s.boards, workspaceId), workspaceCategories(s.categories, workspaceId), creator), collapsed, activeBoard)));
  const live = useBoards((s) => workspaceBoards(s.boards, workspaceId).length);
  const manageAny = useBoards((s) => workspaceBoards(s.boards, workspaceId).some((b) => hasBit(b.permissions, MANAGE_BOARD)));
  const list = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const [newCat, setNewCat] = useState(false);
  const press = useRef<{ kind: 'board' | 'cat'; id: string; y: number; started: boolean; layout: Layout } | null>(null);
  const target = useRef<RoomTarget | { index: number } | null>(null);
  const suppress = useRef(false);

  const measure = useCallback((y: number): void => {
    const el = list.current;
    const p = press.current;
    if (!el || !p) return;
    const box = el.getBoundingClientRect();
    const catOf = new Map<string, string | null>();
    for (const c of p.layout) for (const id of c.rooms) catOf.set(id, c.categoryId);
    const slots: Slot[] = [];
    for (const n of el.querySelectorAll<HTMLElement>('[data-board-row], [data-bcat-header]')) {
      const r = n.getBoundingClientRect();
      if (n.dataset.bcatHeader) slots.push({ kind: 'header', id: n.dataset.bcatHeader, top: r.top, bottom: r.bottom });
      else if (n.dataset.boardRow) slots.push({ kind: 'room', id: n.dataset.boardRow, categoryId: catOf.get(n.dataset.boardRow) ?? null, top: r.top, bottom: r.bottom });
    }
    let at: { lineY: number } | null;
    if (p.kind === 'board') {
      const d = roomDropAt(p.layout, slots, y, p.id);
      if (d) target.current = { categoryId: d.categoryId, index: d.index };
      at = d;
    } else {
      // A category section: its header down to the next header (or the last row).
      const heads = slots.filter((x) => x.kind === 'header');
      const sections: Section[] = heads.map((h, i) => ({ id: h.id, top: h.top, bottom: heads[i + 1]?.top ?? slots.at(-1)?.bottom ?? h.bottom }));
      const d = categoryDropAt(sections, y, p.id);
      if (d) target.current = { index: d.index };
      at = d;
    }
    if (at) setLine(at.lineY - box.top + el.scrollTop);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      const p = press.current;
      if (!p) return;
      if (!p.started) {
        if (Math.abs(e.clientY - p.y) < 6) return;
        p.started = true;
        setDrag(p.id);
      }
      measure(e.clientY);
    };
    const end = (commit: boolean): void => {
      const p = press.current;
      press.current = null;
      if (!p?.started) return;
      suppress.current = true;
      window.setTimeout(() => (suppress.current = false), 0);
      const to = target.current;
      setDrag(null);
      setLine(null);
      target.current = null;
      if (!commit || !to) return;
      if (p.kind === 'board' && 'categoryId' in to) void moveBoardTo(workspaceId, p.id, to);
      else if (p.kind === 'cat') void moveBoardCategory(workspaceId, p.id, to.index);
    };
    const up = (): void => end(true);
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && press.current?.started) {
        e.stopPropagation();
        end(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
    };
  }, [measure, workspaceId]);

  const layoutNow = useCallback((): Layout => {
    const s = useBoards.getState();
    return boardLayout(workspaceBoards(s.boards, workspaceId), workspaceCategories(s.categories, workspaceId), true);
  }, [workspaceId]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent, id: string) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('[data-row-menu]')) return;
      const b = useBoards.getState().boards[id];
      if (!hasBit(b?.permissions, MANAGE_BOARD)) return;
      press.current = { kind: 'board', id, y: e.clientY, started: false, layout: layoutNow() };
    },
    [layoutNow],
  );
  const onCategoryPointerDown = useCallback(
    (e: ReactPointerEvent, id: string) => {
      if (e.button !== 0 || !creator || (e.target as HTMLElement).closest('input, [data-row-menu]')) return;
      press.current = { kind: 'cat', id, y: e.clientY, started: false, layout: layoutNow() };
    },
    [creator, layoutNow],
  );

  return (
    <div
      ref={list}
      className="scrollbar-none relative min-h-0 flex-1 overflow-y-auto px-2 pb-5 pt-1 mobile:px-0 mobile:pt-1"
      onClickCapture={(e) => {
        if (suppress.current) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      data-testid="boards-list"
    >
      <MyTasksRow workspaceId={workspaceId} />
      <div className="flex h-9 items-center pl-2 pr-1 pt-2 mobile:h-11 mobile:px-3">
        <h2 className={cx('min-w-0 flex-1 truncate', GROUP_LABEL)}>{t('boards.boards')}</h2>
        {creator ? (
          <>
            <Tip label={t('boards.cat.new')}>
              <button type="button" aria-label={t('boards.cat.new')} onClick={() => setNewCat(true)} className="hidden size-6 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-hover hover:text-fg mobile:grid" data-testid="board-category-new">
                <FolderPlus className="size-4" aria-hidden />
              </button>
            </Tip>
          </>
        ) : null}
      </div>
      <div className="flex flex-col gap-px pt-0.5 mobile:gap-0 mobile:pt-0">
        {tokens.map((tok) => {
          const id = tok.slice(2);
          return tok.startsWith('h:') ? (
            <CategoryHeader key={tok} id={id} workspaceId={workspaceId} creator={creator} dragging={drag === id} onPointerDown={onCategoryPointerDown} />
          ) : (
            <BoardRow key={tok} id={id} workspaceId={workspaceId} dragging={drag === id} onPointerDown={onPointerDown} />
          );
        })}
      </div>
      {live === 0 ? (
        creator ? (
          <button
            type="button"
            onClick={() => useBoardsUi.getState().openSettings({ boardId: '', workspaceId })}
            className="mt-1 flex w-full items-center gap-2.5 rounded-[var(--radius-row)] border border-dashed border-line px-2 py-2 text-left text-caption text-muted hover:bg-hover hover:text-fg"
            data-testid="boards-empty"
          >
            <Plus className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{t('boards.noBoardsAdmin')}</span>
          </button>
        ) : (
          <p className="px-2 py-3 text-caption text-muted" data-testid="boards-empty">
            {t('boards.noBoards')}
          </p>
        )
      ) : null}
      {creator || manageAny ? <ArchivedBoards workspaceId={workspaceId} live={live} /> : null}
      {line !== null ? <div aria-hidden className="pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-accent" style={{ top: Math.max(0, line - 1) }} /> : null}
      {newCat ? <NewCategoryDialog workspaceId={workspaceId} onClose={() => setNewCat(false)} /> : null}
    </div>
  );
}

/**
 * A board category header (ADR-0058 §1): chevron + name, a click collapses it; with CREATE_BOARDS
 * a double click renames in place, the context menu renames / moves / deletes, a drag reorders.
 */
const CategoryHeader = memo(function CategoryHeader({
  id,
  workspaceId,
  creator,
  dragging,
  onPointerDown,
}: {
  id: string;
  workspaceId: string;
  creator: boolean;
  dragging: boolean;
  onPointerDown: (e: ReactPointerEvent, id: string) => void;
}): ReactNode {
  const name = useBoards((s) => s.categories[id]?.name ?? '');
  const collapsed = useBoardsUi((s) => !!s.collapsedCats[id]);
  const [editing, setEditing] = useState(false);
  const order = (): string[] => workspaceCategories(useBoards.getState().categories, workspaceId).map((c) => c.id);
  const step = (dir: -1 | 1): void => {
    const at = order().indexOf(id);
    if (at >= 0) void moveBoardCategory(workspaceId, id, at + dir);
  };
  const remove = async (): Promise<void> => {
    if (await confirmAction(t('boards.cat.deleteTitle', { name }), t('boards.cat.deleteText'), t('common.delete'))) void deleteBoardCategory(id);
  };
  const header = (
    <div data-bcat-header={id} onPointerDown={(e) => onPointerDown(e, id)} className={cx('group/bcat flex h-7 items-center pr-1 pt-1', dragging && 'opacity-40')} data-testid="board-category">
      {editing ? (
        <CategoryNameInput name={name} onDone={(v) => {
          setEditing(false);
          if (v !== null) void renameBoardCategory(id, v);
        }} />
      ) : (
        <button
          type="button"
          onClick={() => useBoardsUi.getState().toggleCategory(id)}
          onDoubleClick={creator ? () => setEditing(true) : undefined}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('shell.categoryExpand', { name }) : t('shell.categoryCollapse', { name })}
          title={name}
          className={cx('flex h-7 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-row)] pl-2 text-left transition-colors duration-[var(--motion-fast)] hover:text-fg mobile:h-8 mobile:gap-1 mobile:pl-3', GROUP_LABEL)}
          data-testid="board-category-toggle"
        >
          {/* Phone: the chevron first, as before; desktop (owner, 07.10): after the name, on hover. */}
          <ChevronDown className={cx('hidden size-3 shrink-0 transition-transform duration-[var(--motion-fast)] mobile:block', collapsed && '-rotate-90')} strokeWidth={2.25} aria-hidden />
          <span className="truncate">{name}</span>
          <GroupChevron collapsed={collapsed} className="mobile:hidden" />
        </button>
      )}
    </div>
  );
  if (!creator) return header;
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{header}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        {/* No focus return to the header: it would blur (and end) the inline rename right away. */}
        <ContextMenu.Content className={menuBox} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="board-category-menu">
          <ContextMenu.Item className={menuItem} onSelect={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden /> {t('shell.categoryRename')}
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparator} />
          <ContextMenu.Item className={menuItem} onSelect={() => step(-1)}>
            <ArrowUp className="size-4" aria-hidden /> {t('shell.moveUp')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => step(1)}>
            <ArrowDown className="size-4" aria-hidden /> {t('shell.moveDown')}
          </ContextMenu.Item>
          <ContextMenu.Separator className={menuSeparator} />
          <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
            <Trash2 className="size-4" aria-hidden /> {t('shell.categoryDelete')}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

/** Inline rename: Enter or leaving the field saves (`onDone(name)`), Esc cancels (`onDone(null)`). */
function CategoryNameInput({ name, onDone }: { name: string; onDone: (v: string | null) => void }): ReactNode {
  const [value, setValue] = useState(name);
  const finished = useRef(false);
  const finish = (v: string | null): void => {
    if (finished.current) return;
    finished.current = true;
    onDone(v === null ? null : v.trim() || null);
  };
  return (
    <input
      autoFocus
      aria-label={t('shell.categoryName')}
      value={value}
      maxLength={100}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      className="h-6 min-w-0 flex-1 rounded-[4px] bg-[var(--color-fill)] px-1.5 text-micro font-semibold uppercase tracking-[0.04em] text-fg outline-none ring-1 ring-accent"
      data-testid="board-category-name"
    />
  );
}

/** «Новая категория» (CREATE_BOARDS): goes on top of the categories. */
export function NewCategoryDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    const v = name.trim();
    if (!v) return;
    setBusy(true);
    const c = await createBoardCategory(workspaceId, v);
    setBusy(false);
    if (c) onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('boards.cat.new')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={!name.trim()} onClick={() => void submit()} data-testid="board-category-create">
            {t('common.create')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t('shell.categoryName')}>
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} data-testid="board-category-input" />
        </Field>
      </form>
    </Modal>
  );
}

function MyTasksRow({ workspaceId }: { workspaceId: string }): ReactNode {
  const active = useBoardsUi((s) => s.boardOf[workspaceId] === MY_TASKS);
  const unread = useBoards((s) => unreadCount(s, workspaceId));
  return (
    <button
      type="button"
      onClick={() => openBoard(workspaceId, MY_TASKS)}
      aria-current={active ? 'page' : undefined}
      className={cx('flex h-9 w-full items-center gap-2 rounded-[var(--radius-card)] px-2 text-left text-list mobile:h-[52px] mobile:gap-3 mobile:rounded-none mobile:px-3 mobile:text-body', active ? 'bg-active font-medium text-fg' : cx('text-muted hover:text-fg', ROW_HOVER))}
      data-testid="my-tasks"
    >
      <Inbox className="size-[18px] shrink-0 mobile:size-6" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t('boards.myTasks')}</span>
      {unread > 0 ? <CountBadge count={unread} tone="accent" /> : null}
    </button>
  );
}

const BoardRow = memo(function BoardRow({ id, workspaceId, dragging, onPointerDown }: { id: string; workspaceId: string; dragging: boolean; onPointerDown: (e: ReactPointerEvent, id: string) => void }): ReactNode {
  const name = useBoards((s) => s.boards[id]?.name ?? '');
  const emoji = useBoards((s) => s.boards[id]?.emoji ?? '');
  const priv = useBoards((s) => s.boards[id]?.isPrivate ?? false);
  const restricted = useBoards((s) => s.boards[id]?.restricted ?? false);
  const mine = useBoards((s) => s.boards[id]?.myOpenTasks ?? 0);
  const perms = useBoards((s) => s.boards[id]?.permissions);
  const scoped = useBoards((s) => s.boards[id]?.taskScoped ?? false);
  const active = useBoardsUi((s) => s.boardOf[workspaceId] === id);
  const manage = hasBit(perms, MANAGE_BOARD);
  const [forms, setForms] = useState(false);
  const formsOn = useFeatureOn(id, BoardFeature.FORMS);
  const archive = async (): Promise<void> => {
    if (await confirmAction(t('boards.archiveBoardTitle', { name }), t('boards.archiveBoardText'), t('boards.archiveBoard'))) void removeBoard(id, false);
  };
  return (
    <>
      {forms ? <BoardForms boardId={id} workspaceId={workspaceId} onClose={() => setForms(false)} /> : null}
      <div
        data-board-row={id}
        onPointerDown={(e) => onPointerDown(e, id)}
        className={cx('group/board relative flex items-center rounded-[var(--radius-card)] pr-1 mobile:static mobile:rounded-none', scoped ? 'min-h-8 py-0.5 mobile:min-h-[52px]' : 'h-9 mobile:h-[52px]', active ? 'bg-active' : ROW_HOVER, dragging && 'opacity-40')}
        data-testid="board-row"
      >
        <button type="button" onClick={() => openBoard(workspaceId, id)} aria-current={active ? 'page' : undefined} className={cx('flex min-w-0 flex-1 items-center gap-2 pl-2 text-left text-list mobile:gap-3 mobile:pl-3 mobile:text-body', scoped ? 'min-h-8 py-0.5 mobile:min-h-[52px]' : 'h-9 mobile:h-[52px]', active ? 'font-medium text-fg' : 'text-muted group-hover/board:text-fg')}>
          <span className="grid w-[18px] shrink-0 place-items-center text-[15px] leading-none mobile:w-7 mobile:text-[22px]" aria-hidden>
            {emoji || <SquareKanban className="size-[18px] mobile:size-6" />}
          </span>
          {scoped ? (
            <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
              <span className="w-full min-w-0 truncate">{name}</span>
              <span className="inline-flex h-5 max-w-full items-center rounded-full bg-hover px-2 text-micro font-medium text-muted" title={t('boards.scopedHint')} data-testid="board-scoped-chip">
                <span className="truncate">{t('boards.scopedChip')}</span>
              </span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{name}</span>
          )}
          {priv ? <Lock className="size-3.5 shrink-0 text-faint" aria-label={t('boards.private')} /> : null}
          {restricted ? <RestrictedMark /> : null}
          {mine > 0 ? (
            <span
              className="pointer-events-none absolute right-1 top-1/2 grid h-6 min-w-6 -translate-y-1/2 place-items-center rounded-[var(--radius-icon)] bg-[var(--color-fill)] px-1.5 text-caption tabular-nums text-muted group-hover/board:opacity-0 group-has-[[data-state=open]]/board:opacity-0 mobile:pointer-events-auto mobile:static mobile:h-[22px] mobile:min-w-[22px] mobile:translate-y-0 mobile:rounded-full mobile:px-1.5 mobile:text-fg mobile:group-hover/board:opacity-100"
              title={t('boards.myOpen')}
            >
              {mine}
            </span>
          ) : null}
        </button>
        <Dropdown.Root modal={false}>
          <Dropdown.Trigger asChild>
            <button type="button" data-row-menu aria-label={t('boards.boardMenu', { name })} className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 mobile:size-11 mobile:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/board:opacity-100 data-[state=open]:opacity-100">
              <Ellipsis className="size-4" aria-hidden />
            </button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className={cx(menuBox, 'min-w-56')} sideOffset={4} align="start" collisionPadding={16}>
              {manage ? (
                <>
                  <Dropdown.Item className={menuItem} onSelect={() => useBoardsUi.getState().openSettings({ boardId: id, workspaceId })}>
                    <Settings className="size-4" aria-hidden /> {t('boards.settings')}
                  </Dropdown.Item>
                  <Dropdown.Item className={menuItem} onSelect={() => useBoardsUi.getState().openSettings({ boardId: id, workspaceId, tab: 'access' })}>
                    <Shield className="size-4" aria-hidden /> {t('boards.access')}
                  </Dropdown.Item>
                </>
              ) : null}
              {manage ? <MoveToCategory id={id} workspaceId={workspaceId} /> : null}
              <Dropdown.Item className={menuItem} onSelect={() => copyText(boardLink(id), t('boards.linkCopied'))}>
                <Link2 className="size-4" aria-hidden /> {t('boards.copyLink')}
              </Dropdown.Item>
              {manage ? (
                <>
                  {formsOn ? (
                    <>
                      <Dropdown.Separator className={menuSeparator} />
                      <Dropdown.Item className={menuItem} onSelect={() => setForms(true)}>
                        <FileText className="size-4" aria-hidden /> {t('forms.title')}
                      </Dropdown.Item>
                    </>
                  ) : null}
                  <Dropdown.Separator className={menuSeparator} />
                  <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void archive()}>
                    <Archive className="size-4" aria-hidden /> {t('boards.archive')}
                  </Dropdown.Item>
                </>
              ) : null}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
    </>
  );
});

/** «В категорию ›» of a board's menu (MANAGE_BOARD): the end of the chosen container. */
function MoveToCategory({ id, workspaceId }: { id: string; workspaceId: string }): ReactNode {
  const current = useBoards((s) => s.boards[id]?.categoryId ?? '');
  const cats = useBoards(useShallow((s) => workspaceCategories(s.categories, workspaceId).map((c) => `${c.id}\u0000${c.name}`)));
  if (!cats.length) return null;
  const move = (categoryId: string): void => {
    const s = useBoards.getState();
    const n = workspaceBoards(s.boards, workspaceId).filter((b) => b.id !== id && (categoryId ? b.categoryId === categoryId : !b.categoryId || !s.categories[b.categoryId])).length;
    void moveBoardTo(workspaceId, id, { categoryId: categoryId || null, index: n });
  };
  const options = [`\u0000${t('boards.cat.none')}`, ...cats];
  return (
    <Dropdown.Sub>
      <Dropdown.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')} data-testid="board-move-category">
        <FolderInput className="size-4" aria-hidden /> <span className="flex-1">{t('boards.cat.moveTo')}</span> <ChevronRight className="size-4" aria-hidden />
      </Dropdown.SubTrigger>
      <Dropdown.Portal>
        <Dropdown.SubContent className={cx(menuBox, 'w-56')} sideOffset={4} collisionPadding={16}>
          {options.map((x) => {
            const [cid = '', label = ''] = x.split('\u0000');
            return (
              <Dropdown.Item key={cid || 'none'} className={menuItem} disabled={cid === current} onSelect={() => move(cid)}>
                {label}
              </Dropdown.Item>
            );
          })}
        </Dropdown.SubContent>
      </Dropdown.Portal>
    </Dropdown.Sub>
  );
}

/**
 * «Архив» under the boards (ADR-0042 §3, MANAGE_BOARD): the archived boards the viewer manages
 * (shown only when there are some; refetched when a board is archived / restored) —
 * «Восстановить» brings one back, the bin deletes it for good after the key is typed.
 */
function ArchivedBoards({ workspaceId, live }: { workspaceId: string; live: number }): ReactNode {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Board[]>([]);
  const [purge, setPurge] = useState<Board | null>(null);
  useEffect(() => {
    let alive = true;
    void listArchivedBoards(workspaceId).then((l) => {
      if (alive) setList(l);
    });
    return () => {
      alive = false;
    };
  }, [workspaceId, live]);
  const drop = (id: string): void => setList((l) => l.filter((b) => b.id !== id));
  if (!list.length && !purge) return null;
  return (
    <div className="pt-3" data-testid="boards-archive">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cx('flex h-7 w-full items-center gap-1 rounded-[var(--radius-row)] pl-1 pr-2 text-left hover:bg-hover hover:text-fg', GROUP_LABEL)}
        data-testid="boards-archive-toggle"
      >
        <ChevronRight className={cx('size-3.5 transition-transform duration-[var(--motion-fast)]', open && 'rotate-90')} aria-hidden />
        {t('boards.archiveSection')}
        <span className="font-normal tabular-nums">{list.length}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-px pt-0.5">
            {list.map((b) => (
              <div key={b.id} className="group/arch flex h-8 items-center gap-2 rounded-[var(--radius-row)] pl-2 pr-1 text-list text-muted hover:bg-hover" data-testid="archived-board">
                <span className="grid w-[18px] shrink-0 place-items-center text-[15px] leading-none opacity-60" aria-hidden>
                  {b.emoji || <SquareKanban className="size-[18px]" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                <Tip label={t('boards.restoreBoard')}>
                  <button
                    type="button"
                    aria-label={t('boards.restoreBoard')}
                    onClick={() =>
                      void restoreBoard(b.id).then((r) => {
                        if (r) drop(b.id);
                      })
                    }
                    className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] hover:bg-hover hover:text-fg"
                    data-testid="board-restore"
                  >
                    <ArchiveRestore className="size-4" aria-hidden />
                  </button>
                </Tip>
                <Tip label={t('boards.deleteBoard')}>
                  <button
                    type="button"
                    aria-label={t('boards.deleteBoard')}
                    onClick={() => setPurge(b)}
                    className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] hover:bg-hover hover:text-danger-text"
                    data-testid="board-purge"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </Tip>
              </div>
            ))}
        </div>
      ) : null}
      {purge ? <DeleteBoardDialog board={purge} onClose={() => setPurge(null)} onDone={() => drop(purge.id)} /> : null}
    </div>
  );
}
