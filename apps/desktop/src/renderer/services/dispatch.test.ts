import { create } from '@bufbuild/protobuf';
import {
  DispatchEventSchema,
  MessageCreateSchema,
  MessageSchema,
  ReadySchema,
  MessageDeleteSchema,
  ReadStateSchema,
  ReadStateUpdateSchema,
  RoomSchema,
  TypingStartSchema,
  RoomType,
  TimeFormat,
  WorkspaceSchema,
  WorkspaceUpdateSchema,
  WorkspaceSnapshotSchema,
  type DispatchEvent,
} from '@calaba/protocol';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => false });
vi.stubGlobal('window', globalThis);

const onIncomingMessage = vi.fn<(...a: unknown[]) => void>();
const loadMentions = vi.fn(() => Promise.resolve());
vi.mock('./voice', () => ({ voice: { leave: vi.fn(), currentRoomId: null, onMoved: vi.fn(), reconcileSelfState: vi.fn(), stopStream: vi.fn(), checkSeat: vi.fn() } }));
vi.mock('./chat', () => ({ resyncLoadedRooms: vi.fn(() => Promise.resolve()), resyncPins: vi.fn(() => Promise.resolve()) }));
vi.mock('./mentions', () => ({ loadMentions: () => loadMentions() }));
vi.mock('./notify', () => ({ onIncomingMessage: (...a: unknown[]) => {
    onIncomingMessage(...a);
  }, mentionsMe: () => false }));
vi.mock('./profile', () => ({ applyUserSettings: vi.fn() }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { applyDispatch, TYPING_MS } = await import('./dispatch');
const { useMessages } = await import('../stores/messages');
const { useRooms } = await import('../stores/rooms');
const { useTyping } = await import('../stores/typing');
const { useInbox } = await import('../stores/inbox');
const { useDms, HOME } = await import('../stores/dms');
const { useUi } = await import('../stores/ui');
const { useWorkspaces } = await import('../stores/workspaces');
const { installTimeFormat } = await import('./timeFormat');
const { getTimeFormat } = await import('../lib/format');

const WS = 'ws-1';
const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const room = (rid: string, lastMessageId = '') => create(RoomSchema, { id: rid, workspaceId: WS, type: RoomType.TEXT, name: rid, lastMessageId });

function ready(rooms: ReturnType<typeof room>[], reads: Array<[string, string, number?, number?]> = []): DispatchEvent {
  return create(DispatchEventSchema, {
    event: {
      case: 'ready',
      value: create(ReadySchema, {
        sessionId: 'gs',
        workspaces: [create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: WS, name: 'W' }), rooms })],
        readStates: reads.map(([roomId, lastReadMessageId, unreadCount = 0, mentionCount = 0]) =>
          create(ReadStateSchema, { roomId, lastReadMessageId, unreadCount, mentionCount }),
        ),
      }),
    },
  });
}

const messageCreate = (rid: string, n: number): DispatchEvent =>
  create(DispatchEventSchema, {
    event: { case: 'messageCreate', value: create(MessageCreateSchema, { workspaceId: WS, message: create(MessageSchema, { id: id(n), roomId: rid, authorId: 'other' }) }) },
  });

beforeEach(() => {
  useMessages.getState().reset();
  useRooms.getState().reset();
  onIncomingMessage.mockClear();
  loadMentions.mockClear();
});

describe('dispatch READY (re-IDENTIFY while the UI is up)', () => {
  it('keeps loaded windows; counters come from the READY read states; drops vanished rooms', () => {
    applyDispatch(ready([room('a', id(5)), room('b', id(9))], [['a', id(1), 4, 1], ['b', id(1), 8, 2]]));
    expect(useRooms.getState().unread).toEqual({ a: 4, b: 8 });
    expect(useRooms.getState().mentions).toEqual({ a: 1, b: 2 });
    useMessages.getState().setWindow('a', [create(MessageSchema, { id: id(5), roomId: 'a' })], false, false);
    useMessages.getState().setWindow('b', [create(MessageSchema, { id: id(9), roomId: 'b' })], false, false);
    useRooms.getState().addUnread('a', id(6), true);

    // Re-IDENTIFY: room b is gone; a's counters are the server's (they include what was missed).
    applyDispatch(ready([room('a', id(7))], [['a', id(1), 6, 3]]));
    expect(useMessages.getState().rooms['a']?.items).toHaveLength(1);
    expect(useMessages.getState().rooms['b']).toBeUndefined();
    expect(useRooms.getState().unread).toEqual({ a: 6 });
    expect(useRooms.getState().mentions).toEqual({ a: 3 });
    expect(loadMentions).toHaveBeenCalled(); // the inbox list is refreshed
  });

  it('a room without a read state keeps its live counters across READY', () => {
    applyDispatch(ready([room('a', id(5))]));
    useRooms.getState().addUnread('a', id(6), true);
    applyDispatch(ready([room('a', id(6))]));
    expect(useRooms.getState().unread).toEqual({ a: 1 });
    expect(useRooms.getState().mentions).toEqual({ a: 1 });
  });

  it('drops the badge of a room read on another device meanwhile', () => {
    applyDispatch(ready([room('a', id(5))], [['a', id(1), 2, 1]]));
    applyDispatch(ready([room('a', id(5))], [['a', id(5)]]));
    expect(useRooms.getState().mentions['a']).toBeUndefined();
    expect(useRooms.getState().unread['a']).toBe(0);
  });

  it('READ_STATE_UPDATE clears the counters; a deleted unread message counts −1', () => {
    applyDispatch(ready([room('a', id(9))], [['a', id(1), 5, 2]]));
    // A deleted unread mention (the inbox has it) and a deleted unread plain message.
    useInbox.getState().addLive(create(MessageSchema, { id: id(8), roomId: 'a', authorId: 'other' }));
    applyDispatch(create(DispatchEventSchema, { event: { case: 'messageDelete', value: create(MessageDeleteSchema, { roomId: 'a', messageId: id(8) }) } }));
    applyDispatch(create(DispatchEventSchema, { event: { case: 'messageDelete', value: create(MessageDeleteSchema, { roomId: 'a', messageId: id(7) }) } }));
    expect(useRooms.getState().unread['a']).toBe(3);
    expect(useRooms.getState().mentions['a']).toBe(1);
    // An already read message deleted: nothing changes.
    applyDispatch(create(DispatchEventSchema, { event: { case: 'messageDelete', value: create(MessageDeleteSchema, { roomId: 'a', messageId: id(1) }) } }));
    expect(useRooms.getState().unread['a']).toBe(3);
    applyDispatch(
      create(DispatchEventSchema, {
        event: { case: 'readStateUpdate', value: create(ReadStateUpdateSchema, { readState: create(ReadStateSchema, { roomId: 'a', lastReadMessageId: id(9) }) }) },
      }),
    );
    expect(useRooms.getState().unread['a']).toBe(0);
    expect(useRooms.getState().mentions['a']).toBeUndefined();
  });

  it('a replayed MESSAGE_CREATE counts once (no double badge / sound)', () => {
    applyDispatch(ready([room('a')]));
    applyDispatch(messageCreate('a', 100));
    applyDispatch(messageCreate('a', 100));
    expect(onIncomingMessage).toHaveBeenCalledTimes(1);
    applyDispatch(messageCreate('a', 101));
    expect(onIncomingMessage).toHaveBeenCalledTimes(2);
  });

  it('READY and RESUMED run the voice seat check (docs/09 #71)', async () => {
    const { voice } = await import('./voice');
    const check = vi.spyOn(voice, 'checkSeat');
    check.mockClear();
    applyDispatch(ready([room('a')]));
    applyDispatch(create(DispatchEventSchema, { event: { case: 'resumed', value: { replayed: 3 } } }));
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('dispatch TYPING_START', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires on local time even when the server clock is far ahead (review N8)', async () => {
    vi.useFakeTimers();
    useTyping.getState().reset();
    const serverAhead = Date.now() + 10 * 60_000;
    applyDispatch(
      create(DispatchEventSchema, {
        event: { case: 'typingStart', value: create(TypingStartSchema, { roomId: 'a', userId: 'other', timestamp: timestampFromMs(serverAhead) }) },
      }),
    );
    const until = useTyping.getState().rooms['a']?.['other'];
    expect(until).toBeDefined();
    expect(until).toBeLessThanOrEqual(Date.now() + TYPING_MS);
    await vi.advanceTimersByTimeAsync(TYPING_MS + 100);
    expect(useTyping.getState().rooms['a']?.['other']).toBeUndefined();
  });
});

describe('DM_STATE_UPDATE (docs/09 #51)', () => {
  const dmReady = (): DispatchEvent =>
    create(DispatchEventSchema, {
      event: {
        case: 'ready',
        value: create(ReadySchema, {
          sessionId: 'gs',
          dms: [
            {
              room: { id: 'd', type: RoomType.DM, lastMessageId: id(3), createdAt: timestampFromMs(1000) },
              peer: { id: 'p', displayName: 'P' },
              lastMessage: { id: id(3), authorId: 'p', content: 'old', attachmentCount: 0, createdAt: timestampFromMs(2000) },
            },
          ],
          readStates: [create(ReadStateSchema, { roomId: 'd', lastReadMessageId: id(1), unreadCount: 2, mentionCount: 2 })],
        }),
      },
    });
  const state = (archivedAt: number, cleared: string): DispatchEvent =>
    create(DispatchEventSchema, {
      event: { case: 'dmStateUpdate', value: { roomId: 'd', clearedBeforeMessageId: cleared, ...(archivedAt ? { archivedAt: timestampFromMs(archivedAt) } : {}) } },
    });

  it('archives and un-archives; a new clear mark drops the history, counters and the open chat', () => {
    applyDispatch(dmReady());
    applyDispatch(state(5000, ''));
    expect(useDms.getState().byRoom['d']).toMatchObject({ archivedAt: 5000, clearedBefore: '' });
    applyDispatch(state(0, ''));
    expect(useDms.getState().byRoom['d']?.archivedAt).toBe(0);

    useUi.getState().openRoom(HOME, 'd');
    useMessages.getState().setWindow('d', [create(MessageSchema, { id: id(3), roomId: 'd' })], false, false);
    applyDispatch(state(0, id(4)));
    expect(useMessages.getState().rooms['d']).toBeUndefined();
    expect(useRooms.getState().unread['d']).toBe(0);
    expect(useRooms.getState().mentions['d'] ?? 0).toBe(0);
    expect(useDms.getState().preview['d']).toBeNull();
    expect(useUi.getState().lastRoom[HOME]).toBe('');
    // A stale (older) mark never brings the hidden history back.
    applyDispatch(state(0, id(2)));
    expect(useDms.getState().byRoom['d']?.clearedBefore).toBe(id(4));
  });
});

describe('WORKSPACE_UPDATE → clock format (docs/09 #73)', () => {
  const update = (wsId: string, timeFormat: TimeFormat): DispatchEvent =>
    create(DispatchEventSchema, {
      event: { case: 'workspaceUpdate', value: create(WorkspaceUpdateSchema, { workspace: create(WorkspaceSchema, { id: wsId, name: 'W', timeFormat }) }) },
    });

  it('the current workspace format applies live; another one does not; DMs follow the last one opened', () => {
    const off = installTimeFormat();
    try {
      applyDispatch(ready([room('a', id(1))]));
      useUi.getState().setWorkspace(WS);
      expect(getTimeFormat()).toBe('auto');

      applyDispatch(update(WS, TimeFormat.H12));
      expect(getTimeFormat()).toBe('h12');
      applyDispatch(update(WS, TimeFormat.H24));
      expect(getTimeFormat()).toBe('h24');

      // Another workspace (not open) changing its format leaves ours alone.
      useWorkspaces.getState().applySnapshot(create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: 'ws-2', name: 'Other' }) }));
      applyDispatch(update('ws-2', TimeFormat.H12));
      expect(getTimeFormat()).toBe('h24');

      // «Личные» (DMs): the workspace opened last; opening the other one switches.
      useUi.getState().setWorkspace(HOME);
      expect(getTimeFormat()).toBe('h24');
      useUi.getState().setWorkspace('ws-2');
      expect(getTimeFormat()).toBe('h12');

      // UNSPECIFIED (an older server) reads as auto; no workspace at all: auto.
      applyDispatch(update('ws-2', TimeFormat.UNSPECIFIED));
      expect(getTimeFormat()).toBe('auto');
      applyDispatch(update(WS, TimeFormat.H12));
      useWorkspaces.getState().reset();
      expect(getTimeFormat()).toBe('auto');
    } finally {
      off();
    }
  });
});
