import {
  DecideRoomAdmissionRequestSchema,
  DecideRoomAdmissionResponseSchema,
  JoinRoomInviteRequestSchema,
  JoinRoomInviteResponseSchema,
  PresenceStatus,
  RoomAdmissionSchema,
  RoomAdmissionStatus,
  UpdateRoomInviteRequestSchema,
  UpdateRoomInviteResponseSchema,
  type DispatchEvent,
  type Ready,
  type RoomAdmission,
} from '@calaba/protocol';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { t } from '../../../i18n';
import { ApiError, body, call, callEmpty } from '../../../lib/api/client';
import { errorText } from '../../../lib/api/errors';
import { log } from '../../../lib/log';
import { playSound } from '../../../lib/sounds';
import { platform } from '../../../platform';
import { prefs } from '../../../stores/prefs';
import { isQuietRoom, useRooms } from '../../../stores/rooms';
import { myUserId, useSession } from '../../../stores/session';
import { toast } from '../../../stores/toasts';
import { useUi } from '../../../stores/ui';
import { useVoice } from '../../../stores/voice';
import { memberName, useWorkspaces } from '../../../stores/workspaces';
import { knockKey, type MyKnock } from '../admissionsModel';
import { admissions, useAdmissions } from '../stores/admissions';

/**
 * Guest admission on the client (ADR-0040 §5): the gateway events and READY into the store, the
 * deciders' «Пустить / Отклонить» (optimistic), the guest's knock, «Отменить», «Постучать снова».
 */

// ---------------------------------------------------------------- REST (docs/05 «Гостевые ссылки»)

export const admissionApi = {
  decide: (roomId: string, userId: string, init: { status: RoomAdmissionStatus; displayName?: string; badgeId?: string }) =>
    call('POST', `/api/rooms/${roomId}/admissions/${userId}`, DecideRoomAdmissionResponseSchema, body(DecideRoomAdmissionRequestSchema, init)),
  cancel: (roomId: string) => callEmpty('DELETE', `/api/rooms/${roomId}/admissions/me`),
  /** The link's own setting: true / false override the room, null = as the room. */
  setLinkApproval: (roomId: string, inviteId: string, value: boolean | null) =>
    call(
      'PATCH',
      `/api/rooms/${roomId}/invites/${inviteId}`,
      UpdateRoomInviteResponseSchema,
      body(UpdateRoomInviteRequestSchema, value === null ? { inheritApproval: true } : { requireApproval: value }),
    ),
  join: (code: string) =>
    call('POST', `/api/room-invites/${encodeURIComponent(code)}/join`, JoinRoomInviteResponseSchema, body(JoinRoomInviteRequestSchema, {})),
};

// ---------------------------------------------------------------- link codes of my knocks

/**
 * The link a knock came by, per room: «Постучать снова» repeats the join. Kept per browser — a
 * convenience (after a reload the waiting screen comes back from READY; without the code the
 * guest opens the link again).
 */
const CODES_KEY = 'calab-knock-codes';

function readCodes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CODES_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeCode(roomId: string, code: string | null): void {
  try {
    const all = readCodes();
    if (code) all[roomId] = code;
    else delete all[roomId];
    localStorage.setItem(CODES_KEY, JSON.stringify(all));
  } catch {
    // storage blocked: «Постучать снова» asks to open the link again
  }
}

export const knockCode = (roomId: string): string | null => readCodes()[roomId] ?? null;

// ---------------------------------------------------------------- gateway

/** Rooms whose outcome the guest closed this session: a READY within the 10-minute hold does not bring it back. */
const dismissed = new Set<string>();

/** READY: the knocks I decide (every workspace snapshot) and my own (Ready.pending_admissions). */
export function applyReadyAdmissions(r: Ready): void {
  const rooms = useRooms.getState().byId;
  admissions({
    type: 'ready',
    deciders: r.workspaces.flatMap((w) => w.admissions),
    mine: r.pendingAdmissions,
    showDeclined: r.me?.user?.isGuest === true,
    dismissed,
    has: (id) => id in rooms,
  });
  enterAdmitted();
}

/** ROOM_ADMISSION_REQUEST / ROOM_ADMISSION_DECIDED. */
export function onAdmissionEvent(e: DispatchEvent['event']): void {
  if (e.case === 'roomAdmissionRequest') {
    const a = e.value.admission;
    if (!a) return;
    const before = useAdmissions.getState().toasts;
    admissions({ type: 'request', admission: a });
    const key = knockKey(a.roomId, a.user?.id ?? '');
    const added = useAdmissions.getState().toasts !== before;
    if (forMe(a)) {
      if (added) announceKnock(a);
    } else if (useAdmissions.getState().toasts.includes(key)) {
      // Not mine to decide: the row only (no toast, sound or notification), never escalated.
      admissions({ type: 'dismissToast', key });
    }
    return;
  }
  if (e.case !== 'roomAdmissionDecided' || !e.value.admission) return;
  const a = e.value.admission;
  const me = myUserId();
  const hidden = a.user?.id === me ? useAdmissions.getState().mine[a.roomId]?.hidden === true : false;
  admissions({ type: 'decided', admission: a, me });
  if (a.user?.id !== me) return;
  const k = useAdmissions.getState().mine[a.roomId];
  if (!k) return;
  // In the background (a registered user went back to the app): the outcome as a toast.
  if (hidden && k.phase !== 'admitted' && k.phase !== 'pending') {
    toast.info(k.phase === 'declined' ? t('adm.toastDeclined', { room: k.roomName }) : k.phase === 'noAnswer' ? t('adm.toastNoAnswer', { room: k.roomName }) : t('adm.toastCancelled', { room: k.roomName }));
    admissions({ type: 'forget', roomId: a.roomId });
    return;
  }
  enterAdmitted();
}

/** The knock just made (join answered with `admission`): the waiting screen at once. */
export function startWaiting(json: unknown, code: string): boolean {
  let a: RoomAdmission;
  try {
    a = fromJson(RoomAdmissionSchema, json as JsonValue, { ignoreUnknownFields: true });
  } catch (e) {
    log.warn('admission in the join answer unreadable', e);
    return false;
  }
  return waitFor(a, code);
}

export function waitFor(a: RoomAdmission, code: string): boolean {
  if (!a.roomId) return false;
  dismissed.delete(a.roomId);
  writeCode(a.roomId, code);
  admissions({ type: 'knocked', admission: a });
  enterAdmitted();
  return true;
}

/**
 * Admitted knocks whose room is in the store: open it (voice rooms are only opened — joining the
 * call stays the guest's click). Both event orders end here (docs/05: DECIDED vs ROOM_CREATE).
 */
function enterAdmitted(): void {
  const { mine } = useAdmissions.getState();
  const rooms = useRooms.getState().byId;
  for (const k of Object.values(mine)) {
    if (k.phase !== 'admitted' || !rooms[k.roomId]) continue;
    admissions({ type: 'forget', roomId: k.roomId });
    writeCode(k.roomId, null);
    useUi.getState().openRoom(rooms[k.roomId]?.workspaceId ?? k.workspaceId, k.roomId);
    if (k.hidden) toast.success(t('adm.toastAdmitted', { room: k.roomName }));
  }
  armEnterTimeout();
}

/** Admitted but the room never came (removed meanwhile): the screen does not hang on «Входим…». */
let enterTimer = 0;
function armEnterTimeout(): void {
  const waiting = Object.values(useAdmissions.getState().mine).some((k) => k.phase === 'admitted');
  if (!waiting) {
    window.clearTimeout(enterTimer);
    enterTimer = 0;
    return;
  }
  if (enterTimer) return;
  enterTimer = window.setTimeout(() => {
    enterTimer = 0;
    for (const k of Object.values(useAdmissions.getState().mine)) if (k.phase === 'admitted') admissions({ type: 'forget', roomId: k.roomId });
  }, 20_000);
}

// Rooms arriving (the guest's ROOM_CREATE) and going (a decider's room deleted / hidden).
let lastRooms = useRooms.getState().byId;
useRooms.subscribe((s) => {
  if (s.byId === lastRooms) return;
  lastRooms = s.byId;
  const { mine, byRoom } = useAdmissions.getState();
  if (Object.keys(mine).length === 0 && Object.keys(byRoom).length === 0) return;
  const rooms = s.byId;
  admissions({ type: 'rooms', has: (id) => id in rooms });
  enterAdmitted();
});

// Signed out: nothing of the previous account stays (another account may sign in next).
useSession.subscribe((s, prev) => {
  if (s.status !== 'authed' && prev.status === 'authed') {
    useAdmissions.setState({ byRoom: {}, gone: {}, toasts: [], mine: {} });
    dismissed.clear();
  }
});

/**
 * Whose knock this is to decide (ADR-0040 §3, amendment 2026-10-06; the server's knockAudience,
 * gateway/knock.go, sends it to nobody else): the author of the link the guest came by, or me in
 * the voice of that room. A room merely open, or INVITE_GUESTS alone, is not enough — and
 * nothing escalates to other deciders later: a knock the server did not address to me is kept
 * as a row (the room counter, the waiting group) without a toast, sound or notification.
 */
export function forMe(a: Pick<RoomAdmission, 'roomId' | 'inviteCreatedBy'>): boolean {
  if (a.inviteCreatedBy && a.inviteCreatedBy === myUserId()) return true;
  return useVoice.getState().roomId === a.roomId;
}

/** The knock title: «Гость «{name}» просит войти в «{room}»». */
export const knockTitle = (name: string, room: string): string => t('adm.knockTitle', { name, room });

/** «По ссылке от {author}»: the author when he is a member of the workspace, else ''. */
export function knockAuthor(a: RoomAdmission): string {
  const id = a.inviteCreatedBy;
  if (!id || !a.workspaceId || !useWorkspaces.getState().byId[a.workspaceId]?.members[id]) return '';
  return t('adm.knockByLink', { author: memberName(a.workspaceId, id) });
}

/** A live knock: the notification sound (not in «Не беспокоить» or a muted room) and, in the background, a system notification. */
function announceKnock(a: RoomAdmission): void {
  const p = prefs();
  if (p.presence === PresenceStatus.DND) return;
  const quiet = isQuietRoom(a.roomId, useRooms.getState());
  if (!quiet) playSound('mention');
  if (quiet || document.hasFocus() || !(p.notifyMentions || p.notifyAll)) return;
  const room = useRooms.getState().byId[a.roomId];
  try {
    const n = new Notification(knockTitle(a.user?.displayName ?? '', room?.name ?? ''), { body: t('adm.knockBody'), silent: true, tag: `knock:${a.roomId}` });
    n.onclick = () => {
      window.focus();
      if (room) useUi.getState().openRoom(room.workspaceId, room.id);
    };
  } catch {
    // notifications unavailable
  }
  platform.app.attention();
}

// ---------------------------------------------------------------- deciders

export interface Decision {
  admit: boolean;
  /** Renamed on admission (1..40; guests only). */
  displayName?: string | undefined;
  /** '' = none; undefined = unchanged. */
  badgeId?: string | undefined;
}

/**
 * «Пустить» / «Отклонить»: the row and the toast go at once; a refusal brings them back with an
 * error toast. A knock decided elsewhere meanwhile (404 / 409) just stays gone.
 */
export async function decide(roomId: string, userId: string, d: Decision): Promise<boolean> {
  const a = useAdmissions.getState().byRoom[roomId]?.find((x) => x.user?.id === userId);
  admissions({ type: 'take', roomId, userId });
  try {
    await admissionApi.decide(roomId, userId, {
      status: d.admit ? RoomAdmissionStatus.ADMITTED : RoomAdmissionStatus.DECLINED,
      ...(d.admit && d.displayName !== undefined ? { displayName: d.displayName } : {}),
      ...(d.admit && d.badgeId !== undefined ? { badgeId: d.badgeId } : {}),
    });
    return true;
  } catch (e) {
    log.warn('admission decision failed', e);
    if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
      toast.info(t('adm.alreadyDecided'));
      return false;
    }
    if (a) admissions({ type: 'restore', admission: a });
    toast.error(errorText(e, d.admit ? t('adm.admitFailed') : t('adm.declineFailed')));
    return false;
  }
}

export const dismissKnockToast = (roomId: string, userId: string): void => admissions({ type: 'dismissToast', key: knockKey(roomId, userId) });

// ---------------------------------------------------------------- the guest

/** «Отменить»: back to the join card of the room (DELETE …/admissions/me). */
export async function cancelKnock(roomId: string): Promise<void> {
  admissions({ type: 'phase', roomId, phase: 'cancelled' });
  try {
    await admissionApi.cancel(roomId);
  } catch (e) {
    // Already decided (404): the DECIDED event that follows sets the real outcome.
    if (!(e instanceof ApiError && e.status === 404)) {
      admissions({ type: 'phase', roomId, phase: 'pending' });
      toast.error(errorText(e, t('adm.cancelFailed')));
    }
  }
}

/** «Постучать снова» / «Постучать»: the same link again (a signed-in join). */
export async function knockAgain(roomId: string): Promise<void> {
  const code = knockCode(roomId);
  if (!code) return;
  try {
    const r = await admissionApi.join(code);
    if (r.admission) waitFor(r.admission, code);
    else {
      // Let in at once (the setting changed meanwhile): open the room when it arrives.
      admissions({ type: 'phase', roomId, phase: 'admitted' });
      enterAdmitted();
    }
  } catch (e) {
    log.warn('knock again failed', e);
    toast.error(knockError(e));
  }
}

/** Errors of a knock: the 10-minute hold after a decline and the full queue have their own texts. */
export function knockError(e: unknown): string {
  if (e instanceof ApiError && e.is('ERROR_CODE_RATE_LIMITED')) {
    if (e.reason === 'ADMISSION_DECLINED') return t('adm.errDeclined');
    if (e.reason === 'ADMISSION_QUEUE_FULL') return t('adm.errQueueFull');
  }
  return errorText(e);
}

/** «Закрыть» on an outcome: the knock is done with (a decline the server still keeps stays closed). */
export function closeKnock(k: MyKnock): void {
  dismissed.add(k.roomId);
  admissions({ type: 'forget', roomId: k.roomId });
  if (k.phase !== 'declined') writeCode(k.roomId, null);
}

/** A registered user goes back to the app while waiting: a toast brings the outcome. */
export const hideKnock = (roomId: string): void => admissions({ type: 'hide', roomId });
