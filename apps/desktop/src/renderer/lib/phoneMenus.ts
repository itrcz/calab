import { closeKey, levelsToClose, stackPoses, subTitle, type StackCard } from './menuStack';
import { MOBILE_QUERY } from './phone';

/**
 * Menus on a phone (ADR-0073 §6, owner 07.10: «отказался бы от панелей снизу, а сделал их по
 * центру; если есть 2-й уровень — при клике немного зум и смещать влево окошко, и над ним показывать
 * следующий уровень»). Every Radix menu / popover card is centred by app/styles.css; this runtime
 * keeps the stack of open cards in step, for every menu of the app at once (no per-menu wiring):
 *  - marks each card's wrapper with its pose (`data-pm-depth`: 0 = the top card; `data-pm-base` on
 *    the bottom one, which alone draws the scrim) — the CSS zooms back, shifts and dims the cards
 *    under the top one;
 *  - gives a sub-level card a header «‹ <parent item>» that walks back one level;
 *  - a tap on a card under the top one returns to it (the levels above close), and is not an item
 *    tap (the scrim itself is the bottom card's wrapper, so a tap on it never reaches the app);
 *  - a sub-menu opens only by a tap: a hovering mouse (Chrome's device emulation, a trackpad on a
 *    tablet) never opens it or moves the highlight;
 *  - a card that opens while a finger is still held down (a long press: Radix ContextMenu's 700 ms
 *    on touch, Android's contextmenu) calls `onLongPressOpen` once — the haptic «impact» — and
 *    ends that press for the app: a `pointercancel` on the window. The finger's own pointer-up lands
 *    on the scrim and is swallowed (lib/mobile installSheetGuard), so press trackers on the window
 *    (kanban and board-list drags, the calendar's tap / drag) would otherwise stay armed and take
 *    the next tap in the menu for a drag or a tap on what is under it.
 * Events only (portals added / removed, a card's `data-state`): nothing runs while no menu is open.
 * Logic: lib/menuStack.ts (unit-tested). Returns the uninstall function.
 */

const WRAP = '[data-radix-popper-content-wrapper]';

/** The web client's phone layout (`:root.web` at ≤ 768 px); no lib/mobile import — it would pull the platform in. */
const isMobileNow = (): boolean => document.documentElement.classList.contains('web') && window.matchMedia(MOBILE_QUERY).matches;
const OPEN_CARD = '[data-pm-depth]';

/** The card of a popper wrapper: a menu / popover (`mat-popover`), never a tooltip. */
function cardOf(wrap: Element): HTMLElement | null {
  const c = wrap.firstElementChild;
  return c instanceof HTMLElement && c.classList.contains('mat-popover') && !c.classList.contains('tip') ? c : null;
}

/** A Radix sub-menu: labelled by its parent item (`menuitem` + `aria-haspopup="menu"`). */
export function isSubMenu(card: Element): boolean {
  if (card.getAttribute('role') !== 'menu') return false;
  const id = card.getAttribute('aria-labelledby');
  const trigger = id ? document.getElementById(id) : null;
  return !!trigger && trigger.getAttribute('aria-haspopup') === 'menu' && (trigger.getAttribute('role') ?? '').startsWith('menuitem');
}

function textDir(el: Element): 'ltr' | 'rtl' {
  return getComputedStyle(el).direction === 'rtl' ? 'rtl' : 'ltr';
}

/**
 * Closes one layer: a sub-menu back to its parent item, anything else as Esc does (Radix
 * dismisses the topmost layer). Also used by «back» (services/phoneNav.ts).
 */
export function closeLayer(el: Element): void {
  const wrap = el.closest(WRAP);
  const card = (wrap && cardOf(wrap)) ?? el;
  const key = closeKey({ sub: isSubMenu(card) }, textDir(card));
  // A sub-menu handles its close key on itself; Esc goes where the focus is (Radix listens on the document).
  const at = key === 'Escape' ? (document.activeElement instanceof HTMLElement ? document.activeElement : document.body) : card;
  at.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
}

/** The open cards, bottom → top. */
function openCards(): Array<{ wrap: HTMLElement; card: HTMLElement }> {
  const out: Array<{ wrap: HTMLElement; card: HTMLElement }> = [];
  for (const el of Array.from(document.body.children)) {
    if (!(el instanceof HTMLElement) || !el.matches(WRAP)) continue;
    const card = cardOf(el);
    if (card && card.getAttribute('data-state') !== 'closed') out.push({ wrap: el, card });
  }
  return out;
}

/** «‹ <parent item>» at the top of a sub-level (a real button: screen readers and Tab reach it). */
function ensureHeader(card: HTMLElement): void {
  if (card.querySelector(':scope > [data-pm-back]')) return;
  const id = card.getAttribute('aria-labelledby');
  const title = subTitle(id ? document.getElementById(id)?.textContent : '');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pm-back';
  btn.setAttribute('data-pm-back', '');
  // inside role=menu: a menu item of its own (not in Radix's roving collection — reached by a tap or Tab)
  btn.setAttribute('role', 'menuitem');
  btn.setAttribute('data-testid', 'menu-back');
  btn.setAttribute('aria-label', title ? `${backLabel()}: ${title}` : backLabel());
  // lucide «chevron-left», as the phone's PhoneBack
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  const label = document.createElement('span');
  label.textContent = title;
  btn.append(label);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeLayer(card);
  });
  card.prepend(btn);
}

let poseObserver: MutationObserver | null = null;
/** A press shorter than this that opens a card is a tap (a «…» button), not a long press. */
const LONG_PRESS_MIN_MS = 400;
/** The touch press in progress (its start), if any. */
let touchPress: { at: number; id: number } | null = null;
let openCount = 0;
let onLongPressOpen: (() => void) | undefined;
/** «Назад» in the app's language (given by main.tsx: this module stays free of the i18n / platform chain). */
let backLabel = (): string => 'Back';

function relayout(): void {
  const mobile = isMobileNow();
  const cards = mobile ? openCards() : [];
  if (cards.length > openCount && touchPress && performance.now() - touchPress.at >= LONG_PRESS_MIN_MS) {
    const { id } = touchPress;
    touchPress = null;
    onLongPressOpen?.();
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', isPrimary: true }));
  }
  openCount = cards.length;
  const poses = stackPoses(cards.map(({ card }): StackCard => ({ sub: isSubMenu(card) })));
  const live = new Set<Element>();
  cards.forEach(({ wrap, card }, i) => {
    const pose = poses[i];
    if (!pose) return;
    live.add(wrap);
    if (wrap.getAttribute('data-pm-depth') !== String(pose.depth)) wrap.setAttribute('data-pm-depth', String(pose.depth));
    wrap.toggleAttribute('data-pm-base', pose.base);
    wrap.toggleAttribute('data-pm-sub', pose.header);
    if (pose.header) ensureHeader(card);
    // A card scrolls inside (max height); its items are tabindex=-1 (roving focus), so the card itself
    // must be keyboard-reachable to scroll (axe scrollable-region-focusable).
    if (card.getAttribute('tabindex') !== '0') card.setAttribute('tabindex', '0');
    poseObserver?.observe(card, { attributes: true, attributeFilter: ['data-state'] });
  });
  // A card on its way out (exit animation) keeps the top pose; one no longer open drops its marks.
  for (const wrap of Array.from(document.querySelectorAll(OPEN_CARD))) {
    if (live.has(wrap)) continue;
    const card = cardOf(wrap);
    if (mobile && card?.getAttribute('data-state') === 'closed') wrap.setAttribute('data-pm-depth', '0');
    else {
      wrap.removeAttribute('data-pm-depth');
      wrap.removeAttribute('data-pm-base');
    }
  }
}

export function installPhoneMenus(opts: { backLabel: () => string; onLongPressOpen?: () => void }): () => void {
  backLabel = opts.backLabel;
  onLongPressOpen = opts.onLongPressOpen;
  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      relayout();
    });
  };
  poseObserver = new MutationObserver(schedule);
  const portals = new MutationObserver(schedule);
  portals.observe(document.body, { childList: true });

  // A card under the top one: a tap returns to it (the levels above close) and is not a tap on one
  // of its items — the press never reaches Radix (no outside-press dismissal, no focus move); its
  // pointer-up / click land on the card itself (its rows take no pointer events while it is behind).
  const onDown = (e: PointerEvent): void => {
    if (!isMobileNow() || !(e.target instanceof Element)) return;
    const wrap = e.target.closest(OPEN_CARD);
    const depth = Number(wrap?.getAttribute('data-pm-depth') ?? 0);
    if (!wrap || depth < 1) return;
    e.preventDefault();
    e.stopPropagation();
    for (let i = 0; i < levelsToClose(depth); i++) {
      const top = openCards().at(-1);
      if (top) closeLayer(top.card);
    }
  };
  // A hovering mouse inside a menu: no highlight, no sub-menu opening — a phone opens a level by a tap.
  const hover = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
    if (!(e.target instanceof Element) || !e.target.closest(WRAP) || !isMobileNow()) return;
    e.stopPropagation();
  };
  // A menu button opens on the tap's release, not on touch-down (owner 14.10: «⋯» fired by a stray
  // touch, a scroll that began on it). Radix DropdownMenu.Trigger toggles on `pointerdown`; for a
  // finger / pen that press is held back here (nothing else on the page sees it either: no outside-
  // press logic is involved while the menu is shut) and replayed as a mouse press on `click`, which
  // the browser never fires after a scroll or a cancelled touch.
  let held: Element | null = null;
  let replaying = false;
  const triggerOf = (t: EventTarget | null): HTMLElement | null => {
    const el = t instanceof Element ? t.closest('[aria-haspopup="menu"]') : null;
    return el instanceof HTMLElement && !(el.getAttribute('role') ?? '').startsWith('menuitem') ? el : null;
  };
  const holdOpen = (e: PointerEvent): void => {
    held = null;
    if (replaying || e.pointerType === 'mouse' || !isMobileNow()) return;
    const trg = triggerOf(e.target);
    if (!trg || (trg as HTMLButtonElement).disabled || trg.getAttribute('aria-expanded') === 'true') return;
    held = trg;
    e.stopPropagation();
  };
  const replayOpen = (e: MouseEvent): void => {
    const trg = held;
    held = null;
    if (!trg || !trg.contains(e.target as Node)) return;
    replaying = true;
    try {
      trg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true }));
    } finally {
      replaying = false;
    }
  };
  const dropHeld = (): void => {
    held = null;
  };
  document.addEventListener('pointerdown', holdOpen, true);
  document.addEventListener('click', replayOpen, true);
  document.addEventListener('pointercancel', dropHeld, true);
  const HOVER = ['pointermove', 'pointerover', 'pointerout'] as const;
  const onTouchDown = (e: PointerEvent): void => {
    touchPress = e.pointerType === 'touch' && e.isPrimary ? { at: e.timeStamp, id: e.pointerId } : null;
  };
  const onTouchEnd = (): void => {
    touchPress = null;
  };
  window.addEventListener('pointerdown', onTouchDown, true);
  window.addEventListener('pointerup', onTouchEnd, true);
  window.addEventListener('pointercancel', onTouchEnd, true);
  window.addEventListener('pointerdown', onDown, true);
  for (const type of HOVER) window.addEventListener(type, hover, true);
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener('change', schedule);
  return () => {
    document.removeEventListener('pointerdown', holdOpen, true);
    document.removeEventListener('click', replayOpen, true);
    document.removeEventListener('pointercancel', dropHeld, true);
    portals.disconnect();
    poseObserver?.disconnect();
    poseObserver = null;
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerdown', onTouchDown, true);
    window.removeEventListener('pointerup', onTouchEnd, true);
    window.removeEventListener('pointercancel', onTouchEnd, true);
    for (const type of HOVER) window.removeEventListener(type, hover, true);
    mq.removeEventListener('change', schedule);
  };
}
