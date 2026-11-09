import { memo, type ReactNode } from 'react';
import { Button, Modal } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { platform } from '../../platform';
import { useSignInAsk } from '../../stores/webAppSignIn';

function answer(allow: boolean): void {
  const ask = useSignInAsk.getState().ask;
  if (!ask) return;
  useSignInAsk.setState({ ask: null });
  void platform.webApps?.signInAnswer(ask.id, allow);
}

/**
 * «Войти через Calab» of an app's site, the first time (ADR-0159): main shows what the provider's
 * consent request says, the person allows or denies. Esc, a click outside and two minutes without
 * an answer (main closes it) — deny. The view of the app steps aside while it is open (an overlay,
 * AppScreen). Leaf: nothing runs while closed. Mounted in Dialogs.
 */
export function AppSignInHost(): ReactNode {
  const open = useSignInAsk((s) => s.ask !== null);
  return open ? <AppSignIn /> : null;
}

const AppSignIn = memo(function AppSignIn(): ReactNode {
  useLocale();
  const ask = useSignInAsk((s) => s.ask);
  if (!ask) return null;
  const gets = [ask.scopes.includes('profile') ? t('wapp.signInProfile') : '', ask.scopes.includes('email') ? t('wapp.signInEmail') : '']
    .filter(Boolean)
    .join(', ');
  const rows: Array<[string, string]> = [
    [t('wapp.signInWorkspace'), ask.workspace || '—'],
    [t('wapp.signInAccount'), ask.account || '—'],
    [t('wapp.signInSite'), ask.site || '—'],
    [t('wapp.signInGets'), gets || t('wapp.signInOnly')],
  ];
  return (
    <Modal
      open
      onClose={() => answer(false)}
      title={t('wapp.signInTitle', { app: ask.client || '—' })}
      closeButton={false}
      footer={
        <>
          {/* Asked by a site, not by the person: Enter must not allow. */}
          <Button variant="secondary" onClick={() => answer(false)} autoFocus data-testid="app-sign-in-deny">
            {t('wapp.signInDeny')}
          </Button>
          <Button variant="primary" onClick={() => answer(true)} data-testid="app-sign-in-allow">
            {t('wapp.signInAllow')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="app-sign-in">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-body">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 break-words text-fg [overflow-wrap:anywhere]">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-caption text-faint">{t('wapp.signInNote')}</p>
      </div>
    </Modal>
  );
});
