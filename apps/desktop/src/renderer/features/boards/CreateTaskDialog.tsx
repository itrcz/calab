import { BoardFeature, TaskPriority } from '@calaba/protocol';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { BadgeCheck, CalendarClock, Check, Diamond, SquareKanban, Tag, Triangle, UserRound } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Modal, Toggle, cx } from '../../components/ui';
import { t } from '../../i18n';
import { clampRequired, quorumChoices, toggleApprover } from '../../lib/boards/approvals';
import { featureOn, scaleValues } from '../../lib/boards/features';
import { addAssignee, draftsOf, removeAssignee, type AssigneeDraft } from '../../lib/boards/assignees';
import { MOD } from '../../components/ui';
import { createTask, openTaskAnywhere } from '../../services/boards';
import { useBoards, workspaceBoards } from '../../stores/boards';
import { menuBox, menuItem } from '../shell/menu';
import { useBoardsUi } from '../../stores/boardsUi';
import { useToasts } from '../../stores/toasts';
import { ApproverMenu, AssigneeMenu, DateMenu, EstimateMenu, LabelMenu, MemberAvatar, MilestoneMenu, PriorityMenu, StatusMenu, estimateLabel, useToday } from './menus';
import { hasBit, sortedStatuses, CREATE_TASKS } from './model';
import { Dot, PRIORITY_LABEL, PriorityIcon, StatusIcon, formatDue } from './visuals';

const NONE: string[] = [];

/**
 * «Новая задача» (ADR-0042 §5, Linear's create dialog): title, description, the properties as a
 * row of chips (status of the column it came from, priority, assignees, labels, due date,
 * estimate, milestone) and «Создать ещё» — the dialog stays for the next one. ⌘↩ creates.
 */
export function CreateTaskDialog(): ReactNode {
  const req = useBoardsUi((s) => s.createFor);
  if (!req) return null;
  return (
    <Dialog
      key={`${req.boardId}:${req.statusId ?? ''}:${req.parentId ?? ''}:${req.fromMessage?.id ?? ''}`}
      initialBoard={req.boardId}
      statusId={req.statusId}
      parentId={req.parentId}
      fromMessage={req.fromMessage}
    />
  );
}

/** «Создать задачу» from a message: the title is its first line, plain text, ≤ 200 characters. */
export function titleFromMessage(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^\s*(?:>+|#+|[-*]\s)\s*/, '').trim())
      .find(Boolean) ?? '';
  const plain = line
    .replace(/<@[0-9a-f-]{36}>/gi, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 200 ? `${plain.slice(0, 199)}…` : plain;
}

/**
 * The board a task from a message goes to: the one used last time in that workspace, else the
 * open board, else the first where the viewer may create tasks ('' = none).
 */
export function boardForMessage(workspaceId: string): string {
  const ui = useBoardsUi.getState();
  const ok = new Set(
    workspaceBoards(useBoards.getState().boards, workspaceId)
      .filter((b) => hasBit(b.permissions, CREATE_TASKS))
      .map((b) => b.id),
  );
  for (const id of [ui.lastBoard[workspaceId], ui.boardOf[workspaceId]]) if (id && ok.has(id)) return id;
  return ok.values().next().value ?? '';
}

function Dialog({
  initialBoard,
  statusId,
  parentId,
  fromMessage,
}: {
  initialBoard: string;
  statusId?: string | undefined;
  parentId?: string | undefined;
  fromMessage?: { id: string; text: string } | undefined;
}): ReactNode {
  const [boardId, setBoardId] = useState(initialBoard);
  const board = useBoards((s) => s.boards[boardId]);
  const close = (): void => useBoardsUi.getState().openCreate(null);
  const def = sortedStatuses(board).find((s) => s.isDefault)?.id ?? sortedStatuses(board)[0]?.id ?? '';
  const [title, setTitle] = useState(() => (fromMessage ? titleFromMessage(fromMessage.text) : ''));
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState(statusId ?? def);
  const [priority, setPriority] = useState<TaskPriority>(TaskPriority.NONE);
  const [assignees, setAssignees] = useState<AssigneeDraft[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const [estimate, setEstimate] = useState(0);
  const [milestone, setMilestone] = useState('');
  // ADR-0049: optional approvers from the start and the quorum (0 = all).
  const [approvers, setApprovers] = useState<string[]>([]);
  const [required, setRequired] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const today = useToday();
  const st = board?.statuses.find((s) => s.id === status);
  const ms = board?.milestones.find((m) => m.id === milestone);
  const chosen = useMemo(() => (board?.labels ?? []).filter((l) => labels.includes(l.id)), [board?.labels, labels]);
  const boards = useBoards(
    useShallow((s) =>
      fromMessage && board
        ? workspaceBoards(s.boards, board.workspaceId)
            .filter((b) => hasBit(b.permissions, CREATE_TASKS))
            .map((b) => `${b.id}\u0000${b.emoji ? `${b.emoji} ` : ''}${b.name}`)
        : NONE,
    ),
  );
  if (!board || !hasBit(board.permissions, CREATE_TASKS)) return null;
  // Board features (ADR-0058 §3): no chips of a disabled feature, and nothing of one is sent.
  const on = (f: BoardFeature): boolean => featureOn(board.disabledFeatures, f);
  // Another board: its statuses, labels and milestones differ — those picks start over.
  const pickBoard = (id: string): void => {
    if (id === boardId) return;
    const next = useBoards.getState().boards[id];
    setBoardId(id);
    setStatus(sortedStatuses(next).find((s) => s.isDefault)?.id ?? sortedStatuses(next)[0]?.id ?? '');
    setLabels([]);
    setMilestone('');
    // Another estimate scale: a value outside it would be refused (422).
    if (!scaleValues(next?.estimateScale).includes(estimate)) setEstimate(0);
  };

  const submit = async (): Promise<void> => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const made = await createTask(boardId, {
      title: title.trim(),
      description,
      statusId: status,
      priority: on(BoardFeature.PRIORITY) ? priority : TaskPriority.NONE,
      assignees: draftsOf(assignees),
      labelIds: on(BoardFeature.LABELS) ? labels : [],
      dueOn: on(BoardFeature.DUE_DATE) ? due : '',
      estimate: on(BoardFeature.ESTIMATE) ? estimate : 0,
      milestoneId: on(BoardFeature.MILESTONES) ? milestone : '',
      approverIds: on(BoardFeature.APPROVALS) ? approvers : [],
      approvalRequired: on(BoardFeature.APPROVALS) ? clampRequired(required, approvers.length) : 0,
      parentId: parentId ?? '',
      ...(fromMessage ? { fromMessageId: fromMessage.id } : {}),
    });
    setBusy(false);
    if (!made) return;
    if (fromMessage) useBoardsUi.getState().setLastBoard(board.workspaceId, boardId);
    useToasts.getState().push('success', t('boards.created', { key: made.key }), {
      label: t('boards.open'),
      run: () => (fromMessage ? openTaskAnywhere(made) : useBoardsUi.getState().openTask(made.id)),
    });
    if (more) {
      setTitle('');
      setDescription('');
      titleRef.current?.focus();
    } else close();
  };
  const chip = 'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 text-control text-fg hover:bg-hover data-[state=open]:bg-active';
  return (
    <Modal
      open
      onClose={close}
      wide
      title={t('boards.newTaskIn', { board: `${board.emoji ? `${board.emoji} ` : ''}${board.name}` })}
      initialFocus={titleRef}
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-control text-muted">
            <Toggle label={t('boards.createMore')} checked={more} onChange={setMore} />
            {t('boards.createMore')}
          </label>
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} busy={busy} disabled={!title.trim()} title={`${MOD}↩`} data-testid="create-task-submit">
            {t('boards.createTask')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        data-testid="create-task"
      >
        <input
          ref={titleRef}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('boards.taskTitlePlaceholder')}
          aria-label={t('boards.taskTitle')}
          className="selectable h-9 w-full bg-transparent text-title font-semibold text-fg outline-none placeholder:text-faint"
          data-testid="create-task-title"
        />
        <textarea
          value={description}
          maxLength={20000}
          rows={4}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('boards.descriptionPlaceholder')}
          aria-label={t('boards.description')}
          className="selectable min-h-24 w-full resize-y bg-transparent text-body text-fg outline-none placeholder:text-faint"
        />
        <div className="flex flex-wrap gap-1.5 border-t border-line pt-3" data-testid="create-task-props">
          {boards.length > 1 ? (
            <Dropdown.Root modal={false}>
              <Dropdown.Trigger asChild>
                <button type="button" className={chip} data-testid="create-task-board">
                  <SquareKanban className="size-3.5 text-muted" aria-hidden /> {board.emoji ? `${board.emoji} ` : ''}
                  {board.name}
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content className={cx(menuBox, 'w-56')} sideOffset={4} align="start" collisionPadding={16}>
                  {boards.map((x) => {
                    const [id = '', label = ''] = x.split('\u0000');
                    return (
                      <Dropdown.Item key={id} className={menuItem} onSelect={() => pickBoard(id)}>
                        {label}
                      </Dropdown.Item>
                    );
                  })}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          ) : null}
          <StatusMenu boardId={boardId} value={status} onPick={setStatus}>
            <button type="button" className={chip}>
              <StatusIcon type={st?.type ?? 0} color={st?.color ?? 0} /> {st?.name ?? ''}
            </button>
          </StatusMenu>
          {on(BoardFeature.PRIORITY) ? (
            <PriorityMenu value={priority} onPick={setPriority}>
              <button type="button" className={chip}>
                <PriorityIcon priority={priority} /> {t(PRIORITY_LABEL[priority] ?? 'boards.prio.none')}
              </button>
            </PriorityMenu>
          ) : null}
          <AssigneeMenu
            workspaceId={board.workspaceId}
            boardId={boardId}
            value={assignees.map((a) => a.userId)}
            onToggle={(u) => setAssignees((cur) => (cur.some((a) => a.userId === u) ? removeAssignee(cur, u) : addAssignee(cur, u)))}
            onNone={() => setAssignees([])}
          >
            <button type="button" className={chip} data-testid="create-task-assignees">
              {assignees.length ? (
                <>
                  <span className="flex -space-x-1.5">
                    {assignees.slice(0, 3).map((a) => (
                      <span key={a.userId} className="rounded-full ring-2 ring-[var(--color-popover)]">
                        <MemberAvatar workspaceId={board.workspaceId} userId={a.userId} size={18} />
                      </span>
                    ))}
                  </span>
                  {t('boards.nAssignees', { n: assignees.length })}
                </>
              ) : (
                <>
                  <UserRound className="size-3.5 text-muted" aria-hidden /> {t('boards.f.assignee')}
                </>
              )}
            </button>
          </AssigneeMenu>
          {on(BoardFeature.LABELS) ? (
            <LabelMenu boardId={boardId} value={labels} canCreate onToggle={(l) => setLabels((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]))}>
              <button type="button" className={chip}>
                {chosen.length ? (
                  chosen.slice(0, 3).map((l) => (
                    <span key={l.id} className="inline-flex items-center gap-1">
                      <Dot color={l.color} /> {l.name}
                    </span>
                  ))
                ) : (
                  <>
                    <Tag className="size-3.5 text-muted" aria-hidden /> {t('boards.f.label')}
                  </>
                )}
              </button>
            </LabelMenu>
          ) : null}
          {on(BoardFeature.DUE_DATE) ? (
            <DateMenu value={due} onPick={setDue} title={t('boards.f.dueOn')}>
              <button type="button" className={cx(chip, !due && 'text-muted')}>
                <CalendarClock className="size-3.5" aria-hidden /> {due ? formatDue(due, today) : t('boards.f.dueOn')}
              </button>
            </DateMenu>
          ) : null}
          {on(BoardFeature.ESTIMATE) ? (
            <EstimateMenu value={estimate} scale={board.estimateScale} onPick={setEstimate}>
              <button type="button" className={cx(chip, !estimate && 'text-muted')}>
                <Triangle className="size-3.5" aria-hidden /> {estimate ? estimateLabel(estimate, board.estimateScale) : t('boards.f.estimate')}
              </button>
            </EstimateMenu>
          ) : null}
          {on(BoardFeature.APPROVALS) ? (
            <ApproverMenu
              workspaceId={board.workspaceId}
              boardId={boardId}
              value={approvers}
              onToggle={(u) => {
                const next = toggleApprover(approvers, u);
                setApprovers(next);
                setRequired((r) => clampRequired(r, next.length));
              }}
            >
              <button type="button" className={cx(chip, !approvers.length && 'text-muted')} data-testid="create-task-approvers">
                {approvers.length ? (
                  <>
                    <span className="flex -space-x-1.5">
                      {approvers.slice(0, 3).map((u) => (
                        <span key={u} className="rounded-full ring-2 ring-[var(--color-popover)]">
                          <MemberAvatar workspaceId={board.workspaceId} userId={u} size={18} />
                        </span>
                      ))}
                    </span>
                    {t('boards.nApprovers', { n: approvers.length })}
                  </>
                ) : (
                  <>
                    <BadgeCheck className="size-3.5" aria-hidden /> {t('boards.approvals')}
                  </>
                )}
              </button>
            </ApproverMenu>
          ) : null}
          {on(BoardFeature.APPROVALS) && approvers.length > 1 ? (
            <Dropdown.Root modal={false}>
              <Dropdown.Trigger asChild>
                <button type="button" className={chip} data-testid="create-task-quorum">
                  {t('boards.quorum')}: {required ? t('boards.quorumN', { n: required, m: approvers.length }) : t('boards.quorumAll')}
                </button>
              </Dropdown.Trigger>
              <Dropdown.Portal>
                <Dropdown.Content className={cx(menuBox, 'w-40')} sideOffset={4} align="start" collisionPadding={16}>
                  {quorumChoices(approvers.length).map((r) => (
                    <Dropdown.Item key={r} className={menuItem} onSelect={() => setRequired(r)}>
                      {r === required ? <Check className="size-3.5" aria-hidden /> : <span className="size-3.5" />}
                      {r ? t('boards.quorumN', { n: r, m: approvers.length }) : t('boards.quorumAll')}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          ) : null}
          {board.milestones.length && on(BoardFeature.MILESTONES) ? (
            <MilestoneMenu boardId={boardId} value={milestone} onPick={setMilestone}>
              <button type="button" className={cx(chip, !ms && 'text-muted')}>
                <Diamond className="size-3.5" aria-hidden /> {ms ? ms.name : t('boards.f.milestone')}
              </button>
            </MilestoneMenu>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
