import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoardStatusType } from './gen/calaba/v1/boards_pb.js';
import { resolveStatusIcon, STATUS_ICONS, statusIconForType } from './statusIcons.js';

const table = JSON.parse(readFileSync(new URL('../../../proto/testdata/status_icons.json', import.meta.url), 'utf8')) as {
  icons: string[];
  byType: Record<string, string>;
};

const types: Record<string, BoardStatusType> = {
  backlog: BoardStatusType.BACKLOG,
  unstarted: BoardStatusType.UNSTARTED,
  started: BoardStatusType.STARTED,
  completed: BoardStatusType.COMPLETED,
  cancelled: BoardStatusType.CANCELLED,
};

describe('status icons (ADR-0093)', () => {
  it('match the shared vector', () => {
    expect([...STATUS_ICONS]).toEqual(table.icons);
  });
  it('fall back by type', () => {
    for (const [name, icon] of Object.entries(table.byType)) {
      expect(statusIconForType(types[name]!)).toBe(icon);
      expect(resolveStatusIcon('', types[name]!)).toBe(icon);
    }
    expect(statusIconForType(BoardStatusType.UNSPECIFIED)).toBe('circle');
  });
  it('keep a known token and drop an unknown one', () => {
    expect(resolveStatusIcon('rocket', BoardStatusType.BACKLOG)).toBe('rocket');
    expect(resolveStatusIcon('nope', BoardStatusType.COMPLETED)).toBe('check');
  });
});
