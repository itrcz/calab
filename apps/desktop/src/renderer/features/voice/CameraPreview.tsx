import type { LocalVideoTrack } from 'livekit-client';
import { Loader2, SwitchCamera } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Field, Modal, Select, cx } from '../../components/ui';
import { t } from '../../i18n';
import { cameraMirrored } from '../../lib/media/cameraLogic';
import type { MediaErrorAction } from '../../lib/media/errors';
import { applyCameraBackground, backgroundEnv } from '../../services/cameraBackground';
import { humanMediaError, mediaActionLabel, runMediaAction } from '../../services/mediaErrors';
import { voice } from '../../services/voice';
import { useCameraBg } from '../../stores/cameraBg';
import { usePrefs } from '../../stores/prefs';
import { useVoice } from '../../stores/voice';
import { BackgroundPicker } from './BackgroundPicker';
import { CameraAppearance } from './CameraAppearance';
import { useCanFlipCamera } from './useCanFlipCamera';

/** Video inputs, refreshed on `devicechange` (labels appear once the camera is allowed). */
export function useCameras(refresh: unknown = null): MediaDeviceInfo[] {
  const [list, setList] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (!md) return;
    const load = (): void => void md.enumerateDevices().then((d) => setList(d.filter((x) => x.kind === 'videoinput')), () => undefined);
    load();
    md.addEventListener('devicechange', load);
    return () => md.removeEventListener('devicechange', load);
  }, [refresh]);
  return list;
}

/**
 * «Проверьте камеру» (docs/09 #41): a mirrored preview before the first camera start, with the
 * device choice. «Включить камеру» hands the running capture to the engine (no second open of
 * the device); closing the sheet releases it.
 */
export function CameraPreview({ onClose }: { onClose: () => void }): ReactNode {
  const deviceId = usePrefs((s) => s.cameraDeviceId);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const facing = useVoice((s) => s.cameraFacing);
  const canFlip = useCanFlipCamera();
  const inCall = useVoice((s) => s.phase === 'connected' && s.camera === 'off');
  const [track, setTrack] = useState<LocalVideoTrack | null>(null);
  const [error, setError] = useState<{ text: string; action: MediaErrorAction | null } | null>(null);
  const handed = useRef<LocalVideoTrack | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  // Initial focus on the preview frame (not focusable by Tab): Radix would focus the close box and
  // show its tooltip, and a focused select draws a ring on a sheet opened with the mouse.
  const frame = useRef<HTMLDivElement>(null);
  const cameras = useCameras(track);
  // «Фон» (ADR-0035): always shown — where it cannot run, disabled with the reason (owner, 2.1).
  // Two columns on desktop; a phone stacks it under the preview.
  const [wide] = useState(() => !backgroundEnv().mobile);

  // (Re)open the camera for the chosen device; release it when the device changes or on close.
  useEffect(() => {
    let alive = true;
    let got: LocalVideoTrack | null = null;
    voice.camera.capture().then(
      (tr) => {
        if (!alive) {
          tr.stop();
          return;
        }
        got = tr;
        setError(null);
        setTrack(tr);
      },
      (err: unknown) => {
        if (!alive) return;
        const h = humanMediaError(err, 'camera');
        setError({ text: h.text, action: h.action });
      },
    );
    return () => {
      alive = false;
      if (got && handed.current !== got) got.stop();
    };
  }, [deviceId, facing]);

  useEffect(() => {
    const el = video.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  const confirm = (): void => {
    setPrefs({ cameraChecked: true });
    if (inCall && track) {
      handed.current = track;
      void voice.camera.start(track);
    }
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('video.preview.title')}
      description={t('video.preview.text')}
      initialFocus={frame}
      wide={wide}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!track} onClick={confirm} data-testid="camera-preview-enable">
            {inCall ? t('video.preview.enable') : t('video.preview.done')}
          </Button>
        </>
      }
    >
      <div className={cx(wide && 'grid grid-cols-[minmax(0,1fr)_320px] gap-5')}>
        <div className="min-w-0">
          <div ref={frame} tabIndex={-1} className="relative aspect-video w-full overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-video-bg)] outline-none" data-testid="camera-preview">
            {/* Mirrored like a mirror: moving right moves right (the others see it unmirrored). The back camera is not mirrored. */}
            <video ref={video} muted playsInline autoPlay className={cx('size-full object-cover', cameraMirrored(facing) && '-scale-x-100')} />
            {canFlip ? (
              <button
                type="button"
                aria-label={t('video.flip')}
                data-testid="camera-preview-flip"
                onClick={() => voice.camera.flip()}
                className="absolute right-2 top-2 grid size-10 place-items-center rounded-full bg-black/50 text-white active:bg-black/70"
              >
                <SwitchCamera className="size-5" aria-hidden />
              </button>
            ) : null}
            {!track && !error ? (
              <span className="absolute inset-0 grid place-items-center text-body text-white/80" role="status">
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> {t('video.preview.loading')}
                </span>
              </span>
            ) : null}
            {track && !error ? <BackgroundLoading /> : null}
            {track ? <ApplyEffects track={track} /> : null}
            {error ? (
              <span className="absolute inset-0 grid place-items-center p-4 text-center" role="alert">
                <span className="flex flex-col items-center gap-2 text-body text-white">
                  {error.text}
                  {error.action ? (
                    <Button size="sm" variant="secondary" onClick={() => error.action && runMediaAction(error.action)}>
                      {mediaActionLabel(error.action)}
                    </Button>
                  ) : null}
                </span>
              </span>
            ) : null}
          </div>
          <div className="mt-4">
            <Field label={t('video.device')}>
              <Select aria-label={t('video.device')} value={deviceId ?? ''} onChange={(e) => setPrefs({ cameraDeviceId: e.target.value || null })}>
                <option value="">{t('voice.defaultDevice')}</option>
                {cameras.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId.slice(0, 8)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
        {/* «Внешний вид» under «Фон» (docs/08): in the smallest window the sheet's body scrolls to it. */}
        <div className="flex min-w-0 flex-col gap-4">
          <BackgroundPicker />
          <CameraAppearance />
        </div>
      </div>
    </Modal>
  );
}

/** «Загружаем фон…» over the preview while the model loads (≤ 1.5 s, ADR §6); a leaf subscriber. */
function BackgroundLoading(): ReactNode {
  const loading = useCameraBg((s) => s.state === 'loading');
  if (!loading) return null;
  return (
    <span role="status" className="mat-popover absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption text-fg" data-testid="camera-bg-loading">
      <Loader2 className="size-3.5 animate-spin" aria-hidden /> {t('video.bg.loading')}
    </span>
  );
}

/**
 * The preview gets «Фон» and «Внешний вид» live. A leaf subscriber: a slider drag re-renders
 * nothing of the dialog (CLAUDE.md «Ререндеры»).
 */
function ApplyEffects({ track }: { track: LocalVideoTrack }): null {
  const background = usePrefs((s) => s.cameraBackground);
  const effects = usePrefs((s) => s.cameraEffects);
  const fps = usePrefs((s) => s.cameraBgFps);
  useEffect(() => {
    void applyCameraBackground(track, background, effects);
  }, [track, background, effects, fps]);
  return null;
}
