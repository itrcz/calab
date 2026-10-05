import type { FileMeta } from '@calaba/protocol';
import { Download, Film, Maximize, Pause, PictureInPicture2, Play, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { CLOSE_HIT, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { filePath } from '../../lib/api/endpoints';
import { SEEK_STEP, formatTime, rateLabel, seekPosition, trackInfo } from '../../lib/chatMedia';
import { fmt } from '../../lib/format';
import { platform } from '../../platform';
import { probeDuration } from '../../services/player';
import { claimVideo, releaseVideo, usePlayer, type Track } from '../../stores/player';
import { prefs } from '../../stores/prefs';
import { toast } from '../../stores/toasts';
import { useChatView } from './chatView';

/**
 * Audio / video attachments in a bubble and the mini-player (docs/09 #41, docs/08 «Медиа в
 * чате», Telegram). Sound only through media elements (docs/02, echo rule 1: no WebAudio).
 */

/** Video box width in a bubble (images use 420; a 16:9 video at 360 is 202 px tall). */
export const VIDEO_WIDTH = 360;
const VIDEO_MAX_H = 460;
/** macOS full-screen (Space) animation of the window: an exit during it is dropped. */
const FULLSCREEN_SETTLE_MS = 1000;

export function download(f: FileMeta): void {
  void platform.files.download({ fileId: f.id, name: f.name }).then(
    () => toast.success(t('chat.downloaded', { name: f.name })),
    (e: unknown) => toast.fail(e, t('err.ctx.download')),
  );
}

/** Space toggles playback when the player itself (or its progress bar) has keyboard focus. */
export function isSpace(e: KeyboardEvent): boolean {
  return e.key === ' ' || e.key === 'Spacebar';
}

// ---------------------------------------------------------------- audio

export function AudioAttachment({
  f,
  messageId,
  roomId,
  label,
  subtitle,
  className,
}: {
  f: FileMeta;
  messageId: string;
  roomId: string;
  /** Shown (and in the mini-player) instead of the file name's title / performer (a meeting recording). */
  label?: string;
  subtitle?: string;
  /** Width classes instead of the bubble's 300 / 260 px (the recording window: the full width). */
  className?: string;
}): ReactNode {
  const active = usePlayer((s) => s.track?.fileId === f.id && s.track.messageId === messageId);
  const playing = usePlayer((s) => active && s.playing);
  const position = usePlayer((s) => (active ? s.position : 0));
  const known = usePlayer((s) => (active && s.duration > 0 ? s.duration : (s.durations[f.id] ?? 0)));
  const rate = usePlayer((s) => s.rate);
  const failed = usePlayer((s) => active && s.error);
  const { title, performer } = label ? { title: label, performer: subtitle ?? '' } : trackInfo(f.name);
  const track: Track = { fileId: f.id, messageId, roomId, name: f.name, ...(label ? { title: label, subtitle: subtitle ?? '' } : {}) };
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => probeDuration(f.id), [f.id]);
  useReportInView(root, active);

  const toggle = (): void => usePlayer.getState().toggle(track);
  const time = active ? `${formatTime(position)} / ${formatTime(known || Number.NaN)}` : known ? formatTime(known) : fmt.size(f.size);

  return (
    <div
      ref={root}
      role="group"
      tabIndex={0}
      aria-label={t('media.audio', { name: f.name })}
      data-testid="audio-player"
      data-playing={playing || undefined}
      className={cx('flex max-w-full items-center gap-3 rounded-[var(--radius-row)] py-1', className ?? 'w-[300px] mobile:w-[260px]')}
      onKeyDown={(e) => {
        if (isSpace(e) && (e.target === e.currentTarget || (e.target as Element).getAttribute('role') === 'slider')) {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t('media.pause') : t('media.play')}
        className="grid size-11 shrink-0 place-items-center rounded-full bg-[var(--bubble-chip-bg)] text-[color:var(--bubble-chip-fg)] transition-opacity duration-[var(--motion-fast)] hover:opacity-90"
      >
        {playing ? <Pause className="size-5 fill-current" aria-hidden /> : <Play className="ml-0.5 size-5 fill-current" aria-hidden />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1 truncate text-body font-medium leading-5" title={f.name}>
            {title}
          </div>
          <Tip label={t('chat.download')}>
            <button
              type="button"
              onClick={() => download(f)}
              aria-label={`${t('chat.download')} ${f.name}`}
              className="-my-1 grid size-7 shrink-0 place-items-center rounded-full text-[color:var(--bubble-meta)] hover:text-fg mobile:-my-2.5 mobile:size-11"
            >
              <Download className="size-4" aria-hidden />
            </button>
          </Tip>
        </div>
        <SeekBar
          label={t('media.seek')}
          position={position}
          duration={known}
          onSeek={(sec) => usePlayer.getState().seek(track, sec)}
        />
        <div className="flex items-center gap-1 text-caption leading-4 text-[color:var(--bubble-meta)]">
          <span className="min-w-0 flex-1 truncate tabular-nums">
            {failed ? <span className="text-danger-text">{t('media.error')}</span> : time}
            {!failed && performer ? ` · ${performer}` : ''}
          </span>
          {active ? (
            <button
              type="button"
              onClick={() => usePlayer.getState().cycleRate()}
              aria-label={t('media.speed', { rate: rateLabel(rate) })}
              className="-my-1 grid h-6 shrink-0 place-items-center mobile:-my-3.5 mobile:h-11 mobile:min-w-11"
            >
              <span
                className={cx(
                  'rounded-full px-1.5 py-px text-caption font-semibold tabular-nums',
                  rate === 1
                    ? 'bg-[color-mix(in_srgb,var(--bubble-accent)_14%,transparent)] text-[color:var(--bubble-accent)]'
                    : 'bg-[var(--bubble-chip-bg)] text-[color:var(--bubble-chip-fg)]',
                )}
              >
                {rateLabel(rate)}
              </span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Progress bar with seeking: pointer drag (applied on release) and ←/→ ±5 s, Home / End.
 * `render` draws something else than the 3 px line (the voice message waveform).
 */
export function SeekBar({
  label,
  position,
  duration,
  onSeek,
  render,
  className,
}: {
  label: string;
  position: number;
  duration: number;
  onSeek: (sec: number) => void;
  render?: (pct: number) => ReactNode;
  className?: string;
}): ReactNode {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? position;
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const at = (e: PointerEvent<HTMLDivElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    return seekPosition(e.clientX, r.left, r.width, duration);
  };
  return (
    <div
      role="slider"
      tabIndex={duration > 0 ? 0 : -1}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={t('media.position', { pos: formatTime(shown), total: formatTime(duration || Number.NaN) })}
      aria-disabled={duration > 0 ? undefined : true}
      className={cx('group/seek relative flex touch-none items-center', className ?? 'h-4 mobile:h-8', duration > 0 && 'cursor-pointer')}
      onPointerDown={(e) => {
        if (!(duration > 0) || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(at(e));
      }}
      onPointerMove={(e) => {
        if (drag !== null) setDrag(at(e));
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        onSeek(at(e));
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={(e) => {
        if (!(duration > 0)) return;
        const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? SEEK_STEP : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -SEEK_STEP : 0;
        if (step) onSeek(position + step);
        else if (e.key === 'Home') onSeek(0);
        else if (e.key === 'End') onSeek(duration - 0.1);
        else return;
        e.preventDefault();
      }}
    >
      {render ? (
        render(pct)
      ) : (
        <div className="relative h-[3px] w-full rounded-full bg-[color-mix(in_srgb,var(--bubble-accent)_22%,transparent)]">
          <div className="absolute inset-y-0 left-0 rounded-full bg-[color:var(--bubble-accent)]" style={{ width: `${pct}%` }} />
          {duration > 0 && (shown > 0 || drag !== null) ? (
            <div
              aria-hidden
              className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--bubble-accent)]"
              style={{ left: `${pct}%` }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- mini-player

/** The mini-player's height (44 px, 48 on a phone): it lies over the top of the feed. */
const MINI_PLAYER_H = 48;

/**
 * The active track's player in a message reports whether it is on screen (docs/09 #57): the
 * mini-player shows while it is not — above or below the viewport, or unmounted by the
 * virtualised feed. Observed against the feed's scroller minus the strip the mini-player covers,
 * so a row under the mini-player counts as hidden and showing it never changes the answer.
 */
export function useReportInView(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const who = {};
    const scroller = el.closest('[data-virtuoso-scroller]');
    const io = new IntersectionObserver(([e]) => usePlayer.getState().setInView(who, !!e?.isIntersecting), {
      root: scroller instanceof HTMLElement ? scroller : null,
      rootMargin: `-${MINI_PLAYER_H}px 0px 0px 0px`,
    });
    io.observe(el);
    return () => {
      io.disconnect();
      usePlayer.getState().setInView(who, false);
    };
  }, [ref, active]);
}

/** The mini-player is on (a track, its message off screen): the feed's top overlays move below it. */
export const useMiniPlayerShown = (): boolean => usePlayer((s) => !!s.track && !s.inView);

/**
 * The strip over the feed while a track plays and its message is off screen (Telegram): title,
 * play / pause, close; a click on the title jumps to the message when it is in this room. It lies
 * over the top of the feed (MessageList), outside the scroller, so it never resizes the feed —
 * a resize would scroll the message back into view and hide the strip again.
 */
export function MiniPlayer({ roomId }: { roomId: string }): ReactNode {
  const track = usePlayer((s) => s.track);
  const inView = usePlayer((s) => s.inView);
  const playing = usePlayer((s) => s.playing);
  const pct = usePlayer((s) => (s.duration > 0 ? Math.min(100, (s.position / s.duration) * 100) : 0));
  const jump = useChatView((s) => s.requestJump);
  if (!track || inView) return null;
  const { title, performer } = track.title ? { title: track.title, performer: track.subtitle ?? '' } : trackInfo(track.name);
  const here = track.roomId === roomId;
  const text = (
    <>
      <span className="truncate text-body font-semibold">{title}</span>
      <span className="truncate text-caption text-muted">{performer || t('media.nowPlaying')}</span>
    </>
  );
  return (
    <div
      data-testid="mini-player"
      role="region"
      aria-label={t('media.nowPlaying')}
      className="mat-toolbar absolute inset-x-0 top-0 z-[var(--z-sticky)] flex h-11 items-center gap-2 border-b border-line pl-2 pr-2 mobile:h-12"
    >
      <button
        type="button"
        onClick={() => (playing ? usePlayer.getState().pause() : usePlayer.getState().play())}
        aria-label={playing ? t('media.pause') : t('media.play')}
        className="grid size-8 shrink-0 place-items-center rounded-full text-accent-text hover:bg-hover mobile:size-11"
      >
        {playing ? <Pause className="size-4 fill-current" aria-hidden /> : <Play className="ml-0.5 size-4 fill-current" aria-hidden />}
      </button>
      {here ? (
        <button
          type="button"
          onClick={() => jump(roomId, track.messageId)}
          aria-label={`${t('media.jump')}: ${title}`}
          className="flex min-w-0 flex-1 flex-col items-start rounded-[var(--radius-row)] px-1 text-left leading-4 hover:bg-hover mobile:min-h-11 mobile:justify-center"
        >
          {text}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col px-1 leading-4">{text}</div>
      )}
      <Tip label={t('media.close')}>
        <button
          type="button"
          onClick={() => usePlayer.getState().close()}
          aria-label={t('media.close')}
          className={cx(CLOSE_HIT, 'grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg mobile:size-11')}
        >
          <X className="size-4" aria-hidden />
        </button>
      </Tip>
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-0.5">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- video

type FsVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/**
 * A video in a bubble: the first frame as the poster (`preload="metadata"`, Electron streams it
 * with Range requests; the web client would have to download the whole file, so it shows a
 * placeholder until played) and a play button; then it plays in place with the native
 * controls. Full screen and PiP buttons on top; Escape leaves full screen.
 */
export function VideoAttachment({ f }: { f: FileMeta }): ReactNode {
  const ref = useRef<FsVideo>(null);
  const [started, setStarted] = useState(false);
  const [src, setSrc] = useState<string | undefined>(() => (platform.directMedia ? `${platform.apiBase}${filePath(f.id)}#t=0.001` : undefined));
  const [meta, setMeta] = useState<{ w: number; h: number; d: number } | null>(null);
  const [failed, setFailed] = useState(false);

  // One at a time: this video pauses the track and other videos while it plays.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onPlay = (): void => claimVideo(v);
    const onPause = (): void => releaseVideo(v);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      releaseVideo(v);
    };
  }, []);

  // Escape leaves full screen. On macOS the Electron window animates into its own Space, and an
  // exit requested during that animation is lost (the page stays «full screen» for good), so an
  // early Escape waits the animation out.
  useEffect(() => {
    let enteredAt = 0;
    const onChange = (): void => {
      if (document.fullscreenElement && document.fullscreenElement === ref.current) enteredAt = performance.now();
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || !document.fullscreenElement || document.fullscreenElement !== ref.current) return;
      e.preventDefault();
      const wait = Math.max(0, enteredAt + FULLSCREEN_SETTLE_MS - performance.now());
      window.setTimeout(() => {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      }, wait);
    };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const ensureSrc = async (): Promise<FsVideo | null> => {
    const v = ref.current;
    if (!v) return null;
    if (!src) {
      const url = await platform.mediaUrl(filePath(f.id));
      setSrc(url);
      v.src = url;
    }
    const sink = prefs().outputDeviceId;
    if (sink && typeof v.setSinkId === 'function') await v.setSinkId(sink).catch(() => undefined);
    return v;
  };

  const start = async (): Promise<FsVideo | null> => {
    const v = ref.current;
    if (!v) return null;
    setStarted(true);
    // iOS: play() inside the tap, before the (web) URL is resolved.
    if (!v.getAttribute('src')) void v.play().catch(() => undefined);
    try {
      const el = await ensureSrc();
      await el?.play();
      return el;
    } catch {
      return v;
    }
  };

  const fullscreen = async (): Promise<void> => {
    const v = started ? ref.current : await start();
    if (!v) return;
    if (typeof v.requestFullscreen === 'function') await v.requestFullscreen().catch(() => undefined);
    else v.webkitEnterFullscreen?.();
  };

  const pip = async (): Promise<void> => {
    const v = started ? ref.current : await start();
    if (!v) return;
    try {
      if (document.pictureInPictureElement === v) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* not supported / metadata not loaded yet */
    }
  };

  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled;
  const aspect = meta ? `${meta.w} / ${meta.h}` : '16 / 9';
  const overlayBtn =
    'grid size-8 place-items-center rounded-full bg-[rgb(0_0_0/50%)] text-[color:var(--color-on-accent)] hover:bg-[rgb(0_0_0/65%)] mobile:size-11';

  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={t('media.video', { name: f.name })}
      data-testid="video-player"
      className="group/video relative bg-black focus-visible:outline-offset-[-2px]"
      style={{ width: '100%', aspectRatio: aspect, maxHeight: VIDEO_MAX_H }}
      onKeyDown={(e) => {
        if (!isSpace(e) || e.target !== e.currentTarget) return;
        e.preventDefault();
        const v = ref.current;
        if (v && started && !v.paused) v.pause();
        else void (started && v ? v.play().catch(() => undefined) : start());
      }}
    >
      <video
        ref={ref}
        src={src}
        preload="metadata"
        playsInline
        controls={started}
        controlsList="nodownload noremoteplayback"
        disableRemotePlayback
        className="block size-full object-contain"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setMeta({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
        }}
        onError={() => {
          if (src) setFailed(true);
        }}
      />
      {!started ? (
        <button
          type="button"
          onClick={() => void start()}
          aria-label={`${t('media.play')} ${f.name}`}
          className="absolute inset-0 grid place-items-center"
        >
          {!src ? <Film className="absolute size-10 text-[rgb(255_255_255/25%)]" aria-hidden /> : null}
          <span className="grid size-14 place-items-center rounded-full bg-[rgb(0_0_0/50%)] text-[color:var(--color-on-accent)]">
            <Play className="ml-1 size-7 fill-current" aria-hidden />
          </span>
          <span className="absolute bottom-1.5 left-1.5 rounded-full bg-[rgb(0_0_0/50%)] px-2 py-0.5 text-caption tabular-nums text-[color:var(--color-on-accent)]">
            {failed ? t('media.error') : meta && Number.isFinite(meta.d) ? formatTime(meta.d) : fmt.size(f.size)}
          </span>
        </button>
      ) : null}
      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-[var(--motion-fast)] focus-within:opacity-100 group-hover/video:opacity-100 mobile:opacity-100">
        <Tip label={t('chat.download')}>
          <button type="button" onClick={() => download(f)} aria-label={`${t('chat.download')} ${f.name}`} className={overlayBtn}>
            <Download className="size-4" aria-hidden />
          </button>
        </Tip>
        {pipSupported ? (
          <Tip label={t('media.pip')}>
            <button type="button" onClick={() => void pip()} aria-label={t('media.pip')} className={overlayBtn}>
              <PictureInPicture2 className="size-4" aria-hidden />
            </button>
          </Tip>
        ) : null}
        <Tip label={t('media.fullscreen')}>
          <button type="button" onClick={() => void fullscreen()} aria-label={t('media.fullscreen')} className={overlayBtn}>
            <Maximize className="size-4" aria-hidden />
          </button>
        </Tip>
      </div>
    </div>
  );
}
