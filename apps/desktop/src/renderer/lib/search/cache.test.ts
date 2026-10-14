import { describe, expect, it } from 'vitest';
import { SearchCache } from './cache';

describe('SearchCache', () => {
  it('keeps the last 20 keys, least recently used out first', () => {
    const c = new SearchCache<number>(20, 60_000, () => 0);
    for (let i = 0; i < 20; i++) c.set(`k${i}`, i);
    expect(c.get('k0')).toBe(0); // k0 becomes the most recent
    c.set('k20', 20);
    expect(c.size).toBe(20);
    expect(c.get('k1')).toBeUndefined(); // the oldest untouched one went
    expect(c.get('k0')).toBe(0);
    expect(c.get('k20')).toBe(20);
  });

  it('forgets an answer after 60 s', () => {
    let now = 1000;
    const c = new SearchCache<string>(20, 60_000, () => now);
    c.set('q', 'a');
    now += 59_999;
    expect(c.get('q')).toBe('a');
    now += 1;
    expect(c.get('q')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('set refreshes the value and its age', () => {
    let now = 0;
    const c = new SearchCache<string>(2, 1000, () => now);
    c.set('a', '1');
    now = 900;
    c.set('a', '2');
    now = 1500;
    expect(c.get('a')).toBe('2');
    c.clear();
    expect(c.get('a')).toBeUndefined();
  });
});
