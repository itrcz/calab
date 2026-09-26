/**
 * Rebindable in-window shortcuts (docs/09 #18, «Горячие клавиши»). Pure: keys, labels,
 * matching and validation; services/hotkeys.ts listens, the settings page rebinds.
 *
 * A combo always includes the primary modifier (⌘ on macOS, Ctrl elsewhere) so it never fires
 * while typing. Keys are physical (`KeyboardEvent.code`), so they work on any layout
 * (review M8); for Latin letters `e.key` is also accepted (Dvorak/Colemak users keep their
 * letters).
 */
export type HotkeyAction = 'search' | 'mute' | 'deafen';

export interface Combo {
  /** KeyboardEvent.code, e.g. 'KeyK', 'Digit1', 'Slash'. */
  code: string;
  shift: boolean;
  alt: boolean;
}

export const HOTKEY_ACTIONS: HotkeyAction[] = ['search', 'mute', 'deafen'];

const MODIFIER_CODES = /^(Meta|Control|Shift|Alt|OS|CapsLock|Fn)/;

export const DEFAULT_HOTKEYS: Record<HotkeyAction, Combo> = {
  search: { code: 'KeyK', shift: false, alt: false },
  mute: { code: 'KeyM', shift: true, alt: false },
  deafen: { code: 'KeyD', shift: true, alt: false },
};

/**
 * The stored overrides that are usable (prefs come from localStorage: any shape): known actions,
 * `code` a plain KeyboardEvent.code, boolean modifiers, and no Alt off macOS (AltGr, see
 * comboProblem). Invalid entries are dropped → the default applies.
 */
export function validHotkeys(custom: unknown, mac: boolean): Partial<Record<HotkeyAction, Combo>> {
  const out: Partial<Record<HotkeyAction, Combo>> = {};
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return out;
  const raw = custom as Record<string, unknown>;
  for (const action of HOTKEY_ACTIONS) {
    const c = raw[action];
    if (!c || typeof c !== 'object') continue;
    const { code, shift, alt } = c as Record<string, unknown>;
    if (typeof code !== 'string' || !/^[A-Za-z0-9]+$/.test(code) || MODIFIER_CODES.test(code) || code === 'Escape') continue;
    if (typeof shift !== 'boolean' || typeof alt !== 'boolean') continue;
    if (alt && !mac) continue;
    out[action] = { code, shift, alt };
  }
  return out;
}

export function effectiveHotkeys(custom: unknown, mac: boolean): Record<HotkeyAction, Combo> {
  return { ...DEFAULT_HOTKEYS, ...validHotkeys(custom, mac) };
}

/** The combo of a key press, or null (no primary modifier, a lone modifier, Esc). */
export function comboFromEvent(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): Combo | null {
  const primary = mac ? e.metaKey : e.ctrlKey;
  if (!primary || !e.code || MODIFIER_CODES.test(e.code) || e.code === 'Escape') return null;
  return { code: e.code, shift: e.shiftKey, alt: e.altKey };
}

export function sameCombo(a: Combo, b: Combo): boolean {
  return a.code === b.code && a.shift === b.shift && a.alt === b.alt;
}

/** Does this key press trigger the combo? */
export function matchesCombo(e: Pick<KeyboardEvent, 'code' | 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, c: Combo, mac: boolean): boolean {
  const primary = mac ? e.metaKey : e.ctrlKey;
  if (!primary || e.shiftKey !== c.shift || e.altKey !== c.alt) return false;
  if (e.code === c.code) return true;
  // Latin letter by `e.key` (keyboard layouts that move letters).
  const letter = /^Key([A-Z])$/.exec(c.code)?.[1];
  return !!letter && e.key.length === 1 && e.key.toUpperCase() === letter;
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: '↩',
  Backspace: '⌫',
  Tab: '⇥',
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

function keyName(code: string): string {
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  if (m?.[1]) return m[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return KEY_NAMES[code] ?? code;
}

/** «⌘⇧M» on macOS, «Ctrl+Shift+M» elsewhere. */
export function comboLabel(c: Combo, mac: boolean): string {
  if (mac) return `⌘${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${keyName(c.code)}`;
  return `Ctrl+${c.alt ? 'Alt+' : ''}${c.shift ? 'Shift+' : ''}${keyName(c.code)}`;
}

/**
 * Combos the system or the app already uses: clipboard/undo/select-all, quit/close/hide/
 * minimise, the room-history keys, in-room search (⌘F), settings (⌘,), reload.
 */
const RESERVED: Array<{ code: string; shift?: boolean }> = [
  { code: 'KeyC' }, { code: 'KeyV' }, { code: 'KeyX' }, { code: 'KeyA' }, { code: 'KeyZ' }, { code: 'KeyZ', shift: true },
  { code: 'KeyQ' }, { code: 'KeyW' }, { code: 'KeyH' }, { code: 'KeyM' }, { code: 'KeyR' }, { code: 'KeyF' },
  { code: 'Comma' }, { code: 'BracketLeft' }, { code: 'BracketRight' },
];

/**
 * 'altgr': off macOS Ctrl+Alt is AltGr on many layouts (AltGr+Q = «@» on German), so a combo with
 * Alt would fire while typing characters.
 */
export type ComboProblem = 'reserved' | 'altgr' | { conflict: HotkeyAction };

export function comboProblem(action: HotkeyAction, c: Combo, all: Record<HotkeyAction, Combo>, mac: boolean): ComboProblem | null {
  if (c.alt && !mac) return 'altgr';
  if (!c.alt && RESERVED.some((r) => r.code === c.code && !!r.shift === c.shift)) return 'reserved';
  for (const other of HOTKEY_ACTIONS) {
    if (other !== action && sameCombo(all[other], c)) return { conflict: other };
  }
  return null;
}
