import { ReportReason } from '@calaba/protocol';
import { useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, Field, Modal, Select, TextArea, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { sendReport, setUserBlocked } from '../../services/blocks';
import { selectBlocked, useBlocks } from '../../stores/blocks';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';

/** The reasons in the order shown (ADR-0154). */
const REASONS: ReadonlyArray<{ v: ReportReason; label: MessageKey }> = [
  { v: ReportReason.SPAM, label: 'report.reason.spam' },
  { v: ReportReason.HARASSMENT, label: 'report.reason.harassment' },
  { v: ReportReason.VIOLENCE, label: 'report.reason.violence' },
  { v: ReportReason.SEXUAL, label: 'report.reason.sexual' },
  { v: ReportReason.ILLEGAL, label: 'report.reason.illegal' },
  { v: ReportReason.OTHER, label: 'report.reason.other' },
];

export const REPORT_COMMENT_MAX = 1000;

/** «Пожаловаться…» on a message (MessageMenu) or a person (profile, DM menu). */
export function openReport(userId: string, workspaceId: string, messageId = ''): void {
  useUi.getState().openDialog({ kind: 'report', userId, workspaceId, messageId });
}

/**
 * «Пожаловаться» (ADR-0154): a reason from the fixed list, an optional comment, and «Также
 * заблокировать». The report goes to the moderators of one workspace: the room's for a room
 * message; for a person or a DM message, a workspace both share (the current one first).
 */
export function ReportDialog({ userId, workspaceId, messageId, onClose }: { userId: string; workspaceId: string; messageId: string; onClose: () => void }): ReactNode {
  const active = useUi((s) => s.activeWorkspaceId);
  // Workspaces both are members of (ids only: names are read per option below).
  const shared = useWorkspaces(useShallow((s) => s.order.filter((id) => !!s.byId[id]?.members[userId])));
  const names = useWorkspaces(useShallow((s) => shared.map((id) => s.byId[id]?.ws.name ?? '')));
  const fixed = !!workspaceId;
  const initial = useMemo(() => (fixed ? workspaceId : active && shared.includes(active) ? active : (shared[0] ?? '')), [fixed, workspaceId, active, shared]);
  const [ws, setWs] = useState(initial);
  const target = ws || initial;
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [comment, setComment] = useState('');
  const blocked = useBlocks(selectBlocked(userId));
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = memberName(target || null, userId);
  const wsName = useWorkspaces((s) => s.byId[target]?.ws.name ?? '');

  const submit = async (): Promise<void> => {
    if (reason === null || !target) return;
    setBusy(true);
    const ok = await sendReport({
      workspaceId: target,
      userId,
      messageId,
      reason,
      comment: comment.trim(),
    });
    setBusy(false);
    if (!ok) return;
    if (alsoBlock && !blocked) await setUserBlocked(userId, true);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={messageId ? t('report.titleMessage') : t('report.titleUser', { name })}
      description={target ? t('report.who', { ws: wsName }) : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" busy={busy} disabled={reason === null || !target} onClick={() => void submit()} data-testid="report-send">
            {t('report.send')}
          </Button>
        </>
      }
    >
      {!target ? (
        <p className="text-body text-muted">{t('report.noWorkspace')}</p>
      ) : (
        <form
          className="flex flex-col gap-4"
          data-testid="report-dialog"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {!fixed && shared.length > 1 ? (
            <Field label={t('report.workspace')}>
              <Select value={target} onChange={(e) => setWs(e.target.value)} data-testid="report-workspace">
                {shared.map((id, i) => (
                  <option key={id} value={id}>
                    {names[i]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <fieldset className="flex flex-col gap-1">
            <legend className="pb-1.5 text-caption font-medium text-muted">{t('report.reason')}</legend>
            {REASONS.map((x) => (
              <label
                key={x.v}
                className={cx(
                  'flex min-h-9 cursor-default items-center gap-2.5 rounded-[var(--radius-card)] border px-3 py-1.5 text-body mobile:min-h-11',
                  reason === x.v ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : 'border-line hover:bg-hover',
                )}
              >
                <input type="radio" name="report-reason" checked={reason === x.v} onChange={() => setReason(x.v)} className="accent-[var(--color-accent)]" data-testid={`report-reason-${x.v}`} />
                {t(x.label)}
              </label>
            ))}
          </fieldset>
          <Field label={t('report.comment')}>
            <TextArea value={comment} maxLength={REPORT_COMMENT_MAX} rows={3} placeholder={t('report.commentHint')} onChange={(e) => setComment(e.target.value)} data-testid="report-comment" />
          </Field>
          {blocked ? null : (
            <label className="flex cursor-default items-center gap-2.5 text-body">
              <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} className="accent-[var(--color-accent)]" data-testid="report-also-block" />
              {t('report.alsoBlock', { name })}
            </label>
          )}
        </form>
      )}
    </Modal>
  );
}
