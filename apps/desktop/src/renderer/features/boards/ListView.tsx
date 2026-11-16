import { statusShown } from '../../lib/boards/completion';
import { BoardFeature, TaskPriority, type Board, type Task, BoardStatusType } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { Archive, CalendarClock, Check, ChevronDown, CircleSlash, Rocket, Tag, UserRound, X } from 'lucide-react';
import { memo, useCallback, useMemo, type MouseEvent, type ReactNode } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useShallow } from 'zustand/react/shallow';
import { Button, Tip, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { addAssignee, draftsOf, toggleAssignee } from '../../lib/boards/assignees';
import { matchTask, type MatchCtx } from '../../lib/boards/filter';
import { latestRelease, releaseLabel, releasesOf } from '../../lib/boards/releases';
import { bulkArchive, bulkUpdate, pickStatus, setAssignees, updateTask } from '../../services/boards';
import { useBoards } from '../../stores/boards';
import { prefsOf, useBoardsUi, type BoardPrefs } from '../../stores/boardsUi';
import { myUserId } from '../../stores/session';
import { memberName } from '../../stores/workspaces';
import { AssigneeStack } from './AssigneeStack';
import { LabelsOverflow, stopClick, type LabelItem } from './LabelsOverflow';
import { AssigneeMenu, DateMenu, LabelMenu, MemberAvatar, PriorityMenu, StatusMenu, useToday } from './menus';
import { doneType, hasBit, mayArchiveTask, mayEditTask, sortedStatuses, CREATE_TASKS, MANAGE_BOARD } from './model';
import { ApprovalTag } from './Approvals';
import { featureOn, groupOn, sortOn } from '../../lib/boards/features';
import { tabClick } from './TaskTabs';
import { ChecklistBadge, MilestoneBadge, TaskContextMenu, useBlockedStatuses } from './TaskCard';
import { useDisabledFeatures, useMatchCtx } from './useBoardView';
import { useBoardScoped, useTaskPerms } from './useTaskPerms';
import { UnreadDot } from './UnreadDot';
import { UpdatedAge } from './UpdatedAge';
import { Dot, PRIORITY_LABEL, PriorityIcon, StatusIcon, formatDue, isOverdue } from './visuals';

/**
 * Fixed meta columns of a row (right-aligned, an empty cell when the value is absent) so approvals,
 * checklist, age, date and assignees line up across rows. Narrow windows drop the low-priority ones
 * (no wrapping); the phone layout has its own flow (auto width, empty cells hidden).
 */
const COL = 'flex shrink-0 items-center justify-end mobile:w-auto mobile:justify-start mobile:empty:hidden';
const COL_APPROVALS = cx(COL, 'w-[52px]');
const COL_CHECKLIST = cx(COL, 'w-[48px] min-[769px]:max-[1000px]:hidden');
const COL_UPDATED = cx(COL, 'w-[40px] text-micro min-[769px]:max-[1100px]:hidden');
const COL_DUE = cx(COL, 'w-[76px]');
// Fixed width and right-aligned on the phone too: the circles' right edge does not depend on how many there are (#92).
const COL_ASSIGNEE = 'flex w-[52px] shrink-0 items-center justify-end order-last mobile:order-none';

type Item = { kind: 'group'; key: string; label: ReactNode; count: number } | { kind: 'row'; id: string };

const PRIORITY_ORDER: Record<number, number> = { [TaskPriority.URGENT]: 0, [TaskPriority.HIGH]: 1, [TaskPriority.MEDIUM]: 2, [TaskPriority.LOW]: 3, [TaskPriority.NONE]: 4 };
const ms = (x: Task['updatedAt']): number => (x ? timestampMs(x) : 0);

/** Sorting inside a group (ADR-0042 §5: обновлено / срок / приоритет / ключ; manual = board order). */
export function sortTasks(list: Task[], sort: BoardPrefs['sort'], statusOrder: Map<string, number>): Task[] {
  const out = [...list];
  switch (sort) {
    case 'updated':
      return out.sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
    case 'due':
      return out.sort((a, b) => (a.dueOn || '9999').localeCompare(b.dueOn || '9999') || a.position - b.position);
    case 'priority':
      return out.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) || a.position - b.position);
    case 'key':
      return out.sort((a, b) => a.number - b.number);
    default:
      return out.sort((a, b) => (statusOrder.get(a.statusId) ?? 0) - (statusOrder.get(b.statusId) ?? 0) || a.position - b.position || (a.id < b.id ? -1 : 1));
  }
}

/** The list's flat rows: group headers + task ids (pure, for the virtual list and ↑↓). */
export function listItems(tasks: Task[], b: Board, prefs: BoardPrefs, workspaceId: string): Item[] {
  const statuses = sortedStatuses(b);
  const order = new Map(statuses.map((s, i) => [s.id, i]));
  const groups: Array<{ key: string; label: ReactNode; tasks: Task[] }> = [];
  // A grouping / sort by a feature the board switched off falls back (ADR-0058 §3; prefs kept).
  const sort = sortOn(prefs.sort, b.disabledFeatures) ? prefs.sort : 'manual';
  const push = (key: string, label: ReactNode, list: Task[]): void => {
    if (list.length) groups.push({ key, label, tasks: sortTasks(list, sort, order) });
  };
  switch (groupOn(prefs.groupBy, b.disabledFeatures) ? prefs.groupBy : 'status') {
    case 'status':
      for (const s of statuses)
        push(
          s.id,
          <>
            <StatusIcon type={s.type} color={s.color} icon={s.icon} /> {s.name}
          </>,
          tasks.filter((x) => x.statusId === s.id),
        );
      break;
    case 'assignee': {
      const leads = new Map<string, Task[]>();
      for (const x of tasks) {
        const k = x.assignees[0]?.userId ?? '';
        leads.set(k, [...(leads.get(k) ?? []), x]);
      }
      for (const [k, list] of [...leads].sort((a, b) => (a[0] ? memberName(workspaceId, a[0]) : '￿').localeCompare(b[0] ? memberName(workspaceId, b[0]) : '￿')))
        push(
          k || 'none',
          k ? (
            <>
              <MemberAvatar workspaceId={workspaceId} userId={k} size={18} /> {memberName(workspaceId, k)}
            </>
          ) : (
            <>
              <UserRound className="size-4" aria-hidden /> {t('boards.noAssignee')}
            </>
          ),
          list,
        );
      break;
    }
    case 'priority':
      for (const p of [TaskPriority.URGENT, TaskPriority.HIGH, TaskPriority.MEDIUM, TaskPriority.LOW, TaskPriority.NONE])
        push(
          String(p),
          <>
            <PriorityIcon priority={p} /> {t(PRIORITY_LABEL[p] ?? 'boards.prio.none')}
          </>,
          tasks.filter((x) => x.priority === p),
        );
      break;
    case 'label': {
      const labels = [...b.labels].sort((a, c) => a.position - c.position);
      const first = (x: Task): string => labels.find((l) => x.labelIds.includes(l.id))?.id ?? '';
      for (const l of labels)
        push(
          l.id,
          <>
            <Dot color={l.color} /> {l.name}
          </>,
          tasks.filter((x) => first(x) === l.id),
        );
      push(
        'none',
        <>
          <Tag className="size-4" aria-hidden /> {t('boards.noLabels')}
        </>,
        tasks.filter((x) => !first(x)),
      );
      break;
    }
    case 'milestone':
      for (const m of [...b.milestones].sort((a, c) => a.position - c.position)) push(m.id, m.name, tasks.filter((x) => x.milestoneId === m.id));
      push(
        'none',
        <>
          <CircleSlash className="size-4" aria-hidden /> {t('boards.noMilestone')}
        </>,
        tasks.filter((x) => !x.milestoneId || !b.milestones.some((m) => m.id === x.milestoneId)),
      );
      break;
    case 'release': {
      // Board task #101: by the task's newest release (any environment), newest releases first.
      const latest = new Map(tasks.map((x) => [x.id, latestRelease(x)?.releaseId ?? ''] as const));
      for (const r of releasesOf(tasks, true))
        push(
          r.id,
          <>
            <Rocket className="size-4" aria-hidden /> {releaseLabel(r)}
          </>,
          tasks.filter((x) => latest.get(x.id) === r.id),
        );
      push(
        'none',
        <>
          <CircleSlash className="size-4" aria-hidden /> {t('boards.noRelease')}
        </>,
        tasks.filter((x) => !latest.get(x.id)),
      );
      break;
    }
    default:
      push('all', t('boards.allTasks'), tasks);
  }
  const out: Item[] = [];
  for (const g of groups) {
    out.push({ kind: 'group', key: g.key, label: g.label, count: g.tasks.length });
    for (const x of g.tasks) out.push({ kind: 'row', id: x.id });
  }
  return out;
}

/** Ids of the rows as the list shows them (keyboard navigation, Shift-click ranges). */
export function useListIds(boardId: string, workspaceId: string): { items: Item[]; ids: string[] } {
  const prefs = useBoardsUi((s) => prefsOf(s, boardId));
  const ctx = useMatchCtx(boardId);
  const board = useBoards((s) => s.boards[boardId]);
  // A primitive «shape» of what grouping / sorting reads: a title edit (TASK_UPDATE) leaves it —
  // and the list — as they were; only the row of that task re-renders.
  const shape = useBoards((s) => {
    const b = s.boards[boardId];
    if (!b) return '';
    let out = '';
    for (const x of visibleOf(s, b, prefs, ctx)) out += `${x.id}|${x.statusId}|${x.position}|${x.priority}|${x.assignees[0]?.userId ?? ''}|${x.labelIds.join('.')}|${x.milestoneId}|${x.releases.map((r) => r.releaseId).join('.')}|${x.dueOn}|${prefs.sort === 'updated' ? ms(x.updatedAt) : ''};`;
    return out;
  });
  const items = useMemo(
    () => {
      const s = useBoards.getState();
      return board ? listItems(visibleOf(s, board, prefs, ctx), board, prefs, workspaceId) : [];
    },
    // `shape` stands for the tasks read through getState().
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shape, board, prefs, workspaceId, ctx],
  );
  const ids = useMemo(() => items.flatMap((x) => (x.kind === 'row' ? [x.id] : [])), [items]);
  return { items, ids };
}

function visibleOf(s: ReturnType<typeof useBoards.getState>, b: Board, prefs: BoardPrefs, ctx: MatchCtx): Task[] {
  const out: Task[] = [];
  for (const st of b.statuses) {
    if (!statusShown(prefs.completion, st.type)) continue;
    for (const id of s.columns[b.id]?.[st.id] ?? []) {
      const x = s.tasks[id];
      if (x && matchTask(x, prefs.filter, ctx)) out.push(x);
    }
  }
  return out;
}

/**
 * The list view (ADR-0042 §5): rows grouped (status by default), sorted, edited in place (status,
 * priority, assignee, due date, labels right in the row), multi-selection (X, Shift / ⌘-click) with
 * the bulk actions bar. Virtualized; rows are memo and select their own task.
 */
export function ListView({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const { items, ids } = useListIds(boardId, workspaceId);
  const selectedCount = useBoardsUi((s) => Object.keys(s.selected).length);
  // ADR-0059: no bulk actions on a board seen only through its cards.
  const scoped = useBoardScoped(boardId);
  const onRowClick = useCallback(
    (id: string, e: MouseEvent) => {
      const ui = useBoardsUi.getState();
      if (e.shiftKey && ui.focused) {
        const a = ids.indexOf(ui.focused);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          const sel: Record<string, true> = { ...ui.selected };
          for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) sel[x] = true;
          ui.setSelected(sel);
          return;
        }
      }
      if (tabClick(id, e, workspaceId, boardId)) return;
      if (e.metaKey || e.ctrlKey) {
        ui.toggleSelected(id);
        ui.setFocused(id);
        return;
      }
      ui.clearSelection();
      ui.setFocused(id);
      ui.openTask(id);
    },
    [ids, workspaceId, boardId],
  );
  if (items.length === 0) return <EmptyBoard />;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid="list-view">
      <Virtuoso
        className="scrollbar-thin"
        style={{ flex: 1 }}
        data={items}
        computeItemKey={(_, x) => (x.kind === 'group' ? `g:${x.key}` : x.id)}
        increaseViewportBy={400}
        itemContent={(_, x) =>
          x.kind === 'group' ? (
            <div className="sticky top-0 flex h-9 items-center gap-2 border-b border-line bg-[var(--color-bg)] px-4 text-control font-semibold" data-testid="list-group">
              {x.label}
              <span className="text-caption font-normal tabular-nums text-muted">{x.count}</span>
            </div>
          ) : (
            <ListRow id={x.id} boardId={boardId} workspaceId={workspaceId} onClick={onRowClick} selecting={selectedCount > 0} />
          )
        }
      />
      {selectedCount > 0 && !scoped ? <BulkBar boardId={boardId} workspaceId={workspaceId} /> : null}
    </div>
  );
}

export function EmptyBoard(): ReactNode {
  return <div className="grid flex-1 place-items-center p-8 text-center text-body text-muted" data-testid="board-empty">{t('boards.empty')}</div>;
}

const NO_LABELS: readonly LabelItem[] = [];

export const ListRow = memo(function ListRow({ id, boardId, boardLabel, workspaceId, onClick, selecting }: { id: string; boardId: string; boardLabel?: string; workspaceId: string; onClick: (id: string, e: MouseEvent) => void; selecting: boolean }): ReactNode {
  const task = useBoards((s) => s.tasks[id]);
  const perms = useTaskPerms(task);
  const scoped = useBoardScoped(boardId);
  const status = useBoards((s) => (task ? s.boards[boardId]?.statuses.find((x) => x.id === task.statusId) : undefined));
  const labels = useBoards((s) => s.boards[boardId]?.labels);
  const labelIds = task?.labelIds;
  const mine = useMemo(() => (labelIds ? (labels ?? []).filter((l) => labelIds.includes(l.id)) : NO_LABELS), [labels, labelIds]);
  const blocked = useBlockedStatuses(task, boardId);
  const selected = useBoardsUi((s) => !!s.selected[id]);
  const focused = useBoardsUi((s) => s.focused === id || s.taskId === id);
  const menu = useBoardsUi((s) => (s.menu?.taskId === id && !s.taskId ? s.menu.kind : null));
  const disabled = useDisabledFeatures(boardId);
  const today = useToday();
  const me = myUserId();
  if (!task) return null;
  const on = (f: BoardFeature): boolean => featureOn(disabled, f);
  const canEdit = mayEditTask(task, perms, me);
  const manage = !scoped && hasBit(perms, MANAGE_BOARD); // ADR-0108: may move past an incomplete approval
  const done = doneType(status?.type);
  const stop = (e: MouseEvent): void => e.stopPropagation();
  const req = (k: string): { open?: boolean; onOpenChange?: (v: boolean) => void } => (menu === k ? { open: true, onOpenChange: (v) => !v && useBoardsUi.getState().closeMenu() } : {});
  const names = task.assignees.map((a) => memberName(workspaceId, a.userId)).join(', ');
  const assigneeTip = names ? t('boards.tip.assignees', { names }) : t('boards.tip.noAssignee');
  const dueTip = task.dueOn ? t(isOverdue(task.dueOn, today, done) ? 'boards.tip.dueOverdue' : 'boards.tip.due', { date: formatDue(task.dueOn, today) }) : t('boards.f.dueOn');
  const cell = 'grid shrink-0 place-items-center rounded-[var(--radius-icon)] hover:bg-hover disabled:hover:bg-transparent';
  return (
    <TaskContextMenu task={task} canEdit={canEdit} canArchive={mayArchiveTask(task, perms, me)} manage={false}>
      <div
        data-selected={selected || undefined}
        data-testid="list-row"
        data-task={id}
        data-key={task.key}
        onClick={(e) => onClick(id, e)}
        className={cx(
          'group/row flex h-9 cursor-default items-center gap-2 border-b border-line pl-2 pr-3 text-control mobile:h-auto mobile:select-none mobile:min-h-14 mobile:flex-wrap mobile:content-center mobile:gap-y-0 mobile:py-2',
          selected ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]' : focused ? 'bg-active' : 'hover:bg-[color-mix(in_srgb,var(--color-fill)_50%,transparent)]',
        )}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={t('boards.select')}
          onClick={(e) => {
            stop(e);
            useBoardsUi.getState().toggleSelected(id);
          }}
          className={cx('tap-hit grid size-4 shrink-0 place-items-center rounded-[4px] border', selected ? 'border-transparent bg-accent-strong text-accent-fg' : 'border-[var(--color-fill-hover)]', !selected && !selecting && 'opacity-0 group-hover/row:opacity-100 mobile:hidden')}
          data-testid="row-select"
        >
          {selected ? <Check className="size-3" aria-hidden /> : null}
        </button>
        {on(BoardFeature.PRIORITY) ? (
          <PriorityMenu value={task.priority} onPick={(p) => p !== task.priority && void updateTask(id, { priority: p })} {...req('priority')}>
            <button type="button" onClick={stop} disabled={!canEdit} className={cx(cell, 'size-6')} aria-label={t('boards.f.priority')}>
              <PriorityIcon priority={task.priority} />
            </button>
          </PriorityMenu>
        ) : null}
        <span className="w-[64px] shrink-0 truncate text-caption tabular-nums text-muted mobile:hidden">{task.key}</span>
        <StatusMenu boardId={boardId} value={task.statusId} blocked={blocked} overridable={manage} onPick={(s) => void pickStatus(id, s, manage)} {...req('status')}>
          <button type="button" onClick={stop} disabled={!canEdit} className={cx(cell, 'size-6')} aria-label={t('boards.f.status')} data-testid="row-status">
            <StatusIcon type={status?.type ?? BoardStatusType.UNSPECIFIED} color={status?.color ?? 0} icon={status?.icon} />
          </button>
        </StatusMenu>
        <UnreadDot id={id} />
        <span className={cx('min-w-0 flex-1 truncate mobile:line-clamp-2 mobile:whitespace-normal mobile:text-body mobile:[overflow-wrap:anywhere]', done ? 'text-muted' : 'text-fg')}>{task.title}</span>
        {/* Placed here for the phone (end of the title line); `order-last` keeps it rightmost on desktop. */}
        <Tip label={assigneeTip}>
        <span className={COL_ASSIGNEE}>
        <AssigneeMenu
          workspaceId={workspaceId}
          boardId={boardId}
          value={task.assignees.map((a) => a.userId)}
          onToggle={(u) => void setAssignees(id, toggleAssignee(draftsOf(task.assignees), u))}
          onNone={() => void setAssignees(id, [])}
          align="end"
          {...req('assignee')}
        >
          <button type="button" onClick={stop} disabled={!canEdit} className="flex h-6 min-w-6 shrink-0 items-center justify-end rounded-[var(--radius-icon)] px-0.5 disabled:pointer-events-none" aria-label={t('boards.f.assignee')}>
            {task.assignees.length ? <AssigneeStack workspaceId={workspaceId} assignees={task.assignees} /> : <UserRound className="size-4 text-faint" aria-hidden />}
          </button>
        </AssigneeMenu>
        </span>
        </Tip>
        {/* phone: the meta (badges, date) wraps under the title, aligned with it */}
        <span className="hidden h-0 basis-full mobile:block" aria-hidden />
        <span className="hidden w-[56px] shrink-0 mobile:block" aria-hidden />
        {boardLabel ? (
          <span className="max-w-[150px] shrink truncate text-micro text-muted" data-testid="row-board">
            {boardLabel}
          </span>
        ) : null}
        {on(BoardFeature.APPROVALS) ? <ApprovalTag id={id} compact slot={COL_APPROVALS} /> : null}
        {on(BoardFeature.CHECKLISTS) ? <ChecklistBadge id={id} slot={COL_CHECKLIST} /> : null}
        {on(BoardFeature.MILESTONES) ? <MilestoneBadge id={id} /> : null}
        {on(BoardFeature.LABELS) && (mine.length || menu === 'label') ? (
          canEdit ? (
            <LabelMenu
              boardId={boardId}
              value={task.labelIds}
              canCreate={hasBit(perms, CREATE_TASKS) && !scoped}
              onToggle={(l) => void updateTask(id, { labelIds: task.labelIds.includes(l) ? task.labelIds.filter((x) => x !== l) : [...task.labelIds, l] })}
              align="end"
              {...req('label')}
            >
              <LabelsOverflow labels={mine} rows={1} interactive onClick={stopClick} className="max-w-[min(40%,9rem)] shrink mobile:hidden" />
            </LabelMenu>
          ) : (
            <LabelsOverflow labels={mine} rows={1} onClick={stopClick} className="max-w-[min(40%,9rem)] shrink mobile:hidden" />
          )
        ) : null}
        <UpdatedAge id={id} slot={COL_UPDATED} />
        {on(BoardFeature.DUE_DATE) ? (
          <Tip label={dueTip}>
          <span className={COL_DUE}>
          <DateMenu value={task.dueOn} onPick={(d) => void updateTask(id, { dueOn: d })} title={t('boards.f.dueOn')} align="end" {...req('due')}>
            <button
              type="button"
              onClick={stop}
              disabled={!canEdit}
              className={cx('inline-flex h-6 items-center justify-end gap-1 rounded-[var(--radius-icon)] px-1 text-caption tabular-nums hover:bg-hover disabled:pointer-events-none mobile:justify-start', isOverdue(task.dueOn, today, done) ? 'text-danger-text' : 'text-muted', !task.dueOn && 'opacity-0 group-hover/row:opacity-100 mobile:hidden')}
              aria-label={t('boards.f.dueOn')}
            >
              <CalendarClock className="size-3 shrink-0" aria-hidden />
              {task.dueOn ? formatDue(task.dueOn, today) : ''}
            </button>
          </DateMenu>
          </span>
          </Tip>
        ) : null}
      </div>
    </TaskContextMenu>
  );
});

/** Actions on the selected tasks (ADR-0042 §5: статус, исполнитель, лейбл, архив). */
function BulkBar({ boardId, workspaceId }: { boardId: string; workspaceId: string }): ReactNode {
  const sel = useBoardsUi(useShallow((s) => Object.keys(s.selected)));
  const clear = useBoardsUi((s) => s.clearSelection);
  const me = myUserId();
  const btn = 'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-control text-fg hover:bg-hover data-[state=open]:bg-active';
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4" data-testid="bulk-bar">
      <div className="mat-popover pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-full px-2 py-1 shadow-[var(--shadow-popover)]">
        <span className="whitespace-nowrap px-2 text-control font-medium tabular-nums">{plural('boards.selectedN', sel.length)}</span>
        <StatusMenu boardId={boardId} value="" onPick={(statusId) => void bulkUpdate(sel, { statusId })}>
          <button type="button" className={btn} data-testid="bulk-status">
            {t('boards.f.status')} <ChevronDown className="size-3.5" aria-hidden />
          </button>
        </StatusMenu>
        <PriorityMenu value={-1 as unknown as TaskPriority} onPick={(priority) => void bulkUpdate(sel, { priority })}>
          <button type="button" className={btn}>
            {t('boards.f.priority')} <ChevronDown className="size-3.5" aria-hidden />
          </button>
        </PriorityMenu>
        <AssigneeMenu
          workspaceId={workspaceId}
          boardId={boardId}
          value={[]}
          onToggle={(u) => {
            const s = useBoards.getState();
            for (const id of sel) {
              const x = s.tasks[id];
              if (x) void setAssignees(id, addAssignee(draftsOf(x.assignees), u));
            }
          }}
          onNone={() => sel.forEach((id) => void setAssignees(id, []))}
        >
          <button type="button" className={btn}>
            {t('boards.f.assignee')} <ChevronDown className="size-3.5" aria-hidden />
          </button>
        </AssigneeMenu>
        <LabelMenu
          boardId={boardId}
          value={[]}
          canCreate={false}
          onToggle={(l) => {
            const s = useBoards.getState();
            for (const id of sel) {
              const x = s.tasks[id];
              if (x && !x.labelIds.includes(l)) void updateTask(id, { labelIds: [...x.labelIds, l] });
            }
          }}
        >
          <button type="button" className={btn}>
            {t('boards.f.label')} <ChevronDown className="size-3.5" aria-hidden />
          </button>
        </LabelMenu>
        <Button
          variant="ghost"
          className="text-danger-text"
          onClick={() => {
            const s = useBoards.getState();
            const p = s.boards[boardId]?.permissions;
            void bulkArchive(sel.filter((id) => {
              const x = s.tasks[id];
              return !!x && mayArchiveTask(x, p, me);
            }));
            clear();
          }}
        >
          <Archive className="size-3.5" aria-hidden /> {t('boards.archive')}
        </Button>
        <button type="button" aria-label={t('boards.clearSelection')} onClick={clear} className="grid size-7 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export type { MatchCtx };
