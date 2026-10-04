import { describe, expect, it } from 'vitest';
import { LIBRARY_TAB, librarySegments, pickSegment, resolveSettingsTab } from './library';

const rights = (workspace: boolean, members: boolean, stickers: boolean) => ({ workspace, members, stickers });

describe('«Библиотека» segments by rights', () => {
  it('everything for the owner / an admin, in the switch order', () => {
    expect(librarySegments(rights(true, true, true))).toEqual(['achievements', 'badges', 'stickers', 'sounds', 'backgrounds']);
  });

  it('MANAGE_WORKSPACE gates achievements and camera backgrounds', () => {
    expect(librarySegments(rights(true, false, false))).toEqual(['achievements', 'backgrounds']);
  });

  it('MANAGE_MEMBERS gates badges only', () => {
    expect(librarySegments(rights(false, true, false))).toEqual(['badges']);
  });

  it('MANAGE_STICKERS gates stickers and sounds', () => {
    expect(librarySegments(rights(false, false, true))).toEqual(['stickers', 'sounds']);
  });

  it('no right — no segment (the tab is hidden)', () => {
    expect(librarySegments(rights(false, false, false))).toEqual([]);
  });
});

describe('former tab ids → «Библиотека» segment', () => {
  it.each(['badges', 'backgrounds', 'stickers', 'sounds', 'achievements'] as const)('%s opens the library on it', (id) => {
    expect(resolveSettingsTab(id)).toEqual({ tab: LIBRARY_TAB, segment: id });
  });

  it('other ids pass through', () => {
    expect(resolveSettingsTab('invites')).toEqual({ tab: 'invites', segment: undefined });
    expect(resolveSettingsTab(LIBRARY_TAB)).toEqual({ tab: LIBRARY_TAB, segment: undefined });
    expect(resolveSettingsTab(undefined)).toEqual({ tab: undefined, segment: undefined });
  });
});

describe('pickSegment', () => {
  const all = librarySegments(rights(true, true, true));
  it('a deep link wins, then the remembered one, then the first', () => {
    expect(pickSegment(all, 'sounds', 'badges')).toBe('sounds');
    expect(pickSegment(all, undefined, 'badges')).toBe('badges');
    expect(pickSegment(all)).toBe('achievements');
  });

  it('skips ones I may not see', () => {
    const mine = librarySegments(rights(false, false, true));
    expect(pickSegment(mine, 'achievements', 'badges')).toBe('stickers');
    expect(pickSegment([], 'badges')).toBeUndefined();
  });
});
