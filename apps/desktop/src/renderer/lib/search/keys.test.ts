import { describe, expect, it } from 'vitest';
import { sectionStarts, switcherKey } from './keys';

const k = (key: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }> = {}) => ({ key, shiftKey: false, metaKey: false, ctrlKey: false, ...mods });

// key-match task, 2 rooms, 3 message rows (2 hits + «Все»), 2 task rows.
const rows = ['key', 'room', 'room', 's:messages', 's:messages', 's:messages', 's:tasks', 's:tasks'];

describe('⌘K keys', () => {
  it('section starts', () => {
    expect(sectionStarts(rows)).toEqual([0, 1, 3, 6]);
    expect(sectionStarts([])).toEqual([]);
  });

  it('↑↓ move within bounds', () => {
    expect(switcherKey(rows, 0, k('ArrowDown'))).toEqual({ kind: 'move', index: 1 });
    expect(switcherKey(rows, 7, k('ArrowDown'))).toEqual({ kind: 'move', index: 7 });
    expect(switcherKey(rows, 0, k('ArrowUp'))).toEqual({ kind: 'move', index: 0 });
    expect(switcherKey([], 0, k('ArrowDown'))).toEqual({ kind: 'none' });
  });

  it('Tab: the next section, wrapping; ⇧Tab: this section’s start, then the previous one', () => {
    expect(switcherKey(rows, 0, k('Tab'))).toEqual({ kind: 'move', index: 1 });
    expect(switcherKey(rows, 2, k('Tab'))).toEqual({ kind: 'move', index: 3 });
    expect(switcherKey(rows, 4, k('Tab'))).toEqual({ kind: 'move', index: 6 });
    expect(switcherKey(rows, 7, k('Tab'))).toEqual({ kind: 'move', index: 0 });
    expect(switcherKey(rows, 4, k('Tab', { shiftKey: true }))).toEqual({ kind: 'move', index: 3 });
    expect(switcherKey(rows, 3, k('Tab', { shiftKey: true }))).toEqual({ kind: 'move', index: 1 });
    expect(switcherKey(rows, 0, k('Tab', { shiftKey: true }))).toEqual({ kind: 'move', index: 6 });
  });

  it('one section: Tab is left to the browser (focus the row buttons)', () => {
    expect(switcherKey(['room', 'room'], 0, k('Tab'))).toEqual({ kind: 'none' });
  });

  it('↩ opens, ⇧↩ the second action, ⌘↩ / Ctrl+↩ all results', () => {
    expect(switcherKey(rows, 3, k('Enter'))).toEqual({ kind: 'open', index: 3, second: false });
    expect(switcherKey(rows, 1, k('Enter', { shiftKey: true }))).toEqual({ kind: 'open', index: 1, second: true });
    expect(switcherKey(rows, 4, k('Enter', { metaKey: true }))).toEqual({ kind: 'all', index: 4 });
    expect(switcherKey(rows, 4, k('Enter', { ctrlKey: true }))).toEqual({ kind: 'all', index: 4 });
    expect(switcherKey([], 0, k('Enter'))).toEqual({ kind: 'none' });
  });

  it('IME composition and other keys are ignored', () => {
    expect(switcherKey(rows, 0, k('Enter', { isComposing: true }))).toEqual({ kind: 'none' });
    expect(switcherKey(rows, 0, k('a'))).toEqual({ kind: 'none' });
  });
});
