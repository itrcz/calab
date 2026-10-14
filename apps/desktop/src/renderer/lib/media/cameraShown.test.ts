import { describe, expect, it, vi } from 'vitest';
import { CameraShown, RELEASE_MS } from './cameraShown';

const flush = (): Promise<void> => new Promise((r) => queueMicrotask(r));

function setup() {
  vi.useFakeTimers();
  const onChange = vi.fn();
  const shown = new CameraShown(onChange, { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) });
  return { shown, onChange };
}

describe('CameraShown (ADR-0066 §4: subscribe what is on screen)', () => {
  it('a claim shows at once; a release lingers 3 s, then the camera is gone', async () => {
    const { shown, onChange } = setup();
    const release = shown.claim('a', 'high');
    expect(shown.quality('a')).toBe('high');
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    release();
    vi.advanceTimersByTime(RELEASE_MS - 1);
    expect(shown.quality('a')).toBe('high');
    expect([...shown.ids()]).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(shown.quality('a')).toBeNull();
    await flush();
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('flipping back within 3 s does not touch the subscription', async () => {
    const { shown, onChange } = setup();
    const r1 = shown.claim('a', 'medium');
    await flush();
    onChange.mockClear();
    r1();
    vi.advanceTimersByTime(1000);
    shown.claim('a', 'medium');
    vi.advanceTimersByTime(RELEASE_MS * 2);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(shown.quality('a')).toBe('medium');
    vi.useRealTimers();
  });

  it('several elements: the highest layer wins; releasing the large one drops to medium', async () => {
    const { shown, onChange } = setup();
    shown.claim('a', 'medium');
    const big = shown.claim('a', 'high');
    expect(shown.quality('a')).toBe('high');
    await flush();
    onChange.mockClear();
    big();
    expect(shown.quality('a')).toBe('medium');
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('a page flip of 25 claims notifies once; a double release is harmless', async () => {
    const { shown, onChange } = setup();
    const rel = Array.from({ length: 25 }, (_, i) => shown.claim(`u${i}`, 'medium'));
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    rel[0]?.();
    rel[0]?.();
    vi.advanceTimersByTime(RELEASE_MS);
    expect(shown.ids().size).toBe(24);
    vi.useRealTimers();
  });
});
