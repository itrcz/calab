import { useState, type ReactNode } from 'react';
import { Button, Row } from '../../components/ui';
import { t } from '../../i18n';
import { log } from '../../lib/log';
import { reloadForUpdate } from '../../services/resumeVoice';
import { useSession } from '../../stores/session';

/**
 * «О программе» → «Обновления» on the web (and the mobile WebView, which runs the same client):
 * shown when the server is newer than the loaded bundle (the UpdateBar's signal, `webVersion`).
 * The button is the bar's «Обновить страницу»: reloadForUpdate keeps the voice seat and the mic /
 * deafen state across the reload. A leaf with its own primitive subscription.
 */
export function WebUpdateRow({ version }: { version: string }): ReactNode {
  const webVersion = useSession((s) => s.webVersion);
  const [busy, setBusy] = useState(false);
  if (!webVersion) return null;
  const reload = (): void => {
    setBusy(true);
    reloadForUpdate().catch((e: unknown) => {
      log.warn('web update reload failed', e);
      setBusy(false);
    });
  };
  return (
    <Row label={t('about.version', { v: version })} hint={t('about.updateAvailable', { v: webVersion })}>
      <Button busy={busy} onClick={reload} data-testid="update-reload">
        {t('update.reload')}
      </Button>
    </Row>
  );
}
