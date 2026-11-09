import * as Dropdown from '../../components/radix/dropdown-menu';
import { BoardFeature, MessageKind, Permission, TaskRelationKind, WorkspaceRole, taskRoomPermissions, type FileMeta, type Room, type Task } from '@calaba/protocol';
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  ChevronRight,
  CopyPlus,
  Crown,
  Ellipsis,
  FolderInput,
  GitFork,
  Link2,
  Paperclip,
  Plus,
  X,
} from 'lucide-react';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { fmt } from '../../lib/format';
import { log } from '../../lib/log';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ProfileTarget } from '../../components/ProfileTarget';
import { Bar } from '../../components/Bar';
import { PhoneBack } from '../../components/PhoneHeader';
import { useShallow } from 'zustand/react/shallow';
import { Button, CloseButton, IconButton, MOD, Modal, Spinner, Tip, cx } from '../../components/ui';
import { Choice as ChoiceSwitch } from '../../components/Choice';
import { t } from '../../i18n';
import type { ActivityTab } from '../../lib/boards/activity';
import { approvalsWouldReset, blockedStatusIds, decidedApprovers, gateReason } from '../../lib/boards/approvals';
import { addAssignee, draftsOf, removeAssignee, replaceAssignee, setLead, setNote, MAX_NOTE } from '../../lib/boards/assignees';
import { thumbnailPath, uploadFile } from '../../lib/api/endpoints';
import { loadOlder, markRead, openRoom, revealOlder, type OutgoingFile } from '../../services/chat';
import { useChatView } from '../chat/chatView';
import { subscribeRooms } from '../../services/gateway';
import {
  archiveTask,
  copyTaskLink,
  createTask,
  duplicateTask,
  ensureBoardTasks,
  loadTask,
  moveTaskToBoard,
  restoreTask,
  searchAllTasks,
  setAssignees,
  setRelation,
  setSubscription,
  setTaskAttachments,
  pickStatus,
  updateTask,
  useTaskDetails,
} from '../../services/boards';
import { boardsApi } from '../../services/boardsApi';
import { taskMilestonesOf, useBoards, workspaceBoards } from '../../stores/boards';
import { milestoneState } from '../../lib/boards/milestones';
import { useBoardsUi } from '../../stores/boardsUi';
import { EMPTY_ROOM_MESSAGES, useMessages } from '../../stores/messages';
import { useRooms } from '../../stores/rooms';
import { myUserId, useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { memberName, useFormerInfo, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { BotConsentPrompt } from '../people/BotConsentPrompt';
import { FormerChip } from '../people/MemberBits';
import { Composer, toOutgoing } from '../chat/Composer';
import { buildMetas, type RowMeta } from '../chat/grouping';
import { MessageRow, SystemRow } from '../chat/MessageBubble';
import { useFileDrop } from '../chat/useFileDrop';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { DRAG_USER, dragKind } from '../calendar/dragState';
import { featureOn, type Disabled } from '../../lib/boards/features';
import { ApprovalsSection } from './Approvals';
import { WatchersSection } from './Watchers';
import { GitSection, ReleaseValues } from './GitLinks';
import { AttachmentChip } from './AttachmentChip';
import { DescriptionView } from './DescriptionView';
import { descriptionToDoc, docToDescription } from './descriptionDoc';
import { RichDescription } from './RichDescription';
import { preloadWikiEditor, type UploadedImage, type WikiEditorApi } from '../wiki/editor';
import type { PmNode } from '@calaba/wiki-doc/markdown';
import { AttachmentImg } from '../../components/AttachmentImg';
import { THUMB_LARGE, thumbWidthPath } from '../../lib/thumbs';
import { openAttachment } from '../../services/files';
import { TaskDates } from './TaskDates';
import { Checklists } from './Checklists';
import { MilestoneDiamond, TaskMilestones } from './TaskMilestones';
import { TaskHistory } from './TaskHistory';
import { LabelsOverflow } from './LabelsOverflow';
import { AssigneeMenu, ChoiceMenu, DateMenu, EstimateMenu, LabelMenu, MemberAvatar, MilestoneMenu, PriorityMenu, StatusMenu, estimateLabel, useToday, type Choice } from './menus';
import { linkChoices, taskChoices } from './taskChoices';
import { doneType, editLockKey, hasBit, mayArchiveTask, mayEditTask, mayRestoreTask, CREATE_TASKS, MANAGE_BOARD } from './model';
import { useDisabledFeatures, useEstimateScale } from './useBoardView';
import { useBoardScoped, useTaskPerms } from './useTaskPerms';
import { PRIORITY_LABEL, PriorityIcon, StatusIcon, formatDue, isOverdue } from './visuals';

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20000;
/** Attachments of a task (the server's limit). */
const ATTACH_MAX = 20;

/** A «light» task: the server counts files, none are loaded (a board list, an event with another count). */
export function lacksFiles(task: Task | undefined): boolean {
  return !!task && task.attachmentCount > 0 && task.attachments.length === 0;
}

/**
 * CBF-160 safety net: the open card lost its files to a light copy (the count diverged) — fetch it
 * again. Only on the change to «light» while the same task stays open: the open itself is loaded
 * by the caller (no double GET / mark-read), and a server answer that stays empty is no new change (no loop).
 */
export function useRefetchLostFiles(taskId: string, lacks: boolean): void {
  const prev = useRef({ taskId, lacks });
  useEffect(() => {
    const was = prev.current;
    prev.current = { taskId, lacks };
    if (lacks && !was.lacks && was.taskId === taskId) void loadTask(taskId);
  }, [taskId, lacks]);
}

/**
 * The task on the phone (ADR-0042 §5, ADR-0073): a full-screen pushed page with «←». One scroll:
 * title (inline), description (markdown-lite with attachments), properties — status, priority,
 * assignees with the lead and «за что отвечает», labels, dates, estimate, milestone, parent —
 * subtasks, relations and the activity; the chat composer at the bottom. The desktop shows the
 * same sections in two columns (TaskView.tsx); the pieces below are shared.
 */
export function TaskPanel({ taskId }: { taskId: string }): ReactNode {
  const task = useBoards((s) => s.tasks[taskId]);
  useEffect(() => {
    void loadTask(taskId);
  }, [taskId]);
  useRefetchLostFiles(taskId, lacksFiles(task));
  const close = (): void => useBoardsUi.getState().openTask(null);
  const shell = 'mat-content fixed inset-0 z-[var(--z-modal)] flex min-w-0 flex-col pt-[var(--safe-top)]';
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
      <PanelBody task={task} onClose={close} />
    </aside>
  );
}

function PanelBody({ task, onClose }: { task: Task; onClose: () => void }): ReactNode {
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
      <PanelHeader task={task} boardName={boardName} perms={perms} scoped={scoped} onClose={onClose} />
      <ArchivedBanner task={task} />
      <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="task-scroll">
        <div className="flex flex-col gap-5 px-5 pb-6 pt-4">
          <TitleEditor task={task} canEdit={canEdit} />
          <TaskDates id={task.id} />
          <DescriptionEditor task={task} canEdit={canEdit} attachments={on(BoardFeature.ATTACHMENTS)} />
          {/* Git links (ADR-0060 §4): under the attachments; its own subscriber, nothing when none. */}
          {on(BoardFeature.GIT_LINKS) ? <GitSection taskId={task.id} /> : null}
          <Properties task={task} canEdit={canEdit} perms={perms} scoped={scoped} disabled={disabled} />
          {/* Watchers (ADR-0076): their own collapsible section, collapsed by default. */}
          <WatchersSection task={task} canEdit={canEdit} />
          {/* Milestones inside the task (ADR-0063): top-level tasks only; their own subscriber. */}
          {on(BoardFeature.MILESTONES) && !task.parentId ? <TaskMilestones taskId={task.id} canEdit={canEdit} /> : null}
          {/* Checklists: their own subscriber (a toggle re-renders that section only, ADR-0058 §2). */}
          {on(BoardFeature.CHECKLISTS) ? <Checklists taskId={task.id} workspaceId={task.workspaceId} canEdit={canEdit} subtasks={on(BoardFeature.SUBTASKS) && !task.parentId} /> : null}
          {on(BoardFeature.SUBTASKS) ? <Subtasks task={task} ids={detail?.subtasks ?? []} canCreate={hasBit(perms, CREATE_TASKS) && !scoped} /> : null}
          {on(BoardFeature.RELATIONS) ? <Relations task={task} ids={detail?.related ?? []} canEdit={canEdit} /> : null}
          {room ? <Activity task={task} room={room} toEnd={toEnd} commentsOff={!on(BoardFeature.COMMENTS)} /> : <div className="grid h-16 place-items-center"><Spinner /></div>}
        </div>
      </div>
      {room ? <CommentBox key={room.id} task={task} room={room} perms={perms} commentsOff={!on(BoardFeature.COMMENTS)} /> : null}
    </>
  );
}

function PanelHeader({ task, boardName, perms, scoped, onClose }: { task: Task; boardName: string; perms: bigint | undefined; scoped: boolean; onClose: () => void }): ReactNode {
  const subscribed = task.subscribed && !task.muted;
  const parent = useBoards((s) => (task.parentId ? s.tasks[task.parentId] : undefined));
  const searchFrom = useBoardsUi((s) => s.searchFrom);
  return (
    <Bar plain className="gap-1 pl-2 pr-2" data-testid="task-panel-header">
      <PhoneBack />
      {/* From a «Все задачи» search (#89) the path starts there; the phone has room for one crumb. */}
      <button type="button" onClick={onClose} className="min-w-0 truncate rounded-[var(--radius-icon)] px-2 text-caption text-muted hover:bg-hover hover:text-fg mobile:tap-h" title={searchFrom ? t('boards.crumb.back') : undefined} data-testid={searchFrom ? 'panel-crumb-search' : 'panel-crumb-board'}>
        {searchFrom ? `${t('boards.myTasks')} › ${t('boards.crumb.search', { q: searchFrom })}` : boardName}
      </button>
      {parent ? (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
          <button type="button" onClick={() => useBoardsUi.getState().openTask(parent.id)} className="shrink-0 rounded-[var(--radius-icon)] px-1 text-caption tabular-nums text-muted hover:bg-hover hover:text-fg mobile:tap-h" data-testid="panel-crumb-parent">
            {parent.key}
          </button>
        </>
      ) : null}
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
      <TaskMoreMenu task={task} perms={perms} scoped={scoped} />
      <CloseButton size="md" onClick={onClose} shortcut="" data-testid="task-close" />
    </Bar>
  );
}

/** Boards a task can be moved to (MANAGE_BOARD there), as `id\0emoji name`. */
export function useMoveTargets(task: Pick<Task, 'workspaceId' | 'boardId'>): string[] {
  return useBoards(useShallow((s) => workspaceBoards(s.boards, task.workspaceId).filter((b) => b.id !== task.boardId && hasBit(b.permissions, MANAGE_BOARD)).map((b) => `${b.id}\u0000${b.emoji} ${b.name}`)));
}

/**
 * «Задача в архиве» (the task view and the phone panel): the task is read-only; «Восстановить»
 * returns it to the board for those the server allows (EDIT_TASKS, or the author).
 */
export const ArchivedBanner = memo(function ArchivedBanner({ task }: { task: Task }): ReactNode {
  const perms = useTaskPerms(task);
  const can = mayRestoreTask(task, perms, myUserId());
  const [busy, setBusy] = useState(false);
  if (!task.archivedAt) return null;
  const when = fmt.dateTime(new Date(timestampMs(task.archivedAt)), 'short');
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line bg-hover px-4 py-2 text-control mobile:flex-wrap" role="status" data-testid="archived-banner">
      <Archive className="size-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-fg">{t('boards.archiveBanner')}</span>
        <span className="text-muted"> · {t('boards.archivedOn', { when })}</span>
      </span>
      {can ? (
        <Button
          size="sm"
          variant="secondary"
          busy={busy}
          onClick={() => {
            setBusy(true);
            void restoreTask(task.id).finally(() => setBusy(false));
          }}
          data-testid="archived-restore"
        >
          <ArchiveRestore className="size-4" aria-hidden /> {t('boards.restore')}
        </Button>
      ) : null}
    </div>
  );
});

/** The task's «⋯»: duplicate, move to a board, archive. */
export function TaskMoreMenu({ task, perms, scoped }: { task: Task; perms: bigint | undefined; scoped: boolean }): ReactNode {
  const boards = useMoveTargets(task);
  const me = myUserId();
  // An archived task is read-only: «Восстановить» (the banner) is its one action.
  if (task.archivedAt) return null;
  return (
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
  );
}

// ------------------------------------------------------------------ title / description

/**
 * Editing the title, description or attachments resets all votes (ADR-0049 §3): when a vote is
 * already decided, `guard(go, cancel)` asks first and runs `go` only on «Изменить и сбросить».
 * Render `dialog` next to the editor.
 */
function useResetGuard(task: Task): { guard: (go: () => void, cancel?: () => void) => void; dialog: ReactNode } {
  const disabled = useDisabledFeatures(task.boardId);
  const [ask, setAsk] = useState<{ go: () => void; cancel?: () => void } | null>(null);
  const would = approvalsWouldReset(task, disabled);
  const guard = (go: () => void, cancel?: () => void): void => {
    if (would) setAsk({ go, cancel });
    else go();
  };
  const decided = decidedApprovers(task);
  const close = (ok: boolean): void => {
    const a = ask;
    setAsk(null);
    if (a) (ok ? a.go : (a.cancel ?? (() => undefined)))();
  };
  const dialog = ask ? (
    <Modal
      open
      onClose={() => close(false)}
      title={t('boards.resetTitle')}
      description={t('boards.resetText', { n: decided.length, m: task.approvers.length, names: decided.map((a) => memberName(task.workspaceId, a.userId)).join(', ') })}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={() => close(true)} data-testid="approvals-reset-confirm">
            {t('boards.resetConfirm')}
          </Button>
        </>
      }
    >
      {null}
    </Modal>
  ) : null;
  return { guard, dialog };
}

export function TitleEditor({ task, canEdit, large = false }: { task: Task; canEdit: boolean; large?: boolean }): ReactNode {
  const { guard, dialog } = useResetGuard(task);
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
    else if (next !== task.title) guard(() => void updateTask(task.id, { title: next }), () => setV(task.title));
  };
  return (
    <>
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
      className={cx('selectable w-full resize-none overflow-hidden rounded-[var(--radius-row)] bg-transparent font-semibold text-fg outline-none focus-visible:bg-hover', large ? 'text-large leading-[34px]' : 'text-title leading-[26px]')}
      data-testid="task-title"
    />
    {dialog}
    </>
  );
}

/** A picture of the description (CBF-59): the task's attachment shown in place; a click opens the Lightbox. */
const DescriptionImage = memo(function DescriptionImage({ id, name, list }: { id: string; name: string; list: readonly FileMeta[] }): ReactNode {
  const f = list.find((x) => x.id === id);
  if (!f) return <span className="block text-caption text-faint">{name || t('boards.imageGone')}</span>;
  return (
    // Not a <button>: the description is itself a button («edit»); the chip below the text is the keyboard path.
    <div
      onClick={(e) => { e.stopPropagation(); openAttachment(f, list); }}
      className="max-w-full cursor-zoom-in"
      data-testid="task-description-img"
    >
      <AttachmentImg f={f} thumb={thumbWidthPath(thumbnailPath(f.id), THUMB_LARGE)} alt={name} loading="lazy" className="wiki-image-img" />
    </div>
  );
});

/** Changed since editing started, or null when the editor is not there yet (nothing typed). */
function draftOf(api: WikiEditorApi | null, base: string): string | null {
  if (!api || api.editor.isDestroyed) return null;
  const next = docToDescription(api.getJSON() as PmNode);
  return next === base ? null : next;
}

/** A hidden window or the system file picker took the focus: not a blur that ends editing. */
const windowBlur = (): boolean => !document.hasFocus();

/**
 * The description (docs/08 «Доски»): the markdown-lite read view; a click turns it into the rich
 * editor in place (RichDescription, owner 23.10) — saved on blur, ⌘↩ or «Готово», Esc cancels
 * (asks first when something changed). The editor is uncontrolled: typing never re-renders this.
 */
export function DescriptionEditor({ task, canEdit, attachments }: { task: Task; canEdit: boolean; attachments: boolean }): ReactNode {
  const { guard, dialog } = useResetGuard(task);
  const [editing, setEditing] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const api = useRef<WikiEditorApi | null>(null);
  /** The description as the editor writes it back untouched (a save without edits is no save). */
  const base = useRef('');
  /** Pictures uploading: a blur meanwhile keeps the editor (the picture lands in it). */
  const uploads = useRef(0);
  /** A save waits for the reset prompt: no second one from the blur it causes. */
  const asking = useRef(false);
  const live = useRef(task);
  useLayoutEffect(() => {
    live.current = task;
  });

  const start = (): void => {
    if (!canEdit || editing) return;
    base.current = docToDescription(descriptionToDoc(task.description));
    setEditing(true);
  };
  const close = (): void => {
    asking.current = false;
    api.current = null;
    setDiscard(false);
    setEditing(false);
  };
  const save = (): void => {
    if (asking.current) return;
    const next = draftOf(api.current, base.current);
    if (next === null || next === task.description) {
      close();
      return;
    }
    if (next.length > DESCRIPTION_MAX) {
      toast.error(t('boards.descriptionTooLong', { n: DESCRIPTION_MAX.toLocaleString() }));
      return;
    }
    asking.current = true;
    // Cancelling the reset prompt keeps the editor open with the draft.
    guard(
      () => {
        close();
        void updateTask(task.id, { description: next });
      },
      () => {
        asking.current = false;
        api.current?.focus();
      },
    );
  };
  const cancel = (): void => {
    if (draftOf(api.current, base.current) === null) {
      close();
      return;
    }
    asking.current = true; // the prompt takes the focus: that blur is no save
    setDiscard(true);
  };
  const keep = (): void => {
    asking.current = false;
    setDiscard(false);
    api.current?.focus();
  };
  const onKey = (e: KeyboardEvent): boolean => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
    else if (e.key === 'Escape') cancel();
    else return false;
    // The board's own keys (Esc closes the task) never see these.
    e.stopPropagation();
    return true;
  };
  const keyRef = useRef(onKey);
  useLayoutEffect(() => {
    keyRef.current = onKey;
  });
  const stableKey = useCallback((e: KeyboardEvent) => keyRef.current(e), []);
  const onReady = useCallback((a: WikiEditorApi | null) => {
    api.current = a;
    a?.focus('end');
  }, []);
  // CBF-59: a picture pasted / dropped / picked in the editor becomes an attachment of the task at once; the text refers to it.
  const upload = useCallback(
    async (f: File): Promise<UploadedImage> => {
      const cur = live.current;
      if (cur.attachments.length >= ATTACH_MAX) throw new Error('too many attachments');
      uploads.current++;
      try {
        const up = await uploadFile(boardsApi.uploadPath(cur.boardId), f, f.name || 'image.png', () => undefined).promise;
        await setTaskAttachments(cur.id, [...live.current.attachments.map((a) => a.id), up.id]);
        return { fileId: up.id, width: up.width, height: up.height };
      } finally {
        uploads.current--;
      }
    },
    [],
  );
  const attach = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const ids = task.attachments.map((a) => a.id);
      for (const f of [...files].slice(0, ATTACH_MAX - ids.length)) ids.push((await uploadFile(boardsApi.uploadPath(task.boardId), f, f.name, () => undefined).promise).id);
      await setTaskAttachments(task.id, ids);
    } catch (e) {
      toast.fail(e, t('boards.err.save'));
    } finally {
      setBusy(false);
    }
  };
  const removeAttachment = (f: FileMeta): void => guard(() => void setTaskAttachments(task.id, task.attachments.filter((x) => x.id !== f.id).map((x) => x.id)));
  const image = useCallback((id: string, name: string) => <DescriptionImage id={id} name={name} list={task.attachments} />, [task.attachments]);
  const view = (
    <div
      role={canEdit && !editing ? 'button' : undefined}
      tabIndex={canEdit && !editing ? 0 : undefined}
      onClick={start}
      onPointerEnter={canEdit ? preloadWikiEditor : undefined}
      onFocus={canEdit ? preloadWikiEditor : undefined}
      onKeyDown={(e) => e.key === 'Enter' && start()}
      className={cx('selectable min-h-8 rounded-[var(--radius-row)] text-body', canEdit && 'cursor-text hover:bg-[color-mix(in_srgb,var(--color-fill)_40%,transparent)]', !task.description && 'text-faint')}
      data-testid="task-description"
    >
      {task.description ? <DescriptionView workspaceId={task.workspaceId} description={task.description} image={image} /> : canEdit ? t('boards.descriptionPlaceholder') : t('boards.noDescription')}
    </div>
  );
  return (
    <section className="flex flex-col gap-2" aria-label={t('boards.description')}>
      {editing ? (
        <div
          className="flex flex-col gap-1"
          onBlur={(e) => {
            const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
            // Focus inside the editor, into its own popovers (the link field), out of the window, or a blur before the editor is there: still editing.
            if ((to && (e.currentTarget.contains(to) || to.closest('.mat-popover'))) || windowBlur() || uploads.current || !api.current) return;
            save();
          }}
          data-testid="task-description-editor"
        >
          <RichDescription workspaceId={task.workspaceId} initial={task.description} onUploadImage={attachments ? upload : undefined} onReady={onReady} onKey={stableKey} fallback={view} className="min-h-8 rounded-[var(--radius-row)]" />
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={save} title={`${MOD}↩`} data-testid="task-description-save">
              {t('boards.descriptionDone')}
            </Button>
          </div>
        </div>
      ) : (
        view
      )}
      {attachments && (task.attachments.length || canEdit) ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {task.attachments.map((f) => (
            <AttachmentChip key={f.id} file={f} list={task.attachments} {...(canEdit ? { onRemove: removeAttachment } : {})} />
          ))}
          {canEdit ? (
            <>
              <Button variant="ghost" size="sm" busy={busy} onClick={() => guard(() => file.current?.click())} data-testid="task-attach">
                <Paperclip className="size-3.5" aria-hidden /> {t('boards.attach')}
              </Button>
              <input ref={file} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
            </>
          ) : null}
        </div>
      ) : null}
      {discard ? (
        <Modal
          open
          onClose={keep}
          title={t('boards.descriptionDiscard')}
          footer={
            <>
              <Button variant="secondary" onClick={keep}>
                {t('boards.descriptionKeep')}
              </Button>
              <Button variant="destructive" onClick={close} data-testid="task-description-discard">
                {t('boards.descriptionDiscardConfirm')}
              </Button>
            </>
          }
        >
          {null}
        </Modal>
      ) : null}
      {dialog}
    </section>
  );
}

// ------------------------------------------------------------------ properties

export function Prop({ label, children, testId }: { label: string; children: ReactNode; testId?: string }): ReactNode {
  return (
    <div className="flex min-h-8 items-start gap-3 mobile:flex-col mobile:gap-0.5 mobile:py-1" data-testid={testId}>
      <span data-prop-label className="w-[104px] shrink-0 pt-1.5 text-caption text-muted mobile:w-auto mobile:pt-0">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

/** The task's author (Task.created_by: a user or a bot), read-only, the first property. */
const AuthorProp = memo(function AuthorProp({ task }: { task: Task }): ReactNode {
  const name = useMemberName(task.workspaceId, task.createdBy);
  // CBF-41: a bot-made card shows the bot's «act on your behalf» request to the people it concerns.
  const botAuthor = useWorkspaces((s) => !!s.users[task.createdBy]?.isBot && s.byId[task.workspaceId]?.role !== WorkspaceRole.GUEST);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const concerned = botAuthor && me !== '' && (task.subscribed || task.assignees.some((a) => a.userId === me));
  return (
    <>
      <Prop label={t('boards.f.author')} testId="prop-author">
        <ProfileTarget userId={task.createdBy} name={name} workspaceId={task.workspaceId} tabbable className="inline-flex h-7 min-w-0 max-w-full items-center gap-2 rounded-[var(--radius-control)] px-1 text-left">
          <MemberAvatar workspaceId={task.workspaceId} userId={task.createdBy} size={20} />
          <span className="min-w-0 truncate text-control font-medium">{name}</span>
        </ProfileTarget>
      </Prop>
      {concerned ? <BotConsentPrompt workspaceId={task.workspaceId} botUserId={task.createdBy} /> : null}
    </>
  );
});

export const valueBtn = 'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-control text-fg hover:bg-hover disabled:hover:bg-transparent data-[state=open]:bg-active';

export function Properties({ task, canEdit, perms, scoped, disabled, bare = false }: { task: Task; canEdit: boolean; perms: bigint | undefined; scoped: boolean; disabled: Disabled; bare?: boolean }): ReactNode {
  const statuses = useBoards((s) => s.boards[task.boardId]?.statuses);
  const status = statuses?.find((x) => x.id === task.statusId);
  // ADR-0049: statuses «further» are disabled while the task waits for approval.
  const gate = useBoards((s) => s.boards[task.boardId]?.approvalGate);
  const blocked = useMemo(() => blockedStatusIds(task, statuses ?? [], gate), [task, statuses, gate]);
  // Why they are disabled: «1/3» or «rejected» instead of the bare «approval needed».
  const reason = gateReason(task);
  const gateKey = !reason ? '' : reason.kind === 'rejected' ? 'r' : `${reason.n}/${reason.m}`;
  const blockedNote = useMemo(() => (gateKey === '' ? undefined : gateKey === 'r' ? t('boards.gate.hintRejected') : `${t('boards.gate.hint')} ${gateKey}`), [gateKey]);
  // ADR-0108: a board manager may still pick them (marked), after a confirmation.
  const manage = !scoped && hasBit(perms, MANAGE_BOARD);
  const labels = useBoards((s) => s.boards[task.boardId]?.labels);
  const milestone = useBoards((s) => s.boards[task.boardId]?.milestones.find((m) => m.id === task.milestoneId));
  const parent = useBoards((s) => (task.parentId ? s.tasks[task.parentId] : undefined));
  const today = useToday();
  const scale = useEstimateScale(task.boardId);
  const on = (f: BoardFeature): boolean => featureOn(disabled, f);
  const done = doneType(status?.type);
  const labelIds = task.labelIds;
  const mine = useMemo(() => (labels ?? []).filter((l) => labelIds.includes(l.id)), [labels, labelIds]);
  const menu = useBoardsUi((s) => (s.menu?.taskId === task.id ? s.menu.kind : null));
  const req = (k: string): { open?: boolean; onOpenChange?: (v: boolean) => void } => (menu === k ? { open: true, onOpenChange: (v) => !v && useBoardsUi.getState().closeMenu() } : {});
  return (
    <section className={cx('flex flex-col gap-0.5', !bare && 'rounded-[var(--radius-card)] border border-line p-2')} aria-label={t('boards.properties')} data-testid="task-properties">
      {task.createdBy ? <AuthorProp task={task} /> : null}
      <Prop label={t('boards.f.status')}>
        <StatusMenu boardId={task.boardId} value={task.statusId} blocked={blocked} blockedNote={blockedNote} overridable={manage} onPick={(s) => void pickStatus(task.id, s, manage)} {...req('status')}>
          <button type="button" disabled={!canEdit} className={valueBtn} data-testid="prop-status">
            <StatusIcon type={status?.type ?? 0} color={status?.color ?? 0} icon={status?.icon} /> <span className="truncate">{status?.name ?? ''}</span>
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
      <Assignees task={task} canEdit={canEdit} cardOnly={scoped && !hasBit(perms, CREATE_TASKS)} req={req('assignee')} stacked={bare} />
      {on(BoardFeature.LABELS) ? (
        <Prop label={t('boards.f.label')}>
          <LabelsOverflow
            labels={mine}
            size="md"
            dragLabels
            className="w-full"
            trailing={
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
            }
          />
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
      {on(BoardFeature.GIT_LINKS) && task.releases.length ? (
        <Prop label={t('boards.f.release')}>
          <ReleaseValues releases={task.releases} className={valueBtn} />
        </Prop>
      ) : null}
      {/* Approvals last (docs/08): the state band closes the block. */}
      {on(BoardFeature.APPROVALS) ? <ApprovalsSection task={task} canEdit={canEdit} perms={perms} /> : null}
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
  // A task opened by a link / notification / search: its board may not be loaded, so the list would be empty.
  useEffect(() => {
    if (open) void ensureBoardTasks(boardId);
  }, [open, boardId]);
  return useMemo(() => taskChoices(tasks, boardId, exclude), [tasks, boardId, exclude]);
}

/** Typing pause before a relation search request: one query per word, not per key. */
const LINK_DEBOUNCE_MS = 250;

/**
 * The relation picker's choices (CBF-47): the board's tasks at once, and for the typed text the
 * workspace search (GET …/tasks/search — the server keeps only the boards the caller sees) over
 * every board, its hits first; each row names its board. `loading` — the board or the search.
 */
function useLinkChoices(task: Task, open: boolean): { choices: Choice[]; loading: boolean; onInput: (text: string) => void } {
  const tasks = useBoards((s) => (open ? s.tasks : null));
  const boardLoading = useBoards((s) => open && s.load[task.boardId] === 'loading');
  const names = useBoards(useShallow((s) => (open ? workspaceBoards(s.boards, task.workspaceId).map((b) => `${b.id}\u0000${b.emoji || '📋'} ${b.name}`) : NO_NAMES)));
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; ids: string[] } | null>(null);
  const query = open ? q.trim() : '';
  useEffect(() => {
    if (open) void ensureBoardTasks(task.boardId);
  }, [open, task.boardId]);
  useEffect(() => {
    if (!query) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      searchAllTasks(task.workspaceId, query, 'all', ctl.signal).then(
        (ids) => setFound({ q: query, ids }),
        (e: unknown) => {
          if (ctl.signal.aborted) return;
          log.warn('relation search failed', e);
          setFound({ q: query, ids: [] });
        },
      );
    }, LINK_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [task.workspaceId, query]);
  const ids = query && found ? found.ids : NO_NAMES;
  const choices = useMemo(() => {
    const nameOf = new Map(names.map((x) => x.split('\u0000') as [string, string]));
    return linkChoices(tasks, task.boardId, task.id, ids, (b) => nameOf.get(b) ?? '');
  }, [tasks, task.boardId, task.id, ids, names]);
  return { choices, loading: boardLoading || (!!query && found?.q !== query), onInput: setQ };
}

const NO_NAMES: string[] = [];

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

function Assignees({ task, canEdit, cardOnly, req, stacked = false }: { task: Task; canEdit: boolean; cardOnly: boolean; req: { open?: boolean; onOpenChange?: (v: boolean) => void }; stacked?: boolean }): ReactNode {
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
      <span data-prop-label className="w-[104px] shrink-0 pt-1.5 text-caption text-muted mobile:w-auto mobile:pt-0">{t('boards.assignees')}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 mobile:w-full mobile:gap-1.5">
        {task.assignees.map((a) => (
          <AssigneeRow key={a.userId} task={task} userId={a.userId} lead={a.isLead} note={a.note} canEdit={canEdit} stacked={stacked} />
        ))}
        <AssigneeMenu
          workspaceId={task.workspaceId}
          boardId={task.boardId}
          value={task.assignees.map((a) => a.userId)}
          onToggle={(u) => void setAssignees(task.id, drafts.some((d) => d.userId === u) ? removeAssignee(drafts, u) : addAssignee(drafts, u))}
          onNone={() => void setAssignees(task.id, [])}
          {...req}
        >
          <button type="button" disabled={!canEdit} {...(canEdit ? {} : { title: t(editLockKey(!!task.archivedAt, cardOnly)) })} className={cx(valueBtn, 'self-start text-muted')} data-testid="assignee-add">
            <Plus className="size-3.5" aria-hidden /> {t('boards.addAssignee')}
          </button>
        </AssigneeMenu>
      </div>
    </div>
  );
}

/** `stacked` (the full-screen task's properties column, 300 px): the name on its own line, «за что отвечает» under it. */
const AssigneeRow = memo(function AssigneeRow({ task, userId, lead, note, canEdit, stacked = false }: { task: Task; userId: string; lead: boolean; note: string; canEdit: boolean; stacked?: boolean }): ReactNode {
  const name = useMemberName(task.workspaceId, userId);
  const former = !!useFormerInfo(task.workspaceId, userId);
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
    <div className={cx('group/as flex min-h-8 flex-wrap items-center gap-x-2 rounded-[var(--radius-row)] px-1 hover:bg-[color-mix(in_srgb,var(--color-fill)_40%,transparent)] mobile:grid mobile:grid-cols-[minmax(0,1fr)_auto_auto] mobile:gap-x-1 mobile:px-0', stacked && 'relative')} data-testid="assignee-row" data-user={userId}>
      <ProfileTarget userId={userId} name={name} workspaceId={task.workspaceId} tabbable className={cx('inline-flex min-w-0 shrink items-center gap-2 rounded-[var(--radius-control)] text-left mobile:max-w-full', stacked ? 'flex-1' : 'max-w-full')}>
        <MemberAvatar workspaceId={task.workspaceId} userId={userId} size={20} />
        <span className="min-w-0 truncate text-control font-medium mobile:text-[15px] mobile:font-semibold">{name}</span>
        <FormerChip workspaceId={task.workspaceId} userId={userId} />
      </ProfileTarget>
      {former && canEdit ? (
        // ADR-0097 §4: a task of someone who left is not reassigned automatically — the usual picker, one tap.
        <AssigneeMenu
          workspaceId={task.workspaceId}
          boardId={task.boardId}
          value={task.assignees.map((a) => a.userId)}
          onToggle={(u) => void setAssignees(task.id, replaceAssignee(drafts, userId, u))}
          onNone={() => void setAssignees(task.id, removeAssignee(drafts, userId))}
        >
          <button type="button" className="inline-flex h-6 shrink-0 items-center rounded-full border border-line px-2 text-caption text-accent-text hover:bg-hover" data-testid="assignee-reassign">
            {t('former.reassign')}
          </button>
        </AssigneeMenu>
      ) : null}
      <Tip label={lead ? t('boards.lead') : t('boards.makeLead')}>
        <button
          type="button"
          disabled={!canEdit || lead}
          aria-pressed={lead}
          aria-label={lead ? t('boards.lead') : t('boards.makeLead')}
          onClick={() => void setAssignees(task.id, setLead(drafts, userId))}
          className={cx('grid size-6 shrink-0 place-items-center rounded-full mobile:col-start-3 mobile:row-start-1 mobile:justify-self-end', lead ? 'text-[var(--color-role-owner)]' : cx('text-faint opacity-0 hover:text-fg group-hover/as:opacity-100 focus-visible:opacity-100', stacked && 'absolute right-7 top-1 bg-elev'))}
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
        className={cx(stacked ? 'order-last -mt-1 ml-6 min-w-0 basis-full' : 'min-w-[140px] flex-1', 'selectable peer h-7 rounded-[var(--radius-row)] bg-transparent px-1.5 text-caption text-muted outline-none placeholder:text-faint focus:bg-elev focus:text-fg mobile:h-8 mobile:w-full mobile:min-w-0 mobile:px-0 mobile:text-transparent mobile:caret-[var(--color-label-secondary)] mobile:placeholder:text-transparent mobile:focus:text-fg')}
        data-testid="assignee-note"
      />
      <span aria-hidden className="pointer-events-none absolute inset-0 hidden items-center truncate text-[13px] leading-8 text-muted mobile:flex mobile:peer-focus:hidden">
        {v || (canEdit ? <span className="text-faint">{t('boards.notePlaceholder')}</span> : null)}
      </span>
      </div>
      {canEdit ? (
        <button type="button" aria-label={t('boards.removeAssignee', { name })} onClick={() => void setAssignees(task.id, removeAssignee(drafts, userId))} className={cx('grid size-6 shrink-0 place-items-center rounded-full text-muted opacity-0 hover:bg-hover mobile:col-start-2 mobile:row-start-1 hover:text-fg group-hover/as:opacity-100 focus-visible:opacity-100', stacked && 'absolute right-1 top-1 bg-elev')}>
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
      <StatusIcon type={status?.type ?? 0} color={status?.color ?? 0} icon={status?.icon} />
      <span className="shrink-0 text-caption tabular-nums text-muted">{x.key}</span>
      <span className={cx('min-w-0 flex-1 truncate', doneType(status?.type) && 'text-muted line-through')}>{x.title}</span>
      {x.assignees[0] ? <MemberAvatar workspaceId={x.workspaceId} userId={x.assignees[0].userId} size={18} /> : null}
    </button>
  );
}

export function Subtasks({ task, ids, canCreate }: { task: Task; ids: string[]; canCreate: boolean }): ReactNode {
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

export function Relations({ task, canEdit }: { task: Task; ids: string[]; canEdit: boolean }): ReactNode {
  const [kind, setKind] = useState<TaskRelationKind | null>(null);
  const { choices, loading, onInput } = useLinkChoices(task, kind !== null);
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
            <Dropdown.Content className={cx(menuBox, 'w-52')} sideOffset={4} align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
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
        <ChoiceMenu
          open
          onOpenChange={(v) => {
            if (v) return;
            setKind(null);
            onInput('');
          }}
          groups={[{ id: 't', label: '', items: choices }]}
          width={380} onPick={(c) => void setRelation(task.id, c.id, kind, true)} onInput={onInput} placeholder={t('boards.menu.task')} label={t('boards.addRelation')} loading={loading} emptyText={t('boards.noTasksToLink')}>
          <span className="block h-0" />
        </ChoiceMenu>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ comments | history

/**
 * The lower section (ADR-0091 §1): «Комментарии» (the task room as a chat: oldest first, grouped,
 * the composer below) and «История» (the journal timeline, newest first). The tab is remembered;
 * sending a comment or jumping to one (a search hit) switches to «Комментарии».
 */
export function Activity({ task, room, toEnd, commentsOff, aside }: { task: Task; room: Room; toEnd: () => void; commentsOff: boolean; aside?: ReactNode }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  useEffect(() => {
    void openRoom(room.id);
    subscribeRooms([room.id]);
  }, [room.id]);
  // Read: the newest comment is in the panel (it is open) and the window has the focus.
  const lastSent = useMessages((s) => {
    const last = s.rooms[room.id]?.items.at(-1);
    return last?.status === 'sent' ? last.msg.id : '';
  });
  useEffect(() => {
    if (!lastSent) return;
    const mark = (): void => {
      if (document.hasFocus()) markRead(room.id, lastSent);
    };
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [lastSent, room.id]);
  // A new comment of mine: «Комментарии» and the panel scrolled to it.
  const mine = useMessages((s) => {
    const last = s.rooms[room.id]?.items.at(-1);
    return last && last.msg.authorId === me && last.status !== 'sent' ? last.key : '';
  });
  useEffect(() => {
    if (!mine) return;
    if (useBoardsUi.getState().activityTab !== 'comments') useBoardsUi.getState().setActivityTab('comments');
    requestAnimationFrame(toEnd);
  }, [mine, toEnd]);
  const tab = useBoardsUi((s) => s.activityTab);
  const section = useRef<HTMLElement>(null);
  // Seen (ADR-0140): the newest comment is actually on screen (at least half of it, or 120 px of
  // a tall one) with the window focused — the others' ✓✓ and «Прочитали». Opening the panel
  // alone only marks read (above), as before.
  useEffect(() => {
    if (!lastSent || tab !== 'comments') return;
    // Rows carry the item key (an own message keeps its local key after the send).
    const key = useMessages.getState().rooms[room.id]?.items.at(-1)?.key ?? lastSent;
    const el = section.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(key)}"]`);
    if (!el) return;
    let visible = false;
    const mark = (): void => {
      if (visible && document.hasFocus()) markRead(room.id, lastSent, true);
    };
    const io = new IntersectionObserver(
      ([e]) => {
        visible = !!e?.isIntersecting && (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= 120);
        mark();
      },
      { threshold: [0, 0.25, 0.5, 1] },
    );
    io.observe(el);
    window.addEventListener('focus', mark);
    return () => {
      io.disconnect();
      window.removeEventListener('focus', mark);
    };
  }, [lastSent, room.id, tab]);
  // A jump to a comment (a search hit, ADR-0062 §4): page up to it, scroll it into view, flash it.
  const jump = useChatView((s) => (s.jump?.roomId === room.id ? s.jump : null));
  useEffect(() => {
    if (!jump) return;
    useChatView.getState().clearJump();
    const target = jump.messageId;
    if (useBoardsUi.getState().activityTab !== 'comments') useBoardsUi.getState().setActivityTab('comments');
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
  const tabs = useMemo((): Array<{ value: ActivityTab; label: string }> => [
    { value: 'comments', label: t('boards.hist.comments') },
    { value: 'history', label: t('boards.hist.history') },
  ], []);
  return (
    <section ref={section} className="-mx-5 flex flex-col border-t border-line pt-3" aria-label={t('boards.activity')} data-testid="task-activity" data-tab={tab}>
      {aside ? (
        <div className="flex min-h-8 items-center gap-2 px-5 pb-2">
          <h2 className="flex-1 text-control font-semibold text-fg">{t('boards.activity')}</h2>
          {aside}
        </div>
      ) : null}
      <div className="flex items-center px-5 pb-2">
        <ChoiceSwitch value={tab} options={tabs} onChange={useBoardsUi.getState().setActivityTab} label={t('boards.hist.label')} phone="segmented" testId="activity-tabs" />
      </div>
      {tab === 'comments' ? (
        <TaskComments task={task} roomId={room.id} commentsOff={commentsOff} />
      ) : (
        <TaskHistory key={task.id} taskId={task.id} workspaceId={task.workspaceId} boardId={task.boardId} />
      )}
    </section>
  );
}

/** «Комментарии»: the task room's messages with the chat's own rows (reactions, replies, edits). */
function TaskComments({ task, roomId, commentsOff }: { task: Task; roomId: string; commentsOff: boolean }): ReactNode {
  const state = useMessages((s) => s.rooms[roomId] ?? EMPTY_ROOM_MESSAGES);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const perms = useTaskPerms(task);
  const roomPerms = useMemo(() => taskRoomPermissions(perms, !!task.archivedAt, commentsOff), [perms, task.archivedAt, commentsOff]);
  const [cache] = useState(() => new Map<string, RowMeta>());
  const metas = useMemo(() => buildMetas(state.items, '', me, cache), [state.items, me, cache]);
  const highlight = useChatView((s) => s.highlight);
  return (
    <>
      {state.hasMoreBefore ? (
        <button type="button" onClick={() => void loadOlder(roomId)} className="mx-5 mb-2 h-7 self-start rounded-full px-2.5 text-caption text-accent-text hover:bg-hover" data-testid="activity-older">
          {state.loading ? <Spinner className="size-3.5" /> : t('boards.olderComments')}
        </button>
      ) : null}
      <div className="flex flex-col" data-testid="activity-feed">
        {state.items.map((c, i) => {
          const meta = metas[i];
          if (!meta) return null;
          return c.msg.kind === MessageKind.SYSTEM ? (
            <SystemRow key={c.key} c={c} meta={meta} workspaceId={task.workspaceId} perms={roomPerms} highlighted={highlight === c.key} />
          ) : (
            <MessageRow key={c.key} c={c} meta={meta} own={c.msg.authorId === me} workspaceId={task.workspaceId} roomId={roomId} perms={roomPerms} highlighted={highlight === c.key} />
          );
        })}
        {state.items.length === 0 && !state.loading ? (
          <p className="px-5 py-3 text-caption text-muted" data-testid="activity-empty">
            {t('boards.hist.noComments')}
          </p>
        ) : null}
      </div>
    </>
  );
}

/** The chat composer of the task room (attachments, stickers, voice, replies, mentions). */
export function CommentBox({ task, room, perms, commentsOff, className, autoFocus }: { task: Task; room: Room; perms: bigint | undefined; commentsOff: boolean; className?: string; autoFocus?: boolean }): ReactNode {
  // COMMENTS off (ADR-0058 §3): the room is read-only like an archived task's — no composer.
  const roomPerms = useMemo(() => taskRoomPermissions(perms ?? 0n, !!task.archivedAt, commentsOff), [perms, task.archivedAt, commentsOff]);
  const [files, setFiles] = useState<OutgoingFile[]>([]);
  const canAttach = (roomPerms & BigInt(Permission.ATTACH_FILES)) !== 0n;
  const addFiles = useCallback((list: File[]) => canAttach && setFiles((cur) => [...cur, ...list.map(toOutgoing)].slice(0, 20)), [canAttach]);
  const [dragging, drop] = useFileDrop(canAttach, addFiles);
  if (!(roomPerms & BigInt(Permission.SEND_MESSAGES))) return null;
  return (
    <div className={cx('relative shrink-0', className ?? 'border-t border-line bg-feed mobile:pb-[var(--safe-bottom)]')} data-testid="task-composer" {...drop}>
      <Composer workspaceId={task.workspaceId} room={room} perms={roomPerms} files={files} setFiles={setFiles} addFiles={addFiles} {...(autoFocus === false ? { autoFocus } : {})} />
      {dragging ? <div className="pointer-events-none absolute inset-1 rounded-[var(--radius-card)] border-2 border-dashed border-accent" aria-hidden /> : null}
    </div>
  );
}
