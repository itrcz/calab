import * as Popover from '@radix-ui/react-popover';
import { type Sticker, type StickerPack } from '@calaba/protocol';
import { Clock3, Search, Sticker as StickerIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton, Spinner, Tip, cx } from '../../../components/ui';
import { plural, t } from '../../../i18n';
import { autoFocusAllowed, useMobile } from '../../../lib/mobile';
import { can, workspacePerms } from '../../../lib/permissions';
import { coverOf, packUsable, resolveRecent, searchStickers, type StickerPlace } from '../../../lib/stickers';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { installPack, loadMyStickers } from '../../../services/stickers';
import { useSession } from '../../../stores/session';
import { useStickers } from '../../../stores/stickers';
import { useUi } from '../../../stores/ui';
import { useMemberRoles, useWorkspaces } from '../../../stores/workspaces';
import { searchEmoji } from '../emoji';
import { StickerImage } from './StickerImage';

const COLS = 4;
/** Desktop tiles: 4 × 104 px (Telegram Desktop); phones: the card's width / 4. */
const CELL = 104;
/** The sticker sits in its tile with this inset on every side. */
const INSET = 6;
/** The grid's side padding (px-3 on each side). */
const GRID_PAD = 24;
/** The enlarged preview over a hovered tile, and the hover delay before it shows. */
const PREVIEW = 200;
const PREVIEW_DELAY_MS = 250;
/** The pack covers in the strip. */
const COVER = 36;

/**
 * The composer's «Стикеры» button and panel (ADR-0030, docs/08 «Стикеры», like Telegram
 * Desktop): search by emoji or pack name, a strip of pack covers («Недавние» first; a click
 * scrolls to the pack, the pack under the top edge is highlighted), 4 large tiles a row (a 200 px preview over the hovered one). A click
 * sends at once and closes the panel; Shift+click sends and keeps it open. Animated stickers
 * stand on their first frame and play only on hover / focus (docs/14). On a phone the popover
 * is a centred card (app/styles.css `--phone-card-w`).
 */
export function StickerButton({ place, onSend }: { place: StickerPlace; onSend: (s: Sticker) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label={t('stk.tabStickers')}>
        <Popover.Trigger asChild>
          <IconButton tip={false} label={t('stk.tabStickers')} className="mb-1 rounded-full mobile:mb-0 mobile:size-11" data-testid="sticker-button">
            <StickerIcon className="size-5" />
          </IconButton>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={16}
          aria-label={t('stk.tabStickers')}
          data-testid="sticker-panel"
          className="mat-popover dense anim-in z-[var(--z-popover)] flex h-[min(520px,var(--radix-popover-content-available-height))] w-[460px] flex-col overflow-hidden rounded-[var(--radius-panel)] mobile:h-auto mobile:max-h-[min(75dvh,560px)] mobile:min-h-[340px]"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <StickerPanel
            place={place}
            onSend={(s, keepOpen) => {
              onSend(s);
              if (!keepOpen) setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function StickerPanel({ place, onSend, onClose }: { place: StickerPlace; onSend: (s: Sticker, keepOpen: boolean) => void; onClose: () => void }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const loaded = useStickers((s) => s.loaded);
  const installed = useStickers((s) => s.installed);
  const available = useStickers((s) => s.available);
  const recentIds = useStickers((s) => s.recent);
  const byId = useWorkspaces((s) => s.byId);
  const mobile = useMobile();
  const cardWidth = useCardWidth(mobile);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    void loadMyStickers();
  }, []);

  const usable = useMemo(
    () => installed.filter((p) => p.stickers.length > 0 && packUsable(p, place, me, (ws, u) => byId[ws]?.members[u]?.role)),
    [installed, place, me, byId],
  );
  const addable = useMemo(
    () => available.filter((p) => p.stickers.length > 0 && packUsable(p, place, me, (ws, u) => byId[ws]?.members[u]?.role)),
    [available, place, me, byId],
  );
  const recent = useMemo(() => resolveRecent(recentIds, usable), [recentIds, usable]);
  const found = useMemo(() => (q.trim() ? searchStickers(usable, q, searchEmoji) : null), [q, usable]);
  const firstId = recent.length ? 'recent' : (usable[0]?.id ?? null);
  const current = active ?? firstId;

  // The highlighted cover stays in view in the strip.
  useEffect(() => {
    if (!current) return;
    strip.current?.querySelector<HTMLElement>(`[data-pack-tab="${current}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    let cur: string | null = null;
    for (const sec of Array.from(el.querySelectorAll<HTMLElement>('section[data-pack]'))) {
      if (sec.offsetTop - el.offsetTop <= el.scrollTop + 8) cur = sec.dataset['pack'] ?? null;
    }
    setActive(cur);
  };
  const jump = (id: string): void => {
    const el = scroller.current?.querySelector<HTMLElement>(`section[data-pack="${id}"]`);
    if (scroller.current && el) scroller.current.scrollTo({ top: el.offsetTop - scroller.current.offsetTop });
    setActive(id);
  };
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = Array.from(scroller.current?.querySelectorAll<HTMLButtonElement>('button[data-sticker-pick]') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (i < 0 || !step) return;
    e.preventDefault();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + step))];
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  };
  // The phone card (min(360, screen − 32)): its width over 4 columns.
  const cell = mobile ? Math.max(56, Math.floor((cardWidth - GRID_PAD) / COLS)) : CELL;
  const size = { cell, img: cell - 2 * INSET, preview: !mobile };
  const grid = (list: readonly Sticker[]): ReactNode => <Grid stickers={list} onSend={onSend} {...size} />;

  if (!loaded) {
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner />
      </div>
    );
  }
  if (usable.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="sticker-grid">
        {addable.length ? (
          <div className="flex flex-col gap-3">
            <p className="px-1 text-center text-body text-muted">{t('stk.empty')}</p>
            <Available packs={addable} />
          </div>
        ) : (
          <EmptyHint place={place} noneHere={available.length + installed.length > 0} onClose={onClose} />
        )}
      </div>
    );
  }
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
        <Search className="size-4 shrink-0 text-faint" aria-hidden />
        <input
          autoFocus={autoFocusAllowed()}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              scroller.current?.querySelector<HTMLButtonElement>('button[data-sticker-pick]')?.focus();
            }
          }}
          placeholder={t('stk.search')}
          aria-label={t('stk.search')}
          data-testid="sticker-search"
          className="h-10 min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-faint"
        />
      </div>
      {!found ? (
        <nav ref={strip} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5" aria-label={t('stk.packs')} data-testid="sticker-packs">
          {recent.length ? (
            <PackTab id="recent" label={t('stk.recent')} active={current === 'recent'} onClick={() => jump('recent')}>
              <Clock3 className="size-6" aria-hidden />
            </PackTab>
          ) : null}
          {usable.map((p) => {
            const c = coverOf(p);
            return (
              <PackTab key={p.id} id={p.id} label={p.name} active={current === p.id} onClick={() => jump(p.id)}>
                {c ? <StickerImage sticker={c} size={COVER} playing={false} /> : null}
              </PackTab>
            );
          })}
        </nav>
      ) : null}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 pb-2" onScroll={onScroll} onKeyDown={onGridKey} data-testid="sticker-grid">
        {found ? (
          <Section id="search" label={t('stk.found')} cell={size.cell}>
            {found.length === 0 ? <p className="px-1 py-4 text-center text-body text-muted">{t('stk.none')}</p> : grid(found)}
          </Section>
        ) : (
          <>
            {recent.length ? (
              <Section id="recent" label={t('stk.recent')} cell={size.cell}>
                {grid(recent)}
              </Section>
            ) : null}
            {usable.map((p) => (
              <Section key={p.id} id={p.id} label={p.name} cell={size.cell} lazyRows={Math.ceil(p.stickers.length / COLS)}>
                {grid(p.stickers)}
              </Section>
            ))}
            {addable.length ? (
              <section className="-mx-3 px-3 pt-2">
                <h3 className="pb-1 text-caption font-semibold text-muted">{t('stk.available')}</h3>
                <Available packs={addable} />
              </section>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/**
 * No packs to show: «Добавьте пак в настройках пространства», with a button to «Стикеры» of
 * the workspace settings for whoever holds MANAGE_STICKERS there (in a room; a DM has no one
 * workspace to point at).
 */
function EmptyHint({ place, noneHere, onClose }: { place: StickerPlace; noneHere: boolean; onClose: () => void }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const wsId = 'workspaceId' in place ? place.workspaceId : null;
  const roles = useMemberRoles(wsId, me);
  const manage = !!wsId && can(workspacePerms(roles), 'MANAGE_STICKERS');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="sticker-empty">
      <StickerIcon className="size-8 text-faint" aria-hidden />
      <p className="text-body text-muted">{noneHere ? t('stk.noneHere') : t('stk.emptyAdd')}</p>
      {manage && wsId ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
            useUi.getState().openDialog({ kind: 'workspace-settings', workspaceId: wsId, tab: 'stickers' });
          }}
        >
          {t('stk.openSettings')}
        </Button>
      ) : null}
    </div>
  );
}

/** A pack's section: its grid renders once it nears the view (a placeholder of its height before). */
function Section({ id, label, cell, lazyRows, children }: { id: string; label: string; cell: number; lazyRows?: number; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(lazyRows === undefined || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const o = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        setSeen(true);
        o.disconnect();
      }
    }, { rootMargin: '200px 0px' });
    o.observe(el);
    return () => o.disconnect();
  }, [seen]);
  return (
    <section ref={ref} data-pack={id} aria-label={label} className="-mx-3 px-3">
      <h3 className="sticky top-0 z-[1] -mx-3 truncate bg-[var(--color-popover-solid)] px-3 pb-1 pt-2 text-caption font-semibold text-muted">{label}</h3>
      {seen ? children : <div style={{ height: (lazyRows ?? 1) * cell }} aria-hidden />}
    </section>
  );
}

/** The phone card's width (app/styles.css `--phone-card-w`: min(360, window − 32)) while `on`; 0 otherwise. */
const phoneCardWidth = (): number => Math.min(360, window.innerWidth - 32);
function useCardWidth(on: boolean): number {
  const [w, setW] = useState(() => (on && typeof window !== 'undefined' ? phoneCardWidth() : 0));
  useEffect(() => {
    if (!on) return;
    const sync = (): void => setW(phoneCardWidth());
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [on]);
  return w;
}

function Grid({ stickers, onSend, cell, img, preview }: { stickers: readonly Sticker[]; onSend: (s: Sticker, keepOpen: boolean) => void; cell: number; img: number; preview: boolean }): ReactNode {
  return (
    <div className="grid grid-cols-[repeat(4,minmax(0,1fr))] justify-items-center">
      {stickers.map((s, i) => (
        <Tile key={`${s.id}-${i}`} sticker={s} first={i === 0} cell={cell} img={img} preview={preview} onPick={(keep) => onSend(s, keep)} />
      ))}
    </div>
  );
}

/**
 * One tile: grows to 1.12 under the pointer; an animated sticker plays only then (or on focus).
 * On a pointer that hovers (desktop) a 200 px preview rises over the tile after 250 ms.
 */
function Tile({ sticker, first, cell, img, preview, onPick }: { sticker: Sticker; first: boolean; cell: number; img: number; preview: boolean; onPick: (keepOpen: boolean) => void }): ReactNode {
  const [hot, setHot] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const reduce = useMediaQuery('(prefers-reduced-motion: reduce)');
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hide = (): void => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  };
  return (
    <button
      type="button"
      data-sticker-pick
      tabIndex={first ? 0 : -1}
      onClick={(e: MouseEvent) => {
        hide();
        onPick(e.shiftKey);
      }}
      onPointerEnter={(e) => {
        setHot(true);
        if (!preview || e.pointerType !== 'mouse') return;
        const el = e.currentTarget;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setAnchor(el.getBoundingClientRect()), PREVIEW_DELAY_MS);
      }}
      onPointerLeave={() => {
        setHot(false);
        hide();
      }}
      onWheel={hide}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
      aria-label={t('stk.sticker', { emoji: sticker.emoji })}
      className="group grid w-full min-w-0 place-items-center rounded-[var(--radius-card)] hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]"
      style={{ height: cell }}
    >
      <span className="grid place-items-center transition-transform duration-[var(--motion-fast)] motion-safe:group-hover:scale-[1.12] motion-safe:group-focus-visible:scale-[1.12]">
        <StickerImage sticker={sticker} size={img} playing={sticker.animated && hot && !reduce} />
      </span>
      {anchor ? <Preview sticker={sticker} anchor={anchor} playing={sticker.animated && !reduce} /> : null}
    </button>
  );
}

/** The enlarged sticker over the hovered tile (under it when the top is too close), in a portal. */
function Preview({ sticker, anchor, playing }: { sticker: Sticker; anchor: DOMRect; playing: boolean }): ReactNode {
  const gap = 8;
  const above = anchor.top - PREVIEW - gap >= 8;
  const top = above ? anchor.top - PREVIEW - gap : anchor.bottom + gap;
  const left = Math.max(8, Math.min(window.innerWidth - PREVIEW - 8, anchor.left + anchor.width / 2 - PREVIEW / 2));
  return createPortal(
    <div
      className="anim-in pointer-events-none fixed z-[var(--z-tooltip)] grid place-items-center drop-shadow-[0_4px_16px_rgb(0_0_0/0.35)]"
      style={{ top, left, width: PREVIEW, height: PREVIEW }}
      data-testid="sticker-preview"
      aria-hidden
    >
      <StickerImage sticker={sticker} size={PREVIEW} playing={playing} />
    </div>,
    document.body,
  );
}

function Available({ packs }: { packs: readonly StickerPack[] }): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <ul className="flex flex-col gap-1">
      {packs.map((p) => {
        const c = coverOf(p);
        return (
          <li key={p.id} className="flex items-center gap-3 rounded-[var(--radius-row)] px-1 py-1">
            {c ? <StickerImage sticker={c} size={36} playing={false} /> : <span className="size-9" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-medium text-fg">{p.name}</p>
              <p className="text-caption text-muted">{plural('stk.count', p.stickers.length, { n: p.stickers.length })}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              busy={busy === p.id}
              onClick={() => {
                setBusy(p.id);
                void installPack(p).finally(() => setBusy(null));
              }}
            >
              {t('stk.add')}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function PackTab({ id, label, active, onClick, children }: { id: string; label: string; active: boolean; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-current={active || undefined}
        data-pack-tab={id}
        onClick={onClick}
        className={cx(
          'relative grid size-11 shrink-0 place-items-center rounded-[var(--radius-icon)] hover:bg-hover hover:text-fg',
          active ? 'bg-[var(--color-fill)] text-accent' : 'text-muted',
        )}
      >
        {children}
      </button>
    </Tip>
  );
}
