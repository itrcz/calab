import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import { editMenuItems, type EditMenuParams } from './contextMenuModel';
import { mainStrings } from './strings';

const s = mainStrings();
const base: EditMenuParams = {
  isEditable: false,
  selectionText: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: { canCut: true, canCopy: true, canPaste: true },
};
const labels = (p: Partial<EditMenuParams>, replace = vi.fn()): Array<string | undefined> => editMenuItems({ ...base, ...p }, s, replace).map((i) => i.label);

describe('editMenuItems', () => {
  it('offers only Copy for selected plain text', () => {
    expect(labels({ selectionText: 'abc' })).toEqual([s.menuCopy]);
  });

  it('offers nothing without a selection or an editable field', () => {
    expect(labels({})).toEqual([]);
  });

  it('offers Cut/Copy/Paste/Select All in an editable field', () => {
    expect(labels({ isEditable: true })).toEqual([s.menuCut, s.menuCopy, s.menuPaste, s.menuSelectAll]);
  });

  it('reflects edit flags and puts spelling suggestions first', () => {
    const replace = vi.fn();
    const items = editMenuItems(
      { ...base, isEditable: true, misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help', 'halo', 'hero', 'helot', 'held'], editFlags: { canCut: false, canCopy: false, canPaste: true } },
      s,
      replace,
    );
    expect(items.slice(0, 5).map((i) => i.label)).toEqual(['hello', 'help', 'halo', 'hero', 'helot']);
    expect(items[5]?.type).toBe('separator');
    expect(items[6]).toMatchObject({ role: 'cut', enabled: false });
    items[0]?.click?.({} as never, undefined, {} as never);
    expect(replace).toHaveBeenCalledWith('hello');
  });

  it('skips spelling entries when there are no suggestions', () => {
    expect(labels({ isEditable: true, misspelledWord: 'zzzq' })[0]).toBe(s.menuCut);
  });
});
