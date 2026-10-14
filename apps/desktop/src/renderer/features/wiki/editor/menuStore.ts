/**
 * The state of the editor's one suggestion popover (`/` blocks or `@` people): written by the
 * Tiptap suggestion renderers, read by <SuggestionMenu> with useSyncExternalStore. Keeps the
 * popover out of the editor's React tree (no re-render of the editor while typing a query).
 */
export interface MenuState<T = unknown> {
  kind: 'slash' | 'mention';
  items: T[];
  index: number;
  /** Caret rectangle (viewport coordinates) the popover hangs from. */
  rect: { left: number; top: number; bottom: number } | null;
  pick: (item: T) => void;
}

export class MenuStore {
  private state: MenuState | null = null;
  private readonly subs = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  };

  get = (): MenuState | null => this.state;

  set(next: MenuState | null): void {
    this.state = next;
    for (const s of this.subs) s();
  }

  /** Keyboard handling shared by both menus; true when the key was consumed. */
  key(e: KeyboardEvent): boolean {
    const s = this.state;
    if (!s) return false;
    const n = s.items.length;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      if (n) this.set({ ...s, index: (s.index + 1) % n });
      return true;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      if (n) this.set({ ...s, index: (s.index - 1 + n) % n });
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const item = s.items[s.index];
      if (item === undefined) return e.key === 'Enter' ? false : true;
      s.pick(item);
      return true;
    }
    if (e.key === 'Escape') {
      this.set(null);
      return true;
    }
    return false;
  }
}

export function rectOf(clientRect: (() => DOMRect | null) | null | undefined): MenuState['rect'] {
  const r = clientRect?.();
  return r ? { left: r.left, top: r.top, bottom: r.bottom } : null;
}
