import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { NotificationLevel, RoomCategorySchema, RoomNotificationSettingsSchema, RoomSchema, RoomType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { defaultRoom, groupRooms, isQuiet, isUnread, roomNotify, unreadMentionCounts, useRooms } from './rooms';

const room = (id: string, type: RoomType, position: number, categoryId = ''): ReturnType<typeof create<typeof RoomSchema>> =>
  create(RoomSchema, { id, workspaceId: 'w', type, name: id, position, categoryId });
const cat = (id: string, position: number): ReturnType<typeof create<typeof RoomCategorySchema>> =>
  create(RoomCategorySchema, { id, workspaceId: 'w', name: id, position });

const T = RoomType.TEXT;
const V = RoomType.VOICE;

describe('groupRooms', () => {
  it('puts loose rooms first, then categories by position; text before voice', () => {
    const rooms = [room('v1', V, 0), room('t2', T, 2), room('t1', T, 1, 'b'), room('v2', V, 0, 'a'), room('t3', T, 5, 'a')];
    const groups = groupRooms(rooms, [cat('b', 1), cat('a', 0)]);
    expect(groups.map((g) => [g.category?.id ?? null, g.rooms.map((r) => r.id)])).toEqual([
      [null, ['t2', 'v1']],
      ['a', ['t3', 'v2']],
      ['b', ['t1']],
    ]);
  });

  it('hides empty categories unless asked; unknown category ids count as loose', () => {
    const rooms = [room('t1', T, 0, 'gone')];
    expect(groupRooms(rooms, [cat('a', 0)]).map((g) => g.category?.id ?? null)).toEqual([null]);
    expect(groupRooms(rooms, [cat('a', 0)], true).map((g) => g.category?.id ?? null)).toEqual([null, 'a']);
  });

  it('defaultRoom prefers the first text room in list order', () => {
    expect(defaultRoom([room('v', V, 0), room('t', T, 3, 'a')], [cat('a', 0)])?.id).toBe('t');
    expect(defaultRoom([room('v', V, 0)], [])?.id).toBe('v');
    expect(defaultRoom([], [])).toBeUndefined();
  });
});

describe('room notifications', () => {
  const n = (level: NotificationLevel, until?: number): ReturnType<typeof create<typeof RoomNotificationSettingsSchema>> =>
    create(RoomNotificationSettingsSchema, { roomId: 'r', level, ...(until ? { mutedUntil: timestampFromMs(until) } : {}) });

  it('roomNotify: default ALL, expired mute ignored', () => {
    expect(roomNotify(undefined)).toEqual({ level: NotificationLevel.ALL, mutedUntil: null });
    expect(roomNotify(n(NotificationLevel.UNSPECIFIED))).toEqual({ level: NotificationLevel.ALL, mutedUntil: null });
    expect(roomNotify(n(NotificationLevel.MENTIONS, 5_000), 1_000)).toEqual({ level: NotificationLevel.MENTIONS, mutedUntil: 5_000 });
    expect(roomNotify(n(NotificationLevel.ALL, 5_000), 9_000).mutedUntil).toBeNull();
  });

  it('isQuiet: NONE or muted', () => {
    expect(isQuiet(roomNotify(n(NotificationLevel.NONE)))).toBe(true);
    expect(isQuiet(roomNotify(n(NotificationLevel.ALL, 5_000), 1_000))).toBe(true);
    expect(isQuiet(roomNotify(n(NotificationLevel.MENTIONS)))).toBe(false);
  });

  it('setNotify: the default removes the stored row', () => {
    useRooms.getState().setNotifyAll([n(NotificationLevel.NONE)]);
    expect(useRooms.getState().notify.r?.level).toBe(NotificationLevel.NONE);
    useRooms.getState().setNotify(n(NotificationLevel.ALL));
    expect(useRooms.getState().notify.r).toBeUndefined();
  });
});

describe('mention counters', () => {
  it('counts inbox mentions after each room read marker', () => {
    const items = [
      { id: '03', roomId: 'a' },
      { id: '02', roomId: 'a' },
      { id: '01', roomId: 'b' },
      { id: '05', roomId: 'c' },
    ];
    expect(unreadMentionCounts(items, { a: '02', b: '01' })).toEqual({ a: 1, c: 1 });
  });

  it('READY counters, live +1, read → 0, deleted unread −1', () => {
    const r = useRooms.getState;
    r().reset();
    r().setLastMessage('a', '05');
    r().setRead('a', '02');
    r().setCounts('a', 3, 1);
    expect(r().unread['a']).toBe(3);
    expect(r().mentions).toEqual({ a: 1 });
    expect(isUnread('a', r())).toBe(true);
    // A new message of someone else (+ a mention).
    r().setLastMessage('a', '06');
    r().addUnread('a', '06', true);
    expect(r().unread['a']).toBe(4);
    expect(r().mentions['a']).toBe(2);
    // Deleted: the unread mention −1; an already read message changes nothing.
    r().removeUnread('a', '06', true);
    r().removeUnread('a', '01', true);
    expect(r().unread['a']).toBe(3);
    expect(r().mentions['a']).toBe(1);
    // A message at or before the read marker (read elsewhere first) is not counted.
    r().addUnread('a', '02', true);
    expect(r().unread['a']).toBe(3);
    // Read up to the newest message (READ_STATE_UPDATE carries 0/0): nothing unread.
    r().setRead('a', '06');
    expect(r().unread['a']).toBe(0);
    expect(r().mentions['a']).toBeUndefined();
    expect(isUnread('a', r())).toBe(false);
  });

  it('a deleted message that was never counted does not decrement (review pass 3 L)', () => {
    const r = useRooms.getState;
    r().reset();
    r().setLastMessage('a', '05');
    r().setRead('a', '02');
    r().setCounts('a', 2, 1); // server counted 03..05
    // 06 arrives while the room is on screen (not counted), then is deleted before markRead.
    r().setLastMessage('a', '06');
    r().removeUnread('a', '06', true);
    expect(r().unread['a']).toBe(2);
    expect(r().mentions['a']).toBe(1);
    // A counted one (server-covered) does.
    r().removeUnread('a', '04', true);
    expect(r().unread['a']).toBe(1);
    expect(r().mentions['a']).toBeUndefined();
    // Live-counted: −1 once, a repeated delete / a repeated add changes nothing more.
    r().setLastMessage('a', '07');
    r().addUnread('a', '07', false);
    r().addUnread('a', '07', false);
    expect(r().unread['a']).toBe(2);
    r().removeUnread('a', '07', false);
    r().removeUnread('a', '07', false);
    expect(r().unread['a']).toBe(1);
    // Clamped at 0.
    r().removeUnread('a', '03', false);
    r().removeUnread('a', '05', false);
    expect(r().unread['a']).toBe(0);
  });

  it('no server counts (room without a read state): only live-counted deletions decrement', () => {
    const r = useRooms.getState;
    r().reset();
    r().addUnread('b', '03', false);
    r().removeUnread('b', '02', false);
    expect(r().unread['b']).toBe(1);
    r().removeUnread('b', '03', false);
    expect(r().unread['b']).toBe(0);
  });

  it('a partial read keeps the counters; unknown counters fall back to ids', () => {
    const r = useRooms.getState;
    r().reset();
    r().setLastMessage('a', '05');
    r().setCounts('a', 2, 1);
    r().setRead('a', '03'); // newer messages still unread
    expect(r().unread['a']).toBe(2);
    expect(r().mentions['a']).toBe(1);
    // A room never read (no READY read state): the dot comes from the ids.
    r().setLastMessage('b', '04');
    expect(isUnread('b', r())).toBe(true);
    // Counters of 0 win over the ids (only my own messages after the marker).
    r().setCounts('b', 0, 0);
    expect(isUnread('b', r())).toBe(false);
  });
});
