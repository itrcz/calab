import { CircleArrowUp, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UpdateStatus } from '../../../shared/ipc';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { log } from '../../lib/log';
import { platform } from '../../platform';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { reloadForUpdate } from '../../services/resumeVoice';
import { laterAllowed, pendingUpdate, snooze, snoozed, type UpdateBarModel } from './updateBarModel';

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST): fake an update status (e.g. a downloaded update). */
    __calabaUpdateStatus?: (s: UpdateStatus) => void;
  }
}

/**
 * The update bar (docs/08 «Обновление», docs/09 #125; owner, 29.09: «обновление слабо видят»):
 * a 32 px accent strip under the title bar — the reconnect banner's slot — while an update waits:
 * «Доступна версия X — обновление уже загружено» + «Перезапустить и обновить» (restarts at once,
 * also in a call: the relaunched app rejoins the same room / call, docs/09 #126; in a call the
 * hint says so) + a quiet «Позже» (4 h, until
 * the next start at most); after three «Позже» only «×» (24 h). Web: «Обновить страницу» when the
 * server is newer than the loaded bundle (the reloaded page rejoins the room with the same mic /
 * deafen state, services/resumeVoice.reloadForUpdate). The logic is pure in updateBarModel.ts; this leaf is the only
 * subscriber to the update status (download progress re-renders just the bar).
 */
export function UpdateBar(): ReactNode {
  const update = useSession((s) => s.update);
  const webVersion = useSession((s) => s.webVersion);
  const appVersion = useSession((s) => s.appInfo?.version ?? '');
  const autoUpdate = useSession((s) => s.settings?.autoUpdate === true);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  const nag = usePrefs((s) => s.updateNag);
  const inVoice = useVoice((s) => s.roomId !== null);
  /** «Перезапустить» pressed: main may re-check the feed and fetch a newer version first. */
  const [installing, setInstalling] = useState(false);
  // The install did not happen (macOS: Squirrel could not stage it; a download failed): main
  // reports 'error' — the button is usable again once an update is ready (adjusted while rendering).
  const failed = update.state === 'error';
  const [wasFailed, setWasFailed] = useState(failed);
  if (failed !== wasFailed) {
    setWasFailed(failed);
    if (failed) setInstalling(false);
  }
  // While installing, a (re)download is shown even in auto mode: the user is waiting for it.
  const model = useMemo(
    () => pendingUpdate({ update, webVersion, appVersion, autoUpdate: autoUpdate && !installing }),
    [update, webVersion, appVersion, autoUpdate, installing],
  );
  const now = useUntil(nag?.until ?? 0);

  useEffect(() => {
    if (!visualTest) return;
    window.__calabaUpdateStatus = (s) => useSession.getState().set({ update: s });
    return () => {
      delete window.__calabaUpdateStatus;
    };
  }, [visualTest]);

  if (!model || (model.kind !== 'downloading' && snoozed(nag, appVersion, now))) return null;

  const hide = (how: 'later' | 'close'): void => usePrefs.getState().setPrefs({ updateNag: snooze(nag, appVersion, Date.now(), how) });
  const install = (): void => {
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

  return (
    <div
      role="status"
      data-testid="update-bar"
      className="z-[var(--z-sticky)] flex min-h-8 shrink-0 items-center justify-center gap-x-3 gap-y-1 bg-accent-strong px-3 py-1 text-caption font-medium text-accent-fg mobile:flex-wrap"
    >
      <CircleArrowUp className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words leading-4">{text(model)}</span>
      <Action model={model} inVoice={inVoice} installing={installing} onInstall={install} />
      {model.kind === 'downloading' ? null : laterAllowed(nag, appVersion) ? (
        <Tip label={t('update.laterHint')}>
          <button type="button" onClick={() => hide('later')} className={cx(barButton, 'px-2 hover:bg-white/15')}>
            {t('update.later')}
          </button>
        </Tip>
      ) : (
        <Tip label={t('update.close')}>
          <button type="button" aria-label={t('update.close')} onClick={() => hide('close')} className={cx(barButton, 'w-6 justify-center hover:bg-white/15')}>
            <X className="size-3.5" aria-hidden />
          </button>
        </Tip>
      )}
    </div>
  );
}

const barButton =
  'flex h-6 shrink-0 items-center rounded-[var(--radius-control)] text-caption font-semibold text-accent-fg transition-colors duration-[var(--motion-fast)] focus-visible:outline-white';

/** The primary action: white on the accent strip (the birthday card's pill does the same). */
const primary = cx(barButton, 'rounded-full bg-white px-3 text-[var(--color-accent-strong)] hover:bg-white/90 disabled:opacity-80');

function text(m: UpdateBarModel): string {
  switch (m.kind) {
    case 'downloaded':
      return t('update.barReady', { v: m.version });
    case 'available':
      return t('update.barAvailable', { v: m.version });
    case 'downloading':
      return t('update.barDownloading', { v: m.version, p: String(m.percent) });
    case 'web':
      return t('update.barAvailable', { v: m.version });
  }
}

function Action({ model, inVoice, installing, onInstall }: { model: UpdateBarModel; inVoice: boolean; installing: boolean; onInstall: () => void }): ReactNode {
  switch (model.kind) {
    case 'downloaded':
      return (
        <Tip label={t(inVoice ? 'update.restartInCallHint' : 'update.restartHint', { v: model.version })}>
          <button type="button" disabled={installing} onClick={onInstall} className={primary} data-testid="update-bar-restart">
            {t('update.restart')}
          </button>
        </Tip>
      );
    case 'available':
      return model.installable ? (
        <button
          type="button"
          onClick={() => void platform.app.downloadUpdate().catch((e: unknown) => log.warn('update download failed', e))}
          className={primary}
        >
          {t('about.install', { v: model.version })}
        </button>
      ) : (
        <button type="button" onClick={() => void platform.app.openExternal(model.downloadPage)} className={primary}>
          {t('about.download')}
        </button>
      );
    case 'web':
      return (
        <button type="button" onClick={() => void reloadForUpdate()} className={primary}>
          {t('update.reload')}
        </button>
      );
    case 'downloading':
      return null;
  }
}

/** `Date.now()` that re-renders once when `until` passes (one timer, no ticking). */
function useUntil(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) return;
    const id = window.setTimeout(() => setNow(Date.now()), left + 50);
    return () => window.clearTimeout(id);
  }, [until]);
  return now;
}
