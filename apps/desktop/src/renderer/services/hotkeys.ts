import type { MessageKey } from '../i18n';
import { comboLabel, effectiveHotkeys, matchesCombo, type HotkeyAction } from '../lib/shortcuts';
import { usePrefs } from '../stores/prefs';
import { useUi } from '../stores/ui';
import { voice } from './voice';

/**
 * In-window shortcuts (docs/08, «UX-правила»; docs/09 #18): quick switcher (⌘/Ctrl+K), mute
 * (⌘/Ctrl+Shift+M) and deafen (⌘/Ctrl+Shift+D) are rebindable in Настройки → Горячие клавиши
 * (prefs.hotkeys, lib/shortcuts.ts). Room history (⌘[ ⌘] / Alt+← →) and Esc follow the OS.
 * Esc closes the top layer (Radix dialogs/menus handle it themselves).
 */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac OS X|Macintosh/.test(navigator.userAgent);

/** Current label of a rebindable shortcut («⌘⇧M» / «Ctrl+Shift+M»). */
export function hotkeyLabel(action: HotkeyAction): string {
  return comboLabel(effectiveHotkeys(usePrefs.getState().hotkeys, IS_MAC)[action], IS_MAC);
}

/** Reactive variant for tooltips / kbd hints. */
export function useHotkeyLabel(action: HotkeyAction): string {
  const custom = usePrefs((s) => s.hotkeys);
  return comboLabel(effectiveHotkeys(custom, IS_MAC)[action], IS_MAC);
}

/** Room history: ⌘[ / ⌘] on macOS (Finder, Safari), Alt+← / Alt+→ on Windows/Linux. */
export const NAV_SHORTCUTS = IS_MAC ? { back: '⌘[', forward: '⌘]' } : { back: 'Alt+←', forward: 'Alt+→' };

/** Everything listed in the «?» help popover of the title bar. */
export function shortcutHelp(): Array<{ keys: string; label: MessageKey; action?: HotkeyAction }> {
  return [
    { keys: hotkeyLabel('search'), label: 'shell.kbd.search', action: 'search' },
    { keys: NAV_SHORTCUTS.back, label: 'shell.kbd.back' },
    { keys: NAV_SHORTCUTS.forward, label: 'shell.kbd.forward' },
    { keys: hotkeyLabel('mute'), label: 'shell.kbd.mute', action: 'mute' },
    { keys: hotkeyLabel('deafen'), label: 'shell.kbd.deafen', action: 'deafen' },
    { keys: 'Esc', label: 'shell.kbd.esc' },
  ];
}

// e.code: layout-independent (on a Russian layout `[` is «х»).
const isNavBack = (e: KeyboardEvent): boolean =>
  IS_MAC ? e.metaKey && !e.shiftKey && !e.altKey && e.code === 'BracketLeft' : e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft';
const isNavForward = (e: KeyboardEvent): boolean =>
  IS_MAC ? e.metaKey && !e.shiftKey && !e.altKey && e.code === 'BracketRight' : e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowRight';

/**
 * The letter of a shortcut: `e.key` when it is a Latin letter (keeps Dvorak/Colemak users on
 * their own letters), else the physical key from `e.code` — on the Russian layout ⌘K gives
 * `e.key === 'л'` (review M8).
 */
export function shortcutLetter(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
}

/**
 * While the settings page records a new combo, shortcuts must not fire. Per-owner tokens: one
 * row's cleanup must not end another row's capture.
 */
const captures = new Set<symbol>();
/** Starts a capture; call the returned function to end exactly that one. */
export function beginHotkeyCapture(): () => void {
  const token = Symbol('hotkey-capture');
  captures.add(token);
  return () => {
    captures.delete(token);
  };
}
export function hotkeyCaptureActive(): boolean {
  return captures.size > 0;
}

export function installHotkeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' && !mod) {
      // The floating members panel is a layer too (dialogs/menus close themselves).
      const ui = useUi.getState();
      if (ui.membersOverlay && !ui.dialog && !e.defaultPrevented) ui.setMembersOverlay(false);
      return;
    }
    if (isNavBack(e)) {
      e.preventDefault();
      useUi.getState().goBack();
      return;
    }
    if (isNavForward(e)) {
      e.preventDefault();
      useUi.getState().goForward();
      return;
    }
    if (!mod || hotkeyCaptureActive()) return;
    const keys = effectiveHotkeys(usePrefs.getState().hotkeys, IS_MAC);
    if (matchesCombo(e, keys.search, IS_MAC)) {
      e.preventDefault();
      const ui = useUi.getState();
      ui.openDialog(ui.dialog?.kind === 'quick-switcher' ? null : { kind: 'quick-switcher' });
    } else if (matchesCombo(e, keys.mute, IS_MAC)) {
      e.preventDefault();
      voice.toggleMute();
    } else if (matchesCombo(e, keys.deafen, IS_MAC)) {
      e.preventDefault();
      voice.toggleDeafen();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
