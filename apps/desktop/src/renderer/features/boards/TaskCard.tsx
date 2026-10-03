import * as ContextMenu from '@radix-ui/react-context-menu';
import { BoardFeature, type Task } from '@calaba/protocol';
import { CalendarClock, ChevronRight, Copy, CopyPlus, GitFork, Link2, ListChecks, MessageSquare, Archive, UserPlus, SquareArrowOutUpRight, UserRound } from 'lucide-react';
import { memo, useCallback, useMemo, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { blockedStatusIds } from '../../lib/boards/approvals';
import { addAssignee, draftsOf, toggleAssignee } from '../../lib/boards/assignees';
import { archiveTask, copyTaskKey, copyTaskLink, duplicateTask, setAssignees, updateTask } from '../../services/boards';
import { featureOn } from '../../lib/boards/features';
import { checklistProgress, useBoards } from '../../stores/boards';
import { useBoardsUi, type CardMenu } from '../../stores/boardsUi';
import { myUserId } from '../../stores/session';
import { memberName } from '../../stores/workspaces';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { DRAG_USER, dragKind } from '../calendar/dragState';
import { ApprovalBadge } from './Approvals';
import { AssigneeMenu, DateMenu, LabelMenu, MemberAvatar, PriorityMenu, StatusMenu, useToday } from './menus';
import { doneType, hasBit, mayArchiveTask, mayEditTask, CREATE_TASKS, MANAGE_BOARD } from './model';
import { Dot, PRIORITY_LABEL, PriorityIcon, StatusIcon, formatDue, isOverdue, PRIORITIES } from './visuals';
import { chordLabel, BOARD_HOTKEYS, type BoardHotkeyId } from './hotkeys';
import { IS_MAC } from '../../services/hotkeys';
import { useDisabledFeatures, useFeatureOn } from './useBoardView';
import { useBoardScoped, useTaskPerms } from './useTaskPerms';

/** A label dragged onto a card (from the panel / settings): the card gets it. */
export const DRAG_LABEL = 'application/x-calab-label';

const keyOf = (id: BoardHotkeyId): string => {
  const c = BOARD_HOTKEYS.find((h) => h.id === id)?.chords[0];
  return c ? chordLabel(c, IS_MAC) : '';
};

/**
 * A kanban card (ADR-0042 §5, owner: «элементы разные кликабельные»): key, status glyph,
 * title (2 lines), labels, priority, due date (red when overdue), assignees (lead first, with a
 * dot; tooltip «Имя — за что отвечает»), subtask / comment counters. Every element opens its
 * menu in place without opening the task; a click elsewhere opens the task panel. Memo, selects
 * its own task by id: a TASK_UPDATE re-renders this card only.
 */
export const TaskCard = memo(function TaskCard({
  id,
  workspaceId,
  boardId,
  dragging = false,
  onPointerDownCapture,
}: {
  id: string;
  workspaceId: string;
  boardId: string;
  /** The card is the source of a drag (faded; the overlay moves). */
  dragging?: boolean;
  onPointerDownCapture?: (e: React.PointerEvent) => void;
}): ReactNode {
  const task = useBoards((s) => s.tasks[id]);
  const perms = useTaskPerms(task);
  const scoped = useBoardScoped(boardId);
  const statusType = useBoards((s) => (task ? s.boards[boardId]?.statuses.find((x) => x.id === task.statusId)?.type : undefined));
  const statusColor = useBoards((s) => (task ? (s.boards[boardId]?.statuses.find((x) => x.id === task.statusId)?.color ?? 0) : 0));
  const blocked = useBlockedStatuses(task, boardId);
  const focused = useBoardsUi((s) => s.focused === id);
  const selected = useBoardsUi((s) => !!s.selected[id]);
  const open = useBoardsUi((s) => s.taskId === id);
  const menuReq = useBoardsUi((s) => (s.menu?.taskId === id ? s.menu : null));
  const today = useToday();
  // Board features (ADR-0058 §3): the board's array, stable until BOARD_UPDATE.
  const disabled = useDisabledFeatures(boardId);
  const [dropOver, setDropOver] = useState(false);
  const me = myUserId();

  const onClick = useCallback(
    (e: MouseEvent) => {
      const ui = useBoardsUi.getState();
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        ui.toggleSelected(id);
        ui.setFocused(id);
        return;
      }
      ui.clearSelection();
      ui.setFocused(id);
      ui.openTask(id);
    },
    [id],
  );

  if (!task) return null;
  const on = (f: BoardFeature): boolean => featureOn(disabled, f);
  const canEdit = mayEditTask(task, perms, me);
  const done = doneType(statusType);
  const overdue = isOverdue(task.dueOn, today, done);

  // Native drops: a member → assignee, a label → label (owner: «участника … на карточку»).
  const onDragOver = (e: DragEvent): void => {
    if (!canEdit) return;
    const kind = dragKind(e.dataTransfer);
    if (kind === 'user' || (on(BoardFeature.LABELS) && e.dataTransfer.types.includes(DRAG_LABEL))) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!dropOver) setDropOver(true);
    }
  };
  const onDrop = (e: DragEvent): void => {
    setDropOver(false);
    const userId = e.dataTransfer.getData(DRAG_USER);
    const labelId = e.dataTransfer.getData(DRAG_LABEL);
    if (!userId && !labelId) return;
    e.preventDefault();
    if (userId) void setAssignees(id, addAssignee(draftsOf(task.assignees), userId));
    if (labelId && !task.labelIds.includes(labelId)) void updateTask(id, { labelIds: [...task.labelIds, labelId] });
  };

  const menuOpen = (kind: CardMenu): { open?: boolean; onOpenChange?: (v: boolean) => void } =>
    menuReq?.kind === kind ? { open: true, onOpenChange: (v: boolean) => !v && useBoardsUi.getState().closeMenu() } : {};

  const stop = (e: MouseEvent): void => e.stopPropagation();
  const chip = 'inline-flex h-5 max-w-full items-center gap-1 rounded-full border border-line px-1.5 text-micro text-muted transition-colors duration-[var(--motion-fast)] hover:border-[var(--color-fill-hover)] hover:text-fg';

  const card = (
    <article
      aria-label={`${task.key} ${task.title}`}
      data-open={open || undefined}
      data-testid="task-card"
      data-task={id}
      data-key={task.key}
      onClick={onClick}
      onPointerDownCapture={onPointerDownCapture}
      onDragOver={onDragOver}
      onDragLeave={() => setDropOver(false)}
      onDrop={onDrop}
      className={cx(
        'group/card relative flex cursor-default select-none flex-col gap-1.5 rounded-[var(--radius-card)] border bg-elev px-3 py-2.5 text-left transition-[border-color,opacity] duration-[var(--motion-fast)]',
        open || focused ? 'border-accent' : selected ? 'border-[color-mix(in_srgb,var(--color-accent)_60%,transparent)]' : 'border-line hover:border-[var(--color-fill-hover)]',
        selected && 'bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg-elevated))]',
        dragging && 'opacity-40',
        dropOver && 'ring-2 ring-accent',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            copyTaskLink(task.key);
          }}
          title={t('boards.copyLink')}
          className="min-w-0 truncate rounded-[4px] text-caption tabular-nums text-muted hover:text-fg"
          data-testid="card-key"
        >
          {task.key}
        </button>
        <span className="flex-1" />
        <AssigneeMenu
          workspaceId={workspaceId}
          boardId={boardId}
          value={task.assignees.map((a) => a.userId)}
          onToggle={(u) => void setAssignees(id, toggleAssignee(draftsOf(task.assignees), u))}
          onNone={() => void setAssignees(id, [])}
          align="end"
          {...menuOpen('assignee')}
        >
          <button type="button" onClick={stop} disabled={!canEdit} aria-label={t('boards.f.assignee')} className="flex shrink-0 items-center -space-x-1.5 rounded-full disabled:cursor-default" data-testid="card-assignees">
            {task.assignees.length === 0 ? (
              <UserRound className="size-4 text-faint" aria-hidden />
            ) : (
              task.assignees.slice(0, 3).map((a) => (
                <span key={a.userId} className="relative rounded-full ring-2 ring-[var(--color-bg-elevated)]" title={a.note ? `${memberName(workspaceId, a.userId)} — ${a.note}` : memberName(workspaceId, a.userId)}>
                  <MemberAvatar workspaceId={workspaceId} userId={a.userId} size={20} />
                  {a.isLead && task.assignees.length > 1 ? <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-accent ring-2 ring-[var(--color-bg-elevated)]" aria-hidden /> : null}
                </span>
              ))
            )}
            {task.assignees.length > 3 ? <span className="grid size-5 place-items-center rounded-full bg-hover text-micro text-muted ring-2 ring-[var(--color-bg-elevated)]">+{task.assignees.length - 3}</span> : null}
          </button>
        </AssigneeMenu>
      </div>
      <div className="flex min-w-0 items-start gap-2">
        <StatusMenu boardId={boardId} value={task.statusId} blocked={blocked} onPick={(s) => s !== task.statusId && void updateTask(id, { statusId: s })} {...menuOpen('status')}>
          <button type="button" onClick={stop} disabled={!canEdit} aria-label={t('boards.f.status')} className="mt-[3px] shrink-0 rounded-full disabled:cursor-default" data-testid="card-status">
            <StatusIcon type={statusType ?? 0} color={statusColor} />
          </button>
        </StatusMenu>
        <span className={cx('line-clamp-2 min-w-0 flex-1 break-words text-control font-medium', done ? 'text-muted' : 'text-fg')} data-testid="card-title">
          {task.title}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {on(BoardFeature.PRIORITY) ? (
          <PriorityMenu value={task.priority} onPick={(p) => p !== task.priority && void updateTask(id, { priority: p })} {...menuOpen('priority')}>
            <button type="button" onClick={stop} disabled={!canEdit} aria-label={`${t('boards.f.priority')}: ${t(PRIORITY_LABEL[task.priority] ?? 'boards.prio.none')}`} className={cx(chip, 'px-1')} data-testid="card-priority">
              <PriorityIcon priority={task.priority} />
            </button>
          </PriorityMenu>
        ) : null}
        {on(BoardFeature.LABELS) ? <CardLabels task={task} boardId={boardId} canEdit={canEdit} canCreate={hasBit(perms, CREATE_TASKS) && !scoped} chip={chip} req={menuOpen('label')} /> : null}
        {on(BoardFeature.DUE_DATE) && (task.dueOn || menuReq?.kind === 'due') ? (
          <DateMenu value={task.dueOn} onPick={(d) => void updateTask(id, { dueOn: d })} title={t('boards.f.dueOn')} {...menuOpen('due')}>
            <button type="button" onClick={stop} disabled={!canEdit} className={cx(chip, overdue && 'border-[color-mix(in_srgb,var(--color-red)_45%,transparent)] text-danger-text')} data-testid="card-due">
              <CalendarClock className="size-3" aria-hidden />
              {task.dueOn ? formatDue(task.dueOn, today) : t('boards.f.dueOn')}
            </button>
          </DateMenu>
        ) : null}
        {on(BoardFeature.APPROVALS) ? <ApprovalBadge task={task} /> : null}
        {on(BoardFeature.SUBTASKS) && task.subtaskCount > 0 ? (
          <span className="inline-flex h-5 items-center gap-1 px-1 text-micro tabular-nums text-muted" title={t('boards.subtasks')}>
            <GitFork className="size-3" aria-hidden />
            {task.subtaskDone}/{task.subtaskCount}
          </span>
        ) : null}
        {on(BoardFeature.CHECKLISTS) ? <ChecklistBadge id={id} /> : null}
        {on(BoardFeature.COMMENTS) && task.commentCount > 0 ? (
          <span className="inline-flex h-5 items-center gap-1 px-1 text-micro tabular-nums text-muted" title={t('boards.comments')}>
            <MessageSquare className="size-3" aria-hidden />
            {task.commentCount}
          </span>
        ) : null}
        {task.unread ? <span role="img" className="ml-auto size-2 rounded-full bg-accent" aria-label={t('boards.unread')} /> : null}
      </div>
    </article>
  );

  return <TaskContextMenu task={task} canEdit={canEdit} canArchive={mayArchiveTask(task, perms, me)} manage={!scoped && hasBit(perms, MANAGE_BOARD)}>{card}</TaskContextMenu>;
});

/**
 * The card's checklist progress «3/7» (ADR-0058 §2, always shown when the task has items): a leaf
 * subscribed to the counters only — a tick in the panel re-renders this chip, not the card.
 */
export const ChecklistBadge = memo(function ChecklistBadge({ id }: { id: string }): ReactNode {
  const text = useBoards((s) => checklistProgress(s, id));
  if (!text) return null;
  return (
    <span className="inline-flex h-5 items-center gap-1 px-1 text-micro tabular-nums text-muted" title={t('boards.cl.title')} data-testid="card-checklist">
      <ListChecks className="size-3" aria-hidden />
      {text}
    </span>
  );
});

/**
 * Statuses a task waiting for approval may not go to (ADR-0049), stable while its approval state,
 * status and the board's statuses stay (the status menu memoizes on it).
 */
export function useBlockedStatuses(task: Task | undefined, boardId: string): ReadonlySet<string> | undefined {
  const statuses = useBoards((s) => s.boards[boardId]?.statuses);
  const state = task?.approvalState ?? 0;
  const statusId = task?.statusId ?? '';
  return useMemo(() => (statuses ? blockedStatusIds({ approvalState: state, statusId }, statuses) : undefined), [statuses, state, statusId]);
}

function CardLabels({ task, boardId, canEdit, canCreate, chip, req }: { task: Task; boardId: string; canEdit: boolean; canCreate: boolean; chip: string; req: { open?: boolean; onOpenChange?: (v: boolean) => void } }): ReactNode {
  const labels = useBoards((s) => s.boards[boardId]?.labels);
  const mine = (labels ?? []).filter((l) => task.labelIds.includes(l.id));
  if (mine.length === 0 && !req.open) return null;
  return (
    <LabelMenu
      boardId={boardId}
      value={task.labelIds}
      canCreate={canCreate}
      onToggle={(l) => void updateTask(task.id, { labelIds: task.labelIds.includes(l) ? task.labelIds.filter((x) => x !== l) : [...task.labelIds, l] })}
      {...req}
    >
      <button type="button" onClick={(e) => e.stopPropagation()} disabled={!canEdit} className="inline-flex min-w-0 max-w-full items-center gap-1" data-testid="card-labels">
        {mine.map((l) => (
          <span key={l.id} className={cx(chip, 'min-w-0')}>
            <Dot color={l.color} />
            <span className="truncate">{l.name}</span>
          </span>
        ))}
      </button>
    </LabelMenu>
  );
}

/** Right click on a card / row: the actions of the hotkeys, with their keys. */
export function TaskContextMenu({ task, canEdit, canArchive, manage, children }: { task: Task; canEdit: boolean; canArchive: boolean; manage: boolean; children: ReactNode }): ReactNode {
  const statuses = useBoards((s) => s.boards[task.boardId]?.statuses);
  const blocked = useBlockedStatuses(task, task.boardId);
  const priority = useFeatureOn(task.boardId, BoardFeature.PRIORITY);
  const scoped = useBoardScoped(task.boardId);
  const me = myUserId();
  const kbd = (id: BoardHotkeyId): ReactNode => <span className="ml-auto pl-4 text-caption text-muted group-data-[highlighted]:text-inherit">{keyOf(id)}</span>;
  const item = cx(menuItem, 'group');
  const sub = cx(menuItem, 'group data-[state=open]:not-data-[highlighted]:bg-hover');
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-60')} data-testid="task-context-menu">
          <ContextMenu.Item className={item} onSelect={() => useBoardsUi.getState().openTask(task.id)}>
            <SquareArrowOutUpRight className="size-4" aria-hidden /> {t('boards.open')}
            {kbd('open')}
          </ContextMenu.Item>
          {canEdit ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger className={sub}>
                  <StatusIcon type={statuses?.find((s) => s.id === task.statusId)?.type ?? 0} color={statuses?.find((s) => s.id === task.statusId)?.color ?? 0} /> {t('boards.f.status')}
                  <span className="ml-auto pl-4 text-caption text-muted group-data-[highlighted]:text-inherit">{keyOf('status')}</span>
                  <ChevronRight className="size-4" aria-hidden />
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent className={cx(menuBox, 'w-52')} sideOffset={4} collisionPadding={16}>
                    {[...(statuses ?? [])]
                      .sort((a, b) => a.position - b.position)
                      .map((s) => (
                        <ContextMenu.Item key={s.id} className={item} disabled={blocked?.has(s.id)} onSelect={() => s.id !== task.statusId && void updateTask(task.id, { statusId: s.id })}>
                          <StatusIcon type={s.type} color={s.color} /> {s.name}
                          {blocked?.has(s.id) ? <span className="ml-auto pl-3 text-caption text-muted">{t('boards.gate.hint')}</span> : null}
                        </ContextMenu.Item>
                      ))}
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
              {priority ? (
                <ContextMenu.Sub>
                  <ContextMenu.SubTrigger className={sub}>
                    <PriorityIcon priority={task.priority} /> {t('boards.f.priority')}
                    <span className="ml-auto pl-4 text-caption text-muted group-data-[highlighted]:text-inherit">{keyOf('priority')}</span>
                    <ChevronRight className="size-4" aria-hidden />
                  </ContextMenu.SubTrigger>
                  <ContextMenu.Portal>
                    <ContextMenu.SubContent className={cx(menuBox, 'w-52')} sideOffset={4} collisionPadding={16}>
                      {PRIORITIES.map((p) => (
                        <ContextMenu.Item key={p} className={item} onSelect={() => p !== task.priority && void updateTask(task.id, { priority: p })}>
                          <PriorityIcon priority={p} /> {t(PRIORITY_LABEL[p] ?? 'boards.prio.none')}
                        </ContextMenu.Item>
                      ))}
                    </ContextMenu.SubContent>
                  </ContextMenu.Portal>
                </ContextMenu.Sub>
              ) : null}
              {!task.assignees.some((a) => a.userId === me) ? (
                <ContextMenu.Item className={item} onSelect={() => void setAssignees(task.id, addAssignee(draftsOf(task.assignees), me))}>
                  <UserPlus className="size-4" aria-hidden /> {t('boards.assignMe')}
                </ContextMenu.Item>
              ) : null}
            </>
          ) : null}
          <ContextMenu.Separator className={menuSeparator} />
          <ContextMenu.Item className={item} onSelect={() => copyTaskKey(task.key)}>
            <Copy className="size-4" aria-hidden /> {t('boards.copyKey')}
            {kbd('copyKey')}
          </ContextMenu.Item>
          <ContextMenu.Item className={item} onSelect={() => copyTaskLink(task.key)}>
            <Link2 className="size-4" aria-hidden /> {t('boards.copyLink')}
            {kbd('copyLink')}
          </ContextMenu.Item>
          {!scoped && (manage || canEdit) ? (
            <ContextMenu.Item className={item} onSelect={() => void duplicateTask(task.id)}>
              <CopyPlus className="size-4" aria-hidden /> {t('boards.duplicate')}
            </ContextMenu.Item>
          ) : null}
          {canArchive ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={cx(item, 'text-danger-text')} onSelect={() => void archiveTask(task.id)}>
                <Archive className="size-4" aria-hidden /> {t('boards.archive')}
                {kbd('archive')}
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
