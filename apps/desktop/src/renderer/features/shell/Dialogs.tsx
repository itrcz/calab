import { localAuthority } from '../identity/model';
import { lazy, Suspense, type ReactNode } from 'react';
import { openMessage } from '../../services/searchNav';
import { ConfirmHost } from '../../components/Confirm';
import { Lightbox } from '../chat/Lightbox';
import { useUi } from '../../stores/ui';
import { CameraPreview } from '../voice/CameraPreview';
import { StreamPicker } from '../voice/StreamPicker';
import { QuickSwitcher } from './QuickSwitcher';
import { NewDmDialog } from '../dm/NewDmDialog';
import { ForwardDialog } from '../chat/ForwardDialog';
import { InviteToRoomDialog } from '../people/InviteToRoomDialog';
import { ProfileDialog } from '../people/ProfileDialog';
import { AchievementLayers } from '../people/AchievementLayers';
import { RoomCreateDialog, RoomSettingsDialog } from '../workspace/RoomDialogs';
import { TempExtendDialog, TempRoomDialog } from '../workspace/TempRoomDialog';
import { CreateWorkspaceDialog, JoinWorkspaceDialog } from '../workspace/WorkspaceDialogs';
import { AdminWindowLazy, AppSettingsWindow, WorkspaceSettingsWindow } from './lazyWindows';
import { useSession } from '../../stores/session';
import { EventDialog } from '../calendar/EventDialog';
import { SETTINGS_DIALOG_KINDS } from './SettingsScreen';
import { AppDialog } from '../webapps/AppDialog';
import { PlansDialog } from '../workspace/billing/PlansDialog';

const RecordingResult = lazy(() => import('../chat/RecordingResult'));

export function Dialogs(): ReactNode {
  const d = useUi((s) => s.dialog);
  const phone = useUi((s) => s.phone.on);
  const local = useSession((s) => localAuthority(s.authority));
  const superadmin = useSession((s) => s.me?.isSuperadmin === true);
  const close = (): void => useUi.getState().openDialog(null);
  let node: ReactNode = null;
  // Settings windows are screens of the phone stack (SettingsScreen), not dialogs.
  if (d && !(phone && SETTINGS_DIALOG_KINDS.includes(d.kind))) {
    if (!local && ['create-workspace', 'join-workspace', 'profile', 'admin', 'new-dm'].includes(d.kind)) return null;
    switch (d.kind) {
      case 'create-workspace':
        node = <CreateWorkspaceDialog onClose={close} />;
        break;
      case 'join-workspace':
        node = <JoinWorkspaceDialog onClose={close} initialCode={d.code ?? ''} />;
        break;
      case 'workspace-settings':
        // Keyed by the tab: a deep link to another tab while it is open (a plan violation «К ботам») opens it.
        node = <WorkspaceSettingsWindow.Component key={`${d.workspaceId}:${d.tab ?? ''}`} onClose={close} workspaceId={d.workspaceId} tab={d.tab} roomId={d.roomId} />;
        break;
      case 'room-create':
        node = <RoomCreateDialog onClose={close} workspaceId={d.workspaceId} voice={d.voice} categoryId={d.categoryId} />;
        break;
      case 'temp-room-create':
        node = <TempRoomDialog onClose={close} workspaceId={d.workspaceId} />;
        break;
      case 'temp-room-extend':
        node = <TempExtendDialog onClose={close} roomId={d.roomId} />;
        break;
      case 'room-settings':
        node = <RoomSettingsDialog onClose={close} roomId={d.roomId} tab={d.tab} />;
        break;
      case 'settings':
        node = <AppSettingsWindow.Component onClose={close} tab={d.tab} />;
        break;
      case 'stream-picker':
        node = <StreamPicker onClose={close} />;
        break;
      case 'camera-preview':
        node = <CameraPreview onClose={close} />;
        break;
      case 'quick-switcher':
        node = <QuickSwitcher onClose={close} initialQuery={d.query ?? ''} />;
        break;
      case 'new-dm':
        node = <NewDmDialog onClose={close} />;
        break;
      case 'forward':
        node = <ForwardDialog roomId={d.roomId} messageId={d.messageId} onClose={close} />;
        break;
      case 'room-invite':
        node = <InviteToRoomDialog roomId={d.roomId} onClose={close} />;
        break;
      case 'profile':
        node = <ProfileDialog key={d.userId} workspaceId={d.workspaceId} userId={d.userId} focusNote={d.note ?? false} onClose={close} />;
        break;
      case 'admin':
        // Only for superadmins (the server answers 404 to anyone else anyway).
        node = superadmin ? <AdminWindowLazy.Component onClose={close} workspaceId={d.workspaceId} /> : null;
        break;
      case 'event':
        node = (
          <EventDialog
            key={d.eventKey ?? 'new'}
            workspaceId={d.workspaceId}
            {...(d.eventKey ? { eventKey: d.eventKey } : {})}
            {...(d.draft ? { draft: d.draft } : {})}
            onClose={close}
          />
        );
        break;
      case 'web-app':
        node = <AppDialog key={d.appId ?? 'new'} workspaceId={d.workspaceId} appId={d.appId} onClose={close} />;
        break;
      case 'billing-plans':
        node = <PlansDialog key={d.workspaceId} workspaceId={d.workspaceId} welcome={d.welcome ?? false} onClose={close} />;
        break;
      case 'image': {
        const inChat = d.inChat;
        node = (
          <Lightbox
            images={d.images}
            index={d.index}
            onClose={close}
            {...(inChat
              ? {
                  onShowInChat: () => {
                    close();
                    openMessage(inChat.roomId, inChat.messageId);
                  },
                }
              : {})}
          />
        );
        break;
      }
      case 'transcript':
        node = (
          <Suspense fallback={null}>
            <RecordingResult
              key={`${d.recordingId}@${d.offsetMs}`}
              roomId={d.roomId}
              recordingId={d.recordingId}
              messageId={d.messageId}
              offsetMs={d.offsetMs}
              startedAt={d.startedAt}
              onClose={close}
            />
          </Suspense>
        );
        break;
    }
  }
  return (
    <>
      {node}
      <AchievementLayers />
      <ConfirmHost />
    </>
  );
}
