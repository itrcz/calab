import { t } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { describeError } from '../../lib/api/errors';

/**
 * Pure logic of «Удалить аккаунт» (Настройки → Профиль, ADR-0153). Server: POST /api/me/delete →
 * 204; 403 INVALID_CREDENTIALS — wrong password; 422 — no password; 409 CONFLICT reason
 * OWNS_WORKSPACES — the user owns a workspace (the dialog lists them from the store);
 * 429 — more than 5 password checks in 15 minutes.
 */
export interface DeleteAccountErrors {
  password?: string;
  /** The server still sees an owned workspace the store did not know of. */
  owner?: boolean;
  /** Not tied to the field (rate limit, network). */
  form?: string;
}

export function deleteAccountError(err: unknown): DeleteAccountErrors {
  if (err instanceof ApiError) {
    if (err.code === 'ERROR_CODE_INVALID_CREDENTIALS') return { password: t('cred.err.wrongCurrent') };
    if (err.status === 409 && err.reason === 'OWNS_WORKSPACES') return { owner: true };
    if (err.code === 'ERROR_CODE_VALIDATION' || err.status === 422) return { password: t('cred.err.currentRequired') };
    if (err.code === 'ERROR_CODE_RATE_LIMITED' || err.status === 429) return { form: t('cred.err.rate') };
  }
  return { form: describeError(err).text };
}

/** The names of the workspaces the user owns, in the sidebar order (blockers of the deletion). */
export function ownedWorkspaceNames(order: readonly string[], byId: Readonly<Record<string, { ws: { ownerId: string; name: string } } | undefined>>, me: string): string[] {
  if (!me) return [];
  const out: string[] = [];
  for (const id of order) {
    const e = byId[id];
    if (e && e.ws.ownerId === me) out.push(e.ws.name);
  }
  return out;
}
