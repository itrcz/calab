import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, ChevronRight, Ellipsis, Eye, Guitar, Loader2, Lock, MessageCircle, MicOff, MonitorUp, MonitorX, Phone, Settings, SwitchCamera, Video, VideoOff, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DisplayedPhase, offerRetry } from '../../lib/voiceLink';
import { cameraBlock, camerasFull } from '../../lib/media/cameraLogic';
import { isTouchPrimary } from '../../lib/phone';
import { platform } from '../../platform';
import { useCanFlipCamera } from '../voice/useCanFlipCamera';
import { Badge, Button, Tip, cx } from '../../components/ui';
import { t, useLocale, type MessageKey } from '../../i18n';
import { BUILTIN_BACKGROUNDS } from '../../lib/media/background/images';
import { isWorkspaceImage, workspaceImageId, type BackgroundKind } from '../../lib/media/background/logic';
import { thumbnailPath } from '../../lib/api/endpoints';
import { MediaImg } from '../../components/MediaImg';
import { backgroundBlocked, blockedText, effectsBlocked } from '../../services/cameraBackground';
import { useCameraBg } from '../../stores/cameraBg';
import { useCustomBackgrounds } from '../voice/BackgroundPicker';
import { setCameraEffects } from '../voice/CameraAppearance';
import { mediaActionLabel, runMediaAction } from '../../services/mediaErrors';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { setVoice, useVoice, type LinkQuality, type VoicePhase } from '../../stores/voice';
import { RecordingPill } from '../voice/Recording';
import { TempExpiry } from '../voice/TempExpiry';
import { SoundChip, SoundboardButton } from '../voice/Soundboard';
import { MyStreamAnnot } from '../voice/Annotations';
import { useBackgroundList, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { dmPeer } from '../../stores/dms';
import { openDm } from '../../services/dms';
import { NoiseButton } from './NoisePopover';
import { menuBox, menuItem, menuLabel, menuSeparator, popoverBox } from './menu';
import { PRESET_LABEL, viewersText } from '../voice/streamFormat';
import { CAMERA_PRESETS, allowedCameraPreset, cameraPresetLock, type CameraPreset } from '../../lib/plan';
import { planToast } from '../../services/plan';
import { toast } from '../../stores/toasts';
import { musicianLockedToast, setMusicianMode, useMusicianAllowed } from '../../services/musician';

const Q_COLOR: Record<LinkQuality, string> = { good: 'text-ok', fair: 'text-warn', poor: 'text-danger', unknown: 'text-muted' };
/** Lit bars out of 4 per quality (reconnecting reads as «poor»: 1 bar). */
const Q_BARS: Record<LinkQuality, number> = { good: 4, fair: 2, poor: 1, unknown: 4 };

/**
 * Signal bars (18 px): always all four, the lit ones in the text colour, the rest in the neutral
 * fill — one lit bar alone read like a stray pixel (review 2, «Reconnecting»).
 */
function SignalBars({ lit, className }: { lit: number; className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 18 18" className={cx('size-[18px]', className)} aria-hidden>
      {[5, 8, 11, 14].map((h, i) => (
        <rect key={h} x={2 + i * 4} y={16 - h} width={2.5} height={h} rx={1} fill={i < lit ? 'currentColor' : 'var(--color-fill-hover)'} />
      ))}
    </svg>
  );
}
const Q_LABEL: Record<LinkQuality, 'quality.good' | 'quality.fair' | 'quality.poor' | 'quality.unknown'> = {
  good: 'quality.good',
  fair: 'quality.fair',
  poor: 'quality.poor',
  unknown: 'quality.unknown',
};

/**
 * The phase the panel shows (lib/voiceLink.DisplayedPhase): a LiveKit reconnect shorter than
 * 1.5 s never reaches the title; one reconnect cycle is one «Переподключение…». Visual tests
 * see the store phase at once.
 */
function useDisplayedPhase(): VoicePhase {
  const phase = useVoice((s) => s.phase);
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  const [shown, setShown] = useState(phase);
  const ref = useRef<DisplayedPhase | null>(null);
  useEffect(() => {
    // Starts from the phase already shown; the next store change goes through the debounce.
    const d = new DisplayedPhase(useVoice.getState().phase, setShown, undefined, visualTest ? 0 : undefined);
    ref.current = d;
    return () => {
      d.dispose();
      ref.current = null;
    };
  }, [visualTest]);
  useEffect(() => {
    ref.current?.update(phase);
  }, [phase]);
  return shown;
}

/** Connection quality: always visible while in voice; click → details (docs/08, «UX-правила»). */
function QualityButton({ phase }: { phase: VoicePhase }): ReactNode {
  const quality = useVoice((s) => s.quality);
  const q: LinkQuality = phase === 'connected' ? quality : 'poor';
  const open = useUi((s) => s.openDialog);
  if (phase === 'connecting') {
    // «подключение…» (docs/09 #15): a spinner where the signal bars will be.
    return (
      <span className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-card)] bg-[var(--color-fill)]" role="status" aria-label={t('voice.connecting')}>
        <Loader2 className="size-5 animate-spin text-muted" aria-hidden />
      </span>
    );
  }
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${t('quality.title')}: ${t(Q_LABEL[q])}`}
          className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-card)] bg-[var(--color-fill)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)]"
        >
          <SignalBars lit={Q_BARS[q]} className={cx('size-5', phase === 'connected' ? Q_COLOR[q] : 'text-warn')} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={8} aria-label={t('quality.title')} className={cx(popoverBox, 'w-64 p-3')}>
          <div className="mb-2 font-semibold">{t('quality.title')}</div>
          <QualityDetails q={q} />
          <Popover.Close asChild>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => open({ kind: 'settings', tab: 'connection' })}>
              {t('conn.check')}
            </Button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * RTT / loss / path of the quality popover: mounted only while it is open, so the 2 s stats
 * updates do not re-render the voice panel's signal button (docs/14 «Ререндеры в звонке»).
 */
function QualityDetails({ q }: { q: LinkQuality }): ReactNode {
  const rtt = useVoice((s) => s.rttMs);
  const loss = useVoice((s) => s.lossPct);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      <dt className="text-muted">{t('quality.state')}</dt>
      <dd className={q === 'poor' ? 'text-danger-text' : 'text-fg'}>{t(Q_LABEL[q])}</dd>
      <dt className="text-muted">{t('quality.rtt')}</dt>
      <dd>{rtt === null ? '—' : t('unit.ms', { n: Math.round(rtt) })}</dd>
      <dt className="text-muted">{t('quality.loss')}</dt>
      <dd>{loss === null ? '—' : `${loss.toFixed(1)} %`}</dd>
      <dt className="text-muted">{t('quality.path')}</dt>
      <dd className="truncate">{voice.connectionPath() ?? '—'}</dd>
    </dl>
  );
}

/**
 * Big button of the voice panel (docs/09 v0.2, Discord reference): ~56×40, fill on hover,
 * accent fill when on. `children` is the 20 px icon.
 */
const ON = 'bg-accent-strong text-white hover:bg-[color-mix(in_srgb,var(--color-accent-strong)_88%,white)]';
const OFF = 'bg-[var(--color-fill)] text-fg hover:bg-[var(--color-fill-hover)] disabled:hover:bg-[var(--color-fill)]';
const panelBtn = (active: boolean): string =>
  cx('grid h-9 min-w-0 place-items-center rounded-[var(--radius-icon)] transition-colors duration-[var(--motion-fast)] disabled:opacity-40', active ? ON : OFF);

/** Touch only (desktop has the tooltip): a tap on a disabled control says why. */
export function explainDisabled(reason: string): void {
  if (isTouchPrimary()) toast.info(reason);
}

function PanelButton({
  label,
  active = false,
  disabled,
  reason,
  onClick,
  testId,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  /** Why it is off: a tooltip never opens on touch, so a tap on the disabled button toasts it. */
  reason?: string;
  onClick?: () => void;
  testId?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Tip label={label}>
      {/* aria-disabled keeps the tooltip (why it is off) reachable; the click is ignored. */}
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        aria-disabled={disabled || undefined}
        data-testid={testId}
        onClick={disabled ? () => explainDisabled(reason ?? label) : onClick}
        className={cx(panelBtn(active), disabled && 'cursor-default opacity-40 hover:bg-[var(--color-fill)]')}
      >
        {children}
      </button>
    </Tip>
  );
}

/** Tooltip / label of the camera button (why it is unavailable, or what a click does). */
function useCameraLabel(roomId: string): { label: string; disabled: boolean } {
  const phase = useVoice((s) => s.camera);
  const connected = useVoice((s) => s.phase === 'connected');
  const canVideo = useVoice((s) => s.canVideo);
  // A one-to-one call (ADR-0034): cameras on for both, whatever the DM room carries.
  const call = useVoice((s) => s.call);
  const roomLimit = useRooms((s) => s.byId[roomId]?.media?.cameraLimit ?? 0);
  const limit = call ? 2 : roomLimit;
  const wsId = useVoice((s) => s.workspaceId);
  const on = useWorkspaces((s) => Object.values((wsId ? s.byId[wsId]?.voice : undefined) ?? {}).filter((v) => v.roomId === roomId && v.camera).length);
  const block = cameraBlock({ connected, canVideo, limit, phase });
  if (phase === 'on') return { label: t('video.off'), disabled: false };
  if (phase === 'starting' || phase === 'stopping') return { label: t('video.starting'), disabled: false };
  if (block === 'not-connected') return { label: t('video.on'), disabled: true };
  if (block === 'room-off') return { label: t('video.roomOff'), disabled: true };
  if (block === 'no-permission') return { label: t('video.noPermission'), disabled: true };
  if (camerasFull(on, limit, false)) return { label: t('video.full', { n: on, max: limit }), disabled: false };
  return { label: t('video.on'), disabled: false };
}

/** «Камера» with its ▾ device menu: one 56×40 button, the ▾ a narrow part at the right edge. */
/**
 * The camera toggle shared by the island's split button and the phone strip's round one: what a
 * tap does (stop / first-time preview / start), its label and why it may be unavailable. A tap on
 * the disabled one says why on touch (tooltips never open there).
 */
export function useCameraToggle(roomId: string): { label: string; disabled: boolean; on: boolean; busy: boolean; click: () => void } {
  const phase = useVoice((s) => s.camera);
  const checked = usePrefs((s) => s.cameraChecked);
  const open = useUi((s) => s.openDialog);
  const { label, disabled } = useCameraLabel(roomId);
  const on = phase === 'on';
  const busy = phase === 'starting' || phase === 'stopping';
  const click = (): void => {
    if (disabled) {
      explainDisabled(label);
      return;
    }
    if (on || phase === 'starting') void voice.camera.stop();
    else if (phase !== 'off') return;
    else if (!checked) open({ kind: 'camera-preview' });
    else void voice.camera.start();
  };
  return { label, disabled, on, busy, click };
}

function CameraButton({ roomId }: { roomId: string }): ReactNode {
  const { label, disabled, on, busy, click } = useCameraToggle(roomId);
  const [menu, setMenu] = useState(false);
  // One 56×40 split button: the camera toggle and a 20 px ▾ (the full 40 px height) with a
  // hairline between them; right-click on the toggle opens the device menu too.
  const part = on ? 'hover:bg-white/15' : 'hover:bg-[var(--color-fill-hover)]';
  return (
    <div className={cx('flex h-9 min-w-0 overflow-hidden rounded-[var(--radius-icon)]', on ? 'bg-accent-strong text-white' : 'bg-[var(--color-fill)] text-fg')}>
      <Tip label={label}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={on}
          aria-disabled={disabled || undefined}
          data-testid="camera-button"
          onClick={click}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(true);
          }}
          className={cx('grid min-w-0 flex-1 place-items-center transition-colors duration-[var(--motion-fast)]', disabled ? 'cursor-default opacity-40' : part)}
        >
          {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : on ? <Video className="size-5" aria-hidden /> : <VideoOff className="size-5" aria-hidden />}
        </button>
      </Tip>
      <span aria-hidden className={cx('my-2 w-px shrink-0', on ? 'bg-white/30' : 'bg-[var(--color-fill-hover)]')} />
      <Dropdown.Root modal={false} open={menu} onOpenChange={setMenu}>
        <Tip label={t('video.options')}>
          <Dropdown.Trigger asChild>
            <button
              type="button"
              aria-label={t('video.options')}
              className={cx(
                'grid w-5 shrink-0 place-items-center transition-colors duration-[var(--motion-fast)]',
                on ? 'text-white/85 hover:text-white data-[state=open]:bg-white/15' : 'text-muted hover:text-fg data-[state=open]:bg-[var(--color-fill-hover)] data-[state=open]:text-fg',
                part,
              )}
            >
              <ChevronDown className="size-3.5" strokeWidth={2.25} aria-hidden />
            </button>
          </Dropdown.Trigger>
        </Tip>
        <Dropdown.Portal>
          <CameraMenu />
        </Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
}

const DEFAULT_CAMERA = '__default__';

/** Camera ▾: devices, «Проверить камеру», voice settings. */
export function CameraMenu(): ReactNode {
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const current = usePrefs((s) => s.cameraDeviceId) ?? DEFAULT_CAMERA;
  const setPrefs = usePrefs((s) => s.setPrefs);
  const phase = useVoice((s) => s.camera);
  const open = useUi((s) => s.openDialog);
  useEffect(() => {
    let alive = true;
    // mediaDevices is missing on insecure origins (web over plain http).
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (!md) {
      queueMicrotask(() => alive && setDevices([]));
      return;
    }
    void md.enumerateDevices().then(
      (d) => alive && setDevices(d),
      () => alive && setDevices([]),
    );
    return () => {
      alive = false;
    };
  }, []);
  const list = (devices ?? []).filter((d) => d.kind === 'videoinput');
  const canFlip = useCanFlipCamera();
  return (
    // To the right of the panel, over the chat: it doesn't cover the «Голос подключён» header.
    <Dropdown.Content className={cx(menuBox, 'w-72')} side="right" align="end" sideOffset={8} collisionPadding={16}>
      {canFlip ? (
        <>
          <Dropdown.Item className={cx(menuItem, 'h-10')} onSelect={() => voice.camera.flip()} data-testid="camera-flip">
            <SwitchCamera className="size-4" aria-hidden /> {t('video.flip')}
          </Dropdown.Item>
          <Dropdown.Separator className={menuSeparator} />
        </>
      ) : null}
      <Dropdown.Label className={menuLabel}>{t('video.device')}</Dropdown.Label>
      <Dropdown.RadioGroup value={current} onValueChange={(v) => setPrefs({ cameraDeviceId: v === DEFAULT_CAMERA ? null : v })}>
        <Dropdown.RadioItem value={DEFAULT_CAMERA} className={cx(menuItem, 'relative pl-7')}>
          <Dropdown.ItemIndicator className="absolute left-2">
            <Check className="size-3.5" />
          </Dropdown.ItemIndicator>
          <span className="truncate">{t('shell.systemDefault')}</span>
        </Dropdown.RadioItem>
        {list.map((d) => (
          <Dropdown.RadioItem key={d.deviceId} value={d.deviceId} className={cx(menuItem, 'relative pl-7')} title={d.label}>
            <Dropdown.ItemIndicator className="absolute left-2">
              <Check className="size-3.5" />
            </Dropdown.ItemIndicator>
            <span className="truncate">{d.label || d.deviceId.slice(0, 8)}</span>
          </Dropdown.RadioItem>
        ))}
      </Dropdown.RadioGroup>
      {devices !== null && list.length === 0 ? <div className="px-2 py-1 text-caption text-muted">{t('video.noDevices')}</div> : null}
      <Dropdown.Separator className={menuSeparator} />
      <CameraQualityItems />
      <CameraLookItems />
      <Dropdown.Separator className={menuSeparator} />
      {phase === 'off' ? (
        <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'camera-preview' })}>
          <Video className="size-4" /> {t('video.check')}
        </Dropdown.Item>
      ) : null}
      <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'settings', tab: 'voice' })}>
        <Settings className="size-4" /> {t('shell.voiceSettings')}
      </Dropdown.Item>
    </Dropdown.Content>
  );
}

/**
 * «Фон» and «Внешний вид» in the camera ▾ menu; where they cannot run, one disabled line with the
 * reason instead (owner, 2.1: checked before the choice, never hidden). A leaf subscriber.
 */
function CameraLookItems(): ReactNode {
  const failure = useCameraBg((s) => s.failure);
  const bg = backgroundBlocked(failure);
  const fx = effectsBlocked(failure);
  const blocked = bg ?? fx;
  return (
    <>
      <Dropdown.Separator className={menuSeparator} />
      {bg ? null : <CameraBackgroundItems />}
      {!bg && !fx ? <Dropdown.Separator className={menuSeparator} /> : null}
      {fx ? null : <CameraEffectsItems />}
      {blocked ? (
        <Dropdown.Item disabled className={cx(menuItem, 'h-auto whitespace-normal py-1.5 text-caption text-muted')} data-testid="camera-bg-blocked">
          {blockedText(blocked, failure)}
        </Dropdown.Item>
      ) : null}
    </>
  );
}

/**
 * Camera ▾ «Фон» (ADR-0035 §5): the quick picks of the preview's section, without a preview — no
 * blur / light / strong, «Фоны пространства ▸» (the addendum: the voice room's workspace, else the
 * open one; live from the store, docs/09 #121) and «Картинка ▸» with the built-in and the user's
 * pictures. Applied to the live camera at once (services/voice.ts follows prefs.cameraBackground).
 */
function CameraBackgroundItems(): ReactNode {
  const kind = usePrefs((s) => s.cameraBackground.kind);
  const imageId = usePrefs((s) => s.cameraBackground.imageId);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const locale = useLocale();
  const { list } = useCustomBackgrounds();
  const voiceWs = useVoice((s) => s.workspaceId);
  const activeWs = useUi((s) => s.activeWorkspaceId);
  const workspace = useBackgroundList(voiceWs || activeWs);
  const wsChosen = kind === 'image' && isWorkspaceImage(imageId);
  const blur: Array<[BackgroundKind, MessageKey]> = [
    ['none', 'video.bg.none'],
    ['blur-light', 'video.bg.blurLightFull'],
    ['blur-strong', 'video.bg.blurStrongFull'],
  ];
  const pictures = [
    ...BUILTIN_BACKGROUNDS.map((b) => ({ id: b.id, url: b.thumbUrl, label: b.name(locale) })),
    ...list.map((c, i) => ({ id: c.id, url: c.url, label: t('video.bg.custom', { n: i + 1 }) })),
  ];
  return (
    <>
      <Dropdown.Label className={menuLabel}>{t('video.bg.title')}</Dropdown.Label>
      {blur.map(([k, label]) => (
        <Dropdown.Item key={k} role="menuitemradio" aria-checked={kind === k} className={cx(menuItem, 'relative pl-7')} onSelect={() => setPrefs({ cameraBackground: { kind: k } })}>
          {kind === k ? <Check className="absolute left-2 size-3.5" aria-hidden /> : null}
          <span className="flex-1">{t(label)}</span>
        </Dropdown.Item>
      ))}
      {workspace.length > 0 ? (
        <Dropdown.Sub>
          <Dropdown.SubTrigger className={cx(menuItem, 'relative pl-7 data-[state=open]:not-data-[highlighted]:bg-hover')} data-testid="camera-bg-workspace-menu">
            {wsChosen ? <Check className="absolute left-2 size-3.5" aria-hidden /> : null}
            <span className="flex-1">{t('video.bg.workspace')}</span>
            <ChevronRight className="size-3.5 opacity-70" aria-hidden />
          </Dropdown.SubTrigger>
          <Dropdown.Portal>
            <Dropdown.SubContent className={cx(menuBox, 'w-56')} sideOffset={6} alignOffset={-4} collisionPadding={16}>
              {workspace.map((b) => {
                const id = workspaceImageId(b.id);
                const on = kind === 'image' && imageId === id;
                return (
                  <Dropdown.Item key={b.id} role="menuitemradio" aria-checked={on} className={cx(menuItem, 'relative pl-7')} onSelect={() => setPrefs({ cameraBackground: { kind: 'image', imageId: id } })}>
                    {on ? <Check className="absolute left-2 size-3.5" aria-hidden /> : null}
                    <MediaImg path={thumbnailPath(b.fileId)} alt="" className="h-[18px] w-8 shrink-0 rounded-[3px] object-cover" draggable={false} data-wsbg-thumb />
                    <span className="flex-1 truncate">{b.name}</span>
                  </Dropdown.Item>
                );
              })}
            </Dropdown.SubContent>
          </Dropdown.Portal>
        </Dropdown.Sub>
      ) : null}
      <Dropdown.Sub>
        <Dropdown.SubTrigger className={cx(menuItem, 'relative pl-7 data-[state=open]:not-data-[highlighted]:bg-hover')} data-testid="camera-bg-pictures">
          {kind === 'image' && !wsChosen ? <Check className="absolute left-2 size-3.5" aria-hidden /> : null}
          <span className="flex-1">{t('video.bg.pictures')}</span>
          <ChevronRight className="size-3.5 opacity-70" aria-hidden />
        </Dropdown.SubTrigger>
        <Dropdown.Portal>
          <Dropdown.SubContent className={cx(menuBox, 'w-56')} sideOffset={6} alignOffset={-4} collisionPadding={16}>
            {pictures.map((p) => {
              const on = kind === 'image' && imageId === p.id;
              return (
                <Dropdown.Item key={p.id} role="menuitemradio" aria-checked={on} className={cx(menuItem, 'relative pl-7')} onSelect={() => setPrefs({ cameraBackground: { kind: 'image', imageId: p.id } })}>
                  {on ? <Check className="absolute left-2 size-3.5" aria-hidden /> : null}
                  <img src={p.url} alt="" className="h-[18px] w-8 shrink-0 rounded-[3px] object-cover" draggable={false} />
                  <span className="flex-1 truncate">{p.label}</span>
                </Dropdown.Item>
              );
            })}
          </Dropdown.SubContent>
        </Dropdown.Portal>
      </Dropdown.Sub>
    </>
  );
}

/**
 * Camera ▾ «Внешний вид» (ADR-0035 addendum): the preview's two switches; the touch-up strength
 * stays what was set in the preview (default 40). Applied to the live camera at once.
 */
function CameraEffectsItems(): ReactNode {
  const touchUp = usePrefs((s) => s.cameraEffects.touchUp);
  const lowLight = usePrefs((s) => s.cameraEffects.lowLight);
  return (
    <>
      <Dropdown.Label className={menuLabel}>{t('video.fx.title')}</Dropdown.Label>
      <Dropdown.CheckboxItem className={cx(menuItem, 'relative pl-7')} checked={touchUp} onCheckedChange={(v) => setCameraEffects({ touchUp: v })} data-testid="camera-fx-touchup">
        <Dropdown.ItemIndicator className="absolute left-2">
          <Check className="size-3.5" />
        </Dropdown.ItemIndicator>
        {t('video.fx.touchUp')}
      </Dropdown.CheckboxItem>
      <Dropdown.CheckboxItem className={cx(menuItem, 'relative pl-7')} checked={lowLight} onCheckedChange={(v) => setCameraEffects({ lowLight: v })} data-testid="camera-fx-lowlight">
        <Dropdown.ItemIndicator className="absolute left-2">
          <Check className="size-3.5" />
        </Dropdown.ItemIndicator>
        {t('video.fx.lowLight')}
      </Dropdown.CheckboxItem>
    </>
  );
}

/**
 * Camera ▾ «Качество» (ADR-0024): 720p / 1080p. A quality above the plan's camera_max_preset has a
 * lock and a tooltip; choosing it explains how to get it (toast with «Связаться») instead.
 * Changing the quality of a live camera restarts it.
 */
function CameraQualityItems(): ReactNode {
  const chosen = usePrefs((s) => s.cameraPreset);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const phase = useVoice((s) => s.camera);
  const wsId = useVoice((s) => s.workspaceId);
  const planMax = useWorkspaces((s) => (wsId ? s.byId[wsId]?.ws.plan?.limits?.cameraMaxPreset : undefined));
  const current = allowedCameraPreset(chosen, planMax);
  const choose = (p: CameraPreset): void => {
    if (p === current) return;
    setPrefs({ cameraPreset: p });
    if (phase === 'on') {
      toast.info(t('camera.qualityNext'));
      void voice.camera.restart();
    }
  };
  return (
    <>
      <Dropdown.Label className={menuLabel}>{t('camera.quality')}</Dropdown.Label>
      {CAMERA_PRESETS.map((p) => {
        const locked = cameraPresetLock(p, planMax) === 'plan';
        const label = t(PRESET_LABEL[p]);
        const item = (
          <Dropdown.Item
            key={p}
            role="menuitemradio"
            aria-checked={current === p}
            className={cx(menuItem, 'relative pl-7')}
            onSelect={() => (locked ? planToast(t('plan.toast.preset', { preset: label })) : choose(p))}
          >
            {current === p ? <Check className="absolute left-2 size-3.5" aria-hidden /> : null}
            <span className="flex-1">{label}</span>
            {locked ? <Lock className="size-3.5 opacity-70" aria-label={t('plan.lockTip')} /> : null}
          </Dropdown.Item>
        );
        return locked ? (
          <Tip key={p} label={t('plan.lockTip')} side="right">
            {item}
          </Tip>
        ) : (
          item
        );
      })}
    </>
  );
}

declare global {
  interface Window {
    /** Visual tests only (CALABA_VISUAL_TEST): show a voice phase (e.g. «Переподключение…») without breaking the network. */
    __calabaVoicePhase?: (phase: VoicePhase) => void;
    /** Visual tests only: remote cameras in my room (wait for a publisher to leave). */
    __calabaCameras?: () => number;
    /** Visual tests only: who speaks (user ids) — fixture members have no LiveKit audio. */
    __calabaSpeaking?: (userIds: string[]) => void;
    /** Visual tests only: back-date my room join (docs/09 #10 — the invite row's 30 s window). */
    __calabaJoinedAt?: (ms: number) => void;
    /** e2e tests (docs/09 #71): the LiveKit connection as it really is (voice.linkTruth). */
    __calabaVoiceLink?: () => { state: string | null; room: string | null; identity: string | null };
    /** e2e tests: an unexpected LiveKit loss (the reconnect cycle starts). */
    __calabaVoiceDrop?: () => void;
  }
}

/** «Голос подключён» (docs/09 #5), above the self panel while in voice. */
export function VoiceBar(): ReactNode {
  const visualTest = useSession((s) => s.appInfo?.visualTest === true);
  useEffect(() => {
    if (!visualTest) return;
    window.__calabaVoicePhase = (phase) => setVoice({ phase });
    window.__calabaCameras = () => useVoice.getState().cameras.length;
    window.__calabaSpeaking = (ids) => setVoice({ speaking: Object.fromEntries(ids.map((id) => [id, true])) });
    window.__calabaJoinedAt = (ms) => setVoice({ joinedAt: ms });
    window.__calabaVoiceLink = () => voice.linkTruth();
    window.__calabaVoiceDrop = () => voice.simulateLinkLoss();
    return () => {
      delete window.__calabaVoiceLink;
      delete window.__calabaVoiceDrop;
      delete window.__calabaSpeaking;
      delete window.__calabaVoicePhase;
      delete window.__calabaCameras;
      delete window.__calabaJoinedAt;
    };
  }, [visualTest]);
  const roomId = useVoice((s) => s.roomId);
  const wsId = useVoice((s) => s.workspaceId);
  const phase = useDisplayedPhase();
  const link = useVoice((s) => s.link);
  const myStream = useVoice((s) => s.myStream);
  const streamBusy = useVoice((s) => s.streamBusy);
  const canStream = useVoice((s) => s.canStream);
  const micError = useVoice((s) => s.micError);
  const micAction = useVoice((s) => s.micErrorAction);
  const serverMuted = useVoice((s) => s.serverMuted);
  const room = useRooms((s) => (roomId ? s.byId[roomId] : undefined));
  const wsName = useWorkspaces((s) => (wsId ? s.byId[wsId]?.ws.name : undefined));
  // A one-to-one call (ADR-0034): «Звонок · <имя>» instead of «Комната / Пространство».
  const call = useVoice((s) => s.call);
  const peerName = useMemberName(null, call && roomId ? dmPeer(roomId) : '');
  const devStats = usePrefs((s) => s.devStats);
  const saveTraffic = usePrefs((s) => s.saveTraffic);
  const musician = usePrefs((s) => s.musicianMode);
  const musicianAllowed = useMusicianAllowed();
  // camera + more, plus «Показать экран» (not on a phone browser) and «Звуки» (not in a one-to-one call).
  const screenCapture = platform.canShareScreen();
  const cols = 2 + (screenCapture || myStream ? 1 : 0) + (call ? 0 : 1);
  const anyVideo = useVoice((s) => s.cameras.length > 0 || s.camera === 'on');
  const stage = useVoice((s) => s.stage);
  const videoPip = useVoice((s) => s.videoPip);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const openRoom = useUi((s) => s.openRoom);
  const open = useUi((s) => s.openDialog);
  if (!roomId) return null;
  const phaseText =
    phase === 'connected' ? t('voice.connected') : phase === 'reconnecting' ? t('voice.reconnecting') : phase === 'blocked' ? t('voice.blocked') : t('voice.connecting');
  const retry = offerRetry(phase, link.attempts);
  const host = link.blockedHost ?? link.rtcHost ?? '';
  const full = call ? t('call.panel', { name: peerName }) : t('shell.voiceIn', { room: room?.name ?? '', ws: wsName ?? '' });
  // Always «room / workspace» (Discord's «Room / Server»); truncated in the panel, the full path
  // is in the tooltip. A call opens its DM.
  const goRoom = (): void => {
    if (call) openDm(roomId);
    else if (wsId) openRoom(wsId, roomId);
  };

  return (
    <div className="shrink-0 px-2 pb-2 pt-1.5" role="region" aria-label={t('voice.panel')}>
      {/* Header (Discord): signal in a 36 px square (click = connection details), «Голос
          подключён» 14 px semibold green + «Комната / Пространство» 13 px muted, then noise suppression (popover, docs/09
          #12) and the red hang-up. */}
      <div className="flex items-center gap-2">
        <QualityButton phase={phase} />
        <div className="min-w-0 flex-1" aria-live="polite">
          <div className={cx('truncate text-[14px] font-semibold leading-[18px]', phase === 'connected' ? 'text-ok' : 'text-warn')}>{phaseText}</div>
          <button type="button" className="block max-w-full truncate text-left text-[13px] leading-[18px] text-muted hover:text-fg hover:underline" onClick={goRoom} title={full}>
            {full}
          </button>
        </div>
        <NoiseButton />
        <Tip label={t('voice.leave')}>
          <button
            type="button"
            aria-label={t('voice.leave')}
            onClick={() => void voice.leave()}
            className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-icon)] text-danger transition-colors duration-[var(--motion-fast)] hover:bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)]"
          >
            {/* A handset tilted down (Discord's hang-up), not a crossed phone. */}
            <Phone className="size-5 rotate-[135deg]" aria-hidden />
          </button>
        </Tip>
      </div>

      {/* A recording (docs/09 #30): the red «● Запись · 12:34» pill on a line under the header,
          aligned with its text (36 px square + 8 px); who started it — in the tooltip. */}
      <RecordingPill roomId={roomId} workspaceId={wsId} className="mt-1 pl-11" />
      {/* A temporary room closing within 10 minutes (ADR-0044): «⏱ 9 мин» and «Продлить». */}
      {call ? null : <TempExpiry roomId={roomId} workspaceId={wsId} className="mt-1 pl-11" />}
      {/* Soundboard (ADR-0036): «🥁 Ba dum tss · Илья» for 2 s after a sound played in the call. */}
      {call ? null : <SoundChip className="mt-1 pl-11" />}

      {phase === 'reconnecting' || phase === 'blocked' ? (
        // Connection lost (docs/09 #15): yellow notice inside the panel; LiveKit / rejoin brings it
        // back. A sibling of the buttons (no key / wrapper change): showing it never remounts
        // the panel or closes its menus. After 3 failed attempts — the reason and «Повторить»;
        // blocked by our CSP — say so at once (retrying cannot help).
        <div className="mt-1.5 flex items-start gap-2 rounded-[var(--radius-row)] bg-mention px-2 py-1.5 text-[12px]" role="status" data-testid="voice-reconnecting">
          <WifiOff className="mt-px size-4 shrink-0 text-warn" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-fg">
              {phase === 'blocked' ? t('voiceUi.blocked', { host }) : retry && host ? t('voiceUi.cantReach', { host }) : t('voiceUi.reconnectHint')}
            </span>
            {retry && phase !== 'blocked' && link.lastError ? (
              <span className="break-words text-muted" title={link.lastError}>
                {link.lastError}
              </span>
            ) : null}
          </span>
          {retry ? (
            <button type="button" className="shrink-0 rounded-[var(--radius-control)] font-medium text-accent-text hover:underline" onClick={() => voice.retry()}>
              {t('voiceUi.retry')}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Equal 36 px buttons 10 px apart across the island (docs/09 #12): camera ▾, screen,
          sounds (ADR-0036; not in a one-to-one call), more. Noise suppression lives in the
          header's popover and in Settings. */}
      <div className={cx('mt-2 grid gap-2.5', cols === 2 ? 'grid-cols-2' : cols === 3 ? 'grid-cols-3' : 'grid-cols-4')}>
        <CameraButton roomId={roomId} />
        {/* A phone browser has no getDisplayMedia: no button rather than one that always fails. */}
        {!myStream && !screenCapture ? null : myStream ? (
          <PanelButton label={t('shell.stopShare')} active onClick={() => void voice.stopStream()}>
            <MonitorX className="size-5" aria-hidden />
          </PanelButton>
        ) : (
          <PanelButton label={t('shell.shareScreen')} reason={phase === 'connected' && !streamBusy && !canStream ? t('shell.noStreamPermission') : t('shell.shareScreen')} disabled={phase !== 'connected' || streamBusy || !canStream} onClick={() => open({ kind: 'stream-picker' })}>
            <MonitorUp className="size-5" aria-hidden />
          </PanelButton>
        )}
        {call ? null : <SoundboardButton className={cx(panelBtn(false), 'data-[state=open]:bg-[var(--color-fill-hover)]')} />}
        <Dropdown.Root modal={false}>
          <Tip label={t('shell.more')}>
            <Dropdown.Trigger asChild>
              <button type="button" aria-label={t('shell.more')} className={cx(panelBtn(false), 'data-[state=open]:bg-[var(--color-fill-hover)]')}>
                <Ellipsis className="size-5" aria-hidden />
              </button>
            </Dropdown.Trigger>
          </Tip>
          <Dropdown.Portal>
            <Dropdown.Content className={cx(menuBox, 'w-64')} side="top" align="end" sideOffset={6} collisionPadding={16}>
              {anyVideo && (stage === 'pip' || !videoPip) ? (
                <Dropdown.Item className={menuItem} onSelect={() => voice.showVideo()}>
                  <Video className="size-4" /> {t('video.grid')}
                </Dropdown.Item>
              ) : null}
              <Dropdown.CheckboxItem className={cx(menuItem, 'relative pl-7')} checked={saveTraffic} onCheckedChange={(v) => setPrefs({ saveTraffic: v })}>
                <Dropdown.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5" />
                </Dropdown.ItemIndicator>
                {t('video.saveTraffic')}
              </Dropdown.CheckboxItem>
              <Dropdown.CheckboxItem className={cx(menuItem, 'relative pl-7')} checked={devStats} onCheckedChange={(v) => setPrefs({ devStats: v })}>
                <Dropdown.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5" />
                </Dropdown.ItemIndicator>
                {t('shell.stats')}
              </Dropdown.CheckboxItem>
              {/* Musician mode (ADR-0052): on → the headphones warning as a toast. Free: the item
                  stays, with a lock; a click explains the plan (docs/08 «Функции не по тарифу»). */}
              {musicianAllowed ? (
                <Dropdown.CheckboxItem className={cx(menuItem, 'relative pl-7')} checked={musician} onCheckedChange={setMusicianMode}>
                  <Dropdown.ItemIndicator className="absolute left-2">
                    <Check className="size-3.5" />
                  </Dropdown.ItemIndicator>
                  {t('music.mode')}
                </Dropdown.CheckboxItem>
              ) : (
                <Dropdown.Item className={cx(menuItem, 'relative pl-7 text-muted')} onSelect={musicianLockedToast} title={t('plan.lockedFrom', { plan: t('plan.name.team') })} data-testid="musician-locked">
                  {t('music.mode')}
                  <Lock className="ml-auto size-3.5 shrink-0" aria-label={t('plan.lockedFrom', { plan: t('plan.name.team') })} role="img" />
                </Dropdown.Item>
              )}
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Item className={menuItem} onSelect={goRoom}>
                <MessageCircle className="size-4" /> {t('voicePreview.openChat')}
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'settings', tab: 'voice' })}>
                <Settings className="size-4" /> {t('shell.voiceSettings')}
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'settings', tab: 'connection' })}>
                <Wifi className="size-4" /> {t('shell.connCheck')}
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>

      {myStream ? (
        <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-row)] bg-hover px-2 py-1.5 text-[12px]" data-testid="my-stream">
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <Badge tone="danger">{t('shell.live')}</Badge>
              <span className="flex shrink-0 items-center gap-1 text-fg" aria-label={viewersText(myStream.viewers)}>
                <Eye className="size-3.5 text-muted" aria-hidden />
                {viewersText(myStream.viewers)}
              </span>
              {/* The source as a tiny tag in the corner (owner, 29.09), not a line of its own —
                  the same pill as the speaker time-zone tag. */}
              {myStream.sourceName ? (
                <Tip label={myStream.sourceName}>
                  <span
                    data-testid="my-stream-source"
                    className="ml-auto inline-flex h-[14px] min-w-0 max-w-[120px] items-center rounded-full bg-hover px-1 text-[9px] font-medium leading-none text-muted"
                  >
                    <span className="min-w-0 truncate">{myStream.sourceName}</span>
                  </span>
                </Tip>
              ) : null}
            </span>
            {myStream.audioError ? <span className="mt-0.5 block text-muted">{myStream.audioError}</span> : null}
            <MyStreamAnnot />
          </span>
        </div>
      ) : null}
      {musician ? (
        // My own reminder (ADR-0052): the mic goes out raw — others see the guitar by my name.
        <div className="mt-1.5 flex items-center gap-1.5 text-[12px]" role="status" data-testid="musician-self">
          <Guitar className="size-4 shrink-0 text-accent-text" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-fg">{t('music.mode')}</span>
          <button type="button" className="shrink-0 rounded-[var(--radius-control)] font-medium text-accent-text hover:underline" onClick={() => setMusicianMode(false)}>
            {t('music.off')}
          </button>
        </div>
      ) : null}
      {serverMuted ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-danger-text" role="status">
          <MicOff className="size-4 shrink-0 text-danger" aria-hidden />
          {t('voiceUi.serverMuted')}
        </div>
      ) : null}
      {micError ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" role="alert">
          <span className="text-danger-text">{micError}</span>
          {micAction ? (
            <button type="button" className="rounded-[var(--radius-control)] font-medium text-accent-text hover:underline" onClick={() => runMediaAction(micAction)}>
              {mediaActionLabel(micAction)}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
