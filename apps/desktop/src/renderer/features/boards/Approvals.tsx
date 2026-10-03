import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ApproverState, TaskApprovalDecision, type Task } from '@calaba/protocol';
import { Check, ChevronDown, Clock3, Plus, X } from 'lucide-react';
import { memo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Button, Modal, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { approvalBadge, approvalControls, approvedCount, clampRequired, quorumChoices, quorumOf, rejecters, toggleApprover, MAX_REJECT_COMMENT } from '../../lib/boards/approvals';
import { setApprovers, voteApproval } from '../../services/boards';
import { myUserId } from '../../stores/session';
import { memberName, useMemberName } from '../../stores/workspaces';
import { DRAG_USER, dragKind } from '../calendar/dragState';
import { menuBox, menuItem } from '../shell/menu';
import { ApproverMenu, MemberAvatar } from './menus';
import { hasBit, VIEW_BOARD } from './model';

/**
 * Task approvals UI (ADR-0049 §6, docs/08 «Доски»): the card / row badge and the panel section
 * «Согласование» — approvers with their vote marks, «Нужно: Все ▾ / N из M», «+ Согласующий» and,
 * for me as an approver, «Согласовать» / «Отклонить» (a comment is required) / «Отозвать».
 */

// ------------------------------------------------------------------ badge (card, list row)

/**
 * `✓ 1/2` while waiting, a green ✓ once approved, a red ✗ after a veto; nothing without approvers.
 * Memo on primitives: the card re-renders on its own TASK_UPDATE; the badge only when these change.
 */
export const ApprovalBadge = memo(function ApprovalBadge({ task, compact = false }: { task: Pick<Task, 'workspaceId' | 'approvers' | 'approvalRequired' | 'approvalState'>; compact?: boolean }): ReactNode {
  const b = approvalBadge(task);
  const vetoed = b?.kind === 'rejected' ? rejecters(task).map((u) => memberName(task.workspaceId, u)).join(', ') : '';
  return b ? <BadgeView kind={b.kind} approved={b.kind === 'pending' ? b.approved : 0} quorum={b.kind === 'pending' ? b.quorum : 0} who={vetoed} compact={compact} /> : null;
});

const BadgeView = memo(function BadgeView({ kind, approved, quorum, who, compact }: { kind: 'pending' | 'approved' | 'rejected'; approved: number; quorum: number; who: string; compact: boolean }): ReactNode {
  const label = kind === 'pending' ? t('boards.approvalProgress', { n: approved, m: quorum }) : kind === 'approved' ? t('boards.approvalDone') : t('boards.gate.rejected', { name: who });
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full border px-1.5 text-micro tabular-nums',
        kind === 'pending' && 'border-line text-muted',
        kind === 'approved' && 'border-[color-mix(in_srgb,var(--color-green)_45%,transparent)] text-[var(--color-green-text)]',
        kind === 'rejected' && 'border-[color-mix(in_srgb,var(--color-red)_45%,transparent)] text-danger-text',
        compact && 'px-1',
      )}
      data-testid="approval-badge"
      data-state={kind}
    >
      {kind === 'rejected' ? <X className="size-3" aria-hidden /> : <Check className="size-3" aria-hidden />}
      {kind === 'pending' ? `${approved}/${quorum}` : null}
    </span>
  );
});

// ------------------------------------------------------------------ panel section

const valueBtn = 'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-control text-fg hover:bg-hover disabled:hover:bg-transparent data-[state=open]:bg-active';

/**
 * «Согласование» under the assignees (a properties row): shown when there are approvers or the
 * viewer may add them; editing follows the task's edit right; a member dragged here becomes an
 * approver (as onto «Исполнители»).
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
  return (
    <div className={cx('flex min-h-8 items-start gap-3 rounded-[var(--radius-row)]', over && 'ring-2 ring-accent')} onDragOver={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop} data-testid="prop-approvals">
      <span className="w-[104px] shrink-0 pt-1.5 text-caption text-muted mobile:w-[88px]">{t('boards.approvals')}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {task.approvers.map((a) => (
          <ApproverRow key={a.userId} workspaceId={task.workspaceId} userId={a.userId} state={a.state} comment={a.comment} onRemove={c.edit ? () => save(ids.filter((x) => x !== a.userId)) : undefined} />
        ))}
        <div className="flex flex-wrap items-center gap-1">
          {c.edit ? (
            <ApproverMenu workspaceId={task.workspaceId} boardId={task.boardId} value={ids} onToggle={(u) => save(toggleApprover(ids, u))}>
              <button type="button" className={cx(valueBtn, 'text-muted')} data-testid="approver-add">
                <Plus className="size-3.5" aria-hidden /> {t('boards.addApprover')}
              </button>
            </ApproverMenu>
          ) : null}
          {task.approvers.length > 1 ? <QuorumMenu n={task.approvers.length} value={task.approvalRequired} disabled={!c.edit} onPick={(r) => save(ids, r)} /> : null}
          {task.approvers.length ? <Progress task={task} /> : null}
        </div>
        {c.vote ? <VoteBar task={task} mine={c.mine} /> : null}
      </div>
    </div>
  );
}

const ApproverRow = memo(function ApproverRow({ workspaceId, userId, state, comment, onRemove }: { workspaceId: string; userId: string; state: ApproverState; comment: string; onRemove: (() => void) | undefined }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const tip = state === ApproverState.APPROVED ? t('boards.apvState.approved', { name }) : state === ApproverState.REJECTED ? t('boards.apvState.rejected', { name, comment }) : t('boards.apvState.pending', { name });
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
      ) : null}
      {onRemove ? (
        <button type="button" aria-label={t('boards.removeApprover', { name })} onClick={onRemove} className="grid size-6 shrink-0 place-items-center rounded-full text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/ap:opacity-100 mobile:opacity-100" data-testid="approver-remove">
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
        <Dropdown.Content className={cx(menuBox, 'w-40')} sideOffset={4} align="start" collisionPadding={16}>
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

/** «Согласовано 1 из 2» / «Согласовано» / «Отклонено». */
function Progress({ task }: { task: Task }): ReactNode {
  const b = approvalBadge(task);
  if (!b) return null;
  return (
    <span
      className={cx('ml-auto px-1 text-caption tabular-nums', b.kind === 'approved' ? 'text-[var(--color-green-text)]' : b.kind === 'rejected' ? 'text-danger-text' : 'text-muted')}
      data-testid="approval-progress"
    >
      {b.kind === 'pending' ? t('boards.approvalProgress', { n: approvedCount(task), m: quorumOf(task) }) : b.kind === 'approved' ? t('boards.approvalDone') : t('boards.approvalRejected')}
    </span>
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
