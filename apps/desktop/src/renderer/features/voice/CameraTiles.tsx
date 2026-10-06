import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronLeft, ChevronRight, Ellipsis, Maximize2, MessageCircle, Mic, MicOff, Pin, PinOff, VideoOff } from 'lucide-react';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Avatar } from '../../components/Avatar';
import { Badge, CloseButton, IconButton, Segmented, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useMobile } from '../../lib/mobile';
import type { ShownQuality } from '../../lib/media/cameraShown';
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
import { menuBox, menuItem } from '../shell/menu';
import type { Box } from './StreamArea';
import { PIP_SHADOW, WELCOME_ROW, pipSize } from './streamFormat';
import { GALLERY_MEDIUM_FROM, gridTiles, speakerLayout, speakerTiles, type CallView, type TilePerson } from './tileLayout';
import { useGallery, useGalleryPageSize } from './useGallery';

/*
 * Webcam tiles of my voice room (docs/09 #42, ADR-0066): the call view over the chat area
 * («Галерея» with pages or «Спикер» with a scrollable strip), the camera PiP while the chat is
 * open, and 160×90 tiles in the stream stage's strip. Each <video> is attached with LiveKit's
 * attach(), so adaptive stream sizes the subscription to the tile; a mounted camera <video> claims
 * its participant (voice.showCamera) and only claimed cameras are subscribed (ADR-0066 §4).
 * Video elements are always muted: a camera has no audio.
 */

const useMe = (): string => useSession((s) => s.me?.user?.id ?? '');

/**
 * People in my voice room with their tile video flag (call order). The room's membership is read
 * as a primitive key: a mute or a «speaking» flag elsewhere in the room changes nothing here.
 */
export function useRoomPeople(wsId: string | null): TilePerson[] {
  const roomId = useVoice((s) => s.roomId);
  const members = useWorkspaces((s) => {
    const states = wsId ? s.byId[wsId]?.voice : undefined;
    if (!states || !roomId) return '';
    return Object.values(states)
      .filter((v) => v.roomId === roomId)
      .sort((a, b) => Number(a.joinedAt?.seconds ?? 0n) - Number(b.joinedAt?.seconds ?? 0n) || a.userId.localeCompare(b.userId))
      .map((v) => v.userId)
      .join(',');
  });
  const cameras = useVoice((s) => s.cameras.map((c) => c.userId).join(','));
  const myCamera = useVoice((s) => s.camera === 'on');
  const hidden = usePrefs((s) => s.hiddenVideo);
  const me = useMe();
  return useMemo(() => {
    const list = members ? members.split(',') : [];
    const cams = cameras ? cameras.split(',') : [];
    if (me && !list.includes(me)) list.push(me);
    // Someone with a live camera but no voice state yet (webhook lag) still gets a tile.
    for (const c of cams) if (!list.includes(c)) list.push(c);
    return list.map((userId) => ({ userId, video: userId === me ? myCamera : cams.includes(userId) && !hidden[userId] }));
  }, [members, cameras, myCamera, hidden, me]);
}

/** Any camera to show (mine or a remote one)? */
export function useAnyCamera(): boolean {
  return useVoice((s) => s.cameras.length > 0 || s.camera === 'on');
}

/**
 * A camera <video>: mine (mirrored self-view) or a remote one; avatar until the first frame.
 * A remote one claims its subscription while mounted (ADR-0066 §4: only what is on screen).
 */
function CameraVideo({ userId, wsId, avatarSize, fit = 'cover', quality = 'high' }: { userId: string; wsId: string | null; avatarSize: number; fit?: 'cover' | 'contain'; quality?: ShownQuality }): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const me = useMe();
  const isMe = userId === me;
  useEffect(() => (isMe ? undefined : voice.showCamera(userId, quality)), [isMe, userId, quality]);
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
  /** The layer this tile needs (a 16+ gallery page: medium). */
  quality?: ShownQuality;
  /**
   * Absolute position in the call area (primitives: a memo row gets no new objects). Merged over
   * `style`: the member menu's trigger (Radix Slot) injects its own `style` into the tile, which
   * must not wipe the position (2.4.1: every positioned tile collapsed to 0×0 — an empty gallery
   * and an empty large tile while the strip, positioned by class, still showed).
   */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

/** One participant tile; a button (click = pin / unpin). */
const Tile = memo(
  forwardRef<HTMLButtonElement, TileProps>(function Tile({ userId, wsId, video, featured, small, avatarSize, quality, x, y, w, h, className, style, ...rest }, ref) {
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
        {...rest}
        style={x !== undefined ? { ...style, left: x, top: y, width: w, height: h } : style}
      >
        {video && !saved ? (
          <CameraVideo userId={userId} wsId={wsId} avatarSize={avatarSize} fit={featured ? 'contain' : 'cover'} quality={quality} />
        ) : (
          <AvatarFill userId={userId} wsId={wsId} size={avatarSize} />
        )}
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
  }),
);

/** Tile with the member's right-click menu (volume, «Не показывать видео», moderation). Exported for its test. */
export function MemberTile(props: TileProps): ReactNode {
  const wsId = props.wsId;
  if (!wsId) return <Tile {...props} />;
  return (
    <MemberContextMenu workspaceId={wsId} userId={props.userId}>
      <Tile {...props} />
    </MemberContextMenu>
  );
}

function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
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

/** Typing somewhere (the composer, a field): ←/→ belong to it, not to the gallery. */
function typingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

const NO_TILES: readonly TilePerson[] = [];

/** A horizontal touch swipe of at least this many px flips the page. */
const SWIPE_PX = 48;

/**
 * «Говорят сейчас: Анна, Борис» (ADR-0066 §2): someone speaking is not on this gallery page.
 * Its own subscriber with a primitive selector (the ids, joined): a speaking start on the page
 * re-renders nothing; a click goes to the first speaker's page.
 */
const SpeakingNow = memo(function SpeakingNow({ visible, me, wsId, pageOf, onGo }: { visible: string; me: string; wsId: string | null; pageOf: (userId: string) => number; onGo: (page: number) => void }): ReactNode {
  useLocale();
  const on = useMemo(() => new Set(visible.split(',')), [visible]);
  const ids = useVoice((s) => {
    let out = '';
    for (const [id, speaking] of Object.entries(s.speaking)) if (speaking && id !== me && !on.has(id)) out += out ? `,${id}` : id;
    return out;
  });
  const list = ids ? ids.split(',').filter((id) => pageOf(id) >= 0) : [];
  const first = list[0];
  if (first === undefined) return null;
  return (
    <button
      type="button"
      data-testid="video-speaking-now"
      onClick={() => onGo(pageOf(first))}
      title={t('video.speakingNowHint')}
      className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-hover px-2.5 text-[12px] font-medium text-fg transition-colors duration-[var(--motion-fast)] hover:bg-active"
    >
      <Mic className="size-3.5 shrink-0 text-[var(--color-green)]" aria-hidden />
      <span className="sr-only">{t('video.speakingNow')}</span>
      <span className="min-w-0 truncate">
        {list.slice(0, 3).map((id, i) => (
          <SpeakerName key={id} userId={id} wsId={wsId} comma={i > 0} />
        ))}
        {list.length > 3 ? ` +${list.length - 3}` : null}
      </span>
    </button>
  );
});

function SpeakerName({ userId, wsId, comma }: { userId: string; wsId: string | null; comma: boolean }): ReactNode {
  const name = useMemberName(wsId, userId);
  return (
    <>
      {comma ? ', ' : null}
      {name}
    </>
  );
}

/** «Галерея | Спикер» (ADR-0066 §1), remembered on the device. */
function ViewSwitch({ view }: { view: CallView }): ReactNode {
  const setPrefs = usePrefs((s) => s.setPrefs);
  const options = [
    { value: 'gallery' as const, label: t('video.viewGallery') },
    { value: 'speaker' as const, label: t('video.viewSpeaker') },
  ];
  return <Segmented label={t('video.view')} value={view} options={options} onChange={(v) => setPrefs({ callView: v })} />;
}

/** «⋯»: «Скрыть себя», «Скрыть участников без видео». */
function ViewMenu(): ReactNode {
  const hideSelf = usePrefs((s) => s.hideSelf);
  const hideNoVideo = usePrefs((s) => s.hideNoVideo);
  const setPrefs = usePrefs((s) => s.setPrefs);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton size="sm" label={t('video.viewMenu')} className="data-[state=open]:bg-hover" data-testid="video-view-menu">
          <Ellipsis className="size-4" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-64')} side="bottom" align="end" sideOffset={6} collisionPadding={16}>
          <Dropdown.CheckboxItem className={cx(menuItem, 'relative pl-7')} checked={hideSelf} onCheckedChange={(v) => setPrefs({ hideSelf: v })}>
            <Dropdown.ItemIndicator className="absolute left-2">
              <Check className="size-3.5" />
            </Dropdown.ItemIndicator>
            {t('video.hideSelf')}
          </Dropdown.CheckboxItem>
          <Dropdown.CheckboxItem className={cx(menuItem, 'relative pl-7')} checked={hideNoVideo} onCheckedChange={(v) => setPrefs({ hideNoVideo: v })}>
            <Dropdown.ItemIndicator className="absolute left-2">
              <Check className="size-3.5" />
            </Dropdown.ItemIndicator>
            {t('video.hideNoVideo')}
          </Dropdown.CheckboxItem>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** «Скрыть себя» is on: a small «Вы» badge in the corner instead of my tile; click shows it again. */
function SelfBadge({ me }: { me: string }): ReactNode {
  const setPrefs = usePrefs((s) => s.setPrefs);
  const speaking = useVoice((s) => s.speaking[me] ?? false);
  return (
    <button
      type="button"
      data-testid="video-self-badge"
      onClick={() => setPrefs({ hideSelf: false })}
      title={t('video.showSelf')}
      className={cx(
        'absolute bottom-1 right-1 z-[1] flex h-6 items-center rounded-full bg-black/60 px-2.5 text-[12px] font-semibold text-white ring-2 ring-inset',
        speaking ? 'ring-[var(--color-green)]' : 'ring-transparent',
      )}
    >
      {t('video.youBadge')}
    </button>
  );
}

const pagerBtn = 'absolute top-1/2 z-[1] grid size-8 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white transition-colors duration-[var(--motion-fast)] hover:bg-black/80';

/**
 * The call view (stage «expanded» without a watched stream), ADR-0066: «Галерея» — equal tiles
 * in pages (‹ › · «1 / 3» · ←/→ · swipe), page 1 led by the pinned tile, me and recent speakers;
 * «Спикер» — the pinned / active speaker large, everyone else in a scrollable strip.
 */
export function CameraGrid({ box, wsId, top, emptyFeed = false }: { box: Box; wsId: string | null; top?: ReactNode; emptyFeed?: boolean }): ReactNode {
  useLocale();
  const people = useRoomPeople(wsId);
  const pin = useVoice((s) => s.focusedTile);
  // A pin of someone not in this call (left, another room's sidebar click before the voice state
  // arrived) is no pin: no «Открепить», no empty large tile (the layouts ignore it too).
  const focused = pin !== null && people.some((p) => p.userId === pin) ? pin : null;
  const view = usePrefs((s) => s.callView);
  const hideSelf = usePrefs((s) => s.hideSelf);
  const hideNoVideo = usePrefs((s) => s.hideNoVideo);
  const page = useVoice((s) => s.galleryPage);
  const phone = useMobile();
  const size = useGalleryPageSize(phone);
  const area = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(area);
  const me = useMe();
  const gallery = view === 'gallery';
  // Re-renders only when the page's tiles change, not on every speaking start (useGallery).
  const { gallery: g, pageOf } = useGallery(gallery ? { people, pinned: focused, me, hideSelf, hideNoVideo, size, page } : null);
  const pages = g?.pages ?? 1;
  const shownPage = g?.page ?? 0;
  // The page clamped (people left, a bigger page size): the store follows.
  useEffect(() => {
    if (g && g.page !== page) voice.setGalleryPage(g.page);
  }, [g, page]);
  const go = useCallback((p: number) => voice.setGalleryPage(Math.max(0, p)), []);
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
  // ←/→ flip gallery pages (not while typing, not in a menu / dialog).
  useEffect(() => {
    if (!gallery || pages < 2) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (typingTarget(document.activeElement) || document.querySelector('[role="menu"], [role="dialog"]')) return;
      const next = shownPage + (e.key === 'ArrowRight' ? 1 : -1);
      if (next < 0 || next >= pages) return;
      e.preventDefault();
      go(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gallery, pages, shownPage, go]);
  // Swipe on touch: a mostly horizontal stroke of SWIPE_PX flips the page.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  // A swipe that flipped the page must not also pin the tile it ended on.
  const swiped = useRef(false);
  const onPointerDown = (e: ReactPointerEvent): void => {
    swipe.current = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY } : null;
    swiped.current = false;
  };
  const onPointerUp = (e: ReactPointerEvent): void => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || !gallery || pages < 2) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(e.clientY - s.y) * 1.5) return;
    const next = shownPage + (dx < 0 ? 1 : -1);
    swiped.current = true;
    if (next >= 0 && next < pages) go(next);
  };
  const onClickCapture = (e: ReactMouseEvent): void => {
    if (!swiped.current) return;
    swiped.current = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const tiles = g?.tiles ?? NO_TILES;
  const visible = useMemo(() => (g?.tiles ?? NO_TILES).map((p) => p.userId).join(','), [g]);
  const meInCall = people.some((p) => p.userId === me);
  return (
    <div
      data-testid="video-grid"
      data-view={view}
      role="region"
      aria-label={t('video.grid')}
      className="absolute inset-x-0 z-[var(--z-sticky)] flex flex-col gap-2 bg-feed px-3 pb-3 pt-3"
      // Like the stream stage: an empty room keeps its one-row welcome visible underneath (#56).
      style={{ top: box.top, bottom: emptyFeed ? `calc(var(--composer-height) + ${WELCOME_ROW}px)` : 'var(--composer-height)' }}
    >
      <div className="flex min-h-7 shrink-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {top}
          {gallery && pages > 1 ? <SpeakingNow visible={visible} me={me} wsId={wsId} pageOf={pageOf} onGo={go} /> : null}
        </div>
        {focused ? (
          <button
            type="button"
            onClick={() => voice.focusTile(null)}
            title={t('video.unfocusHint')}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-hover px-2.5 text-[12px] font-medium text-fg transition-colors duration-[var(--motion-fast)] hover:bg-active"
          >
            <PinOff className="size-3.5" aria-hidden />
            {phone ? null : t('video.unfocus')}
          </button>
        ) : null}
        <ViewSwitch view={view} />
        <ViewMenu />
        <button
          type="button"
          onClick={() => voice.setStage('pip')}
          aria-label={t('video.showChat')}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-hover px-2.5 text-[12px] font-medium text-fg transition-colors duration-[var(--motion-fast)] hover:bg-active"
        >
          <MessageCircle className="size-3.5" aria-hidden />
          {phone ? null : t('video.showChat')}
        </button>
      </div>
      <div ref={area} className="relative min-h-0 flex-1 touch-pan-y" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (swipe.current = null)} onClickCapture={onClickCapture}>
        {gallery ? (
          <GalleryTiles tiles={tiles} wsId={wsId} w={w} h={h} />
        ) : (
          <SpeakerView people={people} wsId={wsId} pinned={focused} me={me} hideSelf={hideSelf} hideNoVideo={hideNoVideo} w={w} h={h} />
        )}
        {gallery && pages > 1 ? (
          <>
            {shownPage > 0 ? (
              <button type="button" className={cx(pagerBtn, 'left-1')} aria-label={t('video.pagePrev')} onClick={() => go(shownPage - 1)} data-testid="video-page-prev">
                <ChevronLeft className="size-5" aria-hidden />
              </button>
            ) : null}
            {shownPage < pages - 1 ? (
              <button type="button" className={cx(pagerBtn, 'right-1')} aria-label={t('video.pageNext')} onClick={() => go(shownPage + 1)} data-testid="video-page-next">
                <ChevronRight className="size-5" aria-hidden />
              </button>
            ) : null}
          </>
        ) : null}
        {hideSelf && meInCall ? <SelfBadge me={me} /> : null}
      </div>
      {gallery && pages > 1 ? (
        <div className="-mb-1 -mt-1 flex h-5 shrink-0 items-center justify-center text-[12px] font-medium tabular-nums text-muted" data-testid="video-page" aria-live="polite">
          {t('video.pageOf', { page: shownPage + 1, pages })}
        </div>
      ) : null}
    </div>
  );
}

/** One gallery page: equal 16:9 tiles; 16+ tiles ask for 360p at most (ADR-0066 §4). */
const GalleryTiles = memo(function GalleryTiles({ tiles, wsId, w, h }: { tiles: readonly TilePerson[]; wsId: string | null; w: number; h: number }): ReactNode {
  const rects = gridTiles(tiles.length, w, h, 8);
  const quality: ShownQuality = tiles.length >= GALLERY_MEDIUM_FROM ? 'medium' : 'high';
  return (
    <>
      {tiles.map((p, i) => {
        const r = rects[i];
        if (!r) return null;
        return (
          <MemberTile
            key={p.userId}
            userId={p.userId}
            wsId={wsId}
            video={p.video}
            featured={false}
            small={r.w < 240}
            avatarSize={avatarFor(r.w, r.h)}
            quality={quality}
            x={r.x}
            y={r.y}
            w={r.w}
            h={r.h}
          />
        );
      })}
    </>
  );
});

/**
 * «Спикер»: the large tile and a scrollable strip. Speech changes the large tile only through the
 * held active speaker (800 ms / 1.5 s, lib/activeSpeaker.ts); the strip's order never follows
 * speech. Strip tiles scrolled out of view show no video (and claim no subscription).
 */
function SpeakerView({ people, wsId, pinned, me, hideSelf, hideNoVideo, w, h }: { people: readonly TilePerson[]; wsId: string | null; pinned: string | null; me: string; hideSelf: boolean; hideNoVideo: boolean; w: number; h: number }): ReactNode {
  const active = useVoice((s) => s.activeSpeaker);
  // Strip rows are memo and get the same person objects (useRoomPeople) while nothing changes.
  const sel = speakerTiles(people, { pinned, active, me, hideSelf, hideNoVideo });
  const lay = speakerLayout(sel.strip.length, w, h, 8);
  const featured = people.find((p) => p.userId === sel.featured);
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <>
      {featured && lay.main.w > 0 ? (
        <MemberTile
          userId={featured.userId}
          wsId={wsId}
          video={featured.video}
          featured
          avatarSize={avatarFor(lay.main.w, lay.main.h)}
          x={lay.main.x}
          y={lay.main.y}
          w={lay.main.w}
          h={lay.main.h}
        />
      ) : null}
      {lay.strip ? (
        <div
          ref={scroller}
          data-testid="video-strip"
          className={cx('absolute flex gap-2', lay.vertical ? 'flex-col overflow-y-auto overflow-x-hidden' : 'flex-row overflow-x-auto overflow-y-hidden')}
          style={{ left: lay.strip.x, top: lay.strip.y, width: lay.strip.w, height: lay.strip.h }}
        >
          {sel.strip.map((p) => (
            <StripTile key={p.userId} person={p} wsId={wsId} w={lay.tile.w} h={lay.tile.h} root={scroller} />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** A strip tile shows video only while scrolled into view (IntersectionObserver on the strip). */
const StripTile = memo(function StripTile({ person, wsId, w, h, root }: { person: TilePerson; wsId: string | null; w: number; h: number; root: RefObject<HTMLDivElement | null> }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { root: root.current });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  const style = useMemo(() => ({ width: w, height: h }), [w, h]);
  return (
    <div ref={ref} className="relative shrink-0" style={style}>
      <MemberTile userId={person.userId} wsId={wsId} video={person.video && inView} featured={false} small avatarSize={avatarFor(w, h)} className="inset-0" />
    </div>
  );
});

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
