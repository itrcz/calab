import { describe, expect, it } from 'vitest';
import { MENU_ACCELERATORS } from '../../shared/menu';
import { DEFAULT_HOTKEYS, comboAccelerator, comboFromEvent, comboLabel, comboProblem, effectiveHotkeys, matchesCombo, validHotkeys, type Combo } from './shortcuts';

const ev = (code: string, key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  key,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('in-window shortcuts', () => {
  it('captures a combo only with the primary modifier and a real key', () => {
    expect(comboFromEvent(ev('KeyJ', 'j', { meta: true, shift: true }), true)).toEqual({ code: 'KeyJ', shift: true, alt: false });
    expect(comboFromEvent(ev('KeyJ', 'j', { ctrl: true }), true)).toBeNull(); // Ctrl is not primary on macOS
    expect(comboFromEvent(ev('KeyJ', 'j', { ctrl: true }), false)).toEqual({ code: 'KeyJ', shift: false, alt: false });
    expect(comboFromEvent(ev('ShiftLeft', 'Shift', { meta: true, shift: true }), true)).toBeNull();
    expect(comboFromEvent(ev('KeyJ', 'j'), true)).toBeNull();
  });

  it('matches physical keys on any layout and Latin letters by key', () => {
    const m: Combo = DEFAULT_HOTKEYS.mute;
    expect(matchesCombo(ev('KeyM', 'ь', { meta: true, shift: true }), m, true)).toBe(true); // Russian layout
    expect(matchesCombo(ev('Semicolon', 'm', { meta: true, shift: true }), m, true)).toBe(true); // Dvorak-like
    expect(matchesCombo(ev('KeyM', 'm', { meta: true }), m, true)).toBe(false); // no shift
    expect(matchesCombo(ev('KeyM', 'm', { ctrl: true, shift: true }), m, false)).toBe(true);
  });

  it('labels per platform', () => {
    expect(comboLabel(DEFAULT_HOTKEYS.mute, true)).toBe('⌘⇧M');
    expect(comboLabel(DEFAULT_HOTKEYS.search, false)).toBe('Ctrl+K');
    expect(comboLabel({ code: 'Digit1', shift: false, alt: true }, true)).toBe('⌘⌥1');
    expect(comboLabel({ code: 'Slash', shift: true, alt: false }, false)).toBe('Ctrl+Shift+/');
  });

  it('rejects reserved system combos and conflicts, overrides merge with defaults', () => {
    const all = effectiveHotkeys({ search: { code: 'KeyP', shift: false, alt: false } }, true);
    expect(all.search.code).toBe('KeyP');
    expect(all.mute).toEqual(DEFAULT_HOTKEYS.mute);
    expect(comboProblem('search', { code: 'KeyQ', shift: false, alt: false }, all, true)).toBe('reserved');
    expect(comboProblem('search', { code: 'KeyM', shift: false, alt: false }, all, true)).toBe('reserved'); // ⌘M minimise
    expect(comboProblem('search', { code: 'KeyM', shift: true, alt: false }, all, true)).toEqual({ conflict: 'mute' });
    expect(comboProblem('search', { code: 'KeyJ', shift: false, alt: false }, all, true)).toBeNull();
    expect(comboProblem('mute', { code: 'KeyQ', shift: false, alt: true }, all, true)).toBeNull(); // ⌘⌥Q is free
  });

  it('accelerators for the macOS menu match the bindings', () => {
    expect(comboAccelerator(DEFAULT_HOTKEYS.search, true)).toBe('Command+K');
    expect(comboAccelerator(DEFAULT_HOTKEYS.mute, true)).toBe('Command+Shift+M');
    expect(comboAccelerator(DEFAULT_HOTKEYS.deafen, true)).toBe('Command+Shift+D');
    expect(comboAccelerator({ code: 'Slash', shift: false, alt: true }, true)).toBe('Command+Alt+/');
    expect(comboAccelerator({ code: 'Numpad3', shift: false, alt: false }, false)).toBe('Control+num3');
    expect(comboAccelerator({ code: 'F5', shift: true, alt: false }, true)).toBe('Command+Shift+F5');
    expect(comboAccelerator({ code: 'IntlRo', shift: false, alt: false }, true)).toBe('');
  });

  it('the menu-only accelerators (⌘N, ⌘, ⌘1…⌘9) cannot be taken by a rebindable shortcut', () => {
    const all = effectiveHotkeys({}, true);
    const fixed = [MENU_ACCELERATORS.newMessage, MENU_ACCELERATORS.settings, ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => MENU_ACCELERATORS.workspace(i) ?? '')];
    expect(MENU_ACCELERATORS.workspace(9)).toBeUndefined();
    for (const a of fixed) {
      const key = a.replace('CommandOrControl+', '');
      const code = key === ',' ? 'Comma' : /^\d$/.test(key) ? `Digit${key}` : `Key${key}`;
      expect(comboProblem('search', { code, shift: false, alt: false }, all, true)).toBe('reserved');
    }
    // …and the defaults do not collide with them.
    for (const c of Object.values(DEFAULT_HOTKEYS)) expect(fixed).not.toContain(comboAccelerator(c, true).replace('Command+', 'CommandOrControl+'));
  });

  it('off macOS refuses Alt combos (Ctrl+Alt = AltGr on many layouts)', () => {
    const all = effectiveHotkeys({}, false);
    expect(comboProblem('mute', { code: 'KeyQ', shift: false, alt: true }, all, false)).toBe('altgr');
    expect(comboProblem('mute', { code: 'KeyJ', shift: true, alt: true }, all, false)).toBe('altgr');
    expect(comboProblem('mute', { code: 'KeyJ', shift: true, alt: false }, all, false)).toBeNull();
  });

  it('stored overrides are shape-validated; invalid entries fall back to the default', () => {
    const stored: unknown = {
      search: { code: 'KeyP', shift: false, alt: false },
      mute: { code: 'Key M', shift: true, alt: false }, // not a KeyboardEvent.code
      deafen: { code: 'KeyD', shift: 'yes', alt: false },
      bogus: { code: 'KeyB', shift: false, alt: false },
    };
    expect(validHotkeys(stored, true)).toEqual({ search: { code: 'KeyP', shift: false, alt: false } });
    const all = effectiveHotkeys(stored, true);
    expect(all.mute).toEqual(DEFAULT_HOTKEYS.mute);
    expect(all.deafen).toEqual(DEFAULT_HOTKEYS.deafen);
    for (const junk of [null, undefined, 'x', 42, [], { search: null }, { search: { code: 1, shift: false, alt: false } }]) {
      expect(effectiveHotkeys(junk, true)).toEqual(DEFAULT_HOTKEYS);
    }
    expect(validHotkeys({ search: { code: 'ShiftLeft', shift: false, alt: false } }, true)).toEqual({});
    expect(validHotkeys({ search: { code: 'Escape', shift: false, alt: false } }, true)).toEqual({});
    // An Alt combo stored earlier is dropped off macOS, kept on macOS.
    const alt = { search: { code: 'KeyJ', shift: false, alt: true } };
    expect(validHotkeys(alt, false)).toEqual({});
    expect(validHotkeys(alt, true)).toEqual(alt);
  });
});
