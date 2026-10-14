import { describe, expect, it, vi } from 'vitest';
import { filterBlocks } from './blocks';
import { MenuStore } from './menuStore';

describe('filterBlocks', () => {
  it('matches localized labels, English keys and markdown hints', () => {
    expect(filterBlocks('').length).toBeGreaterThan(10);
    expect(filterBlocks('заг').map((b) => b.id)).toEqual(['h1', 'h2', 'h3']);
    expect(filterBlocks('todo').map((b) => b.id)).toEqual(['task']);
    expect(filterBlocks('```').map((b) => b.id)).toEqual(['code']);
    expect(filterBlocks('табл').map((b) => b.id)).toEqual(['table']);
    expect(filterBlocks('zzz')).toEqual([]);
  });
});

describe('MenuStore keys', () => {
  it('moves, picks and closes', () => {
    const m = new MenuStore();
    const pick = vi.fn();
    const key = (k: string): boolean => m.key({ key: k, ctrlKey: false } as KeyboardEvent);
    expect(key('ArrowDown')).toBe(false); // closed: the editor gets the key
    m.set({ kind: 'slash', items: ['a', 'b', 'c'], index: 0, rect: null, pick });
    key('ArrowDown');
    key('ArrowDown');
    key('ArrowDown');
    expect(m.get()?.index).toBe(0);
    key('ArrowUp');
    expect(m.get()?.index).toBe(2);
    expect(key('Enter')).toBe(true);
    expect(pick).toHaveBeenCalledWith('c');
    expect(key('Escape')).toBe(true);
    expect(m.get()).toBeNull();
  });
});
