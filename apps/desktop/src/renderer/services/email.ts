import { getLocale, subscribeLocale, t } from '../i18n';
import { ApiError, onApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';
import { useVerify } from '../stores/verify';

/**
 * Email wiring of a signed-in session (ADR-0023):
 *  - a blocked action (403 EMAIL_NOT_VERIFIED: create a workspace, invite, a new DM; with
 *    EMAIL_VERIFICATION=optional only joining by an email invitation, ADR-0065) closes the dialog
 *    it came from and sends the user to the «Подтвердите почту» bar;
 *  - the language of emails (`me.locale`) follows the UI language: set when empty, updated when
 *    the user switches the language here.
 */
export function installEmail(): () => void {
  const offError = onApiError((e) => {
    if (e.code !== 'ERROR_CODE_EMAIL_NOT_VERIFIED') return;
    const me = useSession.getState().me;
    if (me && me.emailVerified) {
      // Stale local state: the server knows better (the bar appears).
      useSession.getState().set({ me: { ...me, emailVerified: false } });
    }
    // With EMAIL_VERIFICATION=optional only an email invitation's join answers this (ADR-0065):
    // one waits for the address now, so the bar appears for it.
    if (useSession.getState().emailVerificationOptional) useSession.getState().set({ emailInvitePending: true });
    useUi.getState().openDialog(null);
    useVerify.getState().request();
  });

  const sync = (): void => {
    const s = useSession.getState();
    const me = s.me;
    if (!s.ready || !me?.user || me.user.isGuest || me.locale === getLocale()) return;
    void api.me.update({ locale: getLocale() }).then(
      (r) => {
        if (r.me) useSession.getState().set({ me: r.me });
      },
      (e: unknown) => log.warn('email locale not saved', e),
    );
  };
  // Once READY: fill an empty locale (accounts from before ADR-0023, other devices).
  let synced = false;
  const offSession = useSession.subscribe((s) => {
    if (synced || !s.ready || !s.me) return;
    synced = true;
    if (!s.me.locale) sync();
  });
  if (useSession.getState().ready && !useSession.getState().me?.locale) {
    synced = true;
    sync();
  }
  // A language switch on this device: emails follow it.
  const offLocale = subscribeLocale(sync);
  return () => {
    offError();
    offSession();
    offLocale();
  };
}

/**
 * Confirms the address with a code; the bar disappears with `emailVerified`. Confirming may join
 * workspaces that invited the address by email (docs/09 #36): the first one opens (its
 * WORKSPACE_CREATE snapshot arrives over the gateway) and the one toast says so — the only notice
 * of the join, whichever screen confirmed.
 */
export async function verifyEmail(code: string): Promise<void> {
  const r = await api.auth.verify(code);
  if (r.me) useSession.getState().set({ me: r.me });
  const joined = r.joinedWorkspaceIds[0];
  if (!joined) {
    toast.success(t('mail.verified'));
    return;
  }
  useUi.getState().setWorkspace(joined);
  const name = useWorkspaces.getState().byId[joined]?.ws.name;
  toast.success(name ? t('mail.inv.joined', { ws: name }) : t('mail.inv.joinedGeneric'));
}

/** A new code; 409 = already verified (another device): refresh `me` instead of an error. */
export async function resendVerification(): Promise<void> {
  try {
    await api.auth.sendVerification();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const r = await api.me.get();
      if (r.me) useSession.getState().set({ me: r.me });
      return;
    }
    throw e;
  }
}
