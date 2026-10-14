import { describe, expect, it, vi } from 'vitest';
import { HAPTIC_DEDUPE_MS, HAPTIC_PATTERNS, createHaptics, haptics, type HapticEnv } from './haptics';

const vibrateSpy = (): ReturnType<typeof vi.fn<(ms: number) => void>> => vi.fn<(ms: number) => void>();

function env(over: Partial<HapticEnv> = {}): HapticEnv {
  let t = 1000;
  return { mobile: () => true, enabled: () => true, now: () => (t += 100), vibrate: vibrateSpy(), iosSwitch: vi.fn(() => true), ...over };
}

describe('haptics', () => {
  it('vibrates the pattern of each intent', () => {
    const vibrate = vibrateSpy();
    const iosSwitch = vi.fn(() => true);
    const h = createHaptics(env({ vibrate, iosSwitch }));
    h.tap();
    h.select();
    h.impact();
    h.toggle(true);
    h.toggle(false);
    expect(vibrate.mock.calls.map((c) => c[0])).toEqual([
      HAPTIC_PATTERNS.tap,
      HAPTIC_PATTERNS.select,
      HAPTIC_PATTERNS.impact,
      HAPTIC_PATTERNS.toggleOn,
      HAPTIC_PATTERNS.toggleOff,
    ]);
    expect(HAPTIC_PATTERNS.toggleOn).toBeGreaterThan(HAPTIC_PATTERNS.toggleOff);
    expect(iosSwitch).not.toHaveBeenCalled();
  });

  it('without the Vibration API falls back to the iOS switch; the native bridge wins over both', () => {
    const iosSwitch = vi.fn(() => true);
    createHaptics(env({ vibrate: undefined, iosSwitch })).tap();
    expect(iosSwitch).toHaveBeenCalledTimes(1);

    const native = vi.fn(() => true);
    const vibrate = vibrateSpy();
    createHaptics(env({ native, vibrate })).impact();
    expect(native).toHaveBeenCalledWith('impact');
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('is a no-op off the phone, with «Виброотклик» off, and where nothing is supported', () => {
    const desktop = vibrateSpy();
    createHaptics(env({ mobile: () => false, vibrate: desktop })).tap();
    expect(desktop).not.toHaveBeenCalled();

    let on = false;
    const vibrate = vibrateSpy();
    const h = createHaptics(env({ enabled: () => on, vibrate }));
    h.toggle(true);
    expect(vibrate).not.toHaveBeenCalled();
    on = true;
    h.toggle(true);
    expect(vibrate).toHaveBeenCalledTimes(1);

    expect(() => createHaptics(env({ vibrate: undefined, iosSwitch: undefined })).tap()).not.toThrow();
  });

  it('swallows a throwing browser and merges two requests of one tap', () => {
    const throwing = env({
      vibrate: () => {
        throw new Error('no user activation');
      },
    });
    expect(() => createHaptics(throwing).tap()).not.toThrow();

    let t = 0;
    const vibrate = vibrateSpy();
    const h = createHaptics(env({ now: () => t, vibrate }));
    h.select();
    t += HAPTIC_DEDUPE_MS - 1;
    h.toggle(true);
    expect(vibrate).toHaveBeenCalledTimes(1);
    t += HAPTIC_DEDUPE_MS;
    h.tap();
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it('the app instance is a no-op without a DOM (unit tests, Node)', () => {
    expect(() => {
      haptics.tap();
      haptics.toggle(true);
    }).not.toThrow();
  });
});
