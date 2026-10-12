import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NotificationLevel } from './gen/calaba/v1/room_pb.js';
import { effectiveNotificationLevel, levelNotifies, taskNotifies, type TaskNotifyKind } from './notifications.js';

type Lvl = 'all' | 'mentions' | 'none' | 'inherit';
interface Vector {
  name: string;
  dm: boolean;
  mention: boolean;
  room: Lvl;
  workspace: Lvl;
  roomMuted: boolean;
  workspaceMuted: boolean;
  effective: Lvl;
  notifies: boolean;
  // ADR-0042: a task notification vector (the other fields absent).
  task?: {
    kind: TaskNotifyKind;
    level: Lvl;
    subscribed: boolean;
    muted: boolean;
    workspaceMuted: boolean;
    mandatory?: boolean;
    off?: boolean;
  };
}

const levels: Record<Lvl, NotificationLevel> = {
  all: NotificationLevel.ALL,
  mentions: NotificationLevel.MENTIONS,
  none: NotificationLevel.NONE,
  inherit: NotificationLevel.INHERIT,
};

const vectors = JSON.parse(
  readFileSync(new URL('../../../proto/testdata/notifications.json', import.meta.url), 'utf8'),
) as Vector[];

describe('notification levels (shared vectors with Go internal/notifications)', () => {
  it('has the full matrix', () => expect(vectors.length).toBeGreaterThan(50));
  it('has the task matrix', () => expect(vectors.filter((v) => v.task).length).toBeGreaterThan(50));
  for (const v of vectors) {
    it(v.name, () => {
      if (v.task) {
        expect(taskNotifies({ ...v.task, level: levels[v.task.level] })).toBe(v.notifies);
        return;
      }
      expect(effectiveNotificationLevel(levels[v.room], levels[v.workspace], v.dm)).toBe(levels[v.effective]);
      expect(
        levelNotifies({
          ...v,
          room: levels[v.room],
          workspace: levels[v.workspace],
        }),
      ).toBe(v.notifies);
    });
  }
  it('no stored settings: only mentions and DMs', () => {
    const none = { roomMuted: false, workspaceMuted: false };
    expect(effectiveNotificationLevel(undefined, undefined, false)).toBe(NotificationLevel.MENTIONS);
    expect(levelNotifies({ ...none, dm: false, mention: false })).toBe(false);
    expect(levelNotifies({ ...none, dm: false, mention: true })).toBe(true);
    expect(levelNotifies({ ...none, dm: true, mention: false })).toBe(true);
  });
});
