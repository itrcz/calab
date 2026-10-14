import { RoomAdmissionStatus, type RoomAdmission } from '@calaba/protocol';
import { timestampMs } from '@bufbuild/protobuf/wkt';

/**
 * Guest admission (ADR-0040 §3, §5) — the pure state behind the stores: the deciders' pending
 * knocks by room, the knock toasts, and the guest's own knocks with the waiting-screen phase.
 * Events may arrive in any order: ROOM_ADMISSION_DECIDED (ADMITTED) and the guest's ROOM_CREATE
 * are not ordered (docs/05), a REQUEST may be replayed after its DECIDED (RESUME).
 */

/** Waiting-screen phases of the guest's own knock. */
export type WaitPhase =
  /** «Ожидаем подтверждения организатора…» */
  | 'pending'
  /** Admitted: the room opens as soon as it is in the store (ROOM_CREATE may still be on its way). */
  | 'admitted'
  /** «Организатор отклонил вход» — a new knock not before `retryAt`. */
  | 'declined'
  /** «Никто не ответил» — may knock again at once. */
  | 'noAnswer'
  /** Withdrawn («Отменить», or on another device): the join card with «Постучать». */
  | 'cancelled';

export interface MyKnock {
  roomId: string;
  workspaceId: string;
  roomName: string;
  workspaceName: string;
  phase: WaitPhase;
  requestedAt: number;
  /** When a person declined: a new knock is refused until then (ms; 0 = at once). */
  retryAt: number;
  /** The user went back to the app (registered users only): no screen, a toast on the outcome. */
  hidden: boolean;
}

export interface AdmissionsData {
  /** Deciders: pending knocks by room id, oldest first. */
  byRoom: Record<string, RoomAdmission[]>;
  /** Decided / withdrawn knocks → their requested_at (ms): a late REQUEST replay is ignored. */
  gone: Record<string, number>;
  /** Knocks raised live (not READY) that still have a toast, oldest first (keys). */
  toasts: string[];
  /** The guest's own knocks by room id. */
  mine: Record<string, MyKnock>;
}

export const EMPTY: AdmissionsData = { byRoom: {}, gone: {}, toasts: [], mine: {} };

/** A declined knock may be repeated this long after a person's decision (ADR-0040 §2). */
export const DECLINE_HOLD_MS = 10 * 60_000;

/**
 * The users knocking on any room of a workspace, sorted, as one primitive («a,b»): the members
 * panel keeps them out of «В сети» / «Не в сети» until they are let in — a waiting guest is already
 * a `guest` member of the workspace, but not in yet (they show in «Ожидают подтверждения» instead).
 */
export function knockingKey(byRoom: Record<string, RoomAdmission[]>, workspaceId: string): string {
  const ids = new Set<string>();
  for (const list of Object.values(byRoom)) for (const a of list) if (a.workspaceId === workspaceId && a.user?.id) ids.add(a.user.id);
  return [...ids].sort().join(',');
}

export const knockKey = (roomId: string, userId: string): string => `${roomId}:${userId}`;
export const splitKey = (key: string): { roomId: string; userId: string } => {
  const i = key.lastIndexOf(':');
  return { roomId: key.slice(0, i), userId: key.slice(i + 1) };
};

const ms = (a: RoomAdmission, f: 'requestedAt' | 'decidedAt'): number => (a[f] ? timestampMs(a[f]) : 0);

function byRequested(a: RoomAdmission, b: RoomAdmission): number {
  return ms(a, 'requestedAt') - ms(b, 'requestedAt') || (a.user?.id ?? '').localeCompare(b.user?.id ?? '');
}

/** One room's list without `userId` (the same array when absent — no re-render). */
function without(list: RoomAdmission[] | undefined, userId: string): RoomAdmission[] | undefined {
  if (!list?.some((a) => a.user?.id === userId)) return list;
  return list.filter((a) => a.user?.id !== userId);
}

function setRoom(byRoom: Record<string, RoomAdmission[]>, roomId: string, list: RoomAdmission[] | undefined): Record<string, RoomAdmission[]> {
  if (byRoom[roomId] === list) return byRoom;
  const next = { ...byRoom };
  if (list?.length) next[roomId] = list;
  else delete next[roomId];
  return next;
}

/** The guest's knock as the waiting screen shows it. */
export function myKnockOf(a: RoomAdmission, prev?: MyKnock): MyKnock {
  const phase = phaseOf(a);
  const decided = ms(a, 'decidedAt') || Date.now();
  return {
    roomId: a.roomId,
    workspaceId: a.workspaceId || prev?.workspaceId || '',
    roomName: a.roomName || prev?.roomName || '',
    workspaceName: a.workspaceName || prev?.workspaceName || '',
    phase,
    requestedAt: ms(a, 'requestedAt') || prev?.requestedAt || 0,
    retryAt: phase === 'declined' ? decided + DECLINE_HOLD_MS : 0,
    hidden: prev?.hidden ?? false,
  };
}

export function phaseOf(a: RoomAdmission): WaitPhase {
  switch (a.status) {
    case RoomAdmissionStatus.ADMITTED:
      return 'admitted';
    case RoomAdmissionStatus.DECLINED:
      return a.noAnswer ? 'noAnswer' : 'declined';
    case RoomAdmissionStatus.CANCELLED:
      return 'cancelled';
    default:
      return 'pending';
  }
}

export type AdmissionAction =
  /**
   * READY: the deciders' knocks of every workspace snapshot and the recipient's own. `showDeclined`:
   * surface declines kept by the server (guest accounts — they have nothing else to look at);
   * `dismissed`: rooms whose outcome the guest closed this session.
   */
  | { type: 'ready'; deciders: RoomAdmission[]; mine: RoomAdmission[]; showDeclined: boolean; dismissed: ReadonlySet<string>; has: (roomId: string) => boolean }
  /** ROOM_ADMISSION_REQUEST (live: a toast too). */
  | { type: 'request'; admission: RoomAdmission }
  /** ROOM_ADMISSION_DECIDED; `me` tells the guest's own from a knock someone else decides. */
  | { type: 'decided'; admission: RoomAdmission; me: string }
  /** The knock just made (join response): the waiting screen right away. */
  | { type: 'knocked'; admission: RoomAdmission }
  /** A room is in the store now (ROOM_CREATE / snapshot): a waiting knock on it was admitted. */
  | { type: 'rooms'; has: (roomId: string) => boolean }
  /** Optimistic decision: the row goes at once… */
  | { type: 'take'; roomId: string; userId: string }
  /** …and comes back when the server refused. */
  | { type: 'restore'; admission: RoomAdmission }
  | { type: 'dismissToast'; key: string }
  /** The knock is still pending and its toast was held back: show it now (60 s escalation). */
  | { type: 'showToast'; key: string }
  /** The guest's knock is closed (entered the room, «Закрыть»). */
  | { type: 'forget'; roomId: string }
  | { type: 'hide'; roomId: string }
  | { type: 'phase'; roomId: string; phase: WaitPhase };

export function reduce(s: AdmissionsData, act: AdmissionAction): AdmissionsData {
  switch (act.type) {
    case 'ready': {
      const byRoom: Record<string, RoomAdmission[]> = {};
      for (const a of act.deciders) if (a.status === RoomAdmissionStatus.PENDING || a.status === RoomAdmissionStatus.UNSPECIFIED) (byRoom[a.roomId] ??= []).push(a);
      for (const list of Object.values(byRoom)) list.sort(byRequested);
      const mine: Record<string, MyKnock> = {};
      for (const a of act.mine) {
        const k = myKnockOf(a, s.mine[a.roomId]);
        if (k.phase === 'pending') mine[a.roomId] = k;
        else if ((k.phase === 'declined' || k.phase === 'noAnswer') && act.showDeclined && !act.dismissed.has(a.roomId)) mine[a.roomId] = k;
      }
      // Outcomes already on screen stay (the server may not keep them; a reconnect must not wipe
      // «Организатор отклонил вход» the guest is reading). An admitted one waits for its room.
      // A knock that was waiting here and is gone from READY was decided meanwhile: admitted when its
      // room came with READY, else the outcome is unknown and it is dropped.
      for (const [id, k] of Object.entries(s.mine)) {
        if (mine[id]) continue;
        if (k.phase !== 'pending') mine[id] = k;
        else if (act.has(id)) mine[id] = { ...k, phase: 'admitted' };
      }
      for (const [id, k] of Object.entries(mine)) if (k.phase === 'pending' && act.has(id)) mine[id] = { ...k, phase: 'admitted' };
      return { byRoom, gone: {}, toasts: [], mine };
    }
    case 'request': {
      const a = act.admission;
      const userId = a.user?.id ?? '';
      if (!userId || !a.roomId) return s;
      const key = knockKey(a.roomId, userId);
      const gone = s.gone[key];
      if (gone !== undefined && gone >= ms(a, 'requestedAt')) return s; // a replay of a decided knock
      const list = [...(without(s.byRoom[a.roomId], userId) ?? []), a].sort(byRequested);
      const nextGone = { ...s.gone };
      delete nextGone[key];
      return { ...s, byRoom: setRoom(s.byRoom, a.roomId, list), gone: nextGone, toasts: s.toasts.includes(key) ? s.toasts : [...s.toasts, key] };
    }
    case 'decided': {
      const a = act.admission;
      const userId = a.user?.id ?? '';
      if (userId && userId === act.me) {
        const prev = s.mine[a.roomId];
        // Unknown knocks are not resurrected (e.g. entered already by its ROOM_CREATE).
        if (!prev) return s;
        return { ...s, mine: { ...s.mine, [a.roomId]: myKnockOf(a, prev) } };
      }
      const key = knockKey(a.roomId, userId);
      return {
        ...s,
        byRoom: setRoom(s.byRoom, a.roomId, without(s.byRoom[a.roomId], userId)),
        gone: { ...s.gone, [key]: Math.max(s.gone[key] ?? 0, ms(a, 'requestedAt')) },
        toasts: s.toasts.includes(key) ? s.toasts.filter((k) => k !== key) : s.toasts,
      };
    }
    case 'knocked': {
      const a = act.admission;
      return { ...s, mine: { ...s.mine, [a.roomId]: { ...myKnockOf(a, s.mine[a.roomId]), hidden: false } } };
    }
    case 'rooms': {
      let mine = s.mine;
      for (const [id, k] of Object.entries(s.mine)) {
        if (k.phase === 'pending' && act.has(id)) mine = { ...mine, [id]: { ...k, phase: 'admitted' } };
      }
      let byRoom = s.byRoom;
      for (const id of Object.keys(s.byRoom)) if (!act.has(id)) byRoom = setRoom(byRoom, id, undefined);
      if (mine === s.mine && byRoom === s.byRoom) return s;
      const toasts = byRoom === s.byRoom ? s.toasts : s.toasts.filter((k) => splitKey(k).roomId in byRoom);
      return { ...s, mine, byRoom, toasts };
    }
    case 'take': {
      const key = knockKey(act.roomId, act.userId);
      const a = s.byRoom[act.roomId]?.find((x) => x.user?.id === act.userId);
      return {
        ...s,
        byRoom: setRoom(s.byRoom, act.roomId, without(s.byRoom[act.roomId], act.userId)),
        gone: { ...s.gone, [key]: a ? ms(a, 'requestedAt') : Number.MAX_SAFE_INTEGER },
        toasts: s.toasts.filter((k) => k !== key),
      };
    }
    case 'restore': {
      const a = act.admission;
      const userId = a.user?.id ?? '';
      const key = knockKey(a.roomId, userId);
      const gone = { ...s.gone };
      delete gone[key];
      const list = [...(without(s.byRoom[a.roomId], userId) ?? []), a].sort(byRequested);
      return { ...s, byRoom: setRoom(s.byRoom, a.roomId, list), gone };
    }
    case 'showToast': {
      const { roomId, userId } = splitKey(act.key);
      if (s.toasts.includes(act.key) || !s.byRoom[roomId]?.some((x) => x.user?.id === userId)) return s;
      return { ...s, toasts: [...s.toasts, act.key] };
    }
    case 'dismissToast':
      return s.toasts.includes(act.key) ? { ...s, toasts: s.toasts.filter((k) => k !== act.key) } : s;
    case 'forget': {
      if (!s.mine[act.roomId]) return s;
      const mine = { ...s.mine };
      delete mine[act.roomId];
      return { ...s, mine };
    }
    case 'hide': {
      const k = s.mine[act.roomId];
      return k ? { ...s, mine: { ...s.mine, [act.roomId]: { ...k, hidden: true } } } : s;
    }
    case 'phase': {
      const k = s.mine[act.roomId];
      return k && k.phase !== act.phase ? { ...s, mine: { ...s.mine, [act.roomId]: { ...k, phase: act.phase } } } : s;
    }
  }
}

/** The knock the waiting screen shows: the latest one not sent to the background. */
export function focusKnock(mine: Record<string, MyKnock>): MyKnock | null {
  let best: MyKnock | null = null;
  for (const k of Object.values(mine)) if (!k.hidden && (!best || k.requestedAt > best.requestedAt)) best = k;
  return best;
}

/** What the waiting screen offers in a phase (the state machine's visible side). */
export interface WaitView {
  title: 'waiting' | 'entering' | 'declined' | 'noAnswer' | 'join';
  loader: boolean;
  cancel: boolean;
  /** «Постучать снова» / «Постучать» available now (needs the link code). */
  knock: boolean;
  /** Declined: when a new knock is allowed (ms), while it is not yet. */
  retryAt: number | null;
  close: boolean;
}

export function waitView(k: MyKnock, now: number, hasCode: boolean): WaitView {
  switch (k.phase) {
    case 'pending':
      return { title: 'waiting', loader: true, cancel: true, knock: false, retryAt: null, close: false };
    case 'admitted':
      return { title: 'entering', loader: true, cancel: false, knock: false, retryAt: null, close: false };
    case 'declined': {
      const wait = k.retryAt > now;
      return { title: 'declined', loader: false, cancel: false, knock: !wait && hasCode, retryAt: wait ? k.retryAt : null, close: true };
    }
    case 'noAnswer':
      return { title: 'noAnswer', loader: false, cancel: false, knock: hasCode, retryAt: null, close: true };
    case 'cancelled':
      return { title: 'join', loader: false, cancel: false, knock: hasCode, retryAt: null, close: true };
  }
}
