import { timestampMs } from '@bufbuild/protobuf/wkt';
import { CallState, type Call } from '@calaba/protocol';
import type { ResumeVoice, ResumeVoiceSeat } from '../../shared/resumeVoice';
import { roomLabel } from '../features/chat/roomLabel';
import { t } from '../i18n';
import { peerOf } from '../lib/callModel';
import { log } from '../lib/log';
import { decideResume, type ResumeContext } from '../lib/resumeVoice';
import { canAutoplayAudio, saveVoiceSelf, tabStorage, takeVoiceSelf } from '../lib/webResume';
import { isWeb, platform } from '../platform';
import { useRooms } from '../stores/rooms';
import { myUserId, useSession } from '../stores/session';
import { toast, useToasts } from '../stores/toasts';
import { setVoice, useVoice } from '../stores/voice';
import { memberName, useWorkspaces } from '../stores/workspaces';
import { keepCallOnExit, resumeCall } from './call';
import { voice } from './voice';

/**
 * Back into the same room / call after a restart for an update (docs/09 #126, owner 29.09).
 *
 * Before the quit main asks for the seat (platform.app.onPrepareRestart → setResumeVoice) and
 * keeps it for the relaunched instance (main/resumeVoice.ts). On this run's first READY the seat
 * is taken once and lib/resumeVoice.decideResume says what to do: rejoin the room with the mic /
 * deafen state it had (camera and screen share stay off), take an ACTIVE 1:1 call again, or
 * nothing — never when the user is in voice on another device (joining here would take them out
 * there, docs/05 «одно устройство в голосе»). One attempt: a refused join shows its error toast
 * (voice.join), no retry loop. A normal launch has no record, so nothing is joined.
 *
 * Web (owner, 05.10: «нажала обновить — выкинуло из комнаты, а вернулась без мьюта»): «Обновить
 * страницу» stores the same seat in the tab's sessionStorage before reloading (reloadForUpdate,
 * lib/webResume.ts, ≤ 2 min). A reload has no click behind it, so the rejoin first asks whether
 * the page may play sound (canAutoplayAudio): refused → the mic / deafen state is restored and a
 * toast offers «Вернуться» (the click unlocks the sound). Any reload of the tab also keeps the
 * mic / deafen state (written on `pagehide`, restored on the first READY): never back unmuted.
 */

/** How long a call's rejoin may take before its toast is given up (the join reports failures itself). */
const CALL_CONNECT_WAIT_MS = 30_000;

let installed = false;
let taken = false;

/** The seat to hand to main now, or null (not in voice / not signed in). */
function currentSeat(): ResumeVoiceSeat | null {
  const v = useVoice.getState();
  const userId = myUserId();
  if (!v.roomId || v.workspaceId === null || !userId) return null;
  if (v.phase !== 'connected' && v.phase !== 'connecting' && v.phase !== 'reconnecting') return null;
  const call = v.call;
  if (!call && !v.workspaceId) return null;
  return {
    kind: call ? 'dm-call' : 'room',
    roomId: v.roomId,
    workspaceId: call ? '' : v.workspaceId,
    userId,
    muted: v.muted,
    deafened: v.deafened,
    mutedBeforeDeafen: v.mutedBeforeDeafen,
    cameraOn: v.camera === 'on' || v.camera === 'starting',
  };
}

/** How long the web «Вернуться в комнату» toast waits for the click. */
const REJOIN_PROMPT_MS = 60_000;

/** Once per app: answers main's «restarting for an update» with the voice seat. */
export function installResumeVoice(): void {
  if (installed) return;
  installed = true;
  // Any reload of the tab (F5 included): the mic / deafen state comes back with it. An event, not a timer.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      const v = useVoice.getState();
      saveVoiceSelf(tabStorage(), { userId: myUserId(), muted: v.muted, deafened: v.deafened, mutedBeforeDeafen: v.mutedBeforeDeafen });
    });
  }
  platform.app.onPrepareRestart(() => {
    const seat = currentSeat();
    // The call must survive the page closing: this device comes back into it.
    if (seat?.kind === 'dm-call') keepCallOnExit();
    log.info(`update restart: voice seat ${seat ? `${seat.kind} ${seat.roomId}` : 'none'}`);
    void platform.app.setResumeVoice(seat).catch((e: unknown) => log.warn('resume voice: store failed', e));
  });
}

/**
 * Web «Обновить страницу» (features/shell/UpdateBar): keep the voice seat for the reloaded page,
 * then reload. A 1:1 call is kept on the server through the reload (keepCallOnExit).
 */
export async function reloadForUpdate(): Promise<void> {
  const seat = currentSeat();
  if (seat?.kind === 'dm-call') keepCallOnExit();
  log.info(`update reload: voice seat ${seat ? `${seat.kind} ${seat.roomId}` : 'none'}`);
  await platform.app.setResumeVoice(seat).catch((e: unknown) => log.warn('resume voice: store failed', e));
  window.location.reload();
}

/** My seat in a workspace room as the server has it (READY / VOICE_STATE_UPDATE). */
function myServerVoice(me: string): ResumeContext['myVoice'] {
  for (const entry of Object.values(useWorkspaces.getState().byId)) {
    const v = entry.voice[me];
    if (v?.roomId) return { roomId: v.roomId, joinedAt: v.joinedAt ? timestampMs(v.joinedAt) : null };
  }
  return null;
}

/** READY: the first one of this run takes the seat left by a restart for an update (if any). */
export function resumeVoiceAfterReady(readyCall: Call | undefined): void {
  if (taken) return;
  taken = true;
  restoreTabSelf();
  // Never throws into the READY dispatch.
  void Promise.resolve()
    .then(() => platform.app.takeResumeVoice())
    .then((rec) => (rec ? resume(rec, readyCall ?? null) : undefined))
    .catch((e: unknown) => log.warn('resume voice failed', e));
}

async function resume(rec: ResumeVoice, readyCall: Call | null): Promise<void> {
  const me = myUserId();
  const v = useVoice.getState();
  const mine = readyCall && readyCall.state === CallState.ACTIVE && (readyCall.callerId === me || readyCall.calleeId === me);
  const d = decideResume(rec, {
    now: Date.now(),
    serverUrl: useSession.getState().serverUrl,
    userId: me,
    inVoiceHere: v.roomId !== null || v.joining !== null,
    myVoice: myServerVoice(me),
    activeCall: mine ? { id: readyCall.id, dmRoomId: readyCall.dmRoomId } : null,
  });
  log.info(`resume voice after the update restart: ${d.kind}${d.kind === 'none' ? ` (${d.reason})` : ''}`);
  switch (d.kind) {
    case 'none':
      // Not rejoined, but the user is the same: the mic stays as they left it (never back unmuted).
      if (d.reason === 'call-over' || (d.reason === 'expired' && rec.userId === me)) restoreSelf(rec);
      return;
    case 'other-device':
      restoreSelf(rec);
      toast.info(t('call.resumeOtherDevice'));
      return;
    case 'join': {
      const room = useRooms.getState().byId[d.roomId];
      restoreSelf(rec);
      if (!room) {
        toast.error(t('call.resumeUnavailable'));
        return;
      }
      const label = roomLabel(room);
      const join = async (): Promise<void> => {
        await voice.join(d.roomId, d.workspaceId, { resumed: true });
        const after = useVoice.getState();
        if (after.roomId === d.roomId && after.phase === 'connected') toast.info(t('call.resumeRoom', { room: label }));
      };
      if (await soundAllowed()) await join();
      else offerRejoin(t('call.resumePromptRoom', { room: label }), () => void join());
      return;
    }
    case 'call': {
      if (!readyCall) return;
      restoreSelf(rec);
      const name = memberName(null, peerOf(readyCall, me));
      const take = async (): Promise<void> => {
        if (!resumeCall(readyCall)) return;
        if (await connected(readyCall.dmRoomId)) toast.info(t('call.resumeCall', { name }));
      };
      if (await soundAllowed()) await take();
      else offerRejoin(t('call.resumePromptCall', { name }), () => void take());
      return;
    }
  }
}

/** Desktop plays sound without a gesture; a reloaded web page may not (lib/webResume.canAutoplayAudio). */
function soundAllowed(): Promise<boolean> {
  return isWeb ? canAutoplayAudio() : Promise.resolve(true);
}

/** Web, sound blocked until a click: the click on «Вернуться» is that gesture. */
function offerRejoin(text: string, run: () => void): void {
  log.info('resume voice: autoplay blocked, offering the rejoin');
  useToasts.getState().push('info', text, { label: t('call.resumeAction'), run }, REJOIN_PROMPT_MS);
}

/** This tab's mic / deafen state from before a reload (any reload; the seat, if any, overrides it). */
function restoreTabSelf(): void {
  const self = takeVoiceSelf(tabStorage(), myUserId());
  const v = useVoice.getState();
  if (!self || v.roomId !== null || v.joining !== null) return;
  setVoice({ muted: self.muted, deafened: self.deafened, mutedBeforeDeafen: self.mutedBeforeDeafen });
}

/** The mic / deafen state of the seat (the join pushes it to the server with the pending seat). */
function restoreSelf(rec: ResumeVoice): void {
  setVoice({ muted: rec.muted || rec.deafened, deafened: rec.deafened, mutedBeforeDeafen: rec.deafened && rec.mutedBeforeDeafen });
}

/** Resolves true once connected to `roomId`, false when the join is dropped or takes too long. */
function connected(roomId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const state = (): boolean | null => {
      const s = useVoice.getState();
      if (s.roomId === roomId && s.phase === 'connected') return true;
      if (s.roomId !== roomId && s.joining?.roomId !== roomId) return false;
      return null;
    };
    const now = state();
    if (now !== null) {
      resolve(now);
      return;
    }
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      unsub();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), CALL_CONNECT_WAIT_MS);
    const unsub = useVoice.subscribe(() => {
      const r = state();
      if (r !== null) finish(r);
    });
  });
}
