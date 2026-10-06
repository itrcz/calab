/**
 * The phone's menu stack (ADR-0073 §6, owner 07.10): menus, context menus and small pickers open as
 * centred cards; a sub-level (a Radix Sub, a picker opened from a menu) is one more card on top, the
 * card beneath zooms back, shifts left and dims. Pure logic; the DOM runtime is lib/phoneMenus.ts.
 */

/** An open card, bottom → top (the order its portal sits in <body>). */
export interface StackCard {
  /** A Radix sub-menu (its parent item is a `menuitem` with `aria-haspopup="menu"`). */
  sub: boolean;
}

export interface CardPose {
  /** How many cards lie above this one (0 = the top card, the one being used). */
  depth: number;
  /** The bottom card: the only one that draws the scrim. */
  base: boolean;
  /** The top card is a sub-level: it shows «‹ <parent item>». */
  header: boolean;
}

/** The deepest pose drawn differently (cards further down keep this one; they are hidden anyway). */
export const MAX_POSE = 3;

export function stackPoses(cards: readonly StackCard[]): CardPose[] {
  const n = cards.length;
  return cards.map((c, i) => ({ depth: Math.min(n - 1 - i, MAX_POSE), base: i === 0, header: c.sub }));
}

/**
 * How one level is closed: a sub-menu by the key that walks back to its parent item (Radix closes
 * just that level and returns the focus to the item), anything else by Esc (Radix dismisses the
 * topmost layer only).
 */
export function closeKey(card: StackCard, dir: 'ltr' | 'rtl' = 'ltr'): 'ArrowLeft' | 'ArrowRight' | 'Escape' {
  if (!card.sub) return 'Escape';
  return dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
}

/** A tap on a card `depth` levels below the top returns to it: that many levels close. */
export const levelsToClose = (depth: number): number => Math.max(0, depth);

/** The header of a sub-level: the parent item's label on one line («Создать задачу»). */
export function subTitle(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}
