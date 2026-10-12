import { useState, type ReactNode } from 'react';
import { Button, Row } from '../../components/ui';
import { t } from '../../i18n';
import { log } from '../../lib/log';
import { platform } from '../../platform';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { updateAction, updateLabel } from './format';

/**
 * «О программе» → «Обновления»: «Версия X.Y.Z» + one button driven by main's update state
 * (main/updateFlow.ts — the same flow as the background checks and the island banner; docs/08
 * «О программе», docs/09 #93). A leaf with its own subscription: download progress re-renders
 * only this row, not the whole tab. Desktop only (the web has no updater).
 */
export function AboutUpdateRow({ version }: { version: string }): ReactNode {
  const update = useSession((s) => s.update);
  // «Источник обновлений» (Settings → «Основное»): shown next to the status, so «нет обновлений» says where it looked.
  const channel = useSession((s) => s.settings?.updateChannel ?? 'github');
  const inVoice = useVoice((s) => s.roomId !== null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const action = updateAction(update, checking);
  // The install did not happen (macOS staging / a download failed): main reports 'error'.
  const failed = update.state === 'error';
  const [wasFailed, setWasFailed] = useState(failed);
  if (failed !== wasFailed) {
    setWasFailed(failed);
    if (failed) setInstalling(false);
  }

  const check = async (): Promise<void> => {
    setChecking(true);
    try {
      useSession.getState().set({ update: await platform.app.checkUpdates() });
    } catch (e) {
      // Update failures are not toasted: main logs them, the hint says «не удалось».
      log.warn('update check failed', e);
      useSession.getState().set({ update: { state: 'error', message: 'update check failed' } });
    } finally {
      setChecking(false);
    }
  };
  const download = (): void => {
    // Main publishes 'downloading' → progress → 'downloaded' through onUpdateStatus.
    platform.app.downloadUpdate().catch((e: unknown) => log.warn('update download failed', e));
  };
  const install = (): void => {
    // Main re-checks the feed (≤ 8 s) and waits (≤ 3 s) for a token refresh in flight before
    // quitting (docs/09 #89, #125). In a call too: the relaunched app rejoins it (docs/09 #126).
    setInstalling(true);
    platform.app.installUpdate().then(
      (ok) => {
        if (!ok) setInstalling(false);
      },
      (e: unknown) => {
        log.warn('update install failed', e);
        setInstalling(false);
      },
    );
  };

  // In a call: say that the restart comes back into it (docs/09 #126).
  const line = update.state === 'downloaded' && inVoice ? t('update.restartInCallHint', { v: update.version }) : updateLabel(update);
  const hint =
    update.state === 'error' ? (
      <span className="text-danger-text" role="alert">
        {line}
      </span>
    ) : update.state === 'downloading' ? (
      <span className="flex flex-col gap-1.5 pt-0.5">
        <span>{line}</span>
        <span
          className="block h-1 w-56 max-w-full overflow-hidden rounded-full bg-hover"
          role="progressbar"
          aria-label={line ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={update.percent}
          data-testid="update-progress"
        >
          <span className="block h-full rounded-full bg-accent" style={{ width: `${update.percent}%` }} />
        </span>
      </span>
    ) : (
      (line ?? undefined)
    );
  // Not while nothing is checked (dev / self-built: 'disabled').
  const source =
    update.state === 'disabled' ? null : t('about.updateSource', { source: channel === 's3' ? t('app.updateChannelS3') : t('app.updateChannelGithub') });
  const hintWithSource =
    source === null ? hint : (
      <span className="flex flex-col gap-0.5">
        {hint ?? null}
        <span data-testid="update-source">
          {source}
        </span>
      </span>
    );

  return (
    <Row label={t('about.version', { v: version })} hint={hintWithSource}>
      {action === 'install' && update.state === 'available' ? (
        <Button onClick={download} data-testid="update-install">
          {t('about.install', { v: update.version })}
        </Button>
      ) : action === 'downloading' && update.state === 'downloading' ? (
        <Button disabled>{t('about.install', { v: update.version })}</Button>
      ) : action === 'restart' ? (
        <Button busy={installing} onClick={install} data-testid="update-restart">
          {t('about.restart')}
        </Button>
      ) : action === 'page' && update.state === 'available' ? (
        <Button onClick={() => void platform.app.openExternal(update.downloadPage ?? '')}>{t('about.download')}</Button>
      ) : action === 'retry' ? (
        <Button variant="secondary" onClick={() => void check()}>
          {t('common.retry')}
        </Button>
      ) : (
        <Button variant="secondary" busy={action === 'checking'} onClick={() => void check()}>
          {action === 'checking' ? t('about.updateChecking') : t('about.check')}
        </Button>
      )}
    </Row>
  );
}
