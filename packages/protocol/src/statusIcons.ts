import { BoardStatusType } from './gen/calaba/v1/boards_pb.js';

/**
 * Board status icon tokens (ADR-0093), in picker order. The same list is Go boards.StatusIcons;
 * both are checked against proto/testdata/status_icons.json. The first seven are the progress
 * pies (dashed / empty / quarter / half / three quarters / done / cancelled).
 */
export const STATUS_ICONS = [
  'dashed',
  'circle',
  'quarter',
  'half',
  'three-quarters',
  'check',
  'x',
  'eye',
  'shield-check',
  'hourglass',
  'pause',
  'flag',
  'star',
  'bolt',
  'rocket',
  'bug',
  'inbox',
  'archive',
  'lock',
] as const;

export type StatusIconToken = (typeof STATUS_ICONS)[number];

const known = new Set<string>(STATUS_ICONS);

/** The icon of a status without its own token. */
export function statusIconForType(type: BoardStatusType): StatusIconToken {
  switch (type) {
    case BoardStatusType.BACKLOG:
      return 'dashed';
    case BoardStatusType.STARTED:
      return 'half';
    case BoardStatusType.COMPLETED:
      return 'check';
    case BoardStatusType.CANCELLED:
      return 'x';
    default:
      return 'circle';
  }
}

/** The token a status shows: its own when known, else the one of its type (an unknown token from a newer server falls back too). */
export function resolveStatusIcon(icon: string | undefined, type: BoardStatusType): StatusIconToken {
  return icon && known.has(icon) ? (icon as StatusIconToken) : statusIconForType(type);
}
