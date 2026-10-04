import { useCallback, type ReactNode } from 'react';
import { Slider, Switch, cx } from '../../components/ui';
import { t } from '../../i18n';
import type { CameraEffects } from '../../lib/media/background/effects';
import { effectsBlocked, blockedText } from '../../services/cameraBackground';
import { useCameraBg } from '../../stores/cameraBg';
import { usePrefs } from '../../stores/prefs';

/**
 * Merges a change into prefs.cameraEffects (a new object: services/voice.ts follows it by
 * identity). Also the island's camera ▾ menu (the switches, no slider there).
 */
export function setCameraEffects(p: Partial<CameraEffects>): void {
  const s = usePrefs.getState();
  s.setPrefs({ cameraEffects: { ...s.cameraEffects, ...p } });
}

/**
 * «Внешний вид» in the camera preview (ADR-0035 addendum, docs/08 «Превью камеры»): «Улучшить
 * внешность» with its strength, «Низкая освещённость». Device preferences, applied at once to the
 * preview and the live camera, independent of the background.
 */
export function CameraAppearance(): ReactNode {
  const touchUp = usePrefs((s) => s.cameraEffects.touchUp);
  const strength = usePrefs((s) => s.cameraEffects.touchUpStrength);
  const lowLight = usePrefs((s) => s.cameraEffects.lowLight);
  const onTouchUp = useCallback((v: boolean) => setCameraEffects({ touchUp: v }), []);
  const onStrength = useCallback((v: number) => setCameraEffects({ touchUpStrength: v }), []);
  const onLowLight = useCallback((v: boolean) => setCameraEffects({ lowLight: v }), []);
  // Same rule as «Фон» (owner, 2.1): disabled with the reason, never hidden.
  const failure = useCameraBg((s) => s.failure);
  const blocked = effectsBlocked(failure);
  return (
    <section aria-labelledby="camera-fx-title" data-testid="camera-fx">
      <h3 id="camera-fx-title" className="mb-1 text-footnote font-semibold text-muted">
        {t('video.fx.title')}
      </h3>
      <fieldset disabled={blocked !== null} className={cx('m-0 min-w-0 border-0 p-0', blocked && 'opacity-50')}>
        <Switch label={t('video.fx.touchUp')} checked={touchUp} onChange={onTouchUp} />
        {touchUp ? (
          <div className="flex items-center gap-3 pb-1">
            <span className="shrink-0 text-caption text-muted">{t('video.fx.strength')}</span>
            <Slider label={t('video.fx.strengthLabel')} value={strength} min={0} max={100} onChange={onStrength} />
          </div>
        ) : null}
        <Switch label={t('video.fx.lowLight')} hint={t('video.fx.lowLightHint')} checked={lowLight} onChange={onLowLight} />
      </fieldset>
      {blocked ? <p className="mt-1 text-caption text-muted">{blockedText(blocked, failure)}</p> : null}
    </section>
  );
}
