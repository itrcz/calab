import { HeadphoneOff, MicOff, Volume2 } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { Avatar } from '../../components/Avatar';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { useCanvasUi } from '../../stores/canvasUi';
import { useIsland } from '../../stores/island';
import { useMailUi } from '../../stores/mailUi';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { useWikiUi } from '../../stores/wikiUi';
import { useSelfMic } from '../voice/selfMic';
import { SelfPanel } from './SelfPanel';
import { VoiceBar } from './VoiceBar';
import { MeetingRecordPrompt } from '../calendar/RoomEvent';
import { IslandHover, islandVars } from './islandModel';
import { useMyStatus } from './StatusMenu';

/** Which left column the island's right edge follows (docs/08 «Нижний островок»). */
export type IslandColumn = 'sidebar' | 'wiki' | 'canvas' | 'mail';

/**
 * Bottom island (docs/08 «Нижний островок», Discord reference): «Голос подключён» and
 * the self panel as one floating block across the whole left part — from the rail's
 * left edge to the current screen's left column right edge, 8 px in (4 px up from the bottom, so my
 * avatar lands on the rail's axis at the inset the old rail avatar had), radius 12, on the window
 * layer. The rail and the column end above it: its height is published as `--island-height` on the
 * parent (their bottom padding).
 *
 * One island on every desktop screen (owner 23.10), with and without a call (VoiceBar only in
 * voice). `column` picks the width: room / DM / boards / calendar / Disk columns are
 * `--sidebar-width`, the wiki and canvas trees their own resizable width, mail its leftmost column's clamp.
 *
 * `mode="avatar"` (ADR-0146, outside «Команда»): folded into my avatar on the rail, the same
 * island over the content while hovered / toggled; it reserves no room in the lists.
 */
export function BottomIsland({ column, mode }: { column: IslandColumn; mode: 'full' | 'avatar' }): ReactNode {
  // Primitive selectors; only the active screen's store can change while it is shown.
  const wikiW = useWikiUi((s) => (column === 'wiki' ? s.treeWidth : 0));
  // A collapsed canvas tree hides the full island (AppShell), so the width is the tree's.
  const canvasW = useCanvasUi((s) => (column === 'canvas' ? s.treeWidth : 0));
  // Mail: the leftmost column - the mailbox sidebar when shown, else the thread list.
  const mailSidebar = useMailUi((s) => column === 'mail' && s.sidebar);
  const colW =
    column === 'wiki'
      ? `${wikiW}px`
      : column === 'canvas' && canvasW > 0
        ? `${canvasW}px`
        : column === 'mail'
          ? mailSidebar
            ? 'clamp(224px, 19vw, 260px)'
            : 'clamp(300px, 30vw, 380px)'
          : 'var(--sidebar-width)';
  const width = `calc(var(--rail-width) + ${colW} - 16px)`;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    // The shell's row (rail + content): the folded island sits in a box-less wrapper inside it.
    const host = el?.closest<HTMLElement>('[data-island-host]') ?? el?.parentElement;
    if (!el || !host) return;
    const publish = (): void => {
      const v = islandVars(mode, el.offsetHeight);
      if (v.island) host.style.setProperty('--island-height', v.island);
      else host.style.removeProperty('--island-height');
      if (v.rail) host.style.setProperty('--island-rail', v.rail);
      else host.style.removeProperty('--island-rail');
    };
    publish();
    // The folded island reserves a fixed footprint: no need to follow its height.
    const ro = mode === 'full' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      host.style.removeProperty('--island-height');
      host.style.removeProperty('--island-rail');
    };
  }, [mode]);
  // One element for the life of the island: opening / closing never re-renders the panel's parts.
  const content = useMemo(
    () => (
      <>
        <MeetingRecordPrompt />
        <VoiceBar />
        <SelfPanel />
      </>
    ),
    [],
  );
  if (mode === 'avatar') return <FoldedIsland panelRef={ref} width={width} content={content} />;
  return (
    <div
      ref={ref}
      data-testid="bottom-island"
      data-island
      className="mat-toolbar absolute bottom-2 left-2 z-[var(--z-sticky)] flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] shadow-[var(--shadow-island)]"
      style={{ width }}
    >
      {content}
    </div>
  );
}

/**
 * A prompt that needs an answer: a direct child of the island with role=status («Начать запись
 * встречи?», MeetingRecordPrompt). VoiceBar and SelfPanel are a region and a plain row.
 */
function promptIn(panel: HTMLElement | null): boolean {
  return !!panel?.querySelector(':scope > [role="status"]');
}

/** The island must stay open: a menu / popover of it is open (its trigger: aria-expanded, data-state) or a prompt waits. */
function holdIn(panel: HTMLElement | null): boolean {
  return promptIn(panel) || !!panel?.querySelector('[aria-expanded="true"], [data-state="open"]');
}

/**
 * The folded island (ADR-0146): my avatar on the rail, exactly where the full island's avatar is
 * (20 px from the left and bottom edges), and the full island over the content, growing out of it.
 * Hover opens it (80 ms intent), leaving closes it (250 ms grace); a click / tap / Enter / Space on
 * the avatar toggles it; Esc, focus leaving and a press outside close it; an open menu of the
 * island holds it open. Listeners for a press outside and the menu watcher exist only while open.
 */
function FoldedIsland({ panelRef, width, content }: { panelRef: RefObject<HTMLDivElement | null>; width: string; content: ReactNode }): ReactNode {
  const open = useIsland((s) => s.open);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [h] = useState(() => new IslandHover((o) => useIsland.setState({ open: o })));

  // Leaving the folded form (another section, the setting off, unmount): closed, no timer left.
  useEffect(() => () => h.reset(), [h]);

  // A prompt that needs an answer appears in the island (the meeting recording question): open it
  // and hold it until answered. Watches only the island's own child list (a prompt / the call bar
  // coming or going), no subtree: nothing fires on speaking, levels or timers.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const check = (): void => {
      if (promptIn(panel)) {
        h.setHeld(true);
        h.show();
      } else h.setHeld(holdIn(panel));
    };
    check();
    const mo = new MutationObserver(check);
    mo.observe(panel, { childList: true });
    return () => mo.disconnect();
  }, [h, panelRef]);

  const inIsland = useCallback(
    (n: EventTarget | null): boolean => n instanceof Node && (!!panelRef.current?.contains(n) || !!toggleRef.current?.contains(n)),
    [panelRef],
  );

  useEffect(() => {
    if (!open) {
      // Closed while focus was inside: back to the avatar, not to <body>.
      if (panelRef.current?.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true });
      return;
    }
    const panel = panelRef.current;
    h.setHeld(holdIn(panel));
    // A menu of the island opening / closing (attribute changes inside the open island only).
    const mo = new MutationObserver(() => h.setHeld(holdIn(panel)));
    if (panel) mo.observe(panel, { subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'data-state'] });
    // A press outside (touch has no hover): the island and its own menus do not count.
    const down = (e: globalThis.PointerEvent): void => {
      if (inIsland(e.target)) return;
      h.setHeld(holdIn(panel));
      h.pressOutside();
    };
    document.addEventListener('pointerdown', down, true);
    // A frame (the office editor) swallows the pointer: the page would never see it leave the
    // island. While open, frames do not take the pointer (styles.css), so the leave is seen; the
    // first move closes the island and they are live again.
    const root = document.documentElement;
    root.setAttribute('data-island-open', '');
    return () => {
      mo.disconnect();
      document.removeEventListener('pointerdown', down, true);
      root.removeAttribute('data-island-open');
    };
  }, [open, h, panelRef, inIsland]);

  // The mouse only: touch fires enter / leave around every tap, a pen has no reliable hover.
  const onEnter = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType === 'mouse') h.pointerEnter();
    },
    [h],
  );
  const onLeave = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      h.setHeld(holdIn(panelRef.current));
      h.pointerLeave();
    },
    [h, panelRef],
  );
  const onBlur = useCallback(
    (e: FocusEvent) => {
      if (inIsland(e.relatedTarget)) return;
      h.setHeld(holdIn(panelRef.current));
      h.focusLeft();
    },
    [h, panelRef, inIsland],
  );
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      h.setHeld(holdIn(panelRef.current));
      if (h.escape()) {
        e.preventDefault();
        toggleRef.current?.focus({ preventScroll: true });
      }
    },
    [h, panelRef],
  );
  const onToggle = useCallback(() => h.toggle(), [h]);

  return (
    // `contents`: no box of its own (it never blocks a click); the React tree still groups the
    // avatar, the island and the island's portalled menus for enter / leave and blur.
    <div className="contents" onPointerEnter={onEnter} onPointerLeave={onLeave} onBlur={onBlur} onKeyDown={onKey}>
      <IslandToggle ref={toggleRef} open={open} panelId={panelId} onToggle={onToggle} />
      <div
        ref={panelRef}
        id={panelId}
        role="region"
        aria-label={t('island.region')}
        data-testid="bottom-island"
        data-island
        data-open={open || undefined}
        // While open over a web app's native view, the view loses only height, never x/width (band occluder).
        data-app-occluder={open ? 'band' : undefined}
        className="island-pop mat-toolbar absolute bottom-2 left-2 z-[var(--z-sticky)] flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] shadow-[var(--shadow-island)]"
        style={{ width }}
      >
        {content}
      </div>
    </div>
  );
}

const BADGE = 'absolute -right-1 -top-1 box-content grid size-3.5 place-items-center rounded-full border-2 border-[var(--color-rail)]';

/**
 * The folded avatar (a leaf: its own primitive subscriptions, so speaking / mute redraw only it):
 * my avatar with the presence dot, as in the full island, and — in a call — one small mark at the
 * top right: green speaker (in a call), red crossed mic (muted) or headphones (deafened). The system
 * took the mic (#255): the crossed mic too, yellow while it is restored, red once that failed: the
 * panel header that says so is folded here. Above the
 * island (its avatar lies right under it); invisible and click-through while the island is open,
 * still focusable, so Enter / Space / Esc keep working from it.
 */
const IslandToggle = memo(function IslandToggle({ ref, open, panelId, onToggle }: { ref: RefObject<HTMLButtonElement | null>; open: boolean; panelId: string; onToggle: () => void }): ReactNode {
  const user = useSession((s) => s.me?.user);
  const status = useMyStatus();
  const mic = useSelfMic();
  const speaking = useVoice((s) => (user ? (s.speaking[user.id] ?? false) : false));
  const trouble = useVoice((s) => s.micTrouble);
  if (!user) return null;
  const call = mic.here;
  const state = !call ? '' : mic.deafened ? t('island.deafened') : mic.muted ? t('island.muted') : trouble ? t(trouble === 'recovering' ? 'voice.micRecovering' : 'voice.micUnheard') : '';
  const label = [t('island.toggle', { name: user.displayName }), call ? t('island.inCall') : '', state].filter(Boolean).join(', ');
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-expanded={open}
      aria-controls={panelId}
      data-testid="island-avatar"
      data-open={open || undefined}
      onClick={onToggle}
      className={cx('absolute bottom-5 left-5 size-8 rounded-full', open && 'pointer-events-none')}
      style={{ zIndex: 'calc(var(--z-sticky) + 1)' }}
    >
      <span className="island-face relative flex" data-open={open || undefined} aria-hidden>
        <Avatar userId={user.id} name={user.displayName} fileId={user.avatarFileId || undefined} size={32} speaking={speaking && !mic.muted} status={status} ring="var(--color-rail)" />
        {call ? (
          <span
            className={cx(BADGE, trouble === 'recovering' && !mic.muted ? 'bg-warn text-black' : mic.muted || trouble ? 'bg-danger text-white' : 'bg-ok text-white')}
            data-testid="island-call-mark"
            data-muted={mic.muted || undefined}
            data-trouble={trouble ?? undefined}
          >
            {mic.deafened ? (
              <HeadphoneOff className="size-2.5" strokeWidth={2.75} />
            ) : mic.muted || trouble ? (
              <MicOff className="size-2.5" strokeWidth={2.75} />
            ) : (
              <Volume2 className="size-2.5" strokeWidth={2.75} />
            )}
          </span>
        ) : null}
      </span>
    </button>
  );
});
