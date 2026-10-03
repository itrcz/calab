/**
 * «Библиотека» of the workspace settings (docs/08 «Настройки пространства»): one tab with a
 * segmented switch «Ачивки · Бейджи · Стикеры · Звуки · Фоны камеры» in place of the former five
 * tabs. Each segment keeps the right that gated its tab (as the server checks, ADR-0048): achievements
 * and camera backgrounds — MANAGE_WORKSPACE, badges — MANAGE_MEMBERS, stickers and sounds —
 * MANAGE_STICKERS. The former tab ids still open the tab on their segment (deep links). Pure:
 * unit-tested.
 */

export type LibrarySegment = 'achievements' | 'badges' | 'stickers' | 'sounds' | 'backgrounds';

export const LIBRARY_TAB = 'library';

/** The order of the switch. */
export const LIBRARY_SEGMENTS: readonly LibrarySegment[] = ['achievements', 'badges', 'stickers', 'sounds', 'backgrounds'];

/** The rights of lib/permissions `settingsAccess` the segments need. */
export interface LibraryRights {
  /** MANAGE_WORKSPACE. */
  workspace: boolean;
  /** MANAGE_MEMBERS. */
  members: boolean;
  /** MANAGE_STICKERS. */
  stickers: boolean;
}

const RIGHT: Record<LibrarySegment, keyof LibraryRights> = {
  achievements: 'workspace',
  badges: 'members',
  stickers: 'stickers',
  sounds: 'stickers',
  backgrounds: 'workspace',
};

/** The segments I may see, in the switch order; empty = no «Библиотека» tab at all. */
export function librarySegments(r: LibraryRights): LibrarySegment[] {
  return LIBRARY_SEGMENTS.filter((s) => r[RIGHT[s]]);
}

export const isLibrarySegment = (v: unknown): v is LibrarySegment => typeof v === 'string' && (LIBRARY_SEGMENTS as readonly string[]).includes(v);

/**
 * A requested settings tab: a former library tab id (`badges`, `backgrounds`, `stickers`,
 * `sounds`, and `achievements`) opens «Библиотека» on that segment; any other id is kept.
 */
export function resolveSettingsTab(tab: string | undefined): { tab: string | undefined; segment: LibrarySegment | undefined } {
  if (isLibrarySegment(tab)) return { tab: LIBRARY_TAB, segment: tab };
  return { tab, segment: undefined };
}

/**
 * The segment to show: the requested one (a deep link), else the remembered one, else the first
 * visible — each only when visible to me.
 */
export function pickSegment(visible: readonly LibrarySegment[], requested?: LibrarySegment, remembered?: LibrarySegment): LibrarySegment | undefined {
  if (requested && visible.includes(requested)) return requested;
  if (remembered && visible.includes(remembered)) return remembered;
  return visible[0];
}
