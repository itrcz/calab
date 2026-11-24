import type { RoomRecording, WorkspaceSnapshot } from '@calaba/protocol';
import { confirmAction } from '../components/Confirm';
import { t, type MessageKey } from '../i18n';
import { ApiError } from '../lib/api/client';
import { api } from '../lib/api/endpoints';
import { mayManageIntegrations } from '../lib/permissions';
import { retryRefusalKey, stopReasonKey, withEvent, withSnapshot, withoutRooms, type ActiveRecording, type RecordingMap, type RetryAction } from '../lib/recording';
import { playSound } from '../lib/sounds';
import { useRecordings } from '../stores/recordings';
import { myUserId } from '../stores/session';
import { toast, useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { setVoice, useVoice } from '../stores/voice';
import { memberName, rolesOf, useWorkspaces } from '../stores/workspaces';
import { startSpeechReports } from './recordingSpeech';

/**
 * Meeting recording on the client (ADR-0025): the server's state of which rooms are recorded
 * (READY / WORKSPACE_CREATE `recordings[]`, ROOM_RECORDING) → stores/recordings, mirrored into
 * `voice.recording` for my room; start / stop from the room menu with human errors; in my call,
 * a sound and a toast when the recording starts or stops (with the reason), and a toast when I
 * join a room that is being recorded.
 */

/** READY: the recordings of every workspace (anything else known before is dropped). */
export function resetRecordings(snaps: readonly WorkspaceSnapshot[]): void {
  let map: RecordingMap = {};
  for (const s of snaps) if (s.workspace) map = withSnapshot(map, s.workspace.id, s.recordings);
  // A READY after a reconnect replays nothing: announce only what changed in my room.
  commit(map, null);
}

/** WORKSPACE_CREATE (joined a workspace): its recordings. */
export function applySnapshotRecordings(snap: WorkspaceSnapshot): void {
  if (!snap.workspace) return;
  commit(withSnapshot(useRecordings.getState().byRoom, snap.workspace.id, snap.recordings), null);
}

/** ROOM_RECORDING. */
export function onRoomRecording(ev: RoomRecording): void {
  commit(withEvent(useRecordings.getState().byRoom, ev), ev);
}

/** A deleted room / a workspace I left. */
export function dropRecordings(drop: (roomId: string, r: ActiveRecording) => boolean): void {
  commit(withoutRooms(useRecordings.getState().byRoom, drop), null);
}

/**
 * Stores the new map and, when the recording of my room changed, plays the start / stop cue and
 * says why (`ev` carries the stop reason; a READY that silently dropped it says nothing more).
 */
function commit(next: RecordingMap, ev: RoomRecording | null): void {
  const prev = useRecordings.getState().byRoom;
  if (next === prev) return;
  useRecordings.getState().set(next);
  const room = useVoice.getState().roomId;
  if (!room) return;
  const before = prev[room];
  const after = next[room];
  if (before?.recordingId === after?.recordingId) return;
  if (after) {
    playSound('recStart');
    if (after.byUserId !== myUserId()) toast.info(t('rec.notice.started', { name: memberName(after.workspaceId, after.byUserId) }));
  } else if (before) {
    playSound('recStop');
    const reason = ev?.roomId === room ? ev.stopReason : '';
    if (reason === 'user' && ev?.stoppedBy === myUserId()) toast.info(t('rec.stop.self'));
    else toast.info(t(stopReasonKey(reason), { name: memberName(before.workspaceId, ev?.stoppedBy ?? '') }));
  }
}

/**
 * `voice.recording` follows my room: the recordings store for the room I am in (the REC pill in
 * «Голос подключён», the phone strip). Joining a room that is being recorded says so once.
 */
function syncVoice(): void {
  const { roomId, recording } = useVoice.getState();
  const r = roomId ? useRecordings.getState().byRoom[roomId] : undefined;
  const next = r ? { byUserId: r.byUserId, since: r.since } : null;
  if (next?.byUserId === recording?.byUserId && next?.since === recording?.since) return;
  setVoice({ recording: next });
}

let started = false;

/** Subscribes the mirror (app start; idempotent). */
export function startRecordingSync(): void {
  if (started) return;
  started = true;
  startSpeechReports(); // my on-air time while my room is recorded: names in the transcript (ADR-0169)
  useRecordings.subscribe(syncVoice);
  // Only a room change matters here (the voice store changes many times a second: levels).
  useVoice.subscribe((s, p) => {
    if (s.roomId === p.roomId) return;
    syncVoice();
    const r = s.roomId ? useRecordings.getState().byRoom[s.roomId] : undefined;
    if (r) toast.info(t('rec.notice.join', { name: memberName(r.workspaceId, r.byUserId) }));
  });
}

// ---------------------------------------------------------------- actions

/** Pairing GPTunneL: MANAGE_INTEGRATIONS of my roles (ADR-0048), as the server checks. */
function canManage(workspaceId: string): boolean {
  return mayManageIntegrations(rolesOf(useWorkspaces.getState().byId[workspaceId], myUserId()));
}

/** «Запись встречи» in the room menu: POST …/recording/start; the errors say what to do. */
export async function startRecording(roomId: string, workspaceId: string): Promise<void> {
  try {
    const r = await api.recording.start(roomId);
    if (r.recording) onRoomRecording(r.recording);
  } catch (e) {
    startFailed(e, workspaceId);
  }
}

function notPaired(workspaceId: string): void {
  // The one who can connect it gets the way there; the others know whom to ask.
  if (canManage(workspaceId)) {
    useToasts.getState().push('info', t('rec.start.notPairedAdmin'), {
      label: t('rec.start.connect'),
      run: () => useUi.getState().openDialog({ kind: 'workspace-settings', workspaceId, tab: 'gptunnel' }),
    });
  } else toast.info(t('rec.start.notPaired'));
}

function startFailed(e: unknown, workspaceId: string): void {
  const code = e instanceof ApiError ? e.code : '';
  if (code === 'ERROR_CODE_NOT_PAIRED') {
    notPaired(workspaceId);
    return;
  }
  const info: Record<string, MessageKey> = {
    ERROR_CODE_ALREADY_RECORDING: 'rec.start.already',
    ERROR_CODE_RECORDING_LIMIT: 'rec.start.busy',
    ERROR_CODE_CONFLICT: 'rec.start.empty',
  };
  const key = info[code];
  if (key) toast.info(t(key));
  else if (code === 'ERROR_CODE_FORBIDDEN') toast.error(t('rec.start.forbidden'));
  else if (code === 'ERROR_CODE_UNAVAILABLE' && e instanceof ApiError && e.status !== 0) toast.error(t('rec.start.unavailable'));
  else toast.fail(e, t('rec.start.failed'));
}

/**
 * «Проверить снова» / «Отправить снова» on a failed card (docs/09 #40). The card follows by
 * MESSAGE_UPDATE; a refusal (file gone, already delivered, state changed) is an info toast — the
 * server refreshes the card at the same time.
 */
export async function retryRecording(roomId: string, recordingId: string, action: RetryAction, workspaceId: string): Promise<void> {
  try {
    await (action === 'recheck' ? api.recording.recheck(roomId, recordingId) : api.recording.reupload(roomId, recordingId));
  } catch (e) {
    const code = e instanceof ApiError ? e.code : '';
    const key = retryRefusalKey(code);
    if (code === 'ERROR_CODE_NOT_PAIRED') notPaired(workspaceId);
    else if (key) toast.info(t(key));
    else toast.fail(e, t('rec.retry.failed'));
  }
}

/**
 * «Удалить запись» from the card menu (docs/09 #50): asks first; the card turns into «Запись
 * удалена» by MESSAGE_UPDATE. 409 — still recording (stop it first), 404 — already deleted.
 */
export async function deleteRecording(roomId: string, recordingId: string): Promise<void> {
  if (!(await confirmAction(t('rec.delete.title'), t('rec.delete.text'), t('rec.delete.action')))) return;
  try {
    await api.recording.remove(roomId, recordingId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return; // gone already: the card follows
    if (e instanceof ApiError && e.code === 'ERROR_CODE_CONFLICT') toast.info(t('rec.delete.recording'));
    else toast.fail(e, t('rec.delete.failed'));
  }
}

/** «Остановить запись»: any participant (not a guest) may stop it (ADR-0025). */
export async function stopRecording(roomId: string): Promise<void> {
  try {
    const r = await api.recording.stop(roomId);
    if (r.recording) onRoomRecording(r.recording);
  } catch (e) {
    // 404: it has already stopped (the event is on its way or was missed) — just drop it here.
    if (e instanceof ApiError && e.status === 404) {
      dropRecordings((id) => id === roomId);
      return;
    }
    toast.fail(e, t('rec.stop.failed'));
  }
}
