import type { UserReport } from '@calaba/protocol';
import { t } from '../i18n';
import { queryClient } from '../lib/queryClient';
import { reportsKey } from '../lib/moderation';
import { myUserId } from '../stores/session';
import { useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';

/**
 * WORKSPACE_REPORT_CREATE / _UPDATE (ADR-0154; to MANAGE_MEMBERS only): «Жалобы» refetches if
 * open or cached; a new report from someone else shows a toast leading to that tab.
 */
export function onReportEvent(r: UserReport, created: boolean): void {
  void queryClient.invalidateQueries({ queryKey: reportsKey(r.workspaceId) });
  if (!created || r.reporter?.id === myUserId()) return;
  useToasts.getState().push('info', t('reports.new', { name: r.target?.displayName ?? '—' }), {
    label: t('reports.open'),
    run: () =>
      useUi.getState().openDialog({
        kind: 'workspace-settings',
        workspaceId: r.workspaceId,
        tab: 'reports',
      }),
  });
}
