import { localAuthority } from '../features/identity/model';
import { openWorkspace } from '../features/shell/sectionNav';
import { isMenuAction, type MenuAction, type MenuState } from '../../shared/menu';
import { cameraBlock } from '../lib/media/cameraLogic';
import { mayArrangeRooms, mayInviteMembers } from '../lib/permissions';
import { comboAccelerator, effectiveHotkeys } from '../lib/shortcuts';
import { platform } from '../platform';
import { HOME } from '../stores/dms';
import { usePrefs } from '../stores/prefs';
import { useRooms } from '../stores/rooms';
import { useSession } from '../stores/session';
import { MEMBERS_COLUMN_MIN, useUi } from '../stores/ui';
import { useVoice } from '../stores/voice';
import { rolesOf, useWorkspaces } from '../stores/workspaces';
import { IS_MAC } from './hotkeys';
import { voice } from './voice';

/**
 * The macOS menu bar / Dock menu (docs/08 «Меню macOS», shared/menu.ts): pushes a small state
 * summary to main and runs the commands main sends back. The summary is recomputed at most once
 * per task on a store change and sent only when it differs (voice levels, typing, presence do not
 * cause IPC). macOS desktop only.
 */

function voiceSummary(): MenuState['voice'] {
  const v = useVoice.getState();
  const inRoom = v.roomId !== null;
  const connected = v.phase === 'connected';
  const limit = v.call ? 2 : ((v.roomId ? useRooms.getState().byId[v.roomId]?.media?.cameraLimit : 0) ?? 0);
  const camera = v.camera === 'on' || v.camera === 'starting';
  return {
    inRoom,
    muted: v.muted,
    deafened: v.deafened,
    camera,
    canCamera: inRoom && (v.camera !== 'off' || cameraBlock({ connected, canVideo: v.canVideo, limit, phase: v.camera }) === null),
    streaming: v.myStream !== null,
    canStream: inRoom && (v.myStream !== null || (connected && v.canStream)),
  };
}

export function menuSummary(): MenuState {
  const signedIn = useSession.getState().status === 'authed';
  const me = useSession.getState().me?.user?.id ?? '';
  const ws = useWorkspaces.getState();
  const active = useUi.getState().activeWorkspaceId;
  const entry = active && active !== HOME ? ws.byId[active] : undefined;
  const roles = entry ? rolesOf(entry, me) : undefined;
  const keys = effectiveHotkeys(usePrefs.getState().hotkeys, IS_MAC);
  return {
    signedIn,
    voice: voiceSummary(),
    workspaces: ws.order.flatMap((id) => {
      const name = ws.byId[id]?.ws.name;
      return name === undefined ? [] : [{ id, name }];
    }),
    activeWorkspaceId: entry ? active : null,
    canCreateRoom: !!entry && mayArrangeRooms(roles),
    canInvite: !!entry && mayInviteMembers(roles),
    hotkeys: {
      search: comboAccelerator(keys.search, IS_MAC),
      mute: comboAccelerator(keys.mute, IS_MAC),
      deafen: comboAccelerator(keys.deafen, IS_MAC),
    },
  };
}

/** The same as the room header's «Участники» (ChatPane): a column when wide, else the overlay. */
function toggleMembers(): void {
  const ui = useUi.getState();
  if (window.matchMedia(`(min-width: ${MEMBERS_COLUMN_MIN}px)`).matches) ui.toggleMembers();
  else ui.setMembersOverlay(!ui.membersOverlay);
}

/** The same as the voice panel's camera button (VoiceBar CameraButton). */
function toggleCamera(): void {
  const phase = useVoice.getState().camera;
  if (phase === 'on' || phase === 'starting') void voice.camera.stop();
  else if (phase !== 'off') return;
  else if (!usePrefs.getState().cameraChecked) useUi.getState().openDialog({ kind: 'camera-preview' });
  else void voice.camera.start();
}

export function runMenuAction(a: MenuAction): void {
  const ui = useUi.getState();
  const st = menuSummary();
  if (!st.signedIn) return;
  if (a.startsWith('workspace:')) {
    const id = a.slice('workspace:'.length);
    // ⌘1…⌘9: the workspace on the section it was left on (ADR-0074 §2).
    if (st.workspaces.some((w) => w.id === id)) openWorkspace(id);
    return;
  }
  const v = st.voice;
  switch (a) {
    case 'about':
      ui.openDialog({ kind: 'settings', tab: 'about' });
      return;
    case 'settings':
      ui.openDialog({ kind: 'settings' });
      return;
    case 'shortcuts':
      ui.openDialog({ kind: 'settings', tab: 'hotkeys' });
      return;
    case 'new-message':
      if (!localAuthority(useSession.getState().authority)) return;
      ui.openDialog({ kind: 'new-dm' });
      return;
    case 'room-create':
      if (st.canCreateRoom && st.activeWorkspaceId) ui.openDialog({ kind: 'room-create', workspaceId: st.activeWorkspaceId, voice: false });
      return;
    case 'invite':
      if (st.canInvite && st.activeWorkspaceId) ui.openDialog({ kind: 'workspace-settings', workspaceId: st.activeWorkspaceId, tab: 'invites' });
      return;
    case 'search':
      ui.openDialog(ui.dialog?.kind === 'quick-switcher' ? null : { kind: 'quick-switcher' });
      return;
    case 'members':
      toggleMembers();
      return;
    case 'dms':
      if (!localAuthority(useSession.getState().authority)) return;
      ui.setWorkspace(HOME);
      return;
    case 'toggle-mute':
      if (v.inRoom) voice.toggleMute();
      return;
    case 'toggle-deafen':
      if (v.inRoom) voice.toggleDeafen();
      return;
    case 'toggle-camera':
      if (v.canCamera) toggleCamera();
      return;
    case 'share-screen':
      if (v.streaming) void voice.stopStream();
      else if (v.canStream) ui.openDialog({ kind: 'stream-picker' });
      return;
    case 'leave-voice':
      if (v.inRoom) void voice.leave();
      return;
  }
}

let installed = false;

export function installMenu(): void {
  if (installed || platform.kind !== 'electron' || !IS_MAC) return;
  installed = true;
  let last = '';
  let queued = false;
  const push = (): void => {
    queued = false;
    const s = menuSummary();
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    platform.menu.setState(s);
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(push);
  };
  // Only the fields the summary reads: mic levels, speaking, typing etc. do not even schedule it.
  useSession.subscribe((s, p) => {
    if (s.status !== p.status || s.me !== p.me) schedule();
  });
  useUi.subscribe((s, p) => {
    if (s.activeWorkspaceId !== p.activeWorkspaceId) schedule();
  });
  useWorkspaces.subscribe((s, p) => {
    if (s.order !== p.order || s.byId !== p.byId) schedule();
  });
  useVoice.subscribe((s, p) => {
    if (
      s.roomId !== p.roomId ||
      s.phase !== p.phase ||
      s.call !== p.call ||
      s.muted !== p.muted ||
      s.deafened !== p.deafened ||
      s.camera !== p.camera ||
      s.canVideo !== p.canVideo ||
      s.canStream !== p.canStream ||
      s.myStream !== p.myStream
    )
      schedule();
  });
  usePrefs.subscribe((s, p) => {
    if (s.hotkeys !== p.hotkeys) schedule();
  });
  useRooms.subscribe((s, p) => {
    const id = useVoice.getState().roomId;
    if (id && s.byId[id]?.media !== p.byId[id]?.media) schedule();
  });
  platform.menu.onAction((a) => {
    if (isMenuAction(a)) runMenuAction(a);
  });
  push();
}
