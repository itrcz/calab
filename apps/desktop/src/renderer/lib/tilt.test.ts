import { describe, expect, it } from 'vitest';
import { TILT_MAX_DEG, tiltAllowed, tiltAngles, tiltTransform } from './tilt';

const box = { left: 100, top: 100, width: 160, height: 160 };

describe('tiltAngles', () => {
  it('is flat at the centre', () => {
    expect(tiltAngles(180, 180, box)).toEqual({ rx: 0, ry: 0 });
  });
  it('leans toward the cursor, at most 6° at the edges', () => {
    expect(tiltAngles(260, 180, box)).toEqual({ rx: 0, ry: TILT_MAX_DEG });
    expect(tiltAngles(100, 180, box)).toEqual({ rx: 0, ry: -TILT_MAX_DEG });
    expect(tiltAngles(180, 100, box)).toEqual({ rx: TILT_MAX_DEG, ry: 0 });
    expect(tiltAngles(220, 220, box)).toEqual({ rx: -3, ry: 3 });
  });
  it('clamps a pointer outside the box to 6°', () => {
    expect(tiltAngles(9999, -9999, box)).toEqual({ rx: TILT_MAX_DEG, ry: TILT_MAX_DEG });
  });
  it('is 0 when not allowed (reduced motion, low-end, touch) or the box is empty', () => {
    expect(tiltAngles(260, 100, box, false)).toEqual({ rx: 0, ry: 0 });
    expect(tiltAngles(260, 100, { ...box, width: 0 })).toEqual({ rx: 0, ry: 0 });
  });
});

describe('tiltAllowed', () => {
  it('only without reduced motion, the low-end mode and on a hover pointer', () => {
    expect(tiltAllowed({ reducedMotion: false, lowEnd: false, touchOnly: false })).toBe(true);
    expect(tiltAllowed({ reducedMotion: true, lowEnd: false, touchOnly: false })).toBe(false);
    expect(tiltAllowed({ reducedMotion: false, lowEnd: true, touchOnly: false })).toBe(false);
    expect(tiltAllowed({ reducedMotion: false, lowEnd: false, touchOnly: true })).toBe(false);
  });
});

it('tiltTransform', () => {
  expect(tiltTransform({ rx: 1.5, ry: -2 })).toBe('perspective(600px) rotateX(1.5deg) rotateY(-2deg)');
});
