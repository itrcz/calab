import { CallState, PresenceStatus, type Call, type User } from '@calaba/protocol';
import { confirmAction } from '../components/Confirm';
import { t } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { errorText } from '../lib/api/errors';
import { callSince, peerOf, reduceCall, type CallEvent, type CallModel } from '../lib/callModel';
import { log } from '../lib/log';
import { startRing, stopRing } from '../lib/sounds';
import { platform } from '../platform';
import { setCall, useCall } from '../stores/call';
import { dmWith } from '../stores/dms';
import { prefs } from '../stores/prefs';
import { useRooms } from '../stores/rooms';
import { myUserId, useSession } from '../stores/session';
import { toast } from '../stores/toasts';
import { useVoice } from '../stores/voice';
import { memberName, useWorkspaces } from '../stores/workspaces';
import { roomLabel } from '../features/chat/roomLabel';
import { ensureDm, openDm } from './dms';
import { voice } from './voice';

/**
 * One-to-one calls on this device (ADR-0034 §6). The model (lib/callModel.ts) lives in
 * stores/call.ts; this service feeds it — REST answers, CALL_RING / CALL_STATE, READY.call — and
 * runs what a phase change means: the DM's voice session (voice.join with `call: true`), the
 * ringing, the «Входящий звонок» notification, the caller's toasts. Leaving the call's voice
 * session (the panel's hang-up, another room, a failed connect) hangs the call up — unless the
 * server took this device out for another device of the user (the call goes on there).
 */

type Action = 'accept' | 'decline' | 'cancel' | 'hangup';

/** Applies an event to the model and runs the effects of the change. */
export function applyCallEvent(ev: CallEvent): void {
  const me = myUserId();
  if (!me) return;
  // ACTIVE may be another device winning a simultaneous accept. Wait for this
  // request's success before joining media; the HTTP result is the ownership proof.
  if ((ev.kind === 'state' || ev.kind === 'ready' || ev.kind === 'ring') && ev.call?.state === CallState.ACTIVE && accepting?.id === ev.call.id) {
    accepting.activeObserved = true;
    return;
  }
  const prev = useCall.getState();
  const next = reduceCall(prev, ev, me);
  if (next === prev || (next.call === prev.call && next.phase === prev.phase && next.own === prev.own)) return;
  const peerId = next.call ? peerOf(next.call, me) : '';
  setCall({
    ...next,
    peerId,
    since: next.call ? callSince(next.call) : null,
    // A new outgoing call starts as the modal; the strip stays while the same call rings.
    collapsed: next.phase === 'outgoing' && prev.phase === 'outgoing' && prev.call?.id === next.call?.id ? useCall.getState().collapsed : false,
    busy: next.call?.id === prev.call?.id ? useCall.getState().busy : false,
  });
  effects(prev, next, peerId, ev.kind === 'resume');
}

/** `resumed`: back into the call after a restart for an update — the «reconnect» cue, not «join». */
function effects(prev: CallModel, next: CallModel, peerId: string, resumed: boolean): void {
  syncRing(next);
  if (next.phase === 'incoming' && prev.phase !== 'incoming') notifyIncoming(next.call, peerId);
  if (next.phase !== 'incoming') closeIncomingNotice();
  const call = next.call;
  // Answered: both sides join the DM's voice session (the callee's switch leaves a room first).
  if (next.phase === 'active' && prev.phase !== 'active' && call) joinCallVoice(call, resumed);
  // Over (hung up, lost, answered elsewhere): out of the call's voice session.
  const prevCall = prev.call;
  if (prev.phase === 'active' && next.phase !== 'active' && prevCall && useVoice.getState().roomId === prevCall.dmRoomId) void voice.leave();
  // The caller learns why the ringing stopped.
  if (prev.phase === 'outgoing' && next.phase === 'idle' && ended?.id === prevCall?.id) {
    if (ended?.state === CallState.DECLINED) toast.info(t('call.declinedToast'));
    else if (ended?.state === CallState.MISSED) toast.info(t('call.noAnswer'));
  }
}

/** The last CALL_STATE seen, for the caller's toast (the model forgets an ended call). */
let ended: Call | null = null;

const hostIncoming = new Set<string>();
export function setHostIncomingOwnership(id: string, owned: boolean): void {
  if (owned) hostIncoming.add(id); else hostIncoming.delete(id);
  syncRing(useCall.getState());
}

/** Narrow host adapter; REST/model/media stay on the normal call path. */
export async function performHostCallAction(id: string, action: 'answer' | 'end', signal?: AbortSignal, isCurrent: () => boolean = () => true, isSessionCurrent: () => boolean = () => true): Promise<boolean> {
  const c = useCall.getState();
  if (c.call?.id !== id || signal?.aborted || !isCurrent()) return false;
  const context = { signal, isCurrent, isSessionCurrent, session: useSession.getState().sessionId };
  if (action === 'answer') {
    await acceptOnce(id,context);
    const next = useCall.getState();
    return next.call?.id === id && next.phase === 'active' && next.own === id && acceptedHere?.id === id && acceptedHere.session === context.session && !signal?.aborted && isCurrent() && isSessionCurrent();
  }
  if (c.busy) return false;
  if (c.phase === 'incoming') await act(id,'decline',context);
  else if (c.phase === 'active' && c.own === id) await act(id,'hangup',context);
  else return false;
  return useCall.getState().phase === 'idle';
}

function syncRing(m: CallModel): void {
  if (m.phase === 'outgoing') startRing('call-outgoing');
  // «Не беспокоить»: the modal shows, the ringtone stays silent (ADR-0034).
  else if (m.phase === 'incoming' && !hostIncoming.has(m.call?.id ?? '') && prefs().presence !== PresenceStatus.DND) startRing('call-incoming');
  else stopRing();
}

// ---------------------------------------------------------------- gateway

/** CALL_RING: the caller's profile first (the modal names them), then the call. */
export function onCallRing(call: Call | undefined, caller: User | undefined): void {
  if (caller && !useWorkspaces.getState().users[caller.id]) useWorkspaces.getState().upsertUser(caller);
  if (call) applyCallEvent({ kind: 'ring', call });
}

/** CALL_STATE. */
export function onCallState(call: Call | undefined): void {
  if (!call) return;
  ended = call;
  applyCallEvent({ kind: 'state', call });
}

/** READY: the user's current call (restores the ringing / in-call UI after a reconnect). */
export function onReadyCall(call: Call | undefined): void {
  applyCallEvent({ kind: 'ready', call: call ?? null });
}

/**
 * After a restart for an update (docs/09 #126, services/resumeVoice.ts): take the READY call
 * again on this device — it joins the call's voice session (effects). false when a CALL_STATE
 * seen since READY ended it, or it is not ACTIVE any more.
 */
export function resumeCall(call: Call): boolean {
  if (call.state !== CallState.ACTIVE) return false;
  if (ended?.id === call.id && ended.state !== CallState.ACTIVE) return false;
  applyCallEvent({ kind: 'resume', call });
  return useCall.getState().phase === 'active' && useCall.getState().call?.id === call.id;
}

/**
 * The app restarts for an update and comes back into the call (docs/09 #126): closing the page
 * must not hang it up — the server keeps an ACTIVE call through a 30 s loss (ADR-0034).
 */
let keepOnExit = false;
export function keepCallOnExit(): void {
  keepOnExit = true;
}

// ---------------------------------------------------------------- actions

/**
 * «Позвонить»: the DM with the user (created when needed) opens, then the call is placed. In a
 * voice room of a workspace — «Выйти из комнаты и позвонить?» first.
 */
export async function startCall(userId: string): Promise<void> {
  const c = useCall.getState();
  if (c.phase !== 'idle') {
    toast.info(t('call.alreadyInCall'));
    return;
  }
  const v = useVoice.getState();
  if (v.roomId && !v.call) {
    const room = useRooms.getState().byId[v.roomId];
    const ok = await confirmAction(t('call.leaveRoomTitle'), t('call.leaveRoomText', { room: room ? roomLabel(room) : '' }), t('call.call'), 'primary');
    if (!ok) return;
  }
  let dmRoomId: string;
  try {
    dmRoomId = dmWith(userId)?.roomId ?? (await ensureDm(userId));
  } catch (e) {
    log.warn('call: no dm', e);
    toast.error(t('call.failed'));
    return;
  }
  openDm(dmRoomId);
  if (useVoice.getState().roomId && !useVoice.getState().call) await voice.leave();
  try {
    const res = await api.calls.start(dmRoomId);
    if (res.call) applyCallEvent({ kind: 'placed', call: res.call });
  } catch (e) {
    toast.error(callErrorText(e));
  }
}

interface AcceptOperation {
  id: string; session: string; promise: Promise<void>; abort: AbortController;
  host?: HostActionContext; detach?: () => void; activeObserved: boolean;
}
let accepting: AcceptOperation | undefined;
let acceptedHere: { id: string; session: string } | undefined;

/** Server ACTIVE alone is never proof that this document accepted the call. */
export function ownsHostCall(id: string): boolean {
  const c = useCall.getState();
  const session = useSession.getState().sessionId;
  return c.call?.id === id && c.own === id &&
    ((c.phase === 'active' && acceptedHere?.id === id && acceptedHere.session === session) ||
      (accepting?.id === id && accepting.session === session && !accepting.abort.signal.aborted));
}

function attachHostAnswer(pending: AcceptOperation, host?: HostActionContext): void {
  if (!host || pending.host) return;
  pending.host = host;
  const abort = () => pending.abort.abort();
  host.signal?.addEventListener('abort', abort, { once: true });
  pending.detach = () => host.signal?.removeEventListener('abort', abort);
  if (host.signal?.aborted) abort();
}

/** Release the native queue on cancellation even if the underlying response arrives late. */
function waitForAccept(pending: AcceptOperation): Promise<void> {
  return new Promise(resolve => {
    const done = () => { pending.abort.signal.removeEventListener('abort', done); resolve(); };
    pending.abort.signal.addEventListener('abort', done, { once: true });
    void pending.promise.then(done, done);
    if (pending.abort.signal.aborted) done();
  });
}

function acceptOnce(id: string, host?: HostActionContext): Promise<void> {
  const session = useSession.getState().sessionId;
  if (accepting?.id === id && accepting.session === session) {
    attachHostAnswer(accepting, host);
    return waitForAccept(accepting);
  }
  const c = useCall.getState();
  if (c.call?.id !== id || c.phase !== 'incoming' || c.busy) return Promise.resolve();
  const pending: AcceptOperation = { id, session, promise: Promise.resolve(), abort: new AbortController(), activeObserved: false };
  accepting = pending;
  acceptedHere = undefined;
  attachHostAnswer(pending, host);
  applyCallEvent({ kind: 'accepting', callId: id });
  // Mutable host attachment also governs a request started by the web button first.
  const context: HostActionContext = {
    session, signal: pending.abort.signal,
    isCurrent: () => !pending.host || pending.host.isCurrent(),
    isSessionCurrent: () => useSession.getState().sessionId === session && (!pending.host || pending.host.isSessionCurrent()),
  };
  pending.promise = act(id, 'accept', context).finally(() => {
    pending.detach?.();
    if (accepting === pending) accepting = undefined;
    // A failed request cannot own a competing ACTIVE arriving before or after its error.
    const current = useCall.getState();
    const confirmed = acceptedHere?.id === id && acceptedHere.session === session;
    if (!confirmed && context.isSessionCurrent() && current.call?.id === id && current.own === id) {
      if (pending.activeObserved) applyCallEvent({ kind: 'failed', callId: id });
      else setCall({ own: null });
    }
  });
  return waitForAccept(pending);
}

/** «Принять»: the call goes ACTIVE; the voice session follows (applyCallEvent). */
export function accept(): Promise<void> {
  const id = useCall.getState().call?.id;
  if (!id) return Promise.resolve();
  return acceptOnce(id);
}

export function decline(): Promise<void> {
  const id = useCall.getState().call?.id;
  return id ? act(id, 'decline') : Promise.resolve();
}

export function cancel(): Promise<void> {
  const id = useCall.getState().call?.id;
  return id ? act(id, 'cancel') : Promise.resolve();
}

export function hangup(): Promise<void> {
  const id = useCall.getState().call?.id;
  return id ? act(id, 'hangup') : Promise.resolve();
}

interface HostActionContext {signal?:AbortSignal;isCurrent:()=>boolean;isSessionCurrent:()=>boolean;session:string}
async function act(callId: string, action: Action, host?:HostActionContext): Promise<void> {
  const sameSession = () => !host || (host.isSessionCurrent() && useSession.getState().sessionId === host.session);
  const valid = () => sameSession() && (!host || (!host.signal?.aborted && host.isCurrent()));
  if(!valid())return;
  setCall({ busy: true });
  try {
    const res = await api.calls.act(callId, action, host?.signal);
    if(host && !valid()) {
      // A successful late accept is proof of this request's transition. Never join its RTC;
      // retire only that call while the same session still owns it, never under a new account.
      if(sameSession() && useCall.getState().call?.id === callId && useCall.getState().own === callId) {
        applyCallEvent({kind:'failed',callId});
        if(action === 'accept' && res.call?.id === callId && res.call.state === CallState.ACTIVE) {
          const cleanup = new AbortController(); const timer = setTimeout(() => cleanup.abort(),3000);
          const unsubscribe = useSession.subscribe(() => {if(!sameSession())cleanup.abort();});
          const logout = platform.auth.onLoggedOut(() => cleanup.abort());
          void api.calls.act(callId,'hangup',cleanup.signal).catch(() => undefined).finally(() => {clearTimeout(timer);unsubscribe();logout();});
        }
      }
      return;
    }
    if (res.call) {
      if (action === 'accept' && res.call.id === callId && res.call.state === CallState.ACTIVE) acceptedHere = { id: callId, session: useSession.getState().sessionId };
      ended = res.call;
      applyCallEvent({ kind: 'answer', call: res.call });
    }
  } catch (e) {
    if(host && !valid()) {
      if(sameSession() && useCall.getState().call?.id === callId && useCall.getState().own === callId) applyCallEvent({kind:'failed',callId});
      return;
    }
    log.warn(`call ${action} failed`, e);
    // Gone or already in another state (answered / ended elsewhere): the call is over for us.
    if (e instanceof ApiError && (e.status === 404 || e.status === 409 || e.status === 403)) applyCallEvent({ kind: 'failed', callId });
    else toast.error(errorText(e));
  } finally {
    if (sameSession() && useCall.getState().call?.id === callId) setCall({ busy: false });
  }
}

/** Collapse the outgoing modal into the top strip / expand it again. */
export function setCollapsed(collapsed: boolean): void {
  if (useCall.getState().phase === 'outgoing') setCall({ collapsed });
}

export function callErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.is('ERROR_CODE_BUSY')) return t('call.busy');
    if (e.is('ERROR_CODE_IN_CALL')) return t('call.alreadyInCall');
    if (e.status === 403) return t('call.forbidden');
  }
  return errorText(e) || t('call.failed');
}

// ---------------------------------------------------------------- voice

function joinCallVoice(call: Call, resumed: boolean): void {
  void voice.join(call.dmRoomId, '', { call: true, resumed });
}

/**
 * Leaving the call's voice session by any path (the panel's hang-up, joining a room, a connect
 * that failed for good) ends the call; the end of the call itself takes the session down first
 * (the phase is no longer active then, so nothing is sent twice).
 */
function watchVoice(): void {
  useVoice.subscribe((s, p) => {
    const c = useCall.getState();
    if (c.phase !== 'active' || !c.call) return;
    const dm = c.call.dmRoomId;
    if (p.roomId !== dm || s.roomId === dm) return;
    // Taken out because the user joined voice on another device (VOICE_DISCONNECTED): the call
    // is not over — this device only lets go of it, like a call answered elsewhere.
    if (voice.takenOverRoom === dm) applyCallEvent({ kind: 'failed', callId: c.call.id });
    else void hangup();
  });
}

// ---------------------------------------------------------------- notification

let notice: Notification | null = null;

/** «Входящий звонок от X» when the window is hidden or not focused; a click brings the app up. */
function notifyIncoming(call: Call | null, peerId: string): void {
  if (!call || hostIncoming.has(call.id)) return;
  platform.app.attention();
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  if (prefs().presence === PresenceStatus.DND) return;
  try {
    const n = new Notification(t('call.notifyIncoming', { name: memberName(null, peerId) }), { tag: `call:${call.id}`, silent: true, requireInteraction: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    notice = n;
  } catch {
    // notifications unavailable
  }
}

function closeIncomingNotice(): void {
  notice?.close();
  notice = null;
}

// ---------------------------------------------------------------- lifecycle

let installed = false;

/**
 * Once per app: the voice watch and the window-close hook — closing / reloading the app hangs an
 * active call up and cancels an outgoing one (the server would end it after 30 s anyway).
 */
export function installCalls(): void {
  if (installed) return;
  installed = true;
  watchVoice();
  window.addEventListener('pagehide', () => {
    const c = useCall.getState();
    if (!c.call) return;
    if (c.phase === 'active' && keepOnExit) {
      stopRing();
      return;
    }
    if (c.phase === 'active') void api.calls.act(c.call.id, 'hangup').catch(() => undefined);
    else if (c.phase === 'outgoing') void api.calls.act(c.call.id, 'cancel').catch(() => undefined);
    stopRing();
  });
}

/** Tests: forget the module state. */
export function resetCallsForTest(): void {
  ended = null;
  notice = null;
  accepting = undefined;
  acceptedHere = undefined;
}
