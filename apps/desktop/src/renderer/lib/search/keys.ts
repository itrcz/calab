/**
 * ⌘K keyboard model (ADR-0062 §4): ↑↓ move, ↩ opens (the row's first action), ⇧↩ its second
 * action, ⌘↩ / Ctrl+↩ «Все результаты» of the row's section, Tab / ⇧Tab jump to the first row of
 * the next / previous section (wrapping). Rows are given by their section ids, in order.
 */
export type SwitcherOutcome =
  | { kind: 'move'; index: number }
  | { kind: 'open'; index: number; second: boolean }
  | { kind: 'all'; index: number }
  | { kind: 'none' };

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
}

/** First rows of each section, in order. */
export function sectionStarts(sections: readonly string[]): number[] {
  const out: number[] = [];
  sections.forEach((s, i) => {
    if (i === 0 || sections[i - 1] !== s) out.push(i);
  });
  return out;
}

export function switcherKey(sections: readonly string[], cur: number, e: KeyLike): SwitcherOutcome {
  const n = sections.length;
  if (e.isComposing) return { kind: 'none' };
  switch (e.key) {
    case 'ArrowDown':
      return n ? { kind: 'move', index: Math.min(n - 1, cur + 1) } : { kind: 'none' };
    case 'ArrowUp':
      return n ? { kind: 'move', index: Math.max(0, cur - 1) } : { kind: 'none' };
    case 'Tab': {
      const starts = sectionStarts(sections);
      if (starts.length < 2) return { kind: 'none' };
      const at = starts.filter((s) => s <= cur).length - 1; // the section of the current row
      const next = e.shiftKey ? (at <= 0 ? starts.length - 1 : at - 1) : (at + 1) % starts.length;
      // ⇧Tab inside a section first goes to that section's start.
      const target = e.shiftKey && at >= 0 && starts[at] !== cur ? starts[at] : starts[next];
      return { kind: 'move', index: target ?? 0 };
    }
    case 'Enter':
      if (!n) return { kind: 'none' };
      if (e.metaKey || e.ctrlKey) return { kind: 'all', index: cur };
      return { kind: 'open', index: cur, second: e.shiftKey };
    default:
      return { kind: 'none' };
  }
}
