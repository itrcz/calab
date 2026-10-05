import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { CallSchema, CallState, PresenceStatus, type Call } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** services/call.ts: the effects of the call state machine (ADR-0034 §6) with the I/O mocked. */

vi.stubGlobal('window', Object.assign(globalThis, { addEventListener: vi.fn(), focus: vi.fn() }));
vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const start = vi.fn((_id: string): Promise<unknown> => Promise.resolve({}));
const act = vi.fn((_id: string, _a: string): Promise<unknown> => Promise.resolve({}));
vi.mock('../lib/api/endpoints', () => ({ api: { calls: { start: (id: string) => start(id), act: (id: string, a: string) => act(id, a) } } }));
const join = vi.fn((_r: string, _w: string, _o?: unknown) => Promise.resolve());
const leave = vi.fn(() => Promise.resolve());
/** voice.takenOverRoom: the room the server took this device out of for another device. */
const voiceState = { takenOverRoom: null as string | null };
vi.mock('./voice', () => ({
  voice: {
    join: (r: string, w: string, o?: unknown) => join(r, w, o),
    leave: () => leave(),
    get takenOverRoom() {
      return voiceState.takenOverRoom;
    },
  },
}));
const startRing = vi.fn((_n: string) => undefined);
const stopRing = vi.fn(() => undefined);
vi.mock('../lib/sounds', () => ({ startRing: (n: string) => startRing(n), stopRing: () => stopRing() }));
const toastInfo = vi.fn((_s: string) => undefined);
const toastError = vi.fn((_s: string) => undefined);
vi.mock('../stores/toasts', () => ({ toast: { info: (s: string) => toastInfo(s), error: (s: string) => toastError(s) } }));
const confirm = vi.fn(() => Promise.resolve(true));
vi.mock('../components/Confirm', () => ({ confirmAction: () => confirm() }));
const openDm = vi.fn((_id: string) => undefined);
vi.mock('./dms', () => ({ ensureDm: () => Promise.resolve('dm1'), openDm: (id: string) => openDm(id) }));
vi.mock('../platform', () => ({ platform: { app: { attention: vi.fn() }, auth:{onLoggedOut:()=>()=>undefined} } }));

const { applyCallEvent, accept, hangup, onCallRing, onCallState, onReadyCall, resumeCall, startCall, installCalls, performHostCallAction, setHostIncomingOwnership } = await import('./call');
const { useCall, setCall } = await import('../stores/call');
const { useVoice } = await import('../stores/voice');
const { useSession } = await import('../stores/session');
const { usePrefs } = await import('../stores/prefs');
const { ApiError } = await import('../lib/api/client');
const { IDLE } = await import('../lib/callModel');

installCalls();

const ME = 'me';
const incoming = (state: CallState): Call =>
  create(CallSchema, { id: 'c1', dmRoomId: 'dm1', callerId: 'peer', calleeId: ME, state, createdAt: timestampFromMs(1000), ...(state === CallState.ACTIVE ? { answeredAt: timestampFromMs(2000) } : {}) });
const outgoing = (state: CallState): Call => create(CallSchema, { ...incoming(state), callerId: ME, calleeId: 'peer' });

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ me: { user: { id: ME } } as never });
  setCall({ ...IDLE, peerId: '', since: null, collapsed: false, busy: false });
  useVoice.setState({ roomId: null, workspaceId: null, call: false });
  usePrefs.getState().setPrefs({ presence: PresenceStatus.ONLINE });
  voiceState.takenOverRoom = null;
});

describe('call service', () => {
  it('incoming: rings, accept joins the DM voice with the call mic mode, the end leaves it', async () => {
    onCallRing(incoming(CallState.RINGING), undefined);
    expect(useCall.getState()).toMatchObject({ phase: 'incoming', peerId: 'peer' });
    expect(startRing).toHaveBeenLastCalledWith('call-incoming');
    act.mockResolvedValueOnce({ call: incoming(CallState.ACTIVE) });
    await accept();
    expect(act).toHaveBeenCalledWith('c1', 'accept');
    expect(useCall.getState()).toMatchObject({ phase: 'active', since: 2000 });
    expect(stopRing).toHaveBeenCalled();
    expect(join).toHaveBeenCalledWith('dm1', '', { call: true, resumed: false });
    // The peer hangs up: out of the voice session, nothing sent back.
    useVoice.setState({ roomId: 'dm1', workspaceId: '', call: true });
    onCallState(incoming(CallState.ENDED));
    expect(useCall.getState().phase).toBe('idle');
    expect(leave).toHaveBeenCalledTimes(1);
    useVoice.setState({ roomId: null, workspaceId: null, call: false });
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('«Не беспокоить»: the modal shows, no ringtone', () => {
    usePrefs.getState().setPrefs({ presence: PresenceStatus.DND });
    onCallRing(incoming(CallState.RINGING), undefined);
    expect(useCall.getState().phase).toBe('incoming');
    expect(startRing).not.toHaveBeenCalled();
  });

  it('answered on another device: the ringing stops, no voice here', () => {
    onCallRing(incoming(CallState.RINGING), undefined);
    onCallState(incoming(CallState.ACTIVE));
    expect(useCall.getState().phase).toBe('idle');
    expect(join).not.toHaveBeenCalled();
    expect(stopRing).toHaveBeenCalled();
  });

  it('resumed after a restart for an update: READY.call is taken again with the «reconnect» cue', () => {
    const call = outgoing(CallState.ACTIVE);
    onReadyCall(call);
    expect(join).not.toHaveBeenCalled();
    expect(resumeCall(call)).toBe(true);
    expect(useCall.getState().phase).toBe('active');
    expect(join).toHaveBeenCalledWith('dm1', '', { call: true, resumed: true });
  });

  it('leaving the call’s voice session hangs up', async () => {
    applyCallEvent({ kind: 'placed', call: outgoing(CallState.RINGING) });
    applyCallEvent({ kind: 'state', call: outgoing(CallState.ACTIVE) });
    expect(join).toHaveBeenCalledWith('dm1', '', { call: true, resumed: false });
    useVoice.setState({ roomId: 'dm1', workspaceId: '', call: true });
    act.mockResolvedValueOnce({ call: outgoing(CallState.ENDED) });
    useVoice.setState({ roomId: null, workspaceId: null, call: false });
    await flush();
    expect(act).toHaveBeenCalledWith('c1', 'hangup');
    expect(useCall.getState().phase).toBe('idle');
  });

  it('taken out for another device of mine (VOICE_DISCONNECTED): the call is let go here, not hung up', async () => {
    applyCallEvent({ kind: 'placed', call: outgoing(CallState.RINGING) });
    applyCallEvent({ kind: 'state', call: outgoing(CallState.ACTIVE) });
    useVoice.setState({ roomId: 'dm1', workspaceId: '', call: true });
    voiceState.takenOverRoom = 'dm1';
    useVoice.setState({ roomId: null, workspaceId: null, call: false });
    await flush();
    expect(act).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    expect(useCall.getState().phase).toBe('idle');
    expect(stopRing).toHaveBeenCalled();
  });

  it('startCall: opens the DM, places the call, rings back; declined → toast', async () => {
    start.mockResolvedValueOnce({ call: outgoing(CallState.RINGING) });
    await startCall('peer');
    expect(openDm).toHaveBeenCalledWith('dm1');
    expect(start).toHaveBeenCalledWith('dm1');
    expect(useCall.getState().phase).toBe('outgoing');
    expect(startRing).toHaveBeenLastCalledWith('call-outgoing');
    onCallState(outgoing(CallState.DECLINED));
    expect(useCall.getState().phase).toBe('idle');
    expect(toastInfo).toHaveBeenCalledWith('Звонок отклонён');
  });

  it('startCall in a workspace voice room: confirm, then leave the room first', async () => {
    useVoice.setState({ roomId: 'room', workspaceId: 'ws', call: false });
    confirm.mockResolvedValueOnce(false);
    await startCall('peer');
    expect(start).not.toHaveBeenCalled();
    start.mockResolvedValueOnce({ call: outgoing(CallState.RINGING) });
    await startCall('peer');
    expect(leave).toHaveBeenCalled();
    expect(start).toHaveBeenCalled();
  });

  it('BUSY / IN_CALL answers: human toasts, no call', async () => {
    start.mockRejectedValueOnce(new ApiError('ERROR_CODE_BUSY', 'busy', 409));
    await startCall('peer');
    expect(toastError).toHaveBeenLastCalledWith('Занято');
    start.mockRejectedValueOnce(new ApiError('ERROR_CODE_IN_CALL', 'in call', 409));
    await startCall('peer');
    expect(toastError).toHaveBeenLastCalledWith('Вы уже в звонке');
    expect(useCall.getState().phase).toBe('idle');
  });

  it('a hangup the server refuses (409: already over) drops the call', async () => {
    applyCallEvent({ kind: 'placed', call: outgoing(CallState.RINGING) });
    applyCallEvent({ kind: 'state', call: outgoing(CallState.ACTIVE) });
    act.mockRejectedValueOnce(new ApiError('ERROR_CODE_CONFLICT', 'not active', 409));
    await hangup();
    expect(useCall.getState().phase).toBe('idle');
  });
});


it('host answer reuses call transition and refuses a different/answered-elsewhere call', async () => {
 onCallRing(incoming(CallState.RINGING), undefined);
 expect(await performHostCallAction('foreign', 'answer')).toBe(false);
 act.mockResolvedValueOnce({ call: incoming(CallState.ACTIVE) });
 expect(await performHostCallAction('c1', 'answer')).toBe(true);
 expect(useCall.getState()).toMatchObject({phase:'active',own:'c1'});
 expect(await performHostCallAction('c1', 'answer')).toBe(false);
});
it('native-owned ringing uses CallKit sound without starting a second web ring', () => {
 setHostIncomingOwnership('c1',true);onCallRing(incoming(CallState.RINGING),undefined);
 expect(startRing).not.toHaveBeenCalled();
 setHostIncomingOwnership('c1',false);
 expect(startRing).toHaveBeenCalledWith('call-incoming');
});

it('a successful accept arriving after native expiry never joins and retires only its call', async () => {
 useSession.setState({sessionId:'first'});onCallRing(incoming(CallState.RINGING),undefined);
 let finish:(value:unknown)=>void=()=>{};act.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 const signal=new AbortController();const pending=performHostCallAction('c1','answer',signal.signal,()=>!signal.signal.aborted);
 signal.abort();act.mockResolvedValueOnce({call:incoming(CallState.ENDED)});finish({call:incoming(CallState.ACTIVE)});
 expect(await pending).toBe(false);expect(join).not.toHaveBeenCalled();expect(act).toHaveBeenLastCalledWith('c1','hangup');
 expect(useCall.getState().phase).toBe('idle');
});
it('a late accept after account switch never joins, mutates the next call or cleans with new credentials', async () => {
 useSession.setState({sessionId:'first'});onCallRing(incoming(CallState.RINGING),undefined);
 let finish:(value:unknown)=>void=()=>{};act.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 const signal=new AbortController();const pending=performHostCallAction('c1','answer',signal.signal,()=>!signal.signal.aborted);
 signal.abort();useSession.setState({sessionId:'second'});setCall({...IDLE,call:{...incoming(CallState.ACTIVE),id:'next'},phase:'active',own:'next'});
 finish({call:incoming(CallState.ACTIVE)});expect(await pending).toBe(false);expect(join).not.toHaveBeenCalled();
 expect(act).toHaveBeenCalledTimes(1);expect(useCall.getState()).toMatchObject({phase:'active',own:'next',call:{id:'next'}});
});
it('revoked authentication prevents a late accept while the old store is still authed', async () => {
 useSession.setState({sessionId:'first'});onCallRing(incoming(CallState.RINGING),undefined);
 let finish:(value:unknown)=>void=()=>{};act.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
 let current=true;const pending=performHostCallAction('c1','answer',undefined,()=>current,()=>current);
 current=false;finish({call:incoming(CallState.ACTIVE)});
 expect(await pending).toBe(false);expect(join).not.toHaveBeenCalled();expect(act).toHaveBeenCalledTimes(1);
});
