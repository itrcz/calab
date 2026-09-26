import { describe, expect, it, vi } from 'vitest';

vi.mock('./voice', () => ({ voice: {} }));
vi.mock('../stores/ui', () => ({ useUi: { getState: () => ({}) } }));

const { beginHotkeyCapture, hotkeyCaptureActive, shortcutLetter } = await import('./hotkeys');

describe('shortcutLetter (review M8)', () => {
  it('uses the Latin letter when the layout gives one', () => {
    expect(shortcutLetter({ key: 'k', code: 'KeyK' })).toBe('k');
    expect(shortcutLetter({ key: 'M', code: 'KeyM' })).toBe('m'); // Shift
  });
  it('falls back to the physical key on non-Latin layouts (Russian)', () => {
    expect(shortcutLetter({ key: 'л', code: 'KeyK' })).toBe('k');
    expect(shortcutLetter({ key: 'Ь', code: 'KeyM' })).toBe('m');
    expect(shortcutLetter({ key: 'в', code: 'KeyD' })).toBe('d');
  });
  it('ignores non-letter keys', () => {
    expect(shortcutLetter({ key: '[', code: 'BracketLeft' })).toBe('');
    expect(shortcutLetter({ key: 'Enter', code: 'Enter' })).toBe('');
  });
});

describe('hotkey capture (review pass 3 L)', () => {
  it("one owner's cleanup does not end another's capture; ending twice is harmless", () => {
    expect(hotkeyCaptureActive()).toBe(false);
    const endA = beginHotkeyCapture();
    const endB = beginHotkeyCapture();
    endA();
    expect(hotkeyCaptureActive()).toBe(true);
    endA();
    expect(hotkeyCaptureActive()).toBe(true);
    endB();
    expect(hotkeyCaptureActive()).toBe(false);
  });
});
