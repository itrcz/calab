import * as Popover from '@radix-ui/react-popover';
import { LayoutGrid, Maximize2, MessageCircle, MicOff, Pin, Video, VideoOff } from 'lucide-react';
import { forwardRef, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Badge, CloseButton, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { setVoice, useVoice } from '../../stores/voice';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { MemberBadge } from '../people/MemberBadge';
import { MemberContextMenu } from '../people/MemberContextMenu';
import { joinedAtMs } from '../../lib/justJoined';
import { cameraMirrored } from '../../lib/media/cameraLogic';
import { JustJoinedDot } from './JustJoinedDot';
import { popoverBox } from '../shell/menu';
import type { Box } from './StreamArea';
import { PIP_SHADOW, WELCOME_ROW, pipSize } from './streamFormat';
import { layoutTiles, type TilePerson } from './tileLayout';
import { useTileSelection } from './useTileSelection';

/*
 * Webcam tiles of my voice room (docs/09 #42): the grid over the chat area, the camera PiP while
 * the chat is open, and 160×90 tiles in the stream stage's strip. Each <video> is attached with
 * LiveKit's attach(), so adaptive stream sizes the subscription to the tile and pauses it when
 * the tile is gone; the engine decides what is subscribed at all (services/voice.ts
 * applyCameras). Video elements are always muted: a camera has no audio.
 */

const useMe = (): string => useSession((s) => s.me?.user?.id ?? '');

/** People in my voice room with their tile video flag (call order). */
export function useRoomPeople(wsId: string | null): TilePerson[] {
  const roomId = useVoice((s) => s.roomId);
  const states = useWorkspaces((s) => (wsId ? s.byId[wsId]?.voice : undefined));
  const cameras = useVoice((s) => s.cameras);
  const myCamera = useVoice((s) => s.camera === 'on');
  const hidden = usePrefs((s) => s.hiddenVideo);
  const me = useMe();
  return useMemo(() => {
    const list = Object.values(states ?? {})
      .filter((v) => v.roomId === roomId)
      .sort((a, b) => Number(a.joinedAt?.seconds ?? 0n) - Number(b.joinedAt?.seconds ?? 0n) || a.userId.localeCompare(b.userId))
      .map((v) => v.userId);
    if (me && !list.includes(me)) list.push(me);
    // Someone with a live camera but no voice state yet (webhook lag) still gets a tile.
    for (const c of cameras) if (!list.includes(c.userId)) list.push(c.userId);
    return list.map((userId) => ({ userId, video: userId === me ? myCamera : cameras.some((c) => c.userId === userId) && !hidden[userId] }));
  }, [states, roomId, cameras, myCamera, hidden, me]);
}

/** Any camera to show (mine or a remote one)? */
export function useAnyCamera(): boolean {
  return useVoice((s) => s.cameras.length > 0 || s.camera === 'on');
}

/** A camera <video>: mine (mirrored self-view) or a remote one; avatar until the first frame. */
function CameraVideo({ userId, wsId, avatarSize, fit = 'cover' }: { userId: string; wsId: string | null; avatarSize: number; fit?: 'cover' | 'contain' }): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const me = useMe();
  const isMe = userId === me;
  // This tile's own track object: re-attach only when *it* changes, not on every (un)subscribe in
  // the room — adaptive stream would see the element flap (review L4). The selector re-reads it
  // whenever the voice store changes (trackEpoch is bumped on every track change).
  const track = useVoice(() => (isMe ? voice.camera.localTrack : voice.cameraTrack(userId)));
  // The track that produced the last frame: a new track starts with the avatar again.
  const [framed, setFramed] = useState<object | null>(null);
  const hasFrame = track !== null && framed === track;
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    const onFrame = (): void => setFramed(el.videoWidth > 0 ? track : null);
    el.addEventListener('loadeddata', onFrame);
    el.addEventListener('resize', onFrame);
    track.attach(el);
    onFrame();
    return () => {
      el.removeEventListener('loadeddata', onFrame);
      el.removeEventListener('resize', onFrame);
      track.detach(el);
    };
  }, [track]);
  // Own video is mirrored like a mirror, except the back camera (phones: «Переключить камеру»).
  const mirrored = useVoice((s) => isMe && cameraMirrored(s.cameraFacing));
  return (
    <>
      <video
        ref={ref}
        muted
        playsInline
        autoPlay
        data-testid="camera-video"
        className={cx('absolute inset-0 size-full bg-[var(--color-video-bg)]', fit === 'cover' ? 'object-cover' : 'object-contain', mirrored && '-scale-x-100')}
      />
      {hasFrame ? null : <AvatarFill userId={userId} wsId={wsId} size={avatarSize} />}
    </>
  );
}

function AvatarFill({ userId, wsId, size }: { userId: string; wsId: string | null; size: number }): ReactNode {
  const name = useMemberName(wsId, userId);
  const avatar = useWorkspaces((s) => s.users[userId]?.avatarFileId);
  // A primitive (ms) per tile: other voice changes in the room don't re-render it.
  const joinedAt = useWorkspaces((s) => (wsId ? joinedAtMs(s.byId[wsId]?.voice[userId]?.joinedAt) : 0));
  return (
    <span className="pointer-events-none absolute inset-0 grid place-items-center bg-[var(--color-tile-bg)]" aria-hidden data-testid="tile-avatar">
      <span className="relative flex">
        <Avatar userId={userId} name={name} fileId={avatar || undefined} size={size} />
        {/* «Только вошёл»: 6 px left of the avatar, vertically centred. */}
        <JustJoinedDot joinedAt={joinedAt} className="absolute right-[calc(100%+6px)] top-1/2 -translate-y-1/2" />
      </span>
    </span>
  );
}

/** Name chip at the bottom-left of a tile: name, «(вы)», crossed mic when muted. */
function TileName({ userId, wsId, small, className }: { userId: string; wsId: string | null; small?: boolean; className?: string }): ReactNode {
  const name = useMemberName(wsId, userId);
  const me = useMe();
  const muted = useWorkspaces((s) => (wsId ? (s.byId[wsId]?.voice[userId]?.muted ?? false) : false));
  const live = useWorkspaces((s) => (wsId ? (s.byId[wsId]?.voice[userId]?.streaming ?? false) : false));
  const label = userId === me ? t('video.you', { name }) : name;
  return (
    <span
      className={cx(
        'pointer-events-none absolute flex max-w-[calc(100%-12px)] items-center gap-1 rounded-full bg-black/60 font-semibold text-white',
        small ? 'bottom-1 left-1 px-1.5 text-[11px] leading-4' : 'bottom-2 left-2 px-2 py-0.5 text-[12px]',
        className,
      )}
    >
      {muted ? <MicOff className={cx('shrink-0', small ? 'size-3' : 'size-3.5')} aria-label={t('shell.mutedState')} role="img" /> : null}
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
      {small ? null : <MemberBadge workspaceId={wsId} userId={userId} />}
      {/* Streaming right now (Discord shows LIVE on the tile too). */}
      {live ? <Badge tone="danger">{t('shell.live')}</Badge> : null}
    </span>
  );
}

type TileProps = ComponentPropsWithoutRef<'button'> & {
  userId: string;
  wsId: string | null;
  video: boolean;
  featured: boolean;
  small?: boolean;
  avatarSize: number;
};

/** One participant tile; a button (click = show large / back to the grid). */
const Tile = memo(forwardRef<HTMLButtonElement, TileProps>(function Tile({ userId, wsId, video, featured, small, avatarSize, className, style, ...rest }, ref) {
  // Memo row: re-render on a language switch too (ADR-0022).
  useLocale();
  const name = useMemberName(wsId, userId);
  const speaking = useVoice((s) => s.speaking[userId] ?? false);
  const muted = useWorkspaces((s) => (wsId ? (s.byId[wsId]?.voice[userId]?.muted ?? false) : false));
  const hasCamera = useVoice((s) => s.cameras.some((c) => c.userId === userId));
  const hidden = usePrefs((s) => !!s.hiddenVideo[userId]);
  const saveTraffic = usePrefs((s) => s.saveTraffic);
  const primary = useVoice(() => voice.primaryCamera());
  const saved = saveTraffic && hasCamera && !hidden && primary !== userId;
  const focused = useVoice((s) => s.focusedTile === userId);
  const off = hasCamera && (hidden || saved);
  return (
    <button
      ref={ref}
      type="button"
      data-testid="video-tile"
      data-featured={featured || undefined}
      aria-label={video || hasCamera ? t('video.of', { name }) : name}
      aria-pressed={focused}
      title={focused ? t('video.unfocus') : t('video.focus')}
      onClick={() => voice.focusTile(userId)}
      className={cx('group/tile absolute overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-tile-bg)] text-left', className)}
      style={style}
      {...rest}
    >
      {video && !saved ? <CameraVideo userId={userId} wsId={wsId} avatarSize={avatarSize} fit={featured ? 'contain' : 'cover'} /> : <AvatarFill userId={userId} wsId={wsId} size={avatarSize} />}
      {/* Speaking ring over the video (docs/09 #30): green, 2 px inside the tile; a pinned tile keeps an accent ring. */}
      <span
        aria-hidden
        className={cx(
          'pointer-events-none absolute inset-0 rounded-[var(--radius-card)] ring-2 ring-inset transition-shadow duration-100',
          speaking && !muted ? 'ring-[var(--color-green)]' : focused ? 'ring-accent' : 'ring-transparent',
        )}
      />
      {focused ? (
        <span className="pointer-events-none absolute left-2 top-2 grid size-6 place-items-center rounded-full bg-black/60 text-white" title={t('video.pinned')}>
          <Pin className="size-3.5" aria-label={t('video.pinned')} role="img" />
        </span>
      ) : null}
      {off ? (
        <span className="pointer-events-none absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-white" title={hidden ? t('video.hidden') : t('video.saved')}>
          <VideoOff className="size-3.5" aria-label={hidden ? t('video.hidden') : t('video.saved')} role="img" />
        </span>
      ) : null}
      <TileName userId={userId} wsId={wsId} small={small} />
    </button>
  );
}));

/** Tile with the member's right-click menu (volume, «Не показывать видео», moderation). */
function MemberTile(props: TileProps): ReactNode {
  const wsId = props.wsId;
  if (!wsId) return <Tile {...props} />;
  return (
    <MemberContextMenu workspaceId={wsId} userId={props.userId}>
      <Tile {...props} />
    </MemberContextMenu>
  );
}

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      setSize((s) => (s.w === next.w && s.h === next.h ? s : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const avatarFor = (w: number, h: number): number => Math.round(Math.max(32, Math.min(96, Math.min(w, h) * 0.36)));

/** One row of the «Ещё N» list: avatar with the speaking ring, name, camera icon; click = pin. */
const HiddenRow = memo(function HiddenRow({ userId, wsId, onPick }: { userId: string; wsId: string | null; onPick: (userId: string) => void }): ReactNode {
  useLocale();
  const name = useMemberName(wsId, userId);
  const avatar = useWorkspaces((s) => s.users[userId]?.avatarFileId);
  const speaking = useVoice((s) => s.speaking[userId] ?? false);
  const muted = useWorkspaces((s) => (wsId ? (s.byId[wsId]?.voice[userId]?.muted ?? false) : false));
  const hasCamera = useVoice((s) => s.cameras.some((c) => c.userId === userId));
  const me = useMe();
  const label = userId === me ? t('video.you', { name }) : name;
  return (
    <li>
      <button
        type="button"
        data-testid="video-hidden-row"
        title={t('video.focus')}
        onClick={() => onPick(userId)}
        className="flex h-9 w-full items-center gap-2 rounded-[5px] px-2 text-left text-body text-fg outline-none hover:bg-hover focus-visible:bg-hover"
      >
        <Avatar userId={userId} name={name} fileId={avatar || undefined} size={24} speaking={speaking && !muted} />
        <span className={cx('min-w-0 flex-1 truncate', speaking && !muted ? 'text-fg' : 'text-muted')}>{label}</span>
        {muted ? <MicOff className="size-3.5 shrink-0 text-faint" aria-label={t('shell.mutedState')} role="img" /> : null}
        {hasCamera ? <Video className="size-4 shrink-0 text-faint" aria-label={t('video.stateOn')} role="img" /> : null}
      </button>
    </li>
  );
});

/** ↑/↓ (Home/End) move between the rows of the «Ещё N» list; Tab works as usual. */
function onListKey(e: ReactKeyboardEvent<HTMLUListElement>): void {
  const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
  const i = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
}

/**
 * «Ещё N» (ADR-0066 stage 1): the last slot of a full grid; opens the list of the people behind
 * it, a click pins one (they take a slot and go large). Rows subscribe per id: a speaking start
 * repaints its ring only.
 */
const OverflowTile = memo(function OverflowTile({ hidden, wsId, x, y, w, h }: { hidden: readonly string[]; wsId: string | null; x: number; y: number; w: number; h: number }): ReactNode {
  useLocale();
  const [open, setOpen] = useState(false);
  const pick = useCallback((userId: string) => {
    setOpen(false);
    voice.focusTile(userId);
  }, []);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="video-overflow"
          aria-label={t('video.hiddenList')}
          className="absolute grid place-items-center rounded-[var(--radius-card)] bg-[var(--color-tile-bg)] text-headline font-semibold text-fg transition-colors duration-[var(--motion-fast)] hover:bg-hover aria-expanded:ring-2 aria-expanded:ring-inset aria-expanded:ring-accent"
          style={{ left: x, top: y, width: w, height: h }}
        >
          {t('video.more', { n: hidden.length })}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          aria-label={t('video.hiddenList')}
          className={cx(popoverBox, 'max-h-[min(360px,calc(100vh-96px))] w-64 overflow-y-auto p-1')}
          data-testid="video-hidden-list"
        >
          <ul onKeyDown={onListKey}>
            {hidden.map((id) => (
              <HiddenRow key={id} userId={id} wsId={wsId} onPick={pick} />
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

/**
 * The call view (stage «expanded» without a watched stream): up to 6 tiles, the active speaker
 * (or the clicked tile) large, avatars for people without a camera, «Ещё N» for the rest — a
 * hidden speaker comes forward into a slot (ADR-0066 §2, useTileSelection).
 */
export function CameraGrid({ box, wsId, top, emptyFeed = false }: { box: Box; wsId: string | null; top?: ReactNode; emptyFeed?: boolean }): ReactNode {
  const people = useRoomPeople(wsId);
  const focused = useVoice((s) => s.focusedTile);
  const active = useVoice((s) => s.activeSpeaker);
  const area = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(area);
  const me = useMe();
  // Re-renders only when the visible set changes, not on every speaking start (useTileSelection).
  const sel = useTileSelection(people, focused, active, me);
  // Esc returns a pinned tile to the grid (not while a menu or dialog handles its own Esc).
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="menu"], [role="dialog"]')) return;
      voice.focusTile(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);
  const tiles = sel?.tiles ?? [];
  const overflow = sel?.overflow ?? 0;
  const n = tiles.length + (overflow > 0 ? 1 : 0);
  const rects = layoutTiles(n, (sel?.featured ?? null) !== null, w, h, 8);
  const more = rects[n - 1];
  return (
    <div
      data-testid="video-grid"
      role="region"
      aria-label={t('video.grid')}
      className="absolute inset-x-0 z-[var(--z-sticky)] flex flex-col gap-2 bg-feed px-3 pb-3 pt-3"
      // Like the stream stage: an empty room keeps its one-row welcome visible underneath (#56).
      style={{ top: box.top, bottom: emptyFeed ? `calc(var(--composer-height) + ${WELCOME_ROW}px)` : 'var(--composer-height)' }}
    >
      <div className="flex min-h-7 shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">{top}</div>
        {focused ? (
          <button
            type="button"
            onClick={() => voice.focusTile(null)}
            title={t('video.unfocusHint')}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-hover px-2.5 text-[12px] font-medium text-fg transition-colors duration-[var(--motion-fast)] hover:bg-active"
          >
            <LayoutGrid className="size-3.5" aria-hidden />
            {t('video.unfocus')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => voice.setStage('pip')}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-hover px-2.5 text-[12px] font-medium text-fg transition-colors duration-[var(--motion-fast)] hover:bg-active"
        >
          <MessageCircle className="size-3.5" aria-hidden />
          {t('video.showChat')}
        </button>
      </div>
      <div ref={area} className="relative min-h-0 flex-1">
        {tiles.map((p, i) => {
          const r = rects[i];
          if (!r) return null;
          return (
            <MemberTile
              key={p.userId}
              userId={p.userId}
              wsId={wsId}
              video={p.video}
              featured={p.userId === sel?.featured}
              small={r.w < 240}
              avatarSize={avatarFor(r.w, r.h)}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            />
          );
        })}
        {sel && overflow > 0 && more ? <OverflowTile hidden={sel.hidden} wsId={wsId} x={more.x} y={more.y} w={more.w} h={more.h} /> : null}
      </div>
    </div>
  );
}

/** 160×90 camera tile in the stream stage's strip (the low simulcast layer). */
export function CameraStripTile({ userId, wsId }: { userId: string; wsId: string | null }): ReactNode {
  // Only people with a shown camera get a strip tile (useStripCameras).
  return <MemberTile userId={userId} wsId={wsId} video featured={false} small avatarSize={32} className="!relative h-[90px] w-[160px] shrink-0 ring-1 ring-[var(--color-border-popover)]" />;
}

/** Who has a camera tile in the strip: cameras first (mine too), in call order. */
export function useStripCameras(wsId: string | null): string[] {
  const people = useRoomPeople(wsId);
  return people.filter((p) => p.video).map((p) => p.userId);
}

/** PiP inset from the header and the right edge (docs/08: 16). */
const PIP_GAP = 16;

/**
 * The active speaker's camera over the chat (no stream watched): click = the call view. Always
 * says so (ADR-0066 §3): a «Развернуть» pill and «+N камер» when more cameras are on — not on
 * hover only.
 */
export function CameraPip({ box, wsId }: { box: Box; wsId: string | null }): ReactNode {
  useLocale();
  const wide = useMediaQuery('(min-width: 1200px)');
  const me = useMe();
  const mine = useVoice((s) => s.camera === 'on');
  const hiddenVideo = usePrefs((s) => s.hiddenVideo); // re-render when «Не показывать видео» changes
  // The same choice as the engine's subscription (primaryCamera: no hidden ones, review M1);
  // my self-view only when there is no remote camera.
  const primary = useVoice(() => voice.primaryCamera());
  // Cameras one can see in the call view (a primitive: other voice changes don't re-render).
  const shown = useVoice((s) => s.cameras.reduce((n, c) => n + (hiddenVideo[c.userId] ? 0 : 1), 0)) + (mine ? 1 : 0);
  const userId = primary ?? (mine ? me : null);
  const { w, h } = pipSize(wide, box.height, PIP_GAP);
  const name = useMemberName(wsId, userId ?? '');
  if (!userId) return null;
  const small = w < 240;
  const others = shown - 1;
  return (
    <div
      data-testid="camera-pip"
      role="region"
      aria-label={t('video.of', { name })}
      className="mat-popover group absolute z-[var(--z-pip)] overflow-hidden rounded-[var(--radius-panel)]"
      style={{ top: box.top + PIP_GAP, right: PIP_GAP, width: w, height: h, background: 'var(--color-video-bg)', boxShadow: PIP_SHADOW }}
    >
      <CameraVideo userId={userId} wsId={wsId} avatarSize={small ? 32 : 48} />
      <button
        type="button"
        className="absolute inset-0 rounded-[var(--radius-panel)]"
        onClick={() => voice.showVideo()}
        aria-label={others > 0 ? `${t('video.expand')} · ${plural('video.moreCameras', others)}` : t('video.expand')}
      />
      {/* Leaves room for the «Развернуть» pill on the right. */}
      <TileName userId={userId} wsId={wsId} small={small} className={small ? 'max-w-[calc(100%-36px)]' : 'max-w-[calc(100%-124px)]'} />
      {others > 0 ? (
        <span data-testid="camera-pip-more" className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/60 px-2 text-[11px] font-medium leading-5 text-white" aria-hidden>
          {plural('video.moreCameras', others)}
        </span>
      ) : null}
      {/* Always visible: the PiP is the door to the call view (not discoverable on hover only). */}
      <span
        data-testid="camera-pip-expand"
        className={cx('pointer-events-none absolute flex items-center gap-1 rounded-full bg-black/60 font-medium text-white', small ? 'bottom-1 right-1 size-5 justify-center' : 'bottom-2 right-2 px-2 py-0.5 text-[12px]')}
        aria-hidden
      >
        <Maximize2 className="size-3" />
        {small ? null : t('video.expandShort')}
      </span>
      <span className="absolute right-1.5 top-1.5 flex gap-0.5 rounded-[var(--radius-card)] bg-black/60 p-0.5 opacity-0 transition-opacity duration-[var(--motion-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
        <CloseButton label={t('video.close')} shortcut="" className="text-white hover:bg-white/15 hover:text-white" onClick={() => setVoice({ videoPip: false })} />
      </span>
    </div>
  );
}
