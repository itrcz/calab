import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  MessageKind,
  MessageSchema,
  NotificationLevel,
  RoomNotificationSettingsSchema,
  RoomSchema,
  RoomType,
  WorkspaceNotificationSettingsSchema,
} from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => true });
// No Web Locks: a single tab, sounds fire synchronously (the cross-tab claim: lib/crossTab.test.ts).
vi.stubGlobal('navigator', {});
vi.stubGlobal('Notification', class { onclick: (() => void) | null = null; });

const played = vi.hoisted((): Array<[string, unknown]> => []);
vi.mock('../lib/sounds', () => ({ playSound: (name: string, opts: unknown) => void played.push([name, opts]) }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined, attention: () => undefined } } }));

const { onIncomingMessage, shouldNotify } = await import('./notify');
const { useRooms } = await import('../stores/rooms');
const { useSession } = await import('../stores/session');
const { useInbox } = await import('../stores/inbox');

const ME = '0190a0b0-0000-7000-8000-00000000000a';
const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const msg = (n: number, content = '') => create(MessageSchema, { id: id(n), roomId: 'a', authorId: 'other', content });

beforeEach(() => {
  useRooms.getState().reset();
  useRooms.getState().setRead('a', id(1));
  useSession.setState({ me: { user: { id: ME } } } as never);
});

describe('live unread / mention counters', () => {
  it('a message off screen counts +1 unread, a mention also +1 mention', () => {
    onIncomingMessage(msg(2), 'ws', false);
    onIncomingMessage(msg(3, `hi @${ME}`), 'ws', false);
    expect(useRooms.getState().unread['a']).toBe(2);
    expect(useRooms.getState().mentions['a']).toBe(1);
  });

  it('the open, read room does not grow (review N7)', () => {
    onIncomingMessage(msg(2, `hi @${ME}`), 'ws', true);
    expect(useRooms.getState().unread['a']).toBe(0);
    expect(useRooms.getState().mentions['a']).toBeUndefined();
  });
});

describe('direct messages (ADR-0020)', () => {
  it('every DM message counts as a mention and stays out of the mentions inbox', () => {
    useInbox.getState().reset();
    useRooms.getState().upsert({ id: 'a', type: RoomType.DM, workspaceId: '' } as never);
    onIncomingMessage(msg(2, 'без упоминания'), '', false);
    expect(useRooms.getState().unread['a']).toBe(1);
    expect(useRooms.getState().mentions['a']).toBe(1);
    expect(useInbox.getState().items).toHaveLength(0);
  });
});

describe('new message sound (docs/09 P1 #13, item 22)', () => {
  const level = (room?: NotificationLevel, ws?: NotificationLevel, opts: { roomMuted?: boolean; wsMuted?: boolean } = {}): void => {
    const s = useRooms.getState();
    s.upsert(create(RoomSchema, { id: 'a', workspaceId: 'ws', type: RoomType.TEXT }));
    const until = { mutedUntil: timestampFromMs(Date.now() + 60_000) };
    s.setNotifyAll(room || opts.roomMuted ? [create(RoomNotificationSettingsSchema, { roomId: 'a', level: room ?? NotificationLevel.INHERIT, ...(opts.roomMuted ? until : {}) })] : []);
    s.setWsNotifyAll(ws || opts.wsMuted ? [create(WorkspaceNotificationSettingsSchema, { workspaceId: 'ws', level: ws ?? NotificationLevel.MENTIONS, ...(opts.wsMuted ? until : {}) })] : []);
  };
  const sound = (content = ''): string | null => {
    played.length = 0;
    onIncomingMessage(msg(Math.floor(Math.random() * 1e9) + 10, content), 'ws', false);
    return played[0]?.[0] ?? null;
  };
  const MENTION = `hi @${ME}`;

  it('by default (workspace «Только упоминания») a plain message is silent, a mention sounds', () => {
    level();
    expect(sound()).toBeNull();
    expect(sound(MENTION)).toBe('mention');
    expect(shouldNotify(msg(2), 'ws')).toEqual({ dm: false, mention: false, notify: false });
  });

  it('a room picture change (ADR-0092) counts as unread but never sounds, even at «Все сообщения»', () => {
    level(NotificationLevel.ALL);
    played.length = 0;
    const m = create(MessageSchema, {
      id: id(500),
      roomId: 'a',
      authorId: 'other',
      kind: MessageKind.SYSTEM,
      system: { payload: { case: 'roomIcon', value: { fileId: 'f' } } },
    });
    onIncomingMessage(m, 'ws', false);
    expect(played).toHaveLength(0);
    expect(useRooms.getState().unread['a']).toBe(1);
  });

  it('«Все сообщения» on the room, or on the workspace through «Как в пространстве», plays «Новое сообщение»', () => {
    level(NotificationLevel.ALL);
    expect(sound()).toBe('message');
    level(NotificationLevel.INHERIT, NotificationLevel.ALL);
    expect(sound()).toBe('message');
    level(NotificationLevel.MENTIONS, NotificationLevel.ALL);
    expect(sound()).toBeNull();
    expect(sound(MENTION)).toBe('mention');
  });

  it('NONE and mutes silence everything, mentions included; the counters still count', () => {
    level(NotificationLevel.NONE, NotificationLevel.ALL);
    expect(sound(MENTION)).toBeNull();
    level(NotificationLevel.ALL, undefined, { roomMuted: true });
    expect(sound(MENTION)).toBeNull();
    level(NotificationLevel.ALL, NotificationLevel.ALL, { wsMuted: true });
    expect(sound(MENTION)).toBeNull();
    level(undefined, NotificationLevel.NONE);
    expect(sound(MENTION)).toBeNull();
    expect(useRooms.getState().mentions['a']).toBeGreaterThan(0);
  });

  it('a DM notifies every message as a mention, whatever the workspaces say', () => {
    const s = useRooms.getState();
    s.upsert(create(RoomSchema, { id: 'a', workspaceId: '', type: RoomType.DM }));
    s.setWsNotifyAll([create(WorkspaceNotificationSettingsSchema, { workspaceId: 'ws', level: NotificationLevel.NONE })]);
    played.length = 0;
    onIncomingMessage(msg(5), '', false);
    expect(played).toEqual([['mention', { volume: 1 }]]);
    s.setNotify(create(RoomNotificationSettingsSchema, { roomId: 'a', level: NotificationLevel.NONE }));
    played.length = 0;
    onIncomingMessage(msg(6), '', false);
    expect(played).toHaveLength(0);
  });

  it('the open chat in focus does not sound (default «выкл.»)', () => {
    level(NotificationLevel.ALL);
    played.length = 0;
    onIncomingMessage(msg(3), 'ws', true);
    expect(played).toHaveLength(0);
  });
});
