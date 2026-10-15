import { Copy } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Logo } from '../../components/Logo';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { log } from '../../lib/log';
import { ApiError } from '../../lib/api/client';
import { fireDeepLink } from '../auth/LinkLanding';
import { toast } from '../../stores/toasts';
import { useSession } from '../../stores/session';
import { AuthLegalFooter } from '../legal/Legal';
import { redeemMailReset, type MailReset } from '../../services/mailReset';
import { encodeAddPayload } from './mailLink';

/**
 * The one-time mailbox password page `/mail-reset/{token}` (ADR-0101): the bot's reset link
 * opens here, the token is redeemed in the page's single POST (the server deletes it there),
 * the new password is shown once — mono, selectable, with «Скопировать» — and «Открыть в
 * Calab» hands the prefilled add-account form to the app (`calab://mail/<payload>`,
 * ADR-0088 §8). No session, no cache; a used or expired link says so and points back to the
 * bot. Solid materials only (docs/08; no backdrop-filter).
 */

type State = { kind: 'loading' } | { kind: 'data'; data: MailReset } | { kind: 'used' } | { kind: 'failed' };

export function MailResetPage({ token }: { token: string }): ReactNode {
  const [state, setState] = useState<State>({ kind: 'loading' });
  // One POST ever: the token is single-use, so no retry, no StrictMode double-fire.
  const fired = useRef(false);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    redeemMailReset(token)
      .then((data) => setState({ kind: 'data', data }))
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 410 || err.status === 404)) setState({ kind: 'used' });
        else {
          log.warn('mail reset redeem', err);
          setState({ kind: 'failed' });
        }
      });
  }, [token]);

  const data: MailReset | null = state.kind === 'data' ? state.data : null;

  const copy = (): void => {
    if (!data) return;
    void navigator.clipboard.writeText(data.password).then(
      () => toast.success(t('mailReset.copied')),
      (e: unknown) => {
        log.warn('copy password', e);
        toast.error(t('mailReset.copyFailed'));
      },
    );
  };

  const openInApp = (): void => {
    if (!data || visualTest) return;
    fireDeepLink(`calab://mail/${encodeAddPayload(data.email, data.password)}`);
  };

  return (
    <div className="auth-backdrop drag flex h-full flex-col items-center overflow-y-auto px-4 py-10 mobile:pb-[calc(var(--safe-bottom)+24px)] mobile:pt-[calc(var(--safe-top)+16px)]" data-testid="mail-reset">
      <main className="no-drag my-auto flex w-full max-w-[400px] flex-col items-stretch">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={56} alt="Calab" />
        </div>
        <div className="mat-popover flex flex-col gap-5 rounded-[var(--radius-panel)] p-6">
          {state.kind === 'loading' ? (
            <h1 className="text-center text-title font-semibold">{t('mailReset.loading')}</h1>
          ) : state.kind === 'used' ? (
            <div className="flex flex-col items-center gap-1 text-center" role="alert">
              <h1 className="text-title font-semibold">{t('mailReset.used')}</h1>
              <p className="text-body text-muted">{t('mailReset.usedHint')}</p>
            </div>
          ) : state.kind === 'failed' ? (
            <div className="flex flex-col items-center gap-1 text-center" role="alert">
              <h1 className="text-title font-semibold">{t('mailReset.error')}</h1>
              <p className="text-body text-muted">{t('mailReset.usedHint')}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-title font-semibold">{t('mailReset.title')}</h1>
                <p className="max-w-full text-body text-muted [overflow-wrap:anywhere]" title={state.data.email}>
                  {state.data.email}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <p className="sr-only">{t('mailReset.password')}</p>
                <p
                  className="selectable rounded-[var(--radius-control)] border border-line bg-[var(--color-code)] px-3 py-2.5 text-center font-mono text-body [overflow-wrap:anywhere]"
                  data-testid="mail-reset-password"
                >
                  {state.data.password}
                </p>
                <Button variant="secondary" className="h-9 w-full text-body" onClick={copy} autoFocus>
                  <Copy className="size-4" aria-hidden />
                  {t('mailReset.copy')}
                </Button>
              </div>
              <p className="text-center text-caption text-muted">{t('mailReset.once')}</p>
              <Button className="h-9 w-full text-body font-semibold" onClick={openInApp}>
                {t('mailReset.open')}
              </Button>
            </>
          )}
        </div>
      </main>
      {/* NOTICE: the «Powered by GPTunneL» attribution is required in the UI (BUSL-1.1 grant). */}
      <AuthLegalFooter className="mobile:mt-6 mobile:shrink-0" />
    </div>
  );
}
