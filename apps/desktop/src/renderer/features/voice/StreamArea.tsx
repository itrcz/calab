import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Maximize2, MessageCircle, Minimize, Minimize2, MonitorPlay, Fullscreen, SquareArrowOutUpRight, Video, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../../components/Avatar';
import { Badge, CloseButton, CountBadge, IconButton, Slider, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { platform } from '../../platform';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { voice } from '../../services/voice';
import { useMessages } from '../../stores/messages';
import { showsUnread, useRooms } from '../../stores/rooms';
import { useVoice, type RemoteStream, type StreamQuality } from '../../stores/voice';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem } from '../shell/menu';
import { AnnotLayer, AnnotTools } from './Annotations';
import { CameraGrid, CameraPip, CameraStripTile, useAnyCamera, useStripCameras } from './CameraTiles';
import { FullscreenState, domHost, isExitKey, mainFullscreen, useIdle, useStreamFullscreen, windowHost } from './fullscreen';
import { PIP_SHADOW, WELCOME_ROW, layerLabel, pipSize, presetText, qualityOptions } from './streamFormat';
import { isTouchPrimary } from '../../lib/phone';
import { bindPopoutVideo } from './popoutVideo';
import { ZoomSurface } from './ZoomSurface';

/**
 * <video> bound to a stream track: a remote one (its on-screen size drives adaptive stream, the
 * layer choice) or my own local one (docs/09 #18a: no subscription, the captured track itself).
 * Until the first frame arrives it shows the streamer's avatar on the video background instead
 * of a black box (review 2: black strip previews next to a grey stage).
 */
function StreamVideo({
  stream,
  wsId,
  avatarSize,
  className,
  annotate,
  zoom,
}: {
  stream: RemoteStream;
  wsId: string | null;
  avatarSize: number;
  className?: string;
  /** Viewer-side zoom and pan (issue #33): stage and full screen, not the PiP / strip tiles. */
  zoom?: boolean;
  /** Annotations over the video (ADR-0028): shown only, or shown and drawn on. */
  annotate?: 'view' | 'edit';
}): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const epoch = useVoice((s) => s.trackEpoch);
  const [hasFrame, setHasFrame] = useState(false);
  const trackSid = stream.trackSid;
  useEffect(() => {
    const el = ref.current;
    const track = voice.streamVideo(trackSid);
    if (!el || !track) return;
    const onFrame = (): void => setHasFrame(el.videoWidth > 0);
    el.addEventListener('loadeddata', onFrame);
    el.addEventListener('resize', onFrame);
    track.attach(el);
    onFrame();
    return () => {
      el.removeEventListener('loadeddata', onFrame);
      el.removeEventListener('resize', onFrame);
      track.detach(el);
    };
  }, [trackSid, epoch]);
  const body = (
    <>
      <video ref={ref} muted playsInline autoPlay className={cx('bg-[var(--color-video-bg)] object-contain', className)} />
      {hasFrame ? null : <StreamPlaceholder stream={stream} wsId={wsId} size={avatarSize} />}
      {annotate ? <AnnotLayer stream={stream} video={ref} interactive={annotate === 'edit'} /> : null}
    </>
  );
  return zoom ? (
    <ZoomSurface video={ref} resetKey={trackSid}>
      {body}
    </ZoomSurface>
  ) : (
    body
  );
}

function StreamPlaceholder({ stream, wsId, size }: { stream: RemoteStream; wsId: string | null; size: number }): ReactNode {
  const name = useMemberName(wsId, stream.userId);
  const avatar = useWorkspaces((s) => s.users[stream.userId]?.avatarFileId);
  return (
    <span className="pointer-events-none absolute inset-0 grid place-items-center bg-[var(--color-video-bg)]" aria-hidden data-testid="stream-placeholder">
      <Avatar userId={stream.userId} name={name} fileId={avatar || undefined} size={size} />
    </span>
  );
}

/**
 * Pop-out window: same-origin child window, React portal; video shows the same MediaStreamTrack.
 * It has the full-screen layout's overlay and its own «На весь экран» (docs/09 #18): the child
 * window's preload bridge puts *that* window in full screen (main answers the sender's window).
 */
function Popout({ stream, wsId, title, onClose }: { stream: RemoteStream; wsId: string | null; title: string; onClose: () => void }): ReactNode {
  const trackSid = stream.trackSid;
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [child, setChild] = useState<Window | null>(null);
  const epoch = useVoice((s) => s.trackEpoch);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const w = window.open('about:blank', `calaba-popout-${trackSid}`, 'popup,width=960,height=580');
    if (!w) {
      onClose();
      return;
    }
    w.document.title = title;
    for (const node of Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'))) {
      w.document.head.appendChild(node.cloneNode(true));
    }
    w.document.documentElement.dataset['theme'] = document.documentElement.dataset['theme'] ?? 'dark';
    w.document.body.style.margin = '0';
    w.document.body.style.background = '#000';
    const root = w.document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0';
    w.document.body.appendChild(root);
    // The portal target lives in a window created here, so state must be set from the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContainer(root);
    setChild(w);
    w.addEventListener('pagehide', onClose);
    return () => {
      w.removeEventListener('pagehide', onClose);
      if (!w.closed) w.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackSid]);

  // Only the detached window renders this track; it also owns adaptive-stream visibility.
  useEffect(() => {
    const el = videoRef.current;
    const track = voice.streamVideo(trackSid);
    if (!el || !track || !child) return;
    return bindPopoutVideo(track, el, child);
  }, [container, child, trackSid, epoch]);

  if (!container || !child) return null;
  return createPortal(
    <PopoutView stream={stream} wsId={wsId} win={child}>
      <ZoomSurface video={videoRef} resetKey={trackSid}>
        <video ref={videoRef} muted playsInline autoPlay className="size-full bg-[var(--color-video-bg)] object-contain" />
        <AnnotLayer stream={stream} video={videoRef} win={child} interactive />
      </ZoomSurface>
    </PopoutView>,
    container,
  );
}

/** Call-scoped host: changing rooms, calendar or workspace must not close the stream window. */
export function StreamPopout(): ReactNode {
  const current = useVoice((s) => s.stage === 'popout' ? s.streams.find((stream) => stream.trackSid === s.watching) : undefined);
  const wsId = useVoice((s) => s.workspaceId);
  const name = useMemberName(wsId, current?.userId ?? '');
  const onClose = useCallback(() => voice.setStage('expanded'), []);
  return current ? <Popout key={current.trackSid} stream={current} wsId={wsId} title={`${name} — Calab`} onClose={onClose} /> : null;
}

/** The pop-out's full-screen state, on the pop-out window's own bridge (or its Fullscreen API). */
function PopoutView({ stream, wsId, win, children }: { stream: RemoteStream; wsId: string | null; win: Window; children: ReactNode }): ReactNode {
  const [on, setOn] = useState(false);
  const [fs] = useState(() => {
    // The pop-out's own preload bridge (the child window gets it too); the DOM API otherwise.
    const bridge = (win as Partial<Pick<Window, 'calaba'>>).calaba?.window;
    return new FullscreenState(bridge ? windowHost(bridge) : domHost(win.document), setOn);
  });
  useEffect(() => () => fs.dispose(), [fs]);
  const onToggle = useCallback(() => fs.toggle(), [fs]);
  const containerRef = useCallback((el: HTMLDivElement | null) => fs.attach(el), [fs]);
  return (
    <FullscreenView stream={stream} wsId={wsId} win={win} fullscreen={on} onToggle={onToggle} containerRef={containerRef}>
      {children}
    </FullscreenView>
  );
}

/**
 * Video-only layout with a thin overlay (docs/09 #18b): streamer, quality / fps, sound and
 * «Свернуть» on one bar at the top; the bar and the cursor hide after 2 s without movement. Esc
 * and ⌃⌘F leave full screen. Used by the main window's full screen and by the pop-out.
 */
function FullscreenView({
  stream,
  wsId,
  win,
  fullscreen,
  onToggle,
  containerRef,
  children,
}: {
  stream: RemoteStream;
  wsId: string | null;
  /** The window the view lives in (keys are listened to there: the pop-out is another window). */
  win: Window;
  fullscreen: boolean;
  onToggle: () => void;
  containerRef: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}): ReactNode {
  const { idle, poke } = useIdle(FULLSCREEN_IDLE_MS);
  const name = useMemberName(wsId, stream.userId);
  const quality = useStreamQualityText(stream);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      poke();
      if (fullscreen && isExitKey(e)) {
        e.preventDefault();
        onToggle();
      }
    };
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  }, [win, fullscreen, poke, onToggle]);
  const hidden = idle;
  return (
    <div
      ref={containerRef}
      data-testid="stream-fullscreen"
      data-fullscreen={fullscreen ? 'true' : 'false'}
      role="region"
      aria-label={t('streamView.of', { name })}
      onPointerMove={poke}
      onPointerDown={poke}
      // no-drag: over the title bar's drag region, clicks must reach the overlay (docs/09 #1).
      className={cx('no-drag fixed inset-0 z-[var(--z-modal)] overflow-hidden bg-[var(--color-video-bg)]', hidden && 'cursor-none')}
    >
      {children}
      <AnnotTools stream={stream} win={win} visible={!hidden} />
      <div
        data-testid="stream-fullscreen-bar"
        className={cx(
          'absolute inset-x-0 top-0 flex h-11 items-center gap-2 bg-black/60 px-3 text-white transition-opacity duration-[var(--motion-fast)] focus-within:opacity-100',
          hidden ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
      >
        <span className="flex min-w-0 shrink">
          <StreamerChip stream={stream} wsId={wsId} />
        </span>
        {quality ? <span className="shrink-0 text-[12px] font-medium text-white/80">{quality}</span> : null}
        <span className="flex-1" />
        {stream.local ? null : <VolumeControl stream={stream} />}
        <button
          type="button"
          onClick={onToggle}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-2.5 text-[12px] font-medium text-white transition-colors duration-[var(--motion-fast)] hover:bg-white/25"
          title={fullscreen ? t('streamView.leaveFullscreenHint') : undefined}
        >
          {fullscreen ? <Minimize className="size-3.5" aria-hidden /> : <Fullscreen className="size-3.5" aria-hidden />}
          {fullscreen ? t('streamView.leaveFullscreen') : t('stream.fullscreen')}
        </button>
      </div>
    </div>
  );
}

const FULLSCREEN_IDLE_MS = 2000;

/** «1080p · 30 fps»: what is received (remote, from getStats) or what I send (my stream's preset). */
function useStreamQualityText(stream: RemoteStream): string | null {
  const watching = useVoice((s) => (stream.local ? null : s.stats?.watching));
  const preset = useVoice((s) => (stream.local ? s.myStream?.preset : undefined));
  if (stream.local) return preset === undefined ? null : presetText(preset);
  if (!watching?.height) return null;
  return watching.fps ? `${layerLabel(watching.height)} · ${Math.round(watching.fps)} fps` : layerLabel(watching.height);
}

/** The main window's full-screen stage: the window goes full screen (desktop) or the container (web). */
function FullscreenStage({ stream, wsId }: { stream: RemoteStream; wsId: string | null }): ReactNode {
  const fs = mainFs();
  const onToggle = useCallback(() => fs.exit(), [fs]);
  const containerRef = useCallback((el: HTMLDivElement | null) => fs.attach(el), [fs]);
  return createPortal(
    <FullscreenView stream={stream} wsId={wsId} win={window} fullscreen onToggle={onToggle} containerRef={containerRef}>
      <StreamVideo stream={stream} wsId={wsId} avatarSize={96} className="size-full" annotate="edit" zoom />
    </FullscreenView>,
    document.body,
  );
}

function mainFs(): FullscreenState {
  return mainFullscreen(() => (platform.kind === 'web' ? domHost(document) : windowHost(platform.window)));
}

export interface Box {
  /** Offset of the message area's top inside the chat column (below header / pinned bar). */
  top: number;
  /** Height between that top and the composer. */
  height: number;
}

/**
 * Where the message area is: StreamArea renders a zero-height anchor right before the message
 * list, so its offsetTop is the list's top whatever sits above it (pinned bar, search panel).
 */
function useMessageBox(anchor: RefObject<HTMLDivElement | null>): Box {
  const [box, setBox] = useState<Box>({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const el = anchor.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const measure = (): void => {
      const composer = parseFloat(getComputedStyle(el).getPropertyValue('--composer-height')) || 64;
      const next = { top: el.offsetTop, height: Math.max(0, parent.clientHeight - el.offsetTop - composer) };
      setBox((b) => (b.top === next.top && b.height === next.height ? b : next));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) ro.observe(s);
    const composer = parent.querySelector('[data-testid="composer"]');
    if (composer) ro.observe(composer);
    return () => ro.disconnect();
  });
  return box;
}

const PIP_GAP = 16;

/** The same pill LIVE badge as in the room list (one style for every badge). */
function LiveBadge(): ReactNode {
  return <Badge tone="danger">{t('shell.live')}</Badge>;
}

/** Streamer chip over the video: avatar (speaking ring), name, LIVE. */
function StreamerChip({ stream, wsId, size = 'md' }: { stream: RemoteStream; wsId: string | null; size?: 'sm' | 'md' }): ReactNode {
  const name = useMemberName(wsId, stream.userId);
  const avatar = useWorkspaces((s) => s.users[stream.userId]?.avatarFileId);
  const speaking = useVoice((s) => s.speaking[stream.userId] ?? false);
  return (
    <span
      className={cx(
        'pointer-events-none flex min-w-0 items-center gap-1.5 rounded-full bg-black/60 py-0.5 pl-0.5 pr-1.5 text-white',
        size === 'sm' ? 'text-[11px]' : 'text-[12px]',
      )}
    >
      <Avatar userId={stream.userId} name={name} fileId={avatar || undefined} size={size === 'sm' ? 16 : 20} speaking={speaking} />
      <span className="min-w-0 truncate font-semibold" title={name}>
        {name}
      </span>
      {stream.local ? (
        <span data-testid="stream-self-badge" className="flex">
          <Badge tone="danger">{t('streamView.self')}</Badge>
        </span>
      ) : (
        <LiveBadge />
      )}
    </span>
  );
}

const overlayBtn = 'text-white hover:bg-white/15 hover:text-white';

// ---------------------------------------------------------------- PiP

function Pip({ stream, others, wsId, box }: { stream: RemoteStream; others: number; wsId: string | null; box: Box }): ReactNode {
  const wide = useMediaQuery('(min-width: 1200px)');
  const { w, h } = pipSize(wide, box.height, PIP_GAP);
  const name = useMemberName(wsId, stream.userId);
  return (
    <div
      data-testid="stream-pip"
      className="mat-popover group absolute right-4 z-[var(--z-pip)] overflow-hidden rounded-[var(--radius-panel)]"
      // Top-right of the message area (docs/08 layout): clear of the composer, the latest
      // messages and the bottom-aligned empty state. The black video background is inline: the
      // (unlayered) .mat-popover material would override a bg utility → light letterbox bars.
      // A visible edge + deeper shadow so the tile doesn't float unanchored over an empty feed (#56).
      style={{
        top: box.top + PIP_GAP,
        width: w,
        height: h,
        background: 'var(--color-video-bg)',
        boxShadow: PIP_SHADOW,
      }}
      aria-label={t('streamView.of', { name })}
      role="region"
    >
      <StreamVideo stream={stream} wsId={wsId} avatarSize={w < 240 ? 32 : 48} className="size-full" annotate="view" />
      <button type="button" className="absolute inset-0 rounded-[var(--radius-panel)]" onClick={() => voice.setStage('expanded')} aria-label={t('stream.expand')} />
      <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-16px)]">
        <StreamerChip stream={stream} wsId={wsId} size={w < 240 ? 'sm' : 'md'} />
      </span>
      {others > 0 ? (
        <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/60 px-2 text-[11px] font-medium leading-5 text-white">{t('streamView.more', { n: others })}</span>
      ) : null}
      <span className="absolute right-1.5 top-1.5 flex gap-0.5 rounded-[var(--radius-card)] bg-black/60 p-0.5 opacity-0 transition-opacity duration-[var(--motion-fast)] group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <IconButton size="sm" label={t('stream.expand')} className={overlayBtn} onClick={() => voice.setStage('expanded')}>
          <Maximize2 className="size-4" aria-hidden />
        </IconButton>
        <CloseButton label={t('stream.close')} shortcut="" className={overlayBtn} onClick={() => voice.watch(null)} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- expanded stage

function QualityMenu({ stream, onOpenChange }: { stream: RemoteStream; onOpenChange: (open: boolean) => void }): ReactNode {
  const current = useVoice((s) => s.streamQuality[stream.trackSid] ?? 'auto');
  const [options, setOptions] = useState(() => qualityOptions(voice.streamLayers(stream.trackSid)));
  const label = options.find((o) => o.value === current)?.label ?? t('streamView.qualityAuto');
  return (
    <Dropdown.Root
      modal={false}
      onOpenChange={(open) => {
        // Layers come from the SFU's track info, which may arrive after the first render.
        if (open) setOptions(qualityOptions(voice.streamLayers(stream.trackSid)));
        onOpenChange(open);
      }}
    >
      <Dropdown.Trigger asChild>
        <button
          type="button"
          aria-label={t('streamView.quality', { q: label })}
          className="flex h-7 items-center gap-1 rounded-[var(--radius-control)] px-2 text-[12px] font-medium text-white transition-colors duration-[var(--motion-fast)] hover:bg-white/15 data-[state=open]:bg-white/15"
        >
          {label}
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'min-w-36')} side="top" align="start" sideOffset={8}>
          <Dropdown.RadioGroup value={current} onValueChange={(v) => voice.setStreamQuality(stream.trackSid, v as StreamQuality)}>
            {options.map((o) => (
              <Dropdown.RadioItem key={o.value} value={o.value} className={menuItem}>
                <span className="grid size-4 place-items-center">
                  <Dropdown.ItemIndicator>
                    <Check className="size-4" aria-hidden />
                  </Dropdown.ItemIndicator>
                </span>
                {o.label}
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** My stream's control bar: the preset I send («1080p · 15 fps»), as plain text. */
function OwnQuality(): ReactNode {
  const preset = useVoice((s) => s.myStream?.preset);
  if (preset === undefined) return null;
  return <span className="flex h-7 items-center px-2 text-[12px] font-medium text-white">{presetText(preset)}</span>;
}

/** Stream audio volume: the stream's own <audio> element (docs/02 echo rule 1 — no WebAudio). */
function VolumeControl({ stream }: { stream: RemoteStream }): ReactNode {
  const volume = useVoice((s) => s.streamVolume[stream.userId] ?? 1);
  const [before, setBefore] = useState(1);
  if (!stream.hasAudio) {
    return (
      <IconButton size="sm" label={t('streamView.noAudio')} className={cx(overlayBtn, 'opacity-60')} aria-disabled onClick={() => undefined}>
        <VolumeX className="size-4" aria-hidden />
      </IconButton>
    );
  }
  const muted = volume === 0;
  return (
    // The slider slides out on hover / keyboard focus of the volume group (YouTube, Discord).
    <span className="group/vol flex items-center">
      <IconButton
        size="sm"
        label={muted ? t('streamView.unmute') : t('streamView.mute')}
        className={overlayBtn}
        onClick={() => {
          if (!muted) setBefore(volume);
          voice.setStreamVolume(stream.userId, muted ? before || 1 : 0);
        }}
      >
        {muted ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
      </IconButton>
      <span className="w-0 overflow-hidden opacity-0 transition-opacity duration-[var(--motion-fast)] group-focus-within/vol:ml-1 group-focus-within/vol:w-20 group-focus-within/vol:opacity-100 group-hover/vol:ml-1 group-hover/vol:w-20 group-hover/vol:opacity-100">
        <Slider label={t('streamView.volume')} value={Math.round(volume * 100)} min={0} max={100} onChange={(v) => voice.setStreamVolume(stream.userId, v / 100)} />
      </span>
    </span>
  );
}

function PreviewTile({ stream, wsId, current, detached }: { stream: RemoteStream; wsId: string | null; current: boolean; detached: boolean }): ReactNode {
  const name = useMemberName(wsId, stream.userId);
  return (
    <button
      type="button"
      aria-pressed={current}
      aria-label={t('streamView.of', { name })}
      title={current ? t('streamView.watching') : name}
      onClick={() => voice.watch(stream.trackSid)}
      className={cx(
        'relative h-[90px] w-[160px] shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-video-bg)] transition-shadow duration-[var(--motion-fast)]',
        current ? 'ring-2 ring-accent' : 'ring-1 ring-[var(--color-border-popover)] hover:ring-2 hover:ring-[var(--color-fill-hover)]',
      )}
    >
      {detached ? <StreamPlaceholder stream={stream} wsId={wsId} size={32} /> : <StreamVideo stream={stream} wsId={wsId} avatarSize={32} className="size-full" />}
      <span className="absolute bottom-1 left-1 flex max-w-[calc(100%-8px)]">
        <StreamerChip stream={stream} wsId={wsId} size="sm" />
      </span>
    </button>
  );
}



/**
 * The room's chat unread while the stage hides the feed (issue #35): the mention counter as in
 * the room rows (it survives a muted room), else the unread counter, else — when the count is
 * unknown (no read state yet) — a plain dot; a quiet room shows only mentions (docs/09 #22).
 */
function ChatUnreadBadge(): ReactNode {
  const roomId = useVoice((s) => s.roomId);
  const mentions = useRooms((s) => (roomId ? (s.mentions[roomId] ?? 0) : 0));
  const unread = useRooms((s) => (roomId ? (s.unread[roomId] ?? 0) : 0));
  const dot = useRooms((s) => (roomId ? showsUnread(roomId, s) : false));
  if (mentions > 0) {
    return (
      <CountBadge count={mentions} aria-label={plural('shell.unreadMentions', mentions)} data-testid="stream-chat-unread" />
    );
  }
  if (unread > 0 && dot) {
    return (
      <CountBadge count={unread} tone="accent" aria-label={plural('stream.chatUnread', unread)} data-testid="stream-chat-unread" />
    );
  }
  return dot ? <span aria-label={t('ws.unread')} data-testid="stream-chat-unread" className="size-1.5 shrink-0 rounded-full bg-white" /> : null;
}

function Stage({ stream, streams, wsId, box, emptyFeed }: { stream: RemoteStream; streams: RemoteStream[]; wsId: string | null; box: Box; emptyFeed: boolean }): ReactNode {
  const stage = useVoice((s) => s.stage);
  const [menuOpen, setMenuOpen] = useState(false);
  const name = useMemberName(wsId, stream.userId);
  const cameras = useStripCameras(wsId);
  return (
    <div
      data-testid="stream-stage"
      role="region"
      aria-label={t('streamView.of', { name })}
      className="absolute inset-x-0 z-[var(--z-sticky)] flex flex-col gap-2 bg-feed px-3 pb-3 pt-3"
      // Over the message area only: header and composer stay usable.
      // An empty room keeps its one-row welcome visible under the stage (docs/09 #56).
      style={{ top: box.top, bottom: emptyFeed ? `calc(var(--composer-height) + ${WELCOME_ROW}px)` : 'var(--composer-height)' }}
    >
      <div
        className="mat-popover group relative min-h-0 flex-1 overflow-hidden rounded-[var(--radius-panel)]"
        // Inline, as in the PiP: the unlayered .mat-popover material overrides a bg utility.
        style={{ background: 'var(--color-video-bg)' }}
      >
        {stage !== 'popout' ? <StreamVideo stream={stream} wsId={wsId} avatarSize={80} className="size-full" annotate="edit" zoom /> : null}
        {stage !== 'popout' ? <AnnotTools stream={stream} /> : null}
        <span className="absolute left-3 top-3 flex max-w-[calc(100%-120px)]">
          <StreamerChip stream={stream} wsId={wsId} />
        </span>
        {/* Focus mode hides the chat: an always-visible way back (the stream goes to the PiP). */}
        <button
          type="button"
          onClick={() => voice.setStage('pip')}
          className="absolute right-3 top-3 flex h-7 items-center gap-1.5 rounded-full bg-black/60 px-2.5 text-[12px] font-medium text-white transition-colors duration-[var(--motion-fast)] hover:bg-black/75"
          title={t('stream.showChatHint')}
        >
          <MessageCircle className="size-3.5" aria-hidden />
          {t('stream.showChat')}
          <ChatUnreadBadge />
        </button>
        {stage === 'popout' ? (
          <div className="absolute inset-0 grid place-items-center bg-black/80 text-white">
            <div className="text-center">
              <div className="font-semibold">{t('stream.inPopout')}</div>
              <button type="button" className="mt-2 rounded-[var(--radius-control)] px-2 py-1 text-white underline hover:bg-white/15" onClick={() => voice.setStage('expanded')}>
                {t('stream.returnHere')}
              </button>
            </div>
          </div>
        ) : null}
        {/* Control bar: shows on hover / keyboard focus (and while its menu is open); always on touch, where there is no hover. */}
        <div
          data-testid="stream-controls"
          className={cx(
            'absolute bottom-3 left-1/2 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1 rounded-[var(--radius-card)] bg-black/70 p-1 ring-1 ring-white/10 transition-opacity duration-[var(--motion-fast)] group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
            menuOpen ? 'opacity-100' : 'opacity-0',
          )}
        >
          {/* My own stream: what I send (the preset), nothing to choose or to hear (docs/09 #18a). */}
          {stream.local ? (
            <OwnQuality />
          ) : (
            <>
              <QualityMenu stream={stream} onOpenChange={setMenuOpen} />
              <span className="mx-0.5 h-4 w-px bg-white/25" aria-hidden />
              <VolumeControl stream={stream} />
            </>
          )}
          <span className="mx-0.5 h-4 w-px bg-white/25" aria-hidden />
          <IconButton size="sm" label={t('stream.collapse')} className={overlayBtn} onClick={() => voice.setStage('pip')}>
            <Minimize2 className="size-4" aria-hidden />
          </IconButton>
          {/* A phone browser has no second window (window.open leaves the page). */}
          {isTouchPrimary() ? null : (
            <IconButton size="sm" label={t('stream.popout')} className={overlayBtn} onClick={() => voice.setStage(stage === 'popout' ? 'expanded' : 'popout')}>
              <SquareArrowOutUpRight className="size-4" aria-hidden />
            </IconButton>
          )}
          <IconButton size="sm" label={t('stream.fullscreen')} className={overlayBtn} onClick={() => mainFs().request()}>
            <Fullscreen className="size-4" aria-hidden />
          </IconButton>
          <CloseButton label={t('stream.close')} shortcut="" className={overlayBtn} onClick={() => voice.watch(null)} />
        </div>
      </div>
      {/* The stream is the main picture; other streams and the cameras line up underneath (docs/09 #42). */}
      {streams.length > 1 || cameras.length > 0 ? (
        <div className="flex shrink-0 justify-center-safe gap-2 overflow-x-auto p-0.5" role="group" aria-label={t('streamView.others')} data-testid="stream-strip">
          {streams.length > 1 ? streams.map((s) => <PreviewTile key={s.trackSid} stream={s} wsId={wsId} current={s.trackSid === stream.trackSid} detached={stage === 'popout' && s.trackSid === stream.trackSid} />) : null}
          {cameras.map((id) => (
            <CameraStripTile key={`cam:${id}`} userId={id} wsId={wsId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Live streams as chips (click = watch). */
function LiveChips({ streams, wsId }: { streams: RemoteStream[]; wsId: string | null }): ReactNode {
  if (!streams.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12px]">
      <MonitorPlay className="size-4 text-danger" aria-hidden />
      <span className="text-muted">{t('stream.live')}:</span>
      {streams.map((s) => (
        <LiveChip key={s.trackSid} stream={s} wsId={wsId} />
      ))}
    </span>
  );
}

/** Nothing on the stage: a slim bar with who is live and, with the camera PiP closed, «Камеры». */
function LiveBar({ streams, wsId, cameras }: { streams: RemoteStream[]; wsId: string | null; cameras: boolean }): ReactNode {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-1.5 text-[12px]" data-testid="stream-live-bar">
      <LiveChips streams={streams} wsId={wsId} />
      {cameras ? (
        <button type="button" onClick={() => voice.showVideo()} className="flex items-center gap-1.5 rounded-full bg-active px-2 py-0.5 text-fg hover:bg-hover">
          <Video className="size-3.5" aria-hidden />
          {t('video.grid')}
        </button>
      ) : null}
    </div>
  );
}

function LiveChip({ stream, wsId }: { stream: RemoteStream; wsId: string | null }): ReactNode {
  const name = useMemberName(wsId, stream.userId);
  return (
    <button type="button" onClick={() => voice.watch(stream.trackSid)} className="max-w-48 truncate rounded-full bg-active px-2 py-0.5 text-fg hover:bg-hover" title={name}>
      {name}
    </button>
  );
}

export function StreamArea(): ReactNode {
  const streams = useVoice((s) => s.streams);
  const watching = useVoice((s) => s.watching);
  const stage = useVoice((s) => s.stage);
  const wsId = useVoice((s) => s.workspaceId);
  const anchor = useRef<HTMLDivElement>(null);
  const box = useMessageBox(anchor);
  const current = streams.find((s) => s.trackSid === watching);
  const roomId = useVoice((s) => s.roomId);
  const emptyFeed = useMessages((s) => {
    const r = roomId ? s.rooms[roomId] : undefined;
    return !!r && r.loaded && r.items.length === 0 && !r.hasMoreBefore && !r.hasMoreAfter;
  });
  const anyCamera = useAnyCamera();
  const videoPip = useVoice((s) => s.videoPip);
  const fullscreen = useStreamFullscreen((s) => s.on);
  // The stream on full screen ended (or I stopped watching / left): leave full screen.
  useEffect(() => {
    if (fullscreen && !current) mainFs().exit();
  }, [fullscreen, current]);

  let view: ReactNode = null;
  if (current)
    view = stage === 'pip' ? <Pip stream={current} others={streams.length - 1} wsId={wsId} box={box} /> : <Stage stream={current} streams={streams} wsId={wsId} box={box} emptyFeed={emptyFeed} />;
  else if (anyCamera && stage !== 'pip') view = <CameraGrid box={box} wsId={wsId} emptyFeed={emptyFeed} top={<LiveChips streams={streams} wsId={wsId} />} />;
  else if (streams.length || anyCamera)
    view = (
      <>
        {streams.length || !videoPip ? <LiveBar streams={streams} wsId={wsId} cameras={anyCamera && !videoPip} /> : null}
        {anyCamera && videoPip ? <CameraPip box={box} wsId={wsId} /> : null}
      </>
    );

  return (
    <>
      <div ref={anchor} aria-hidden className="h-0 shrink-0" />
      {view}
      {current && fullscreen ? <FullscreenStage stream={current} wsId={wsId} /> : null}
    </>
  );
}
