import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { MeSchema, ReadySchema, RoomAdmissionSchema, RoomAdmissionStatus, RoomSchema, RoomType, UserSchema, WorkspaceSnapshotSchema, type DispatchEvent } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => true });
vi.stubGlobal('window', globalThis);

const played = vi.fn<(name: string) => void>();
vi.mock('../../../lib/sounds', () => ({ playSound: (name: string) => played(name) }));
vi.mock('../../../platform', () => ({ platform: { kind: 'web', apiFetch: vi.fn(), app: { log: () => undefined, attention: vi.fn() } } }));
vi.mock('../../../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const svc = await import('./admissions');
const { useAdmissions } = await import('../stores/admissions');
const { useRooms } = await import('../../../stores/rooms');
const { useUi } = await import('../../../stores/ui');
const { useVoice } = await import('../../../stores/voice');
const { useSession } = await import('../../../stores/session');

const ME = 'guest-1';
const T0 = Date.UTC(2026, 8, 29, 12, 0);

const knock = (status = RoomAdmissionStatus.PENDING, userId = ME) =>
  create(RoomAdmissionSchema, {
    roomId: 'voice',
    workspaceId: 'ws',
    user: create(UserSchema, { id: userId, displayName: 'Гость' }),
    status,
    requestedAt: timestampFromMs(T0),
    roomName: 'Созвон',
    workspaceName: 'Команда',
  });
const room = create(RoomSchema, { id: 'voice', workspaceId: 'ws', type: RoomType.VOICE, name: 'Созвон' });
const decidedEv = (status: RoomAdmissionStatus, userId = ME): DispatchEvent['event'] => ({ case: 'roomAdmissionDecided', value: { $typeName: 'calaba.v1.RoomAdmissionDecided', admission: knock(status, userId) } });
const requestEv = (userId: string): DispatchEvent['event'] => ({ case: 'roomAdmissionRequest', value: { $typeName: 'calaba.v1.RoomAdmissionRequest', admission: knock(RoomAdmissionStatus.PENDING, userId) } });

beforeEach(() => {
  useRooms.getState().reset();
  useAdmissions.setState({ byRoom: {}, gone: {}, toasts: [], mine: {} });
  useUi.setState({ activeWorkspaceId: null, lastRoom: {} });
  useSession.setState({ me: create(MeSchema, { user: { id: ME, isGuest: true } }) });
  played.mockClear();
});

describe('guest: DECIDED (ADMITTED) and ROOM_CREATE in either order open the room', () => {
  it('DECIDED first, then the room arrives', () => {
    svc.waitFor(knock(), 'code-1');
    expect(useAdmissions.getState().mine['voice']?.phase).toBe('pending');
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.ADMITTED));
    expect(useAdmissions.getState().mine['voice']?.phase).toBe('admitted');
    expect(useUi.getState().lastRoom['ws']).toBeUndefined();
    useRooms.getState().upsert(room);
    expect(useAdmissions.getState().mine).toEqual({});
    expect(useUi.getState().activeWorkspaceId).toBe('ws');
    expect(useUi.getState().lastRoom['ws']).toBe('voice');
    expect(svc.knockCode('voice')).toBeNull();
  });

  it('the room first, then DECIDED (ignored)', () => {
    svc.waitFor(knock(), 'code-1');
    useRooms.getState().upsert(room);
    expect(useAdmissions.getState().mine).toEqual({});
    expect(useUi.getState().lastRoom['ws']).toBe('voice');
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.ADMITTED));
    expect(useAdmissions.getState().mine).toEqual({});
  });

  it('declined keeps the screen with the outcome and the link for «Постучать снова»', () => {
    svc.waitFor(knock(), 'code-1');
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.DECLINED));
    expect(useAdmissions.getState().mine['voice']?.phase).toBe('declined');
    expect(svc.knockCode('voice')).toBe('code-1');
  });

  it('READY pending_admissions brings the waiting screen back after a reload', () => {
    svc.applyReadyAdmissions(create(ReadySchema, { pendingAdmissions: [knock()], me: { user: { id: ME, isGuest: true } } }));
    expect(useAdmissions.getState().mine['voice']?.phase).toBe('pending');
  });
});

describe('deciders', () => {
  it('a live knock plays the notification sound; READY knocks do not', () => {
    svc.applyReadyAdmissions(create(ReadySchema, { workspaces: [create(WorkspaceSnapshotSchema, { admissions: [knock(RoomAdmissionStatus.PENDING, 'g0')] })] }));
    expect(played).not.toHaveBeenCalled();
    useRooms.getState().upsert(room);
    useVoice.setState({ roomId: 'voice' }); // in the room's voice: mine to decide
    svc.onAdmissionEvent(requestEv('g1'));
    expect(played).toHaveBeenCalledWith('mention');
    expect(useAdmissions.getState().byRoom['voice']?.map((a) => a.user?.id)).toEqual(['g0', 'g1']);
    expect(useAdmissions.getState().toasts).toEqual(['voice:g1']);
  });

  it('a knock on a room that goes away (deleted / hidden) is dropped', () => {
    useRooms.getState().upsert(room);
    svc.onAdmissionEvent(requestEv('g1'));
    useRooms.getState().remove('voice');
    expect(useAdmissions.getState().byRoom).toEqual({});
  });

  it('«Пустить» / «Отклонить» only call the API: the decider keeps the view (no room opened)', async () => {
    useRooms.getState().upsert(room);
    useUi.setState({ activeWorkspaceId: 'other-ws', lastRoom: { 'other-ws': 'other-room' } });
    const opened = vi.spyOn(useUi.getState(), 'openRoom');
    const decide = vi.spyOn(svc.admissionApi, 'decide').mockResolvedValue({} as never);
    svc.onAdmissionEvent(requestEv('g1'));
    svc.onAdmissionEvent(requestEv('g2'));
    await svc.decide('voice', 'g1', { admit: true });
    await svc.decide('voice', 'g2', { admit: false });
    // the server's echo of both decisions reaches the decider too
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.ADMITTED, 'g1'));
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.DECLINED, 'g2'));
    expect(decide).toHaveBeenCalledTimes(2);
    expect(opened).not.toHaveBeenCalled();
    expect(useUi.getState().activeWorkspaceId).toBe('other-ws');
    expect(useUi.getState().lastRoom).toEqual({ 'other-ws': 'other-room' });
    expect(useAdmissions.getState().toasts).toEqual([]);
    expect(useAdmissions.getState().mine).toEqual({});
  });
});

describe('decider: whose knock it is (ADR-0040 §3 amendment: the link author or me in the voice of the room, nothing escalates)', () => {
  const DEC = 'dec-1';
  const req = (by: string): DispatchEvent['event'] => ({
    case: 'roomAdmissionRequest',
    value: { $typeName: 'calaba.v1.RoomAdmissionRequest', admission: create(RoomAdmissionSchema, { ...knock(RoomAdmissionStatus.PENDING, 'g-2'), inviteCreatedBy: by }) },
  });
  const toasts = () => useAdmissions.getState().toasts;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 1000);
    useSession.setState({ me: create(MeSchema, { user: { id: DEC } }) });
    useUi.setState({ activeWorkspaceId: 'ws', lastRoom: {} });
    useVoice.setState({ roomId: null });
    useRooms.getState().upsert(room);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the link author: at once, with the sound', () => {
    svc.onAdmissionEvent(req(DEC));
    expect(toasts()).toEqual(['voice:g-2']);
    expect(played).toHaveBeenCalledTimes(1);
  });

  it('in the voice of the room: at once', () => {
    useVoice.setState({ roomId: 'voice' });
    svc.onAdmissionEvent(req('someone'));
    expect(toasts()).toHaveLength(1);
  });

  it('with the room merely open (not in its voice): the row only — no toast, no sound', () => {
    useUi.setState({ lastRoom: { ws: 'voice' } });
    svc.onAdmissionEvent(req('someone'));
    expect(toasts()).toEqual([]);
    expect(played).not.toHaveBeenCalled();
    expect(useAdmissions.getState().byRoom['voice']).toHaveLength(1);
  });

  it('another decider: never — not after a minute, not after an hour (no timers armed)', () => {
    svc.onAdmissionEvent(req('someone'));
    expect(toasts()).toEqual([]);
    expect(played).not.toHaveBeenCalled();
    expect(useAdmissions.getState().byRoom['voice']).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    expect(toasts()).toEqual([]);
    expect(played).not.toHaveBeenCalled();
  });

  it('forMe: the author, or me in the voice of that room; nobody else', () => {
    expect(svc.forMe({ roomId: 'voice', inviteCreatedBy: DEC })).toBe(true);
    expect(svc.forMe({ roomId: 'voice', inviteCreatedBy: 'someone' })).toBe(false);
    useVoice.setState({ roomId: 'voice' });
    expect(svc.forMe({ roomId: 'voice', inviteCreatedBy: 'someone' })).toBe(true);
    expect(svc.forMe({ roomId: 'other', inviteCreatedBy: 'someone' })).toBe(false);
  });

  it('decided by someone else: the row goes, nothing was ever shown', () => {
    svc.onAdmissionEvent(req('someone'));
    svc.onAdmissionEvent(decidedEv(RoomAdmissionStatus.ADMITTED, 'g-2'));
    expect(useAdmissions.getState().byRoom['voice'] ?? []).toHaveLength(0);
    expect(toasts()).toEqual([]);
    expect(played).not.toHaveBeenCalled();
  });

  it('the title marks a guest; the author line only for a known member', () => {
    expect(svc.knockTitle('Кука', 'Созвон')).toBe('Гость «Кука» просит войти в «Созвон»');
    const a = create(RoomAdmissionSchema, { ...knock(), inviteCreatedBy: 'u-9' });
    expect(svc.knockAuthor(a)).toBe('');
  });
});
