import type { MenuItemConstructorOptions } from 'electron';
import type { MainStrings } from '../shared/ipc';

/** The slice of Electron's ContextMenuParams the edit/selection part reads. */
export interface EditMenuParams {
  isEditable: boolean;
  selectionText: string;
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean };
}

const MAX_SUGGESTIONS = 5;

/**
 * Native «edit» part of a context menu, shared by the app window and the web-app views:
 * an editable field gets spelling suggestions + Cut/Copy/Paste/Select All, plain selected text
 * gets Copy, anything else gets nothing (no trailing separator).
 */
export function editMenuItems(
  p: EditMenuParams,
  s: Pick<MainStrings, 'menuCut' | 'menuCopy' | 'menuPaste' | 'menuSelectAll'>,
  replaceMisspelling: (word: string) => void,
): MenuItemConstructorOptions[] {
  if (p.isEditable) {
    const items: MenuItemConstructorOptions[] = [];
    if (p.misspelledWord) {
      for (const w of p.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)) items.push({ label: w, click: () => replaceMisspelling(w) });
      if (items.length) items.push({ type: 'separator' });
    }
    items.push({ label: s.menuCut, role: 'cut', enabled: p.editFlags.canCut });
    items.push({ label: s.menuCopy, role: 'copy', enabled: p.editFlags.canCopy });
    items.push({ label: s.menuPaste, role: 'paste', enabled: p.editFlags.canPaste });
    items.push({ label: s.menuSelectAll, role: 'selectAll' });
    return items;
  }
  if (p.selectionText) return [{ label: s.menuCopy, role: 'copy' }];
  return [];
}
