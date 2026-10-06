import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { BoardFeature, MessageKind, Permission, TaskRelationKind, taskRoomPermissions, type Room, type Task, type TaskActivity } from '@calaba/protocol';
import {
  Archive,
  Cog,
  Bell,
  BellOff,
  ChevronRight,
  CopyPlus,
  Crown,
  Ellipsis,
  FolderInput,
  GitFork,
  Link2,
  Maximize2,
  Minimize2,
  Paperclip,
  Plus,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ProfileTarget } from '../../components/ProfileTarget';
import { Bar } from '../../components/Bar';
import { PhoneBack } from '../../components/PhoneHeader';
import { useShallow } from 'zustand/react/shallow';
import { Button, CloseButton, IconButton, Segmented, Spinner, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { Markdown } from '../../lib/markdown/Markdown';
import { filterFeed, startsRun, type ActivityTab } from '../../lib/boards/activity';
import { blockedStatusIds } from '../../lib/boards/approvals';
import { addAssignee, draftsOf, removeAssignee, setLead, setNote, MAX_NOTE } from '../../lib/boards/assignees';
import { uploadFile } from '../../lib/api/endpoints';
import { useMobile } from '../../lib/mobile';
import { loadOlder, markRead, openRoom, revealOlder, type OutgoingFile } from '../../services/chat';
import { useChatView } from '../chat/chatView';
import { subscribeRooms } from '../../services/gateway';
import {
  archiveTask,
  copyTaskLink,
  createTask,
  duplicateTask,
  loadActivity,
  loadTask,
  moveTaskToBoard,
  setAssignees,
  setRelation,
  setSubscription,
  setTaskAttachments,
  updateTask,
  useTaskDetails,
} from '../../services/boards';
import { boardsApi } from '../../services/boardsApi';
import { ensureRules } from '../../services/automations';
import { ruleNameOf, useAutomations } from '../../stores/automations';
import { taskMilestonesOf, useBoards, workspaceBoards } from '../../stores/boards';
import { milestoneState } from '../../lib/boards/milestones';
import { useBoardsUi } from '../../stores/boardsUi';
import { EMPTY_ROOM_MESSAGES, useMessages } from '../../stores/messages';
import { useRooms } from '../../stores/rooms';
import { myUserId, useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { memberName, useMemberName } from '../../stores/workspaces';
import { Composer, toOutgoing } from '../chat/Composer';
import { buildMetas, type RowMeta } from '../chat/grouping';
import { MessageRow, SystemRow } from '../chat/MessageBubble';
import { useFileDrop } from '../chat/useFileDrop';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { DRAG_USER, dragKind } from '../calendar/dragState';
import { featureOn, type Disabled } from '../../lib/boards/features';
import { ApprovalsSection } from './Approvals';
import { WatchersSection } from './Watchers';
import { GitSection } from './GitLinks';
import { Checklists } from './Checklists';
import { MilestoneDiamond, TaskMilestones } from './TaskMilestones';
import { AssigneeMenu, ChoiceMenu, DateMenu, EstimateMenu, LabelMenu, MemberAvatar, MilestoneMenu, PriorityMenu, StatusMenu, estimateLabel, useToday, type Choice } from './menus';
import { doneType, hasBit, mayArchiveTask, mayEditTask, CREATE_TASKS, MANAGE_BOARD } from './model';
import { useDisabledFeatures, useEstimateScale } from './useBoardView';
import { useBoardScoped, useTaskPerms } from './useTaskPerms';
import { Dot, PRIORITY_LABEL, PriorityIcon, StatusIcon, formatDue, isOverdue } from './visuals';

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20000;

/**
 * The task panel (ADR-0042 §5, Linear's issue page): on the right, twice the members column
 * (a floating sheet under 1200 px, ⌘\ covers the whole centre, full screen on a phone). One
 * scroll: title (inline), description (markdown-lite with attachments), properties — status,
 * priority, assignees with the lead and «за что отвечает», labels, dates, estimate, milestone,
 * parent — subtasks, relations and the activity: the task room's messages (the chat's own rows:
 * reactions, stickers, voice, replies, edits) interleaved with the journal; the chat composer
 * at the bottom.
 */
export function TaskPanel({ taskId, floating = false, page = false }: { taskId: string; floating?: boolean; page?: boolean }): ReactNode {
  const task = useBoards((s) => s.tasks[taskId]);
  const wide = useBoardsUi((s) => s.panelWide);
  const mobile = useMobile();
  useEffect(() => {
    void loadTask(taskId);
  }, [taskId]);
  const close = (): void => useBoardsUi.getState().openTask(null);
  const shell = cx(
    'mat-content relative flex min-w-0 flex-col',
    page || mobile ? 'fixed inset-0 z-[var(--z-modal)] pt-[var(--safe-top)]' : wide ? 'absolute inset-0 z-[var(--z-sticky)]' : floating ? 'absolute inset-y-0 right-0 z-[var(--z-sticky)] w-[min(480px,100%)] border-l border-line shadow-[var(--shadow-popover)]' : 'w-[480px] shrink-0 border-l border-line',
  );
  if (!task) {
    return (
      <aside className={shell} aria-label={t('boards.task')} data-testid="task-panel">
        <div className="flex h-12 items-center justify-end px-2">
          <CloseButton onClick={close} />
        </div>
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      </aside>
    );
  }
  return (
    <aside className={shell} aria-label={`${task.key} ${task.title}`} data-testid="task-panel">
      <PanelBody task={task} onClose={close} wide={wide} mobile={mobile || page} />
    </aside>
  );
}

function PanelBody({ task, onClose, wide, mobile }: { task: Task; onClose: () => void; wide: boolean; mobile: boolean }): ReactNode {
  const perms = useTaskPerms(task);
  const scoped = useBoardScoped(task.boardId);
  const boardName = useBoards((s) => s.boards[task.boardId]?.name ?? '');
  const detail = useTaskDetails((s) => s.byTask[task.id]);
  const room = useRooms((s) => (task.roomId ? s.byId[task.roomId] : undefined));
  const me = myUserId();
  const canEdit = mayEditTask(task, perms, me);
  // Board features (ADR-0058 §3): a disabled feature's fields and sections are hidden, data kept.
  const disabled = useDisabledFeatures(task.boardId);
  const on = (f: BoardFeature): boolean => featureOn(disabled, f);
  const scroller = useRef<HTMLDivElement>(null);
  const toEnd = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  return (
    <>
      <PanelHeader task={task} boardName={boardName} perms={perms} scoped={scoped} onClose={onClose} wide={wide} mobile={mobile} />
      <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="task-scroll">
        <div className={cx('flex flex-col gap-5 px-5 pb-6 pt-4', wide && 'mx-auto w-full max-w-[860px]')}>
          <TitleEditor task={task} canEdit={canEdit} />
          <DescriptionEditor task={task} canEdit={canEdit} attachments={on(BoardFeature.ATTACHMENTS)} />
          {/* Git links (ADR-0060 §4): under the attachments; its own subscriber, nothing when none. */}
          {on(BoardFeature.GIT_LINKS) ? <GitSection taskId={task.id} /> : null}
          <Properties task={task} canEdit={canEdit} perms={perms} scoped={scoped} disabled={disabled} />
          {/* Milestones inside the task (ADR-0063): top-level tasks only; their own subscriber. */}
          {on(BoardFeature.MILESTONES) && !task.parentId ? <TaskMilestones taskId={task.id} canEdit={canEdit} /> : null}
          {/* Checklists: their own subscriber (a toggle re-renders that section only, ADR-0058 §2). */}
          {on(BoardFeature.CHECKLISTS) ? <Checklists taskId={task.id} workspaceId={task.workspaceId} canEdit={canEdit} subtasks={on(BoardFeature.SUBTASKS) && !task.parentId} /> : null}
          {on(BoardFeature.SUBTASKS) ? <Subtasks task={task} ids={detail?.subtasks ?? []} canCreate={hasBit(perms, CREATE_TASKS) && !scoped} /> : null}
          {on(BoardFeature.RELATIONS) ? <Relations task={task} ids={detail?.related ?? []} canEdit={canEdit} /> : null}
          {room ? <Activity task={task} room={room} toEnd={toEnd} commentsOff={!on(BoardFeature.COMMENTS)} /> : <div className="grid h-16 place-items-center"><Spinner /></div>}
        </div>
      </div>
      {room ? <CommentBox task={task} room={room} perms={perms} commentsOff={!on(BoardFeature.COMMENTS)} /> : null}
    </>
  );
}

function PanelHeader({ task, boardName, perms, scoped, onClose, wide, mobile }: { task: Task; boardName: string; perms: bigint | undefined; scoped: boolean; onClose: () => void; wide: boolean; mobile: boolean }): ReactNode {
  const boards = useBoards(useShallow((s) => workspaceBoards(s.boards, task.workspaceId).filter((b) => b.id !== task.boardId && hasBit(b.permissions, MANAGE_BOARD)).map((b) => `${b.id}\u0000${b.emoji} ${b.name}`)));
  const me = myUserId();
  const subscribed = task.subscribed && !task.muted;
  return (
    <Bar plain className="gap-1 pl-2 pr-2" data-testid="task-panel-header">
      {mobile ? (
        <PhoneBack />
      ) : null}
      <span className="min-w-0 truncate pl-2 text-caption text-muted">{boardName}</span>
      <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
      <button type="button" onClick={() => copyTaskLink(task.key)} className="shrink-0 rounded-[var(--radius-icon)] px-1 text-caption font-medium tabular-nums text-fg hover:bg-hover mobile:tap-h" title={t('boards.copyLink')} data-testid="panel-key">
        {task.key}
      </button>
      <span className="flex-1" />
      <IconButton label={subscribed ? t('boards.unsubscribe') : t('boards.subscribe')} active={subscribed} onClick={() => void setSubscription(task.id, subscribed)} className={cx(subscribed && 'mobile:bg-transparent mobile:text-accent-text')} data-testid="panel-subscribe">
        {/* phone: the state is the icon (filled accent bell), not a grey plate */}
        {subscribed ? <Bell className="size-4 mobile:size-5 mobile:fill-current" aria-hidden /> : <BellOff className="size-4 mobile:size-5" aria-hidden />}
      </IconButton>
      <IconButton label={t('boards.copyLink')} onClick={() => copyTaskLink(task.key)}>
        <Link2 className="size-4" aria-hidden />
      </IconButton>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <IconButton tip={false} label={t('boards.more')} className="data-[state=open]:bg-active" data-testid="panel-more">
            <Ellipsis className="size-4" aria-hidden />
          </IconButton>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="end" collisionPadding={16}>
            {hasBit(perms, CREATE_TASKS) && !scoped ? (
              <Dropdown.Item className={menuItem} onSelect={() => void duplicateTask(task.id).then((c) => c && useBoardsUi.getState().openTask(c.id))}>
                <CopyPlus className="size-4" aria-hidden /> {t('boards.duplicate')}
              </Dropdown.Item>
            ) : null}
            {boards.length && !scoped && hasBit(perms, MANAGE_BOARD) ? (
              <Dropdown.Sub>
                <Dropdown.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
                  <FolderInput className="size-4" aria-hidden /> <span className="flex-1">{t('boards.moveToBoard')}</span> <ChevronRight className="size-4" aria-hidden />
                </Dropdown.SubTrigger>
                <Dropdown.Portal>
                  <Dropdown.SubContent className={cx(menuBox, 'w-56')} sideOffset={4} collisionPadding={16}>
                    {boards.map((x) => {
                      const [id = '', label = ''] = x.split('\u0000');
                      return (
                        <Dropdown.Item key={id} className={menuItem} onSelect={() => void moveTaskToBoard(task.id, id)}>
                          {label}
                        </Dropdown.Item>
                      );
                    })}
                  </Dropdown.SubContent>
                </Dropdown.Portal>
              </Dropdown.Sub>
            ) : null}
            {mayArchiveTask(task, perms, me) ? (
              <>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void archiveTask(task.id)} data-testid="panel-archive">
                  <Archive className="size-4" aria-hidden /> {t('boards.archive')}
                </Dropdown.Item>
              </>
            ) : null}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {!mobile ? (
        <IconButton label={wide ? t('boards.collapsePanel') : t('boards.expandPanel')} shortcut={`${isMac() ? '⌘' : 'Ctrl+'}\\`} onClick={() => useBoardsUi.getState().setPanelWide(!wide)} data-testid="panel-expand">
          {wide ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
        </IconButton>
      ) : null}
      {!mobile ? <CloseButton onClick={onClose} /> : null}
    </Bar>
  );
}

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac OS X|Macintosh/.test(navigator.userAgent);

// ------------------------------------------------------------------ title / description

function TitleEditor({ task, canEdit }: { task: Task; canEdit: boolean }): ReactNode {
  const [v, setV] = useState(task.title);
  const ref = useRef<HTMLTextAreaElement>(null);
  // A title changed elsewhere (TASK_UPDATE) replaces the field (derived during render).
  const [prev, setPrev] = useState(task.title);
  if (prev !== task.title) {
    setPrev(task.title);
    setV(task.title);
  }
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [v]);
  const save = (): void => {
    const next = v.trim();
    if (!next) setV(task.title);
    else if (next !== task.title) void updateTask(task.id, { title: next });
  };
  return (
    <textarea
      ref={ref}
      value={v}
      rows={1}
      readOnly={!canEdit}
      maxLength={TITLE_MAX}
      onChange={(e) => setV(e.target.value.replace(/\n/g, ' '))}
      onBlur={save}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === 'Escape') {
          setV(task.title);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      aria-label={t('boards.taskTitle')}
      className="selectable w-full resize-none overflow-hidden rounded-[var(--radius-row)] bg-transparent text-title font-semibold leading-[26px] text-fg outline-none focus-visible:bg-hover"
      data-testid="task-title"
    />
  );
}

function DescriptionEditor({ task, canEdit, attachments }: { task: Task; canEdit: boolean; attachments: boolean }): ReactNode {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(task.description);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [prev, setPrev] = useState(task.description);
  if (prev !== task.description && !editing) {
    setPrev(task.description);
    setV(task.description);
  }
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.max(96, el.scrollHeight)}px`;
    }
  }, [v, editing]);
  const save = (): void => {
    setEditing(false);
    if (v !== task.description) void updateTask(task.id, { description: v });
  };
  const attach = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const ids = task.attachments.map((a) => a.id);
      for (const f of [...files].slice(0, 20 - ids.length)) ids.push((await uploadFile(boardsApi.uploadPath(task.boardId), f, f.name, () => undefined).promise).id);
      await setTaskAttachments(task.id, ids);
    } catch (e) {
      toast.fail(e, t('boards.err.save'));
    } finally {
      setBusy(false);
    }
  };
  const mention = useCallback((val: string, key: string) => <span key={key} className="font-medium text-accent-text">@{memberName(task.workspaceId, val)}</span>, [task.workspaceId]);
  return (
    <section className="flex flex-col gap-2" aria-label={t('boards.description')}>
      {editing ? (
        <>
          <textarea
            ref={ref}
            autoFocus
            value={v}
            maxLength={DESCRIPTION_MAX}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
              if (e.key === 'Escape') {
                setV(task.description);
                setEditing(false);
              }
            }}
            placeholder={t('boards.descriptionPlaceholder')}
            className="selectable w-full resize-none rounded-[var(--radius-card)] border border-accent bg-elev p-3 text-body text-fg outline-none"
            data-testid="task-description-editor"
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-caption text-faint">{t('boards.markdownHint')}</span>
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={save} data-testid="task-description-save">
              {t('common.save')}
            </Button>
          </div>
        </>
      ) : (
        <div
          role={canEdit ? 'button' : undefined}
          tabIndex={canEdit ? 0 : undefined}
          onClick={() => canEdit && setEditing(true)}
          onKeyDown={(e) => canEdit && e.key === 'Enter' && setEditing(true)}
          className={cx('selectable min-h-8 whitespace-pre-wrap break-words rounded-[var(--radius-row)] text-body', canEdit && 'cursor-text hover:bg-[color-mix(in_srgb,var(--color-fill)_40%,transparent)]', !task.description && 'text-faint')}
          data-testid="task-description"
        >
          {task.description ? <Markdown text={task.description} mention={mention} /> : canEdit ? t('boards.descriptionPlaceholder') : t('boards.noDescription')}
        </div>
      )}
      {attachments && (task.attachments.length || canEdit) ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {task.attachments.map((f) => (
            <span key={f.id} className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-full border border-line pl-2 pr-1 text-caption">
              <Paperclip className="size-3.5 shrink-0 text-muted" aria-hidden />
              <a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
                {f.name}
              </a>
              {canEdit ? (
                <button type="button" aria-label={t('boards.removeAttachment', { name: f.name })} onClick={() => void setTaskAttachments(task.id, task.attachments.filter((x) => x.id !== f.id).map((x) => x.id))} className="grid size-5 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
                  <X className="size-3" aria-hidden />
                </button>
              ) : null}
            </span>
          ))}
          {canEdit ? (
            <>
              <Button variant="ghost" size="sm" busy={busy} onClick={() => file.current?.click()} data-testid="task-attach">
                <Paperclip className="size-3.5" aria-hidden /> {t('boards.attach')}
              </Button>
              <input ref={file} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ properties

function Prop({ label, children, testId }: { label: string; children: ReactNode; testId?: string }): ReactNode {
  return (
    <div className="flex min-h-8 items-start gap-3 mobile:flex-col mobile:gap-0.5 mobile:py-1" data-testid={testId}>
      <span className="w-[104px] shrink-0 pt-1.5 text-caption text-muted mobile:w-auto mobile:pt-0">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

const valueBtn = 'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-control text-fg hover:bg-hover disabled:hover:bg-transparent data-[state=open]:bg-active';

function Properties({ task, canEdit, perms, scoped, disabled }: { task: Task; canEdit: boolean; perms: bigint | undefined; scoped: boolean; disabled: Disabled }): ReactNode {
  const statuses = useBoards((s) => s.boards[task.boardId]?.statuses);
  const status = statuses?.find((x) => x.id === task.statusId);
  // ADR-0049: statuses «further» are disabled while the task waits for approval.
  const blocked = useMemo(() => blockedStatusIds(task, statuses ?? []), [task, statuses]);
  const labels = useBoards((s) => s.boards[task.boardId]?.labels);
  const milestone = useBoards((s) => s.boards[task.boardId]?.milestones.find((m) => m.id === task.milestoneId));
  const parent = useBoards((s) => (task.parentId ? s.tasks[task.parentId] : undefined));
  const today = useToday();
  const scale = useEstimateScale(task.boardId);
  const on = (f: BoardFeature): boolean => featureOn(disabled, f);
  const done = doneType(status?.type);
  const mine = (labels ?? []).filter((l) => task.labelIds.includes(l.id));
  const menu = useBoardsUi((s) => (s.menu?.taskId === task.id ? s.menu.kind : null));
  const req = (k: string): { open?: boolean; onOpenChange?: (v: boolean) => void } => (menu === k ? { open: true, onOpenChange: (v) => !v && useBoardsUi.getState().closeMenu() } : {});
  return (
    <section className="flex flex-col gap-0.5 rounded-[var(--radius-card)] border border-line p-2" aria-label={t('boards.properties')} data-testid="task-properties">
      <Prop label={t('boards.f.status')}>
        <StatusMenu boardId={task.boardId} value={task.statusId} blocked={blocked} onPick={(s) => s !== task.statusId && void updateTask(task.id, { statusId: s })} {...req('status')}>
          <button type="button" disabled={!canEdit} className={valueBtn} data-testid="prop-status">
            <StatusIcon type={status?.type ?? 0} color={status?.color ?? 0} /> <span className="truncate">{status?.name ?? ''}</span>
          </button>
        </StatusMenu>
      </Prop>
      {on(BoardFeature.PRIORITY) ? (
        <Prop label={t('boards.f.priority')}>
          <PriorityMenu value={task.priority} onPick={(p) => p !== task.priority && void updateTask(task.id, { priority: p })} {...req('priority')}>
            <button type="button" disabled={!canEdit} className={valueBtn} data-testid="prop-priority">
              <PriorityIcon priority={task.priority} /> {t(PRIORITY_LABEL[task.priority] ?? 'boards.prio.none')}
            </button>
          </PriorityMenu>
        </Prop>
      ) : null}
      <Assignees task={task} canEdit={canEdit} req={req('assignee')} />
      {on(BoardFeature.APPROVALS) ? <ApprovalsSection task={task} canEdit={canEdit} perms={perms} /> : null}
      <WatchersSection task={task} canEdit={canEdit} />
      {on(BoardFeature.LABELS) ? (
        <Prop label={t('boards.f.label')}>
          {mine.map((l) => (
            <span key={l.id} className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2 text-caption" draggable onDragStart={(e) => e.dataTransfer.setData('application/x-calab-label', l.id)}>
              <Dot color={l.color} /> {l.name}
            </span>
          ))}
          <LabelMenu
            boardId={task.boardId}
            value={task.labelIds}
            canCreate={hasBit(perms, CREATE_TASKS) && !scoped}
            onToggle={(l) => void updateTask(task.id, { labelIds: task.labelIds.includes(l) ? task.labelIds.filter((x) => x !== l) : [...task.labelIds, l] })}
            {...req('label')}
          >
            <button type="button" disabled={!canEdit} aria-label={t('boards.addLabel')} className={cx(valueBtn, 'text-muted')} data-testid="prop-labels">
              <Plus className="size-3.5" aria-hidden /> {mine.length ? null : t('boards.addLabel')}
            </button>
          </LabelMenu>
        </Prop>
      ) : null}
      {on(BoardFeature.START_DATE) ? (
        <Prop label={t('boards.f.startOn')}>
          <DateMenu value={task.startOn} onPick={(d) => void updateTask(task.id, { startOn: d })} title={t('boards.f.startOn')}>
            <button type="button" disabled={!canEdit} className={cx(valueBtn, !task.startOn && 'text-muted')} data-testid="prop-start">
              {task.startOn ? formatDue(task.startOn, today) : t('boards.setDate')}
            </button>
          </DateMenu>
        </Prop>
      ) : null}
      {on(BoardFeature.DUE_DATE) ? (
        <Prop label={t('boards.f.dueOn')}>
          <DateMenu value={task.dueOn} onPick={(d) => void updateTask(task.id, { dueOn: d })} title={t('boards.f.dueOn')} {...req('due')}>
            <button type="button" disabled={!canEdit} className={cx(valueBtn, !task.dueOn && 'text-muted', isOverdue(task.dueOn, today, done) && 'text-danger-text')} data-testid="prop-due">
              {task.dueOn ? formatDue(task.dueOn, today) : t('boards.setDate')}
            </button>
          </DateMenu>
        </Prop>
      ) : null}
      {on(BoardFeature.ESTIMATE) ? (
        <Prop label={t('boards.f.estimate')}>
          <EstimateMenu value={task.estimate} scale={scale} onPick={(n) => void updateTask(task.id, { estimate: n })} {...req('estimate')}>
            <button type="button" disabled={!canEdit} className={cx(valueBtn, !task.estimate && 'text-muted')} data-testid="prop-estimate">
              {task.estimate ? estimateLabel(task.estimate, scale) : t('boards.noEstimate')}
            </button>
          </EstimateMenu>
        </Prop>
      ) : null}
      {on(BoardFeature.MILESTONES) ? (
        <Prop label={t('boards.f.milestone')}>
          <MilestoneMenu boardId={task.boardId} value={task.milestoneId} onPick={(m) => void updateTask(task.id, { milestoneId: m })} {...req('milestone')}>
            <button type="button" disabled={!canEdit} className={cx(valueBtn, !milestone && 'text-muted')} data-testid="prop-milestone">
              {milestone ? milestone.name : t('boards.noMilestone')}
            </button>
          </MilestoneMenu>
        </Prop>
      ) : null}
      {on(BoardFeature.MILESTONES) && task.parentId ? <ParentMilestone task={task} canEdit={canEdit} /> : null}
      {on(BoardFeature.SUBTASKS) ? (
        <Prop label={t('boards.f.parent')}>
          <ParentMenu task={task}>
            <button type="button" disabled={!canEdit} className={cx(valueBtn, !parent && 'text-muted')} data-testid="prop-parent">
              {parent ? (
                <>
                  <span className="tabular-nums text-muted">{parent.key}</span> <span className="truncate">{parent.title}</span>
                </>
              ) : (
                t('boards.noParent')
              )}
            </button>
          </ParentMenu>
          {parent ? (
            <button type="button" onClick={() => useBoardsUi.getState().openTask(parent.id)} className="text-caption text-accent-text hover:underline">
              {t('boards.open')}
            </button>
          ) : null}
        </Prop>
      ) : null}
    </section>
  );
}

/**
 * A subtask's «Веха родителя» (ADR-0063 §5): one of the parent's milestones. Shown while the
 * parent has milestones or the subtask still links one; the parent's milestones are read by id.
 */
function ParentMilestone({ task, canEdit }: { task: Task; canEdit: boolean }): ReactNode {
  const list = useBoards(useShallow((s) => taskMilestonesOf(s, task.parentId).map((m) => `${m.id}\u0000${m.name}\u0000${m.dueOn}\u0000${m.completedAt ? 1 : 0}`)));
  const today = useToday();
  const rows = list.map((x) => {
    const [id = '', name = '', dueOn = '', done = ''] = x.split('\u0000');
    return { id, name, dueOn, done: done === '1' };
  });
  const cur = rows.find((m) => m.id === task.taskMilestoneId);
  if (!rows.length && !task.taskMilestoneId) return null;
  const groups = [
    { id: 'none', label: '', items: [{ id: '', search: [t('boards.noMilestone')], label: t('boards.noMilestone'), checked: !task.taskMilestoneId }] },
    {
      id: 'm',
      label: '',
      items: rows.map(
        (m): Choice => ({
          id: m.id,
          search: [m.name],
          label: m.name,
          icon: <MilestoneDiamond state={milestoneState({ completedAt: m.done, dueOn: m.dueOn }, today)} />,
          checked: m.id === task.taskMilestoneId,
          note: m.dueOn ? formatDue(m.dueOn, today) : '',
        }),
      ),
    },
  ];
  return (
    <Prop label={t('boards.ms.field')} testId="prop-task-milestone">
      <ChoiceMenu groups={groups} onPick={(c) => c.id !== task.taskMilestoneId && void updateTask(task.id, { taskMilestoneId: c.id })} placeholder={t('boards.ms.pick')} label={t('boards.ms.field')} testId="task-milestone-menu">
        <button type="button" disabled={!canEdit} className={cx(valueBtn, !cur && 'text-muted')} data-testid="prop-task-milestone-value">
          {cur ? (
            <>
              <MilestoneDiamond state={milestoneState({ completedAt: cur.done, dueOn: cur.dueOn }, today)} /> <span className="truncate">{cur.name}</span>
            </>
          ) : (
            t('boards.noMilestone')
          )}
        </button>
      </ChoiceMenu>
    </Prop>
  );
}

/** Tasks of the board as picker choices (parent, relations). */
function useTaskChoices(boardId: string, exclude: string, open: boolean): Choice[] {
  const tasks = useBoards((s) => (open ? s.tasks : null));
  return useMemo(() => {
    if (!tasks) return [];
    return Object.values(tasks)
      .filter((x) => x.boardId === boardId && x.id !== exclude && !x.archivedAt)
      .sort((a, b) => b.number - a.number)
      .slice(0, 500)
      .map((x) => ({ id: x.id, search: [x.key, x.title], label: `${x.key} ${x.title}` }));
  }, [tasks, boardId, exclude]);
}

function ParentMenu({ task, children }: { task: Task; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  const choices = useTaskChoices(task.boardId, task.id, open);
  const groups = useMemo(() => [{ id: 'n', label: '', items: [{ id: '', search: [t('boards.noParent')], label: t('boards.noParent'), checked: !task.parentId }] }, { id: 't', label: '', items: choices.map((c) => ({ ...c, checked: c.id === task.parentId })) }], [choices, task.parentId]);
  return (
    <ChoiceMenu open={open} onOpenChange={setOpen} groups={groups} width={320} onPick={(c) => c.id !== task.parentId && void updateTask(task.id, { parentId: c.id })} placeholder={t('boards.menu.task')} label={t('boards.f.parent')}>
      {children}
    </ChoiceMenu>
  );
}

// ------------------------------------------------------------------ assignees

function Assignees({ task, canEdit, req }: { task: Task; canEdit: boolean; req: { open?: boolean; onOpenChange?: (v: boolean) => void } }): ReactNode {
  const [over, setOver] = useState(false);
  const drafts = useMemo(() => draftsOf(task.assignees), [task.assignees]);
  const onDragOver = (e: DragEvent): void => {
    if (canEdit && dragKind(e.dataTransfer) === 'user') {
      e.preventDefault();
      setOver(true);
    }
  };
  const onDrop = (e: DragEvent): void => {
    setOver(false);
    const userId = e.dataTransfer.getData(DRAG_USER);
    if (!userId) return;
    e.preventDefault();
    void setAssignees(task.id, addAssignee(drafts, userId));
  };
  return (
    <div className={cx('flex min-h-8 items-start gap-3 rounded-[var(--radius-row)] mobile:flex-col mobile:gap-0.5 mobile:py-1', over && 'ring-2 ring-accent')} onDragOver={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop} data-testid="prop-assignees">
      <span className="w-[104px] shrink-0 pt-1.5 text-caption text-muted mobile:w-auto mobile:pt-0">{t('boards.assignees')}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 mobile:w-full mobile:gap-1.5">
        {task.assignees.map((a) => (
          <AssigneeRow key={a.userId} task={task} userId={a.userId} lead={a.isLead} note={a.note} canEdit={canEdit} />
        ))}
        <AssigneeMenu
          workspaceId={task.workspaceId}
          boardId={task.boardId}
          value={task.assignees.map((a) => a.userId)}
          onToggle={(u) => void setAssignees(task.id, drafts.some((d) => d.userId === u) ? removeAssignee(drafts, u) : addAssignee(drafts, u))}
          onNone={() => void setAssignees(task.id, [])}
          {...req}
        >
          <button type="button" disabled={!canEdit} className={cx(valueBtn, 'self-start text-muted')} data-testid="assignee-add">
            <Plus className="size-3.5" aria-hidden /> {t('boards.addAssignee')}
          </button>
        </AssigneeMenu>
      </div>
    </div>
  );
}

const AssigneeRow = memo(function AssigneeRow({ task, userId, lead, note, canEdit }: { task: Task; userId: string; lead: boolean; note: string; canEdit: boolean }): ReactNode {
  const name = useMemberName(task.workspaceId, userId);
  const [v, setV] = useState(note);
  const [prev, setPrev] = useState(note);
  if (prev !== note) {
    setPrev(note);
    setV(note);
  }
  const drafts = draftsOf(task.assignees);
  const saveNote = (): void => {
    if (v.trim() !== note) void setAssignees(task.id, setNote(drafts, userId, v));
  };
  return (
    <div className="group/as flex min-h-8 flex-wrap items-center gap-x-2 rounded-[var(--radius-row)] px-1 hover:bg-[color-mix(in_srgb,var(--color-fill)_40%,transparent)] mobile:grid mobile:grid-cols-[minmax(0,1fr)_auto_auto] mobile:gap-x-1 mobile:px-0" data-testid="assignee-row" data-user={userId}>
      <ProfileTarget userId={userId} name={name} workspaceId={task.workspaceId} tabbable className="inline-flex min-w-0 max-w-[40%] shrink items-center gap-2 rounded-[var(--radius-control)] text-left mobile:max-w-full">
        <MemberAvatar workspaceId={task.workspaceId} userId={userId} size={20} />
        <span className="min-w-0 truncate text-control font-medium mobile:text-[15px] mobile:font-semibold">{name}</span>
      </ProfileTarget>
      <Tip label={lead ? t('boards.lead') : t('boards.makeLead')}>
        <button
          type="button"
          disabled={!canEdit || lead}
          aria-pressed={lead}
          aria-label={lead ? t('boards.lead') : t('boards.makeLead')}
          onClick={() => void setAssignees(task.id, setLead(drafts, userId))}
          className={cx('grid size-6 shrink-0 place-items-center rounded-full', lead ? 'text-[var(--color-role-owner)]' : 'text-faint opacity-0 hover:text-fg group-hover/as:opacity-100 focus-visible:opacity-100')}
          data-testid="assignee-lead"
        >
          <Crown className="size-3.5" aria-hidden />
        </button>
      </Tip>
      {/* Phone: the field must be 16 px (iOS zooms into smaller ones), so at rest a 13 px secondary
          text of the same value is drawn over it; focusing shows the real field. */}
      <div className="contents mobile:relative mobile:order-last mobile:col-span-3 mobile:ml-7 mobile:block">
      <input
        value={v}
        readOnly={!canEdit}
        maxLength={MAX_NOTE}
        onChange={(e) => setV(e.target.value)}
        onBlur={saveNote}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setV(note);
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={canEdit ? t('boards.notePlaceholder') : ''}
        aria-label={t('boards.noteOf', { name })}
        className="selectable peer h-7 min-w-[140px] flex-1 rounded-[var(--radius-row)] bg-transparent px-1.5 text-caption text-muted outline-none placeholder:text-faint focus:bg-elev focus:text-fg mobile:h-8 mobile:w-full mobile:min-w-0 mobile:px-0 mobile:text-transparent mobile:caret-[var(--color-label-secondary)] mobile:placeholder:text-transparent mobile:focus:text-fg"
        data-testid="assignee-note"
      />
      <span aria-hidden className="pointer-events-none absolute inset-0 hidden items-center truncate text-[13px] leading-8 text-muted mobile:flex mobile:peer-focus:hidden">
        {v || (canEdit ? <span className="text-faint">{t('boards.notePlaceholder')}</span> : null)}
      </span>
      </div>
      {canEdit ? (
        <button type="button" aria-label={t('boards.removeAssignee', { name })} onClick={() => void setAssignees(task.id, removeAssignee(drafts, userId))} className="grid size-6 shrink-0 place-items-center rounded-full text-muted opacity-0 hover:bg-hover hover:text-fg group-hover/as:opacity-100 focus-visible:opacity-100">
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
});

// ------------------------------------------------------------------ subtasks / relations

function TaskLine({ id }: { id: string }): ReactNode {
  const x = useBoards((s) => s.tasks[id]);
  const status = useBoards((s) => (x ? s.boards[x.boardId]?.statuses.find((st) => st.id === x.statusId) : undefined));
  if (!x) return null;
  return (
    <button type="button" onClick={() => useBoardsUi.getState().openTask(id)} className="flex h-8 w-full min-w-0 items-center gap-2 rounded-[var(--radius-row)] px-2 text-left text-control hover:bg-hover" data-testid="task-line">
      <StatusIcon type={status?.type ?? 0} color={status?.color ?? 0} />
      <span className="shrink-0 text-caption tabular-nums text-muted">{x.key}</span>
      <span className={cx('min-w-0 flex-1 truncate', doneType(status?.type) && 'text-muted line-through')}>{x.title}</span>
      {x.assignees[0] ? <MemberAvatar workspaceId={x.workspaceId} userId={x.assignees[0].userId} size={18} /> : null}
    </button>
  );
}

function Subtasks({ task, ids, canCreate }: { task: Task; ids: string[]; canCreate: boolean }): ReactNode {
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState('');
  const add = async (): Promise<void> => {
    const title = v.trim();
    if (!title) {
      setAdding(false);
      return;
    }
    setV('');
    const made = await createTask(task.boardId, { title, parentId: task.id });
    if (made) useTaskDetails.setState((s) => {
      const d = s.byTask[task.id];
      return d ? { byTask: { ...s.byTask, [task.id]: { ...d, subtasks: [...d.subtasks, made.id] } } } : {};
    });
  };
  if (task.parentId && ids.length === 0) return null;
  return (
    <section className="flex flex-col gap-0.5" aria-label={t('boards.subtasks')} data-testid="task-subtasks">
      <h3 className="flex items-center gap-1.5 pb-1 text-caption font-semibold text-muted">
        <GitFork className="size-3.5" aria-hidden /> {t('boards.subtasks')}
        {task.subtaskCount ? <span className="font-normal tabular-nums">{task.subtaskDone}/{task.subtaskCount}</span> : null}
      </h3>
      {ids.map((id) => (
        <TaskLine key={id} id={id} />
      ))}
      {adding ? (
        <input
          autoFocus
          value={v}
          maxLength={TITLE_MAX}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => void add()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') void add();
            if (e.key === 'Escape') {
              setV('');
              setAdding(false);
            }
          }}
          placeholder={t('boards.subtaskPlaceholder')}
          className="selectable h-8 rounded-[var(--radius-row)] border border-accent bg-elev px-2 text-control outline-none"
          data-testid="subtask-input"
        />
      ) : canCreate && !task.parentId ? (
        <button type="button" onClick={() => setAdding(true)} className="flex h-8 items-center gap-1.5 self-start rounded-[var(--radius-row)] px-2 text-control text-muted hover:bg-hover hover:text-fg" data-testid="subtask-add">
          <Plus className="size-3.5" aria-hidden /> {t('boards.addSubtask')}
        </button>
      ) : null}
    </section>
  );
}

const REL_GROUPS: ReadonlyArray<{ key: 'blocks' | 'blocked' | 'relates' | 'duplicates'; label: 'boards.rel.blocks' | 'boards.rel.blocked' | 'boards.rel.relates' | 'boards.rel.duplicates' }> = [
  { key: 'blocks', label: 'boards.rel.blocks' },
  { key: 'blocked', label: 'boards.rel.blocked' },
  { key: 'relates', label: 'boards.rel.relates' },
  { key: 'duplicates', label: 'boards.rel.duplicates' },
];

function Relations({ task, canEdit }: { task: Task; ids: string[]; canEdit: boolean }): ReactNode {
  const [kind, setKind] = useState<TaskRelationKind | null>(null);
  const choices = useTaskChoices(task.boardId, task.id, kind !== null);
  const groups = useMemo(() => {
    const g: Record<string, Array<{ other: string; kind: TaskRelationKind }>> = { blocks: [], blocked: [], relates: [], duplicates: [] };
    for (const r of task.relations) {
      const other = r.taskId === task.id ? r.relatedId : r.taskId;
      const key = r.kind === TaskRelationKind.BLOCKS ? (r.taskId === task.id ? 'blocks' : 'blocked') : r.kind === TaskRelationKind.RELATES ? 'relates' : 'duplicates';
      g[key]?.push({ other, kind: r.kind });
    }
    return g;
  }, [task.relations, task.id]);
  const any = task.relations.length > 0;
  return (
    <section className="flex flex-col gap-0.5" aria-label={t('boards.relations')} data-testid="task-relations">
      {any ? <h3 className="pb-1 text-caption font-semibold text-muted">{t('boards.relations')}</h3> : null}
      {REL_GROUPS.map((g) =>
        groups[g.key]?.length ? (
          <div key={g.key} className="flex flex-col">
            <span className="px-2 text-micro font-semibold uppercase tracking-[0.04em] text-faint">{t(g.label)}</span>
            {groups[g.key]?.map((r) => (
              <div key={r.other} className="group/rel flex items-center">
                <div className="min-w-0 flex-1">
                  <TaskLine id={r.other} />
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    aria-label={t('boards.removeRelation')}
                    onClick={() => (g.key === 'blocked' ? void setRelation(r.other, task.id, r.kind, false) : void setRelation(task.id, r.other, r.kind, false))}
                    className="grid size-6 place-items-center rounded-full text-muted opacity-0 hover:bg-hover hover:text-fg group-hover/rel:opacity-100"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null,
      )}
      {canEdit ? (
        <Dropdown.Root modal={false}>
          <Dropdown.Trigger asChild>
            <button type="button" className="flex h-8 items-center gap-1.5 self-start rounded-[var(--radius-row)] px-2 text-control text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active" data-testid="relation-add">
              <Link2 className="size-3.5" aria-hidden /> {t('boards.addRelation')}
            </button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className={cx(menuBox, 'w-52')} sideOffset={4} align="start">
              {[TaskRelationKind.BLOCKS, TaskRelationKind.RELATES, TaskRelationKind.DUPLICATES].map((k) => (
                <Dropdown.Item key={k} className={menuItem} onSelect={() => window.setTimeout(() => setKind(k), 0)}>
                  {t(k === TaskRelationKind.BLOCKS ? 'boards.rel.blocks' : k === TaskRelationKind.RELATES ? 'boards.rel.relates' : 'boards.rel.duplicates')}
                </Dropdown.Item>
              ))}
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      ) : null}
      {kind !== null ? (
        <ChoiceMenu open onOpenChange={(v) => !v && setKind(null)} groups={[{ id: 't', label: '', items: choices }]} width={320} onPick={(c) => void setRelation(task.id, c.id, kind, true)} placeholder={t('boards.menu.task')} label={t('boards.addRelation')}>
          <span className="block h-0" />
        </ChoiceMenu>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ activity

type FeedRow = { kind: 'msg'; at: number; key: string; index: number } | { kind: 'act'; at: number; key: string; a: TaskActivity };

/** Comments (the task room) and the journal in one timeline, oldest first (Linear). */
function Activity({ task, room, toEnd, commentsOff }: { task: Task; room: Room; toEnd: () => void; commentsOff: boolean }): ReactNode {
  const state = useMessages((s) => s.rooms[room.id] ?? EMPTY_ROOM_MESSAGES);
  const live = useBoards((s) => s.activity[task.id]);
  const [loaded, setLoaded] = useState<TaskActivity[]>([]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const perms = useTaskPerms(task);
  const roomPerms = useMemo(() => taskRoomPermissions(perms, !!task.archivedAt, commentsOff), [perms, task.archivedAt, commentsOff]);
  useEffect(() => {
    void openRoom(room.id);
    subscribeRooms([room.id]);
    let alive = true;
    void loadActivity(task.id).then((list) => alive && setLoaded(list));
    return () => {
      alive = false;
    };
  }, [room.id, task.id]);
  const [cache] = useState(() => new Map<string, RowMeta>());
  const metas = useMemo(() => buildMetas(state.items, '', me, cache), [state.items, me, cache]);
  const rows = useMemo((): FeedRow[] => {
    const acts = new Map<string, TaskActivity>();
    for (const a of [...loaded, ...(live ?? [])]) acts.set(a.id, a);
    const firstMsg = state.items[0]?.msg.createdAt ? timestampMs(state.items[0].msg.createdAt) : Infinity;
    const out: FeedRow[] = state.items.map((c, i) => ({ kind: 'msg' as const, at: c.msg.createdAt ? timestampMs(c.msg.createdAt) : Number.MAX_SAFE_INTEGER, key: c.key, index: i }));
    for (const a of acts.values()) {
      const at = a.createdAt ? timestampMs(a.createdAt) : 0;
      // Older history not loaded yet: journal rows before it wait for «Показать ранние».
      if (state.hasMoreBefore && at < firstMsg) continue;
      out.push({ kind: 'act', at, key: a.id, a });
    }
    return out.sort((x, y) => x.at - y.at || (x.key < y.key ? -1 : 1));
  }, [state.items, state.hasMoreBefore, loaded, live]);
  // Read: the newest comment is on screen (the panel is open) and the window has the focus.
  const last = state.items.at(-1);
  useEffect(() => {
    if (!last || last.status !== 'sent') return;
    const mark = (): void => {
      if (document.hasFocus()) markRead(room.id, last.msg.id);
    };
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [last, room.id]);
  // A new comment of mine scrolls the panel to it.
  const count = state.items.length;
  useEffect(() => {
    if (last?.msg.authorId === me && last.status !== 'sent') toEnd();
  }, [count, last, me, toEnd]);
  const tab = useBoardsUi((s) => s.activityTab);
  const shown = useMemo(() => filterFeed(rows, tab), [rows, tab]);
  // A jump to a comment (a search hit, ADR-0062 §4): page up to it, scroll it into view, flash it.
  const jump = useChatView((s) => (s.jump?.roomId === room.id ? s.jump : null));
  const highlight = useChatView((s) => s.highlight);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!jump) return;
    useChatView.getState().clearJump();
    const target = jump.messageId;
    // The comment must be visible in the feed: «Все» or «Комментарии», not «Изменения».
    if (useBoardsUi.getState().activityTab === 'changes') useBoardsUi.getState().setActivityTab('all');
    void revealOlder(room.id, target).then((ok) => {
      if (!ok) {
        toast.info(t('chat.messageGone'));
        return;
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const el = section.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`);
          if (!el) return;
          el.scrollIntoView({ block: 'center' });
          useChatView.getState().setHighlight(target);
          window.setTimeout(() => {
            if (useChatView.getState().highlight === target) useChatView.getState().setHighlight(null);
          }, 1800);
        }),
      );
    });
  }, [jump, room.id]);
  const tabs: Array<{ value: ActivityTab; label: string }> = [
    { value: 'all', label: t('boards.feed.all') },
    { value: 'changes', label: t('boards.feed.changes') },
    { value: 'comments', label: t('boards.feed.comments') },
  ];
  return (
    <section ref={section} className="-mx-5 flex flex-col border-t border-line pt-3" aria-label={t('boards.activity')} data-testid="task-activity">
      <div className="flex flex-wrap items-center gap-2 px-5 pb-2">
        <h3 className="mr-auto text-control font-semibold">{t('boards.activity')}</h3>
        <Segmented value={tab} options={tabs} onChange={useBoardsUi.getState().setActivityTab} label={t('boards.feed.label')} />
      </div>
      {state.hasMoreBefore ? (
        <button type="button" onClick={() => void loadOlder(room.id)} className="mx-5 mb-2 h-7 self-start rounded-full px-2.5 text-caption text-accent-text hover:bg-hover" data-testid="activity-older">
          {state.loading ? <Spinner className="size-3.5" /> : t('boards.olderComments')}
        </button>
      ) : null}
      <div className="flex flex-col" data-testid="activity-feed" data-tab={tab}>
        {shown.map((r, i) => {
          // A comment group and a run of journal lines are set apart (docs/08: 8 px above / below).
          const gap = startsRun(shown, i) ? 'mt-2' : '';
          if (r.kind === 'act') return <ActivityRow key={r.key} a={r.a} task={task} className={gap} />;
          const c = state.items[r.index];
          const meta = metas[r.index];
          if (!c || !meta) return null;
          return (
            <div key={r.key} className={gap}>
              {c.msg.kind === MessageKind.SYSTEM ? (
                <SystemRow c={c} meta={meta} workspaceId={task.workspaceId} perms={roomPerms} highlighted={highlight === c.key} />
              ) : (
                <MessageRow c={c} meta={{ ...meta, day: false, isNew: false }} own={c.msg.authorId === me} workspaceId={task.workspaceId} roomId={room.id} perms={roomPerms} highlighted={highlight === c.key} />
              )}
            </div>
          );
        })}
        {shown.length === 0 && tab !== 'all' ? (
          <p className="px-5 py-3 text-caption text-muted" data-testid="activity-empty">
            {tab === 'comments' ? t('boards.feed.noComments') : t('boards.feed.noChanges')}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function ActivityRow({ a, task, className }: { a: TaskActivity; task: Task; className?: string }): ReactNode {
  const name = useMemberName(task.workspaceId, a.actorId);
  const board = useBoards((s) => s.boards[task.boardId]);
  const text = activityText(a, board, task.workspaceId);
  const at = a.createdAt ? toDate(a.createdAt) : null;
  // A change made by an automation rule (ADR-0060): no actor, «⚙ Автоматизация: имя правила».
  const rule = !a.actorId && !!a.ruleId;
  return (
    <div className={cx('flex items-start gap-2 px-5 py-0.5 text-caption text-muted', className)} data-testid="activity-row" data-kind={a.kind} data-rule={rule || undefined}>
      {rule ? <RuleActor boardId={task.boardId} ruleId={a.ruleId} /> : (
        <ProfileTarget userId={a.actorId} name={name} workspaceId={task.workspaceId} tabbable className="shrink-0 rounded-full">
          <MemberAvatar workspaceId={task.workspaceId} userId={a.actorId} size={16} />
        </ProfileTarget>
      )}
      <span className="min-w-0 flex-1">
        {rule ? null : (
          <ProfileTarget userId={a.actorId} name={name} workspaceId={task.workspaceId} tabbable className="rounded-[var(--radius-control)] text-left font-medium text-fg hover:underline">
            {name}
          </ProfileTarget>
        )}{' '}
        {text}
      </span>
      {at ? <span className="shrink-0 tabular-nums text-faint" title={fmt.full(at)}>{fmt.time(at)}</span> : null}
    </div>
  );
}

/**
 * The actor of a rule's change: a cog and «Автоматизация: <имя правила>». The name comes from the
 * board's rules (loaded on demand — readable by every viewer, BOARD_RULE_UPDATE keeps it); a
 * deleted or unknown rule — «Автоматизация».
 */
function RuleActor({ boardId, ruleId }: { boardId: string; ruleId: string }): ReactNode {
  const name = useAutomations((s) => ruleNameOf(s, ruleId));
  useEffect(() => {
    if (!name) void ensureRules(boardId);
  }, [boardId, name]);
  return (
    <>
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[var(--color-fill-hover)] text-fg" aria-hidden>
        <Cog className="size-3" />
      </span>
      <span className="-mr-1 shrink-0 font-medium text-fg" data-testid="activity-rule">
        {name ? t('rules.actorNamed', { name }) : t('rules.actor')}
      </span>
    </>
  );
}

type Json = Record<string, unknown> | undefined;

/** One journal row as text: «статус: Todo → В работе» (before / after JSON of boards.proto). */
export function activityText(a: Pick<TaskActivity, 'kind' | 'before' | 'after'>, board: { statuses: Array<{ id: string; name: string }>; milestones: Array<{ id: string; name: string }> } | undefined, workspaceId: string): string {
  const b = a.before as Json;
  const f = a.after as Json;
  const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const status = (id: unknown): string => board?.statuses.find((s) => s.id === id)?.name ?? '—';
  switch (a.kind) {
    case 'created':
      return t('boards.act.created');
    case 'status':
      return t('boards.act.status', { from: status(b?.['status_id']), to: status(f?.['status_id']) });
    case 'priority':
      return t('boards.act.priority', { from: t(PRIORITY_LABEL[Number(b?.['priority'] ?? 0)] ?? 'boards.prio.none'), to: t(PRIORITY_LABEL[Number(f?.['priority'] ?? 0)] ?? 'boards.prio.none') });
    case 'assignees': {
      const list = Array.isArray(f?.['assignees']) ? (f['assignees'] as Array<Record<string, unknown>>) : [];
      return list.length ? t('boards.act.assignees', { names: list.map((x) => `${memberName(workspaceId, str(x['user_id']))}${x['is_lead'] ? ' ★' : ''}`).join(', ') }) : t('boards.act.unassigned');
    }
    case 'labels':
      return t('boards.act.labels');
    case 'dates':
      return f?.['due_on'] ? t('boards.act.due', { date: str(f['due_on']) }) : t('boards.act.dates');
    case 'estimate':
      return t('boards.act.estimate', { n: str(f?.['estimate']) || '—' });
    case 'parent':
      return t('boards.act.parent');
    case 'milestone':
      return t('boards.act.milestone', { name: board?.milestones.find((m) => m.id === f?.['milestone_id'])?.name ?? '—' });
    case 'relation':
      return t('boards.act.relation');
    case 'title':
      return t('boards.act.title', { title: str(f?.['title']) });
    case 'description':
      return t('boards.act.description');
    case 'archived':
      return t('boards.act.archived');
    case 'restored':
      return t('boards.act.restored');
    case 'moved_board':
      return t('boards.act.moved');
    case 'approvers': {
      const ids = Array.isArray(f?.['user_ids']) ? (f['user_ids'] as unknown[]).map(str) : [];
      if (!ids.length) return t('boards.act.noApprovers');
      const names = ids.map((u) => memberName(workspaceId, u)).join(', ');
      const required = Number(f?.['required'] ?? 0);
      return required > 0 && required < ids.length ? t('boards.act.approversQuorum', { names, n: required, m: ids.length }) : t('boards.act.approvers', { names });
    }
    case 'watchers': {
      const was = Array.isArray(b?.['user_ids']) ? (b['user_ids'] as unknown[]).map(str) : [];
      const now = Array.isArray(f?.['user_ids']) ? (f['user_ids'] as unknown[]).map(str) : [];
      const added = now.filter((u) => !was.includes(u));
      const removed = was.filter((u) => !now.includes(u));
      const names = (ids: string[]): string => ids.map((u) => memberName(workspaceId, u)).join(', ');
      if (added.length) return t('boards.act.watchersAdded', { names: names(added) });
      if (removed.length) return t('boards.act.watchersRemoved', { names: names(removed) });
      return t('boards.act.changed');
    }
    case 'approval': {
      const state = str(f?.['state']);
      if (state === 'approved') return t('boards.act.approved');
      if (state === 'rejected') return t('boards.act.rejected', { comment: str(f?.['comment']) });
      return t('boards.act.withdrawn');
    }
    case 'approvals_reset':
      return t('boards.act.approvalsReset');
    case 'checklist':
      return checklistActivity(f);
    case 'milestones':
      return milestoneActivity(f);
    case 'git':
      return gitActivity(f);
    default:
      return t('boards.act.changed');
  }
}

/** A «git» journal row (ADR-0060 §4): after {event, kind, repo, ref, state…}. */
function gitActivity(f: Json): string {
  const s = (k: string): string => (typeof f?.[k] === 'string' ? (f[k]) : '');
  const kind = s('kind');
  const ref = kind === 'pr' ? `${s('repo')}#${s('ref')}` : kind === 'commit' ? `${s('repo')}@${s('ref').slice(0, 7)}` : s('ref');
  if (kind === 'pr' && s('state') === 'merged') return t('boards.act.gitMerged', { ref });
  if (kind === 'pr' && s('state') === 'closed') return t('boards.act.gitClosed', { ref });
  return t('boards.act.git', { what: t(kind === 'pr' ? 'boards.act.gitPr' : kind === 'commit' ? 'boards.act.gitCommit' : 'boards.act.gitBranch'), ref });
}

/**
 * A «milestones» journal row (ADR-0063): after {action, milestone_id, name, due_on} on the task;
 * on a subtask {action: linked | unlinked, task_milestone_id, parent_id} (the name from the parent).
 */
function milestoneActivity(f: Json): string {
  const s = (k: string): string => (typeof f?.[k] === 'string' ? (f[k]) : '');
  const name = s('name');
  switch (f?.['action']) {
    case 'created':
      return t('boards.act.msCreated', { name });
    case 'renamed':
      return t('boards.act.msRenamed', { name });
    case 'dated':
      return s('due_on') ? t('boards.act.msDated', { name, date: s('due_on') }) : t('boards.act.msUndated', { name });
    case 'moved':
      return t('boards.act.msMoved');
    case 'completed':
      return t('boards.act.msCompleted', { name });
    case 'reopened':
      return t('boards.act.msReopened', { name });
    case 'deleted':
      return t('boards.act.msDeleted', { name });
    case 'auto_completed':
      return t('boards.act.msAutoCompleted', { name });
    case 'auto_reopened':
      return t('boards.act.msAutoReopened', { name });
    case 'linked': {
      const m = taskMilestonesOf(useBoards.getState(), s('parent_id')).find((x) => x.id === s('task_milestone_id'));
      return t('boards.act.msLinked', { name: m?.name ?? '—' });
    }
    case 'unlinked':
      return t('boards.act.msUnlinked');
    default:
      return t('boards.act.changed');
  }
}

/** A «checklist» journal row (ADR-0058 §2): after {checklist_id, title, item_id?, text?, action}. */
function checklistActivity(f: Json): string {
  const title = typeof f?.['title'] === 'string' ? f['title'] : '';
  const text = typeof f?.['text'] === 'string' ? f['text'] : '';
  switch (f?.['action']) {
    case 'created':
      return t('boards.act.clCreated', { title });
    case 'renamed':
      return t('boards.act.clRenamed', { title });
    case 'deleted':
      return t('boards.act.clDeleted', { title });
    case 'item_added':
      return t('boards.act.clItemAdded', { text, title });
    case 'item_edited':
      return t('boards.act.clItemEdited', { text });
    case 'item_done':
      return t('boards.act.clItemDone', { text });
    case 'item_undone':
      return t('boards.act.clItemUndone', { text });
    case 'item_removed':
      return t('boards.act.clItemRemoved', { text });
    case 'item_moved':
      return t('boards.act.clItemMoved', { text, title });
    case 'converted':
      return t('boards.act.clConverted', { text });
    default:
      return t('boards.act.clChanged', { title });
  }
}

/** The chat composer of the task room (attachments, stickers, voice, replies, mentions). */
function CommentBox({ task, room, perms, commentsOff }: { task: Task; room: Room; perms: bigint | undefined; commentsOff: boolean }): ReactNode {
  // COMMENTS off (ADR-0058 §3): the room is read-only like an archived task's — no composer.
  const roomPerms = useMemo(() => taskRoomPermissions(perms ?? 0n, !!task.archivedAt, commentsOff), [perms, task.archivedAt, commentsOff]);
  const [files, setFiles] = useState<OutgoingFile[]>([]);
  const canAttach = (roomPerms & BigInt(Permission.ATTACH_FILES)) !== 0n;
  const addFiles = useCallback((list: File[]) => canAttach && setFiles((cur) => [...cur, ...list.map(toOutgoing)].slice(0, 20)), [canAttach]);
  const [dragging, drop] = useFileDrop(canAttach, addFiles);
  if (!(roomPerms & BigInt(Permission.SEND_MESSAGES))) return null;
  return (
    <div className="relative shrink-0 border-t border-line bg-feed mobile:pb-[var(--safe-bottom)]" data-testid="task-composer" {...drop}>
      <Composer workspaceId={task.workspaceId} room={room} perms={roomPerms} files={files} setFiles={setFiles} addFiles={addFiles} />
      {dragging ? <div className="pointer-events-none absolute inset-1 rounded-[var(--radius-card)] border-2 border-dashed border-accent" aria-hidden /> : null}
    </div>
  );
}
