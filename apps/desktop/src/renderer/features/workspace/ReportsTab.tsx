import { ReportReason, type UserReport } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Badge, Button, Card, Empty, Spinner } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { reportsKey } from '../../lib/moderation';
import { toast } from '../../stores/toasts';

const REASON_LABEL: Record<ReportReason, MessageKey> = {
  [ReportReason.UNSPECIFIED]: 'report.reason.other',
  [ReportReason.SPAM]: 'report.reason.spam',
  [ReportReason.HARASSMENT]: 'report.reason.harassment',
  [ReportReason.VIOLENCE]: 'report.reason.violence',
  [ReportReason.SEXUAL]: 'report.reason.sexual',
  [ReportReason.ILLEGAL]: 'report.reason.illegal',
  [ReportReason.OTHER]: 'report.reason.other',
};

/**
 * Workspace settings → «Жалобы» (ADR-0154; MANAGE_MEMBERS, as «Забаненные»): who reported whom,
 * why, the reported message as it was, and «Решено». Acting on a report (remove, ban) stays in
 * the member's menu.
 */
export function ReportsTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: reportsKey(workspaceId),
    queryFn: ({ signal }) => api.reports.list(workspaceId, signal),
  });
  const resolve = useMutation({
    mutationFn: (id: string) => api.reports.resolve(workspaceId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: reportsKey(workspaceId) }),
    onError: (e) => toast.error(errorText(e)),
  });
  const reports = q.data?.reports ?? [];
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Empty>{errorText(q.error)}</Empty>;
  if (reports.length === 0) return <Empty>{t('reports.none')}</Empty>;
  const open = reports.filter((r) => !r.resolvedAt).length;
  return (
    <Card title={t('reports.card', { n: open })} footer={t('reports.hint')}>
      {reports.map((r) => (
        <ReportRow key={r.id} r={r} onResolve={resolve.mutate} />
      ))}
    </Card>
  );
}

const ReportRow = memo(function ReportRow({ r, onResolve }: { r: UserReport; onResolve: (id: string) => void }): ReactNode {
  const u = r.target;
  const name = u?.displayName ?? t('reports.deleted');
  const when = r.createdAt ? fmt.shortDate(timestampDate(r.createdAt)) : '—';
  const who = r.reporter?.displayName ?? t('reports.deleted');
  return (
    <div className="flex min-h-12 items-start gap-3 px-3 py-2" data-testid="ws-report-row">
      <Avatar userId={u?.id ?? r.id} name={name} fileId={u?.avatarFileId || undefined} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-medium">{name}</span>
          <Badge tone={r.resolvedAt ? 'neutral' : 'danger'}>{t(REASON_LABEL[r.reason])}</Badge>
        </div>
        {r.messageText ? <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-caption text-muted">{r.messageText}</div> : null}
        {r.comment ? <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-caption text-fg">{r.comment}</div> : null}
        <div className="truncate text-caption text-faint">
          {t(r.messageId ? 'reports.metaMessage' : 'reports.metaUser', {
            when,
            who,
          })}
        </div>
      </div>
      {r.resolvedAt ? (
        <span className="shrink-0 pt-1 text-caption text-faint">{t('reports.resolved')}</span>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => onResolve(r.id)} data-testid="ws-report-resolve">
          {t('reports.resolve')}
        </Button>
      )}
    </div>
  );
});
