import { describe, expect, it } from 'vitest';
import { closeKey, levelsToClose, MAX_POSE, stackPoses, subTitle } from './menuStack';

describe('phone menu stack (owner 07.10: centred cards, sub-levels stacked)', () => {
  it('one menu: the top card, with the scrim, no header', () => {
    expect(stackPoses([{ sub: false }])).toEqual([{ depth: 0, base: true, header: false }]);
  });

  it('a sub-level: the parent goes one level back, the sub is on top with «‹ parent»', () => {
    expect(stackPoses([{ sub: false }, { sub: true }])).toEqual([
      { depth: 1, base: true, header: false },
      { depth: 0, base: false, header: true },
    ]);
  });

  it('any depth: each level one step further back, capped', () => {
    const poses = stackPoses([{ sub: false }, { sub: true }, { sub: true }, { sub: true }, { sub: true }, { sub: true }]);
    expect(poses.map((p) => p.depth)).toEqual([MAX_POSE, MAX_POSE, 3, 2, 1, 0]);
    expect(poses.filter((p) => p.base)).toHaveLength(1);
  });

  it('nothing open: nothing to pose', () => {
    expect(stackPoses([])).toEqual([]);
  });

  it('a sub-level closes by walking back to its item; anything else by Esc', () => {
    expect(closeKey({ sub: true })).toBe('ArrowLeft');
    expect(closeKey({ sub: true }, 'rtl')).toBe('ArrowRight');
    expect(closeKey({ sub: false })).toBe('Escape');
    expect(closeKey({ sub: false }, 'rtl')).toBe('Escape');
  });

  it('a tap on a card below the top returns to it', () => {
    expect(levelsToClose(1)).toBe(1);
    expect(levelsToClose(2)).toBe(2);
    expect(levelsToClose(0)).toBe(0);
    expect(levelsToClose(-1)).toBe(0);
  });

  it('the header is the parent item on one line', () => {
    expect(subTitle('  Создать\n  задачу ')).toBe('Создать задачу');
    expect(subTitle(null)).toBe('');
  });
});
