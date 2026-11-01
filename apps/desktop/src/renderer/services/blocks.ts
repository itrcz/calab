import type { ReportReason } from '@calaba/protocol';
import { confirmAction } from '../components/Confirm';
import { t } from '../i18n';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { useBlocks } from '../stores/blocks';
import { toast } from '../stores/toasts';

/**
 * Report and block users on the client (ADR-0154). The server refuses DMs and calls with a
 * blocked person; here the list is loaded (every READY) and shared rooms hide their messages.
 */

let loading: Promise<void> | null = null;

/** GET /api/me/blocked-users — on every READY (a block from another device while offline). */
export function loadBlockedUsers(): Promise<void> {
  loading ??= api.blocks
    .list()
    .then((r) => useBlocks.getState().setAll(r.userIds))
    .catch((e: unknown) => log.warn('blocked users', e))
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** «Заблокировать» / «Разблокировать»: optimistic, rolled back on an error. */
export async function setUserBlocked(userId: string, blocked: boolean): Promise<void> {
  useBlocks.getState().setOne(userId, blocked);
  try {
    await (blocked ? api.blocks.block(userId) : api.blocks.unblock(userId));
    toast.success(t(blocked ? 'block.done' : 'block.undone'));
  } catch (e) {
    useBlocks.getState().setOne(userId, !blocked);
    toast.fail(e);
  }
}

/** «Заблокировать» with the confirmation (what it does and that the person is not told). */
export async function confirmBlockUser(userId: string, name: string): Promise<void> {
  if (await confirmAction(t('block.confirmTitle', { name }), t('block.confirmText'), t('block.action'))) await setUserBlocked(userId, true);
}

/** POST /api/reports; true when sent (the dialog closes). */
export async function sendReport(r: { workspaceId: string; userId: string; messageId: string; reason: ReportReason; comment: string }): Promise<boolean> {
  try {
    await api.reports.create(r);
    toast.success(t('report.sent'));
    return true;
  } catch (e) {
    toast.fail(e, t('report.failed'));
    return false;
  }
}
