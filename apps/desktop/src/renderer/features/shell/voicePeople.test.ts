import { describe, expect, it } from 'vitest';
import { cardOrder, firstNames, stackOrder, stackSlice } from './voicePeople';

describe('stackOrder', () => {
  it('keeps join order when nobody speaks and I am not in', () => {
    expect(stackOrder(['b', 'v', 'g'], 'a', [])).toEqual(['b', 'v', 'g']);
  });
  it('puts me first', () => {
    expect(stackOrder(['b', 'a', 'v'], 'a', [])).toEqual(['a', 'b', 'v']);
  });
  it('brings speakers forward after me, each group in join order', () => {
    expect(stackOrder(['b', 'v', 'g', 'a', 'd'], 'a', ['d', 'g'])).toEqual(['a', 'g', 'd', 'b', 'v']);
  });
  it('me first even when I speak and others too', () => {
    expect(stackOrder(['b', 'a'], 'a', ['a', 'b'])).toEqual(['a', 'b']);
  });
  it('ignores speakers who are not in the room', () => {
    expect(stackOrder(['b', 'v'], 'a', ['x'])).toEqual(['b', 'v']);
  });
});

describe('cardOrder', () => {
  it('me first, the rest in join order', () => {
    expect(cardOrder(['b', 'a', 'v'], 'a')).toEqual(['a', 'b', 'v']);
  });
  it('without me: as is', () => {
    expect(cardOrder(['b', 'v'], 'a')).toEqual(['b', 'v']);
  });
});

describe('stackSlice', () => {
  it('three avatars, no counter', () => {
    expect(stackSlice(['a', 'b', 'c'])).toEqual({ shown: ['a', 'b', 'c'], more: 0 });
  });
  it('more than three: the counter', () => {
    expect(stackSlice(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 });
  });
});

describe('firstNames', () => {
  it('first words, comma-separated (the aria label «В голосе: Борис, Вера»)', () => {
    expect(firstNames(['Борис Петров', ' Вера  Соколова ', 'Анна'])).toBe('Борис, Вера, Анна');
  });
  it('skips empty names', () => {
    expect(firstNames(['', 'Вера'])).toBe('Вера');
  });
});
