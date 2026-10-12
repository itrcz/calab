import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ApproverState, TaskApprovalDecision, type Task } from '@calaba/protocol';
import { Check, ChevronDown, Clock3, Plus, X } from 'lucide-react';
import { memo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Button, Modal, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { approvalBadge, approvalControls, approvalTagKey, approvedCount, clampRequired, parseApprovalTag, quorumChoices, quorumOf, rejecters, toggleApprover, MAX_REJECT_COMMENT } from '../../lib/boards/approvals';
import { useBoards } from '../../stores/boards';
import { setApprovers, voteApproval } from '../../services/boards';
import { myUserId } from '../../stores/session';
import { memberName, useMemberName } from '../../stores/workspaces';
import { DRAG_USER, dragKind } from '../calendar/dragState';
import { menuBox, menuItem } from '../shell/menu';
import { ApproverMenu, MemberAvatar } from './menus';
import { hasBit, VIEW_BOARD } from './model';

/**
 * Task approvals UI (ADR-0049 §6, docs/08 «Доски»): the card / row tag and the panel section
 * «Согласующие» — the state band / approvers with their votes, «Нужно: Все ▾ / N из M», «+ Согласующий» and,
 * for me as an approver, «Согласовать» / «Отклонить» (a comment is required) / «Отозвать».
 */

// ------------------------------------------------------------------ tag (card, list row)

/**
 * «✓ 3/3» filled green once approved, «2/3» outlined orange while waiting, «✕ 1/3» outlined red
 * after a veto; nothing without approvers. Reads its task by id through a primitive selector
 * (approvalTagKey): a card's TASK_UPDATE re-renders the tag only when the tag itself changes.
 */
export const ApprovalTag = memo(function ApprovalTag({ id, compact = false }: { id: string; compact?: boolean }): ReactNode {
  const key = useBoards((s) => approvalTagKey(s.tasks[id]));
  return key ? <TagView tag={key} id={id} compact={compact} /> : null;
});

/** The tag's markup (exported for tests: the SSR render needs no store). */
export function TagView({ tag, id, compact }: { tag: string; id: string; compact: boolean }): ReactNode {
  const p = parseApprovalTag(tag);
  if (!p) return null;
  const { kind, n, m } = p;
  // Who vetoed — only for the tooltip, read once when the tag (re-)renders.
  const task = kind === 'rejected' ? useBoards.getState().tasks[id] : undefined;
  const who = task ? rejecters(task).map((u) => memberName(task.workspaceId, u)).join(', ') : '';
  const label = kind === 'pending' ? t('boards.approvalProgress', { n, m }) : kind === 'approved' ? t('boards.approvalDoneN', { n, m }) : t('boards.gate.rejected', { name: who });
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full border px-1.5 text-micro font-medium tabular-nums',
        kind === 'approved' && 'border-transparent bg-ok-fill text-white',
        kind === 'pending' && 'border-[color-mix(in_srgb,var(--color-warn-text)_60%,transparent)] text-[var(--color-warn-text)]',
        kind === 'rejected' && 'border-[color-mix(in_srgb,var(--color-red)_55%,transparent)] text-danger-text',
        compact && 'px-1',
      )}
      data-testid="approval-badge"
      data-state={kind}
    >
      {kind === 'approved' ? <Check className="size-3" strokeWidth={3} aria-hidden /> : kind === 'rejected' ? <X className="size-3" strokeWidth={3} aria-hidden /> : null}
      {n}/{m}
    </span>
  );
}

// ------------------------------------------------------------------ panel section

const valueBtn = 'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-control text-fg hover:bg-hover disabled:hover:bg-transparent data-[state=open]:bg-active';

/**
 * «Согласующие» — the last part of the properties block (after the dates, the milestone, the
 * parent): shown when there are approvers or the viewer may add them. Approved: a full-width green
 * band «Согласовано · 3 из 3» with the approvers' avatars; rejected: a red band with who rejected
 * and the comment; pending: the approvers with their votes and «N из M согласовали» in orange.
 * Editing follows the task's edit right; a member dragged here becomes an approver.
 */
export function ApprovalsSection({ task, canEdit, perms }: { task: Task; canEdit: boolean; perms: bigint | undefined }): ReactNode {
  const me = myUserId();
  const c = approvalControls(task, canEdit, hasBit(perms, VIEW_BOARD), me);
  const [over, setOver] = useState(false);
  if (!c.visible) return null;
  const ids = task.approvers.map((a) => a.userId);
  const save = (next: string[], required = task.approvalRequired): void => void setApprovers(task.id, next, clampRequired(required, next.length));
  const onDragOver = (e: DragEvent): void => {
    if (c.edit && dragKind(e.dataTransfer) === 'user') {
      e.preventDefault();
      setOver(true);
    }
  };
  const onDrop = (e: DragEvent): void => {
    setOver(false);
    const userId = e.dataTransfer.getData(DRAG_USER);
    if (!userId) return;
    e.preventDefault();
    if (!ids.includes(userId)) save(toggleApprover(ids, userId));
  };
  const state = approvalBadge(task)?.kind ?? null;
  const quorum = quorumOf(task);
  const approved = approvedCount(task);
  return (
    <div
      className={cx('mt-1 flex flex-col gap-1 rounded-[var(--radius-row)] border-t border-line pt-2', over && 'ring-2 ring-accent')}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      data-testid="prop-approvals"
      data-state={state ?? 'none'}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-1">
        <span className="mr-auto pl-1 text-caption text-muted">{t('boards.approvers')}</span>
        {task.approvers.length > 1 ? <QuorumMenu n={task.approvers.length} value={task.approvalRequired} disabled={!c.edit} onPick={(r) => save(ids, r)} /> : null}
        {c.edit ? (
          <ApproverMenu workspaceId={task.workspaceId} boardId={task.boardId} value={ids} onToggle={(u) => save(toggleApprover(ids, u))}>
            <button type="button" className={cx(valueBtn, 'text-muted')} data-testid="approver-add">
              <Plus className="size-3.5" aria-hidden /> {t('boards.addApprover')}
            </button>
          </ApproverMenu>
        ) : null}
      </div>
      <ApprovalsBody task={task} state={state} quorum={quorum} approved={approved} onRemove={c.edit ? (u) => save(ids.filter((x) => x !== u)) : undefined} />
      {c.vote ? <VoteBar task={task} mine={c.mine} /> : null}
    </div>
  );
}

/** The state part of «Согласующие» (exported for tests: rendered without the store). */
export function ApprovalsBody({
  task,
  state,
  quorum,
  approved,
  onRemove,
}: {
  task: Pick<Task, 'workspaceId' | 'approvers'>;
  state: 'pending' | 'approved' | 'rejected' | null;
  quorum: number;
  approved: number;
  onRemove: ((userId: string) => void) | undefined;
}): ReactNode {
  if (state === 'approved') {
    const yes = task.approvers.filter((a) => a.state === ApproverState.APPROVED);
    return (
      <div className="flex min-h-10 w-full items-center gap-2 rounded-[var(--radius-card)] bg-ok-surface px-3 py-2 text-[var(--color-green-text)]" role="status" data-testid="approval-band" data-state="approved">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ok-fill text-white" aria-hidden>
          <Check className="size-3.5" strokeWidth={3} />
        </span>
        <span className="min-w-0 flex-1 truncate text-control font-semibold">{t('boards.approvalBand', { n: Math.min(approved, quorum), m: quorum })}</span>
        <span className="flex shrink-0 -space-x-1.5">
          {yes.map((a) => (
            <BandAvatar key={a.userId} workspaceId={task.workspaceId} userId={a.userId} />
          ))}
        </span>
      </div>
    );
  }
  const rows = task.approvers.map((a) => (
    <ApproverRow key={a.userId} workspaceId={task.workspaceId} userId={a.userId} state={a.state} comment={state === 'rejected' ? '' : a.comment} onRemove={onRemove} />
  ));
  if (state === 'rejected') {
    const no = task.approvers.filter((a) => a.state === ApproverState.REJECTED);
    return (
      <>
        <div className="flex w-full flex-col gap-1 rounded-[var(--radius-card)] bg-danger-surface px-3 py-2" role="status" data-testid="approval-band" data-state="rejected">
          {no.map((a) => (
            <RejectLine key={a.userId} workspaceId={task.workspaceId} userId={a.userId} comment={a.comment} />
          ))}
        </div>
        {rows}
      </>
    );
  }
  return (
    <>
      {rows}
      {state === 'pending' ? (
        <span className="px-1 text-caption font-medium tabular-nums text-[var(--color-warn-text)]" data-testid="approval-progress">
          {t('boards.approvalPending', { n: approved, m: quorum })}
        </span>
      ) : null}
    </>
  );
}

const BandAvatar = memo(function BandAvatar({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  return (
    <Tip label={t('boards.apvState.approved', { name })}>
      <span className="rounded-full ring-2 ring-[var(--color-ok-surface)]" tabIndex={0} aria-label={t('boards.apvState.approved', { name })}>
        <MemberAvatar workspaceId={workspaceId} userId={userId} size={22} />
      </span>
    </Tip>
  );
});

/** «✕ Анна отклонила» + the comment (the red band). */
const RejectLine = memo(function RejectLine({ workspaceId, userId, comment }: { workspaceId: string; userId: string; comment: string }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  return (
    <div className="flex min-w-0 items-start gap-2" data-testid="approval-reject-line">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-danger-fill text-white" aria-hidden>
        <X className="size-3.5" strokeWidth={3} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-control font-semibold text-danger-text">{t('boards.rejectedBy', { name })}</div>
        {comment ? <div className="selectable whitespace-pre-wrap break-words text-control text-fg">{comment}</div> : null}
      </div>
    </div>
  );
});

const ApproverRow = memo(function ApproverRow({ workspaceId, userId, state, comment, onRemove }: { workspaceId: string; userId: string; state: ApproverState; comment: string; onRemove: ((userId: string) => void) | undefined }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const tip = state === ApproverState.APPROVED ? t('boards.apvState.approved', { name }) : state === ApproverState.REJECTED ? t('boards.apvState.rejected', { name, comment }) : t('boards.apvState.pending', { name });
  const status = state === ApproverState.APPROVED ? t('boards.apv.approved') : state === ApproverState.REJECTED ? t('boards.apv.rejected') : t('boards.apv.pending');
  return (
    <div className="group/ap flex min-h-8 items-center gap-2 rounded-[var(--radius-row)] px-1 hover:bg-[color-mix(in_srgb,var(--color-fill)_40%,transparent)]" data-testid="approver-row" data-user={userId} data-state={ApproverState[state].toLowerCase()}>
      <Tip label={tip}>
        <span className="relative shrink-0" tabIndex={0} aria-label={tip}>
          <MemberAvatar workspaceId={workspaceId} userId={userId} size={20} />
          <StateMark state={state} />
        </span>
      </Tip>
      <span className="min-w-0 flex-1 truncate text-control font-medium">{name}</span>
      {state === ApproverState.REJECTED && comment ? (
        <Tip label={comment}>
          <span className="min-w-0 max-w-[45%] truncate text-caption text-danger-text" data-testid="approver-comment">
            {comment}
          </span>
        </Tip>
      ) : (
        <span className={cx('shrink-0 text-caption', state === ApproverState.APPROVED ? 'text-[var(--color-green-text)]' : state === ApproverState.REJECTED ? 'text-danger-text' : 'text-muted')}>{status}</span>
      )}
      {onRemove ? (
        <button type="button" aria-label={t('boards.removeApprover', { name })} onClick={() => onRemove(userId)} className="grid size-6 shrink-0 place-items-center rounded-full text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/ap:opacity-100 mobile:opacity-100" data-testid="approver-remove">
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
});

/** The vote on the avatar: ✓ success, ✗ danger, a clock while waiting. */
function StateMark({ state }: { state: ApproverState }): ReactNode {
  const base = 'absolute -bottom-1 -right-1 grid size-3.5 place-items-center rounded-full ring-2 ring-[var(--color-bg)]';
  if (state === ApproverState.APPROVED)
    return (
      <span className={cx(base, 'bg-ok-fill text-white')} aria-hidden>
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    );
  if (state === ApproverState.REJECTED)
    return (
      <span className={cx(base, 'bg-danger-fill text-white')} aria-hidden>
        <X className="size-2.5" strokeWidth={3} />
      </span>
    );
  return (
    <span className={cx(base, 'bg-[var(--color-fill-hover)] text-muted')} aria-hidden>
      <Clock3 className="size-2.5" strokeWidth={2.5} />
    </span>
  );
}

/** «Нужно: Все ▾» / «Нужно: 2 из 3 ▾» (read-only text without the edit right). */
function QuorumMenu({ n, value, disabled, onPick }: { n: number; value: number; disabled: boolean; onPick: (required: number) => void }): ReactNode {
  const text = (r: number): string => (r === 0 ? t('boards.quorumAll') : t('boards.quorumN', { n: r, m: n }));
  const current = clampRequired(value, n);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild disabled={disabled}>
        <button type="button" className={cx(valueBtn, 'text-muted')} data-testid="approval-quorum">
          {t('boards.quorum')}: <span className="text-fg">{text(current)}</span>
          {disabled ? null : <ChevronDown className="size-3.5" aria-hidden />}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-40')} sideOffset={4} align="end" collisionPadding={16}>
          {quorumChoices(n).map((r) => (
            <Dropdown.Item key={r} className={menuItem} onSelect={() => r !== current && onPick(r)}>
              {r === current ? <Check className="size-3.5" aria-hidden /> : <span className="size-3.5" />}
              {text(r)}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** My vote: «Согласовать» (primary) · «Отклонить» (dialog); after it — what I decided and «Отозвать». */
function VoteBar({ task, mine }: { task: Task; mine: ApproverState }): ReactNode {
  const [busy, setBusy] = useState<TaskApprovalDecision | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const vote = async (d: TaskApprovalDecision): Promise<void> => {
    setBusy(d);
    await voteApproval(task.id, d);
    setBusy(null);
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] bg-[color-mix(in_srgb,var(--color-fill)_45%,transparent)] px-2 py-1.5" data-testid="approval-vote">
      {mine === ApproverState.PENDING ? (
        <>
          <span className="mr-auto text-caption text-muted">{t('boards.yourVote')}</span>
          <Button size="sm" variant="secondary" onClick={() => setRejecting(true)} disabled={busy !== null} data-testid="approval-reject">
            {t('boards.reject')}
          </Button>
          <Button size="sm" busy={busy === TaskApprovalDecision.APPROVE} disabled={busy !== null} onClick={() => void vote(TaskApprovalDecision.APPROVE)} data-testid="approval-approve">
            <Check className="size-3.5" aria-hidden /> {t('boards.approve')}
          </Button>
        </>
      ) : (
        <>
          <span className={cx('mr-auto inline-flex items-center gap-1 text-caption', mine === ApproverState.APPROVED ? 'text-[var(--color-green-text)]' : 'text-danger-text')}>
            {mine === ApproverState.APPROVED ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
            {mine === ApproverState.APPROVED ? t('boards.youApproved') : t('boards.youRejected')}
          </span>
          <Button size="sm" variant="ghost" busy={busy === TaskApprovalDecision.WITHDRAW} disabled={busy !== null} onClick={() => void vote(TaskApprovalDecision.WITHDRAW)} data-testid="approval-withdraw">
            {t('boards.withdraw')}
          </Button>
        </>
      )}
      {rejecting ? <RejectDialog task={task} onClose={() => setRejecting(false)} /> : null}
    </div>
  );
}

/** «Отклонить»: a comment is required (≤ 500), it reaches the creator and the lead. */
function RejectDialog({ task, onClose }: { task: Task; onClose: () => void }): ReactNode {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = v.trim();
  const submit = async (): Promise<void> => {
    if (!text || busy) return;
    setBusy(true);
    const ok = await voteApproval(task.id, TaskApprovalDecision.REJECT, text);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('boards.rejectTitle', { key: task.key })}
      description={t('boards.rejectText')}
      initialFocus={ref}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" busy={busy} disabled={!text} onClick={() => void submit()} data-testid="reject-confirm">
            {t('boards.reject')}
          </Button>
        </>
      }
    >
      <textarea
        ref={ref}
        value={v}
        rows={4}
        maxLength={MAX_REJECT_COMMENT}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder={t('boards.rejectComment')}
        aria-label={t('boards.rejectComment')}
        className="selectable min-h-24 w-full resize-y rounded-[var(--radius-card)] border border-line bg-elev p-2.5 text-body text-fg outline-none placeholder:text-faint focus-visible:border-accent"
        data-testid="reject-comment"
      />
      <div className="pt-1 text-right text-caption tabular-nums text-faint">
        {Array.from(v).length}/{MAX_REJECT_COMMENT}
      </div>
    </Modal>
  );
}
