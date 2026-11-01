import { beforeEach, describe, expect, it } from 'vitest';
import { isBlocked, selectBlocked, useBlocks } from './blocks';

describe('blocks store (ADR-0154)', () => {
  beforeEach(() => useBlocks.getState().reset());

  it('loads, blocks and unblocks one user', () => {
    expect(selectBlocked('a')(useBlocks.getState())).toBe(false);
    useBlocks.getState().setAll(['a', 'b']);
    expect(isBlocked('a')).toBe(true);
    useBlocks.getState().setOne('a', false);
    expect(isBlocked('a')).toBe(false);
    expect(isBlocked('b')).toBe(true);
  });

  it('keeps the state object when nothing changes (no re-render of the rows)', () => {
    useBlocks.getState().setAll(['a']);
    const before = useBlocks.getState();
    useBlocks.getState().setOne('a', true);
    useBlocks.getState().setOne('z', false);
    expect(useBlocks.getState()).toBe(before);
  });

  it('reveals a hidden message once, for this session', () => {
    useBlocks.getState().reveal('m1');
    const s = useBlocks.getState();
    useBlocks.getState().reveal('m1');
    expect(useBlocks.getState()).toBe(s);
    expect(s.revealed['m1']).toBe(true);
    useBlocks.getState().reset();
    expect(useBlocks.getState().revealed).toEqual({});
  });
});
