import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, Ellipsis, Headphones, HeadphoneOff, Loader2, Mic, MicOff, Music, Phone, Radio, Settings, SwitchCamera, Video, VideoOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { haptic } from '../../lib/mobile';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useConnectingRing, useVoiceStateOf } from '../../stores/voicePending';
import { useVoice } from '../../stores/voice';
import { dmPeer } from '../../stores/dms';
import { useMemberName } from '../../stores/workspaces';
import { openDm } from '../../services/dms';
import { menuBox, menuItem, menuLabel, menuSeparator } from './menu';
import { selectMicMode } from './micMenu';
import { MobileRecDot, useRecording } from '../voice/Recording';
import { SoundboardAnchored } from '../voice/Soundboard';
import { useCanFlipCamera } from '../voice/useCanFlipCamera';
import { useCameraToggle } from './VoiceBar';
import { TempExpiry } from '../voice/TempExpiry';

/** 40 px round control of the strip (pill buttons, docs/08). */
const round = 'grid size-11 shrink-0 place-items-center rounded-full transition-colors duration-[var(--motion-fast)]';
const idle = 'bg-[var(--color-fill)] text-fg active:bg-[var(--color-fill-hover)]';
const off = 'bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] text-danger';

/**
 * Phone voice strip (ADR-0021, Discord mobile): one 56 px solid bar at the bottom of the screen
 * while in voice — «Голос подключён · Комната» (tap = open the voice room), mute, deafen, the
 * push-to-talk hold button (PTT mic mode), the camera, «Ещё» (soundboard, mic mode switch) and
 * hang up. Devices are on the «Я» tab (ADR-0073). On a tab root it sits above the tab bar
 * (`aboveTabs`: no home-indicator inset of its own), on a pushed screen at the bottom.
 * 16 px from the screen edges; the status may take two lines next to a 28 px avatar (hyphenated if one
 * word doesn't fit), so «Переподключение…» is never cut to «Переподк…».
 * Room for five 40 px buttons next to the avatar and the status text: the camera takes the place
 * of the soundboard button (now «Ещё → Звуки»); in push-to-talk mode (the PTT button is the fifth)
 * the camera is «Ещё → Камера» too.
 */
export function MobileVoiceStrip({ aboveTabs = false }: { aboveTabs?: boolean }): ReactNode {
  const roomId = useVoice((s) => s.roomId);
  const wsId = useVoice((s) => s.workspaceId);
  const phase = useVoice((s) => s.phase);
  const muted = useVoice((s) => s.muted);
  const serverMuted = useVoice((s) => s.serverMuted);
  const deafened = useVoice((s) => s.deafened);
  // A one-to-one call is voice activation only (ADR-0034): no PTT button there.
  const call = useVoice((s) => s.call);
  const ptt = usePrefs((s) => s.micMode === 'ptt') && !call;
  const peerName = useMemberName(null, call && roomId ? dmPeer(roomId) : '');
  const onAir = useVoice((s) => s.pttDown && s.transmitting);
  const room = useRooms((s) => (roomId ? s.byId[roomId] : undefined));
  const me = useSession((s) => s.me?.user);
  // My speaking ring (local VAD / PTT, docs/08 «Индикация речи»).
  const speaking = useVoice((s) => (me ? (s.speaking[me.id] ?? false) : false));
  const openRoom = useUi((s) => s.openRoom);
  // Still pending (optimistic join, docs/05) after 3 s: the «connecting» ring on my avatar.
  const mine = useVoiceStateOf(wsId ?? '', me?.id ?? '');
  const connectingRing = useConnectingRing(wsId, me?.id, mine?.pending ?? false);
  const recording = useRecording(roomId);
  const [sounds, setSounds] = useState(false);
  const openSounds = useCallback(() => setSounds(true), []);
  if (!roomId) return null;
  const connected = phase === 'connected';
  // While the PTT button is held the status line says so (the button itself is a 40 px circle).
  const phaseText = connected && ptt && onAir ? t('mobile.pttOn') : connected ? t('voice.connected') : phase === 'reconnecting' ? t('voice.reconnecting') : phase === 'blocked' ? t('voice.blocked') : t('voice.connecting');
  return (
    <div className={cx('shrink-0 px-4 pt-1 [.kb-open_&]:hidden', aboveTabs ? 'pb-2' : 'pb-[calc(var(--safe-bottom,0px)+8px)]')} data-testid="mobile-voice-strip">
      <div role="region" aria-label={t('mobile.voiceStrip')} className="mat-toolbar flex h-14 items-center gap-1 rounded-[var(--radius-panel)] pl-2 pr-1.5 shadow-[var(--shadow-island)]">
        {me ? (
          <span
            className="mr-0.5 flex shrink-0"
            data-speaking={(speaking && !muted && !connectingRing) || undefined}
            data-pending={connectingRing || undefined}
            title={connectingRing ? t('voice.pendingMember') : undefined}
            data-testid="mobile-voice-avatar"
          >
            <Avatar userId={me.id} name={me.displayName} fileId={me.avatarFileId || undefined} size={28} speaking={speaking && !muted} connecting={connectingRing} />
          </span>
        ) : null}
        {/* The whole text block opens the room (a full-size button under the text); the REC dot
            sits above it as its own button — a menu trigger cannot nest inside a button. */}
        <div className="relative flex min-w-0 flex-1 flex-col items-start justify-center self-stretch" aria-live="polite">
          <button
            type="button"
            aria-label={call ? t('call.panel', { name: peerName }) : (room?.name ?? '')}
            className="absolute inset-0 rounded-[var(--radius-row)]"
            onClick={() => (call ? openDm(roomId) : wsId && openRoom(wsId, roomId))}
          />
          <span className="pointer-events-none flex max-w-full items-center gap-1">
            {/* A long status («Переподключение…») wraps instead of being cut; the room name then gives way
                (line-clamp keeps the strip 56 px). A single word wider than the slot (≈ 75–90 px between the
                avatar and five buttons: «Подключение…») is hyphenated by the document language
                («Подклю-чение…»), not broken at an arbitrary letter. */}
            <span className={cx('line-clamp-2 min-w-0 break-words text-[12px] font-semibold leading-[15px] [hyphens:auto]', connected ? 'text-ok' : 'text-warn')} data-testid="mobile-voice-status">
              {phaseText}
            </span>
            {/* Recording (docs/09 #30): the red dot only — the strip has no room for the timer; a tap
                opens «Идёт запись · 12:34» / «Остановить запись» (docs/09 #64). */}
            {recording ? <MobileRecDot roomId={roomId} workspaceId={wsId} rec={recording} className="pointer-events-auto -my-1 relative" /> : null}
            {call ? null : <TempExpiry roomId={roomId} workspaceId={wsId} compact />}
          </span>
          <span className="pointer-events-none max-w-full truncate text-[12px] leading-[15px] text-muted">{call ? t('call.panel', { name: peerName }) : (room?.name ?? '')}</span>
        </div>
        <button
          type="button"
          aria-label={serverMuted ? t('voiceUi.serverMuted') : muted ? t('voice.unmute') : t('voice.mute')}
          aria-pressed={muted}
          onClick={() => voice.toggleMute()}
          className={cx(round, muted ? off : idle)}
        >
          {muted ? <MicOff className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
        </button>
        <button
          type="button"
          aria-label={deafened ? t('voice.undeafen') : t('voice.deafen')}
          aria-pressed={deafened}
          onClick={() => voice.toggleDeafen()}
          className={cx(round, deafened ? off : idle)}
        >
          {deafened ? <HeadphoneOff className="size-5" aria-hidden /> : <Headphones className="size-5" aria-hidden />}
        </button>
        {ptt ? <PttHoldButton disabled={!connected || muted || deafened} /> : <StripCamera roomId={roomId} />}
        {/* Soundboard (ADR-0036): the island's panel as a bottom sheet, «Ещё → Звуки». */}
        {call ? (
          <MoreMenu roomId={roomId} cameraItem={ptt} />
        ) : (
          <SoundboardAnchored open={sounds} onOpenChange={setSounds}>
            <span className="flex shrink-0">
              <MoreMenu roomId={roomId} cameraItem={ptt} onSounds={connected ? openSounds : undefined} />
            </span>
          </SoundboardAnchored>
        )}
        <button type="button" aria-label={t('voice.leave')} onClick={() => void voice.leave()} className={cx(round, 'bg-danger-fill text-white active:brightness-90')}>
          <Phone className="size-5 rotate-[135deg]" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/**
 * The strip's camera: the island's toggle (first tap = «Проверьте камеру», then on / off; the
 * reason when unavailable is a toast, VoiceBar `useCameraToggle`).
 */
function StripCamera({ roomId }: { roomId: string }): ReactNode {
  const { label, disabled, on, busy, click } = useCameraToggle(roomId);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      aria-disabled={disabled || undefined}
      data-testid="mobile-camera-button"
      onClick={click}
      className={cx(round, on ? 'bg-accent-strong text-white' : idle, disabled && 'opacity-40')}
    >
      {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : on ? <Video className="size-5" aria-hidden /> : <VideoOff className="size-5" aria-hidden />}
    </button>
  );
}

/**
 * «Ещё»: «Звуки», the camera (push-to-talk mode, where the strip has no room for it), «Переключить
 * камеру» (phone with front + back camera, camera on), the mic mode (docs/09 #28 — voice
 * activation / push-to-talk) and «Настройки голоса».
 */
function MoreMenu({ roomId, cameraItem, onSounds }: { roomId: string; cameraItem: boolean; onSounds?: (() => void) | undefined }): ReactNode {
  const cam = useCameraToggle(roomId);
  const canFlip = useCanFlipCamera();
  const micMode = usePrefs((s) => s.micMode);
  const openDialog = useUi((s) => s.openDialog);
  const soundsPicked = useRef(false);
  const radio = cx(menuItem, 'relative h-11 pl-8');
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button type="button" aria-label={t('shell.more')} data-testid="mobile-voice-more" className={cx(round, idle, 'data-[state=open]:bg-[var(--color-fill-hover)]')}>
          <Ellipsis className="size-5" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          className={cx(menuBox, 'w-64')}
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={12}
          // «Звуки» opens the sheet: focus must not jump back to «Ещё» (it would close the sheet).
          onCloseAutoFocus={(e) => (soundsPicked.current ? e.preventDefault() : undefined)}
        >
          {cameraItem ? (
            <Dropdown.Item className={cx(menuItem, 'h-11', cam.disabled && 'opacity-40')} data-testid="mobile-voice-camera" onSelect={cam.click}>
              {cam.on ? <Video className="size-4" aria-hidden /> : <VideoOff className="size-4" aria-hidden />} {cam.label}
            </Dropdown.Item>
          ) : null}
          {canFlip && cam.on ? (
            <Dropdown.Item className={cx(menuItem, 'h-11')} data-testid="mobile-voice-flip" onSelect={() => voice.camera.flip()}>
              <SwitchCamera className="size-4" aria-hidden /> {t('video.flip')}
            </Dropdown.Item>
          ) : null}
          {!onSounds && (cameraItem || (canFlip && cam.on)) ? <Dropdown.Separator className={menuSeparator} /> : null}
          {onSounds ? (
            <>
              <Dropdown.Item
                className={cx(menuItem, 'h-11')}
                data-testid="mobile-voice-sounds"
                onSelect={() => {
                  soundsPicked.current = true;
                  requestAnimationFrame(() => {
                    soundsPicked.current = false;
                    onSounds();
                  });
                }}
              >
                <Music className="size-4" aria-hidden /> {t('snd.button')}
              </Dropdown.Item>
              <Dropdown.Separator className={menuSeparator} />
            </>
          ) : null}
          <Dropdown.Label className={menuLabel}>{t('voice.mode')}</Dropdown.Label>
          <Dropdown.RadioGroup value={micMode} onValueChange={selectMicMode}>
            <Dropdown.RadioItem value="voice" className={radio} data-testid="mobile-mic-mode-voice">
              <Dropdown.ItemIndicator className="absolute left-2.5">
                <Check className="size-4" />
              </Dropdown.ItemIndicator>
              {t('shell.micModeVoice')}
            </Dropdown.RadioItem>
            <Dropdown.RadioItem value="ptt" className={radio} data-testid="mobile-mic-mode-ptt">
              <Dropdown.ItemIndicator className="absolute left-2.5">
                <Check className="size-4" />
              </Dropdown.ItemIndicator>
              {t('voice.modePtt')}
            </Dropdown.RadioItem>
          </Dropdown.RadioGroup>
          <Dropdown.Separator className={menuSeparator} />
          <Dropdown.Item className={cx(menuItem, 'h-11')} onSelect={() => openDialog({ kind: 'settings', tab: 'voice' })}>
            <Settings className="size-4" aria-hidden /> {t('shell.voiceSettings')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/**
 * Push-to-talk on a touch screen: held = on air. Pointer capture keeps the press while the finger
 * slides off the button; release, cancel (the system takes the gesture), a lost capture, the page
 * going to the background or the button unmounting all end it — it can never stay stuck on.
 * Space / Enter hold it from a keyboard. A short vibration marks press and release where the
 * browser supports it.
 */
function PttHoldButton({ disabled }: { disabled: boolean }): ReactNode {
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const press = useCallback((down: boolean): void => {
    if (heldRef.current === down) return;
    heldRef.current = down;
    setHeld(down);
    voice.pttHold(down);
    haptic(down ? 12 : 6);
  }, []);
  useEffect(() => {
    const release = (): void => press(false);
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') release();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
      release();
    };
  }, [press]);
  useEffect(() => {
    if (disabled) press(false);
  }, [disabled, press]);

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); // no focus-scroll, no text selection, no emulated mouse events
    e.currentTarget.setPointerCapture(e.pointerId);
    press(true);
  };
  const onUp = (): void => press(false);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, down: boolean): void => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (down && e.repeat) return;
    if (!disabled || !down) press(down);
  };
  return (
    <button
      type="button"
      aria-label={t('mobile.ptt')}
      aria-pressed={held}
      aria-disabled={disabled || undefined}
      data-testid="ptt-hold"
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
      onKeyDown={(e) => onKey(e, true)}
      onKeyUp={(e) => onKey(e, false)}
      onContextMenu={(e) => e.preventDefault()}
      className={cx(
        'grid size-11 shrink-0 touch-none select-none place-items-center rounded-full transition-colors duration-[var(--motion-fast)]',
        held ? 'bg-ok-fill text-white' : 'bg-accent-strong text-accent-fg',
        disabled && 'opacity-40',
      )}
    >
      <Radio className="size-5" aria-hidden />
    </button>
  );
}
