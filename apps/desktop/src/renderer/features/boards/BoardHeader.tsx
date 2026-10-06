import { BoardForms } from './BoardForms';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Archive, Check, ChevronDown, Columns3, Download, Ellipsis, FileText, GanttChart, Layers, Link2, List, Plus, Settings, Shield, SlidersHorizontal, Trash2 } from 'lucide-react';
import { BoardFeature } from '@calaba/protocol';
import { useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Field, Input, Modal, Switch, Tip, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { groupOn, sortOn } from '../../lib/boards/features';
import { filterKey, fromTaskFilter } from '../../lib/boards/filter';
import { applyView, boardLink, copyText, deleteView, removeBoard, saveView } from '../../services/boards';
import { useBoards } from '../../stores/boards';
import { prefsOf, useBoardsUi, type BoardPrefs, type GroupBy, type SortBy, type ViewKind } from '../../stores/boardsUi';
import { myUserId } from '../../stores/session';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
import { FilterButton, QuickChips } from './FilterBar';
import { exportCsv } from './exportCsv';
import { hasBit, CREATE_TASKS, MANAGE_BOARD } from './model';
import { useDisabledFeatures, useFeatureOn, useMatchCtx, useViewKind } from './useBoardView';
import { useBoardScoped } from './useTaskPerms';
import { CreateButton } from '../../components/CreateButton';
import { NavButton } from '../../components/PhoneHeader';
import { useMobile } from '../../lib/mobile';

const KINDS: ReadonlyArray<{ kind: ViewKind; label: 'boards.view.kanban' | 'boards.view.list' | 'boards.view.timeline'; icon: typeof Columns3; key: string }> = [
  { kind: 'kanban', label: 'boards.view.kanban', icon: Columns3, key: '1' },
  { kind: 'list', label: 'boards.view.list', icon: List, key: '2' },
  { kind: 'timeline', label: 'boards.view.timeline', icon: GanttChart, key: '3' },
];

/**
 * The board header (ADR-0042 §5): emoji and name, saved views, `Канбан | Список | Таймлайн`,
 * «+ Задача» (C) and ⋯ (settings, access, link, CSV, archive); under it the filter row: «Фильтр»
 * (F), quick chips and «Отображение» (grouping, sort, «Показывать завершённые»).
 */
export function BoardHeader({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const name = useBoards((s) => s.boards[boardId]?.name ?? '');
  const emoji = useBoards((s) => s.boards[boardId]?.emoji ?? '');
  const perms = useBoards((s) => s.boards[boardId]?.permissions);
  const manage = hasBit(perms, MANAGE_BOARD);
  const mobile = useMobile();
  return (
    <div className="shrink-0">
      {/* Phone: the standard PhoneHeader row — «‹» · emoji + title on the free width · «+» · «…», 44 px targets, 16 px gutter. */}
      <header className={cx('flex h-12 items-center gap-2 border-b border-line pl-4 pr-2 mobile:gap-0.5 mobile:pl-0.5 mobile:pr-2', mobile && 'mat-toolbar')} data-testid="board-header">
        {mobile ? <NavButton /> : null}
        <span className="flex min-w-0 items-center gap-2 mobile:flex-1 mobile:pl-1.5">
          <span className="shrink-0 text-headline leading-none" aria-hidden>
            {emoji || '📋'}
          </span>
          <h1 className="min-w-0 truncate text-headline font-semibold mobile:text-list mobile:leading-5" title={name}>
            {name}
          </h1>
        </span>
        {mobile ? null : <ViewsMenu boardId={boardId} />}
        {mobile ? null : <span className="flex-1" />}
        {mobile ? null : <ViewSwitch boardId={boardId} />}
        {/* Phone: «…» then the accent «+» in the corner (the universal CreateButton); desktop: «+ Задача», then «…». */}
        {mobile ? <BoardMoreMenu boardId={boardId} workspaceId={workspaceId} manage={manage} /> : null}
        {hasBit(perms, CREATE_TASKS) ? (
          mobile ? (
            <CreateButton label={t('boards.newTask')} tip={false} onClick={() => useBoardsUi.getState().openCreate({ boardId })} data-testid="new-task" />
          ) : (
            <Tip label={t('boards.newTask')} shortcut="C">
              <Button size="md" aria-label={t('boards.newTask')} className="ml-1 h-7" onClick={() => useBoardsUi.getState().openCreate({ boardId })} data-testid="new-task">
                <Plus className="size-4" aria-hidden />
                <span>{t('boards.task')}</span>
              </Button>
            </Tip>
          )
        ) : null}
        {mobile ? null : <BoardMoreMenu boardId={boardId} workspaceId={workspaceId} manage={manage} />}
      </header>
      {mobile ? (
        <>
          <div className="flex h-12 items-center justify-between gap-2 pl-4 pr-1" data-testid="view-row">
            <ViewSwitch boardId={boardId} />
            <DisplayMenu boardId={boardId} />
          </div>
          <div className="relative">
            <div className="flex h-11 min-w-0 items-center gap-1.5 overflow-x-auto pl-4 [scrollbar-width:none]" data-testid="filter-row">
              <FilterButton boardId={boardId} workspaceId={workspaceId} />
              <span className="h-4 w-px shrink-0 bg-line" aria-hidden />
              <QuickChips boardId={boardId} />
              {/* A real end gap: WebKit drops the padding at the end of a flex scroller. */}
              <span className="w-4 shrink-0" aria-hidden />
            </div>
            <span className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--color-bg)] to-transparent" aria-hidden />
          </div>
        </>
      ) : (
        <div className="flex h-10 min-w-0 items-center gap-1.5 overflow-x-auto px-3" data-testid="filter-row">
          <FilterButton boardId={boardId} workspaceId={workspaceId} />
          <span className="h-4 w-px shrink-0 bg-line" aria-hidden />
          <QuickChips boardId={boardId} />
          <span className="flex-1" />
          <DisplayMenu boardId={boardId} />
        </div>
      )}
    </div>
  );
}

/** `Канбан | Список | Таймлайн` (1 / 2 / 3); on a phone icons only, in the filter row. */
function ViewSwitch({ boardId }: { boardId: string }): ReactNode {
  const kind = useViewKind(boardId);
  const setPrefs = useBoardsUi((s) => s.setPrefs);
  // TIMELINE off (ADR-0058 §3): no «Таймлайн» (a saved timeline view opens as the list).
  const timeline = useFeatureOn(boardId, BoardFeature.TIMELINE);
  return (
        <div role="radiogroup" aria-label={t('boards.view.label')} className="inline-flex h-7 shrink-0 items-center rounded-[var(--radius-control)] bg-hover p-0.5 mobile:h-auto" data-testid="view-switch">
          {KINDS.filter((k) => timeline || k.kind !== 'timeline').map((k) => (
            <Tip key={k.kind} label={t(k.label)} shortcut={k.key}>
              <button
                type="button"
                role="radio"
                aria-checked={kind === k.kind}
                aria-label={t(k.label)}
                onClick={() => setPrefs(boardId, { kind: k.kind })}
                className={cx(
                  'inline-flex h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-control font-medium transition-colors duration-[var(--motion-fast)] mobile:h-9 mobile:w-12 mobile:px-0',
                  kind === k.kind ? 'bg-[var(--color-segment-on)] text-fg shadow-[var(--shadow-segment)]' : 'text-fg hover:bg-[var(--color-fill)]',
                )}
                data-testid={`view-${k.kind}`}
              >
                <k.icon className="size-3.5 mobile:size-5" aria-hidden />
                <span className="mobile:hidden">{t(k.label)}</span>
              </button>
            </Tip>
          ))}
        </div>
  );
}

/** Saved views: shared and mine; «Сохранить как вид» when the filter is not a saved one. */
function ViewsMenu({ boardId }: { boardId: string }): ReactNode {
  const views = useBoards((s) => s.boards[boardId]?.views);
  const perms = useBoards((s) => s.boards[boardId]?.permissions);
  // ADR-0059: views are read-only (applying one works, saving / deleting is a 403) on a scoped board.
  const scoped = useBoardScoped(boardId);
  const prefs = useBoardsUi((s) => prefsOf(s, boardId));
  const [saving, setSaving] = useState(false);
  const current = views?.find((v) => v.id === prefs.viewId);
  const changed = !!current && filterKey(fromTaskFilter(current.filter)) !== filterKey(prefs.filter);
  const me = myUserId();
  const shared = (views ?? []).filter((v) => v.shared);
  const mine = (views ?? []).filter((v) => !v.shared && v.createdBy === me);
  const item = (v: NonNullable<typeof views>[number]): ReactNode => (
    <Dropdown.Item key={v.id} className={menuItem} onSelect={() => applyView(boardId, v, fromTaskFilter)} data-testid="view-item">
      {v.id === prefs.viewId ? <Check className="size-3.5" aria-hidden /> : <span className="size-3.5" />}
      <span className="min-w-0 flex-1 truncate">{v.name}</span>
    </Dropdown.Item>
  );
  return (
    <>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" className="inline-flex h-7 min-w-0 shrink items-center gap-1 rounded-full px-2 text-control text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active" data-testid="views-menu">
            <Layers className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{current ? current.name : t('boards.allTasks')}</span>
            {changed ? <span className="size-1.5 shrink-0 rounded-full bg-accent" title={t('boards.viewChanged')} /> : null}
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="start" collisionPadding={16}>
            <Dropdown.Item className={menuItem} onSelect={() => useBoardsUi.getState().setPrefs(boardId, { viewId: '', filter: { conds: [], any: false } })}>
              {!prefs.viewId ? <Check className="size-3.5" aria-hidden /> : <span className="size-3.5" />}
              {t('boards.allTasks')}
            </Dropdown.Item>
            {shared.length ? (
              <>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Label className={menuLabel}>{t('boards.sharedViews')}</Dropdown.Label>
                {shared.map(item)}
              </>
            ) : null}
            {mine.length ? (
              <>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Label className={menuLabel}>{t('boards.myViews')}</Dropdown.Label>
                {mine.map(item)}
              </>
            ) : null}
            {scoped ? null : (
              <>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={menuItem} onSelect={() => setSaving(true)} data-testid="save-view">
                  <Plus className="size-4" aria-hidden /> {t('boards.saveView')}
                </Dropdown.Item>
              </>
            )}
            {!scoped && current && (current.shared ? hasBit(perms, MANAGE_BOARD) : current.createdBy === me) ? (
              <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void deleteView(boardId, current.id)}>
                <Trash2 className="size-4" aria-hidden /> {t('boards.deleteView')}
              </Dropdown.Item>
            ) : null}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {saving ? <SaveViewDialog boardId={boardId} prefs={prefs} canShare={hasBit(perms, MANAGE_BOARD)} onClose={() => setSaving(false)} /> : null}
    </>
  );
}

function SaveViewDialog({ boardId, prefs, canShare, onClose }: { boardId: string; prefs: BoardPrefs; canShare: boolean; onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    if (!name.trim()) return;
    setBusy(true);
    void saveView(boardId, name.trim(), shared, prefs).then((v) => {
      setBusy(false);
      if (v) onClose();
    });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('boards.saveView')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} busy={busy} disabled={!name.trim()} data-testid="save-view-submit">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <Field label={t('boards.viewName')}>
          <Input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-testid="view-name" />
        </Field>
        {canShare ? <Switch checked={shared} onChange={setShared} label={t('boards.viewShared')} hint={t('boards.viewSharedHint')} /> : null}
      </form>
    </Modal>
  );
}

const GROUPS: ReadonlyArray<{ v: GroupBy; label: 'boards.group.status' | 'boards.group.assignee' | 'boards.group.priority' | 'boards.group.label' | 'boards.group.milestone' | 'boards.group.none' }> = [
  { v: 'status', label: 'boards.group.status' },
  { v: 'assignee', label: 'boards.group.assignee' },
  { v: 'priority', label: 'boards.group.priority' },
  { v: 'label', label: 'boards.group.label' },
  { v: 'milestone', label: 'boards.group.milestone' },
  { v: 'none', label: 'boards.group.none' },
];
const SORTS: ReadonlyArray<{ v: SortBy; label: 'boards.sort.manual' | 'boards.sort.updated' | 'boards.sort.due' | 'boards.sort.priority' | 'boards.sort.key' }> = [
  { v: 'manual', label: 'boards.sort.manual' },
  { v: 'updated', label: 'boards.sort.updated' },
  { v: 'due', label: 'boards.sort.due' },
  { v: 'priority', label: 'boards.sort.priority' },
  { v: 'key', label: 'boards.sort.key' },
];

/** «Отображение»: grouping and sort (the list), «Показывать завершённые». */
function DisplayMenu({ boardId }: { boardId: string }): ReactNode {
  const prefs = useBoardsUi((s) => prefsOf(s, boardId));
  const kind = useViewKind(boardId);
  const disabled = useDisabledFeatures(boardId);
  const set = (p: Partial<BoardPrefs>): void => useBoardsUi.getState().setPrefs(boardId, p);
  const sel = 'h-7 rounded-[var(--radius-control)] border border-line bg-elev px-2 text-control text-fg';
  const mobile = useMobile();
  // Phone: «Показывать завершённые» lives in «…»; the popover is for the list's grouping / sort and hidden columns only.
  if (mobile && kind !== 'list' && !prefs.hidden.length) return null;
  return (
    <Popover.Root modal={false}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={t('boards.display')} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-control text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active mobile:size-11 mobile:justify-center mobile:px-0" data-testid="display-menu">
          <SlidersHorizontal className="size-3.5 mobile:size-5" aria-hidden />
          <span className="mobile:hidden">{t('boards.display')}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={8} className="mat-popover anim-in z-[var(--z-popover)] flex w-[280px] flex-col gap-3 rounded-[var(--radius-card)] p-3 text-body">
          {kind === 'list' ? (
            <>
              <label className="flex items-center justify-between gap-3">
                <span className="text-muted">{t('boards.groupBy')}</span>
                <select className={sel} value={groupOn(prefs.groupBy, disabled) ? prefs.groupBy : 'status'} onChange={(e) => set({ groupBy: e.target.value as GroupBy })} data-testid="group-by">
                  {GROUPS.filter((g) => groupOn(g.v, disabled)).map((g) => (
                    <option key={g.v} value={g.v}>
                      {t(g.label)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-muted">{t('boards.sortBy')}</span>
                <select className={sel} value={sortOn(prefs.sort, disabled) ? prefs.sort : 'manual'} onChange={(e) => set({ sort: e.target.value as SortBy })} data-testid="sort-by">
                  {SORTS.filter((g) => sortOn(g.v, disabled)).map((g) => (
                    <option key={g.v} value={g.v}>
                      {t(g.label)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {mobile ? null : (
            <div className="flex items-center justify-between gap-3">
              <span>{t('boards.showCompleted')}</span>
              <Toggle label={t('boards.showCompleted')} checked={prefs.showCompleted} onChange={(v) => set({ showCompleted: v })} />
            </div>
          )}
          {prefs.hidden.length ? (
            <button type="button" className="self-start text-caption text-accent-text hover:underline" onClick={() => set({ hidden: [] })}>
              {t('boards.showHidden', { n: prefs.hidden.length })}
            </button>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function BoardMoreMenu({ boardId, workspaceId, manage }: { boardId: string; workspaceId: string; manage: boolean }): ReactNode {
  const ctx = useMatchCtx(boardId);
  const mobile = useMobile();
  const showCompleted = useBoardsUi((s) => prefsOf(s, boardId).showCompleted);
  const [forms, setForms] = useState(false);
  const formsOn = useFeatureOn(boardId, BoardFeature.FORMS);
  const archive = async (): Promise<void> => {
    const b = useBoards.getState().boards[boardId];
    if (!b) return;
    if (await confirmAction(t('boards.archiveBoardTitle', { name: b.name }), t('boards.archiveBoardText'), t('boards.archiveBoard'))) void removeBoard(boardId, false);
  };
  return (
    <>
      {forms ? <BoardForms boardId={boardId} workspaceId={workspaceId} onClose={() => setForms(false)} /> : null}
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button type="button" aria-label={t('boards.more')} className="grid size-7 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active mobile:size-11" data-testid="board-more">
            <Ellipsis className="size-[18px] mobile:size-5" aria-hidden />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="end" collisionPadding={16}>
            {manage ? (
              <>
                <Dropdown.Item className={menuItem} onSelect={() => useBoardsUi.getState().openSettings({ boardId, workspaceId })} data-testid="board-settings">
                  <Settings className="size-4" aria-hidden /> {t('boards.settings')}
                </Dropdown.Item>
                <Dropdown.Item className={menuItem} onSelect={() => useBoardsUi.getState().openSettings({ boardId, workspaceId, tab: 'access' })}>
                  <Shield className="size-4" aria-hidden /> {t('boards.access')}
                </Dropdown.Item>
                <Dropdown.Separator className={menuSeparator} />
              </>
            ) : null}
            {mobile ? (
              <>
                <Dropdown.CheckboxItem className={menuItem} checked={showCompleted} onCheckedChange={(v) => useBoardsUi.getState().setPrefs(boardId, { showCompleted: v })} data-testid="show-completed">
                  {showCompleted ? <Check className="size-4" aria-hidden /> : <span className="size-4" />} {t('boards.showCompleted')}
                </Dropdown.CheckboxItem>
                <Dropdown.Separator className={menuSeparator} />
              </>
            ) : null}
            <Dropdown.Item className={menuItem} onSelect={() => copyText(boardLink(boardId), t('boards.linkCopied'))}>
              <Link2 className="size-4" aria-hidden /> {t('boards.copyLink')}
            </Dropdown.Item>
            <Dropdown.Item className={menuItem} onSelect={() => exportCsv(boardId, ctx)}>
              <Download className="size-4" aria-hidden /> {t('boards.exportCsv')}
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
    </>
  );
}
