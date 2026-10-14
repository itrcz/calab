/**
 * «Кто в голосе» on a phone (ADR-0073 §4, owner 13.10): the order of the avatar stack in a voice
 * room's header and of the rows of the «В голосе» card, and the stack's spoken label. Pure.
 */

/** Avatars shown in a stack; the rest is the «+N» counter. */
export const STACK_MAX = 3;

/**
 * The stack's order: me first (I see myself in the call at once), then whoever is speaking, then
 * the rest — each group in join order (`people` comes sorted by join time).
 */
export function stackOrder(people: readonly string[], me: string, speaking: readonly string[]): string[] {
  const talking = new Set(speaking);
  const mine = people.filter((id) => id === me);
  const loud = people.filter((id) => id !== me && talking.has(id));
  const rest = people.filter((id) => id !== me && !talking.has(id));
  return [...mine, ...loud, ...rest];
}

/** The card's rows: me first, the others in join order (no reordering while people speak). */
export function cardOrder(people: readonly string[], me: string): string[] {
  return people.includes(me) ? [me, ...people.filter((id) => id !== me)] : [...people];
}

/** What the stack shows: up to STACK_MAX avatars and how many more there are. */
export function stackSlice(order: readonly string[]): { shown: string[]; more: number } {
  return { shown: order.slice(0, STACK_MAX), more: Math.max(0, order.length - STACK_MAX) };
}

/** «Борис, Вера» — the first names of the people, in the given order. */
export function firstNames(names: readonly string[]): string {
  return names
    .map((n) => n.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)
    .join(', ');
}
