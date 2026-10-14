import { BoardStatusType, resolveStatusIcon } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { PIE_SHARE, piePath } from './visuals';

/** The end point of a pie path's arc: the last two numbers before «Z». */
function arcEnd(d: string): [number, number] {
  const n = d.replace(/Z$/, '').trim().split(/[ A-Z]+/).filter(Boolean).map(Number);
  return [n[n.length - 2] ?? NaN, n[n.length - 1] ?? NaN];
}

describe('status icon (ADR-0093)', () => {
  it('draws the pie share clockwise from 12 o’clock', () => {
    expect(piePath(0)).toBe('');
    expect(arcEnd(piePath(0.25))).toEqual([10.5, 7]);
    expect(arcEnd(piePath(0.5))).toEqual([7, 10.5]);
    expect(arcEnd(piePath(0.75))).toEqual([3.5, 7]);
    // the large-arc flag only past a half
    expect(piePath(0.5)).toContain(' 0 0 1 ');
    expect(piePath(0.75)).toContain(' 0 1 1 ');
    // the whole disc: two half arcs
    expect(piePath(1).match(/A/g)).toHaveLength(2);
    expect(piePath(2)).toBe(piePath(1));
  });
  it('maps the pie tokens to quarter / half / three quarters', () => {
    expect(PIE_SHARE).toEqual({ quarter: 0.25, half: 0.5, 'three-quarters': 0.75 });
  });
  it('picks the token by type when the status has none', () => {
    expect(resolveStatusIcon('', BoardStatusType.STARTED)).toBe('half');
    expect(resolveStatusIcon(undefined, BoardStatusType.BACKLOG)).toBe('dashed');
    expect(resolveStatusIcon('eye', BoardStatusType.STARTED)).toBe('eye');
    expect(resolveStatusIcon('gone', BoardStatusType.CANCELLED)).toBe('x');
  });
});
