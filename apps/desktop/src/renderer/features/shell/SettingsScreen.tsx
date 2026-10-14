import type { ReactNode } from 'react';
import { SettingsPageProvider } from '../../components/SettingsWindow';
import { useBoardsUi } from '../../stores/boardsUi';
import { useUi } from '../../stores/ui';
import { BoardSettingsHost } from '../boards/BoardSettings';
import { RoomSettingsDialog } from '../workspace/RoomDialogs';
import { AppSettingsWindow, WorkspaceSettingsWindow } from './lazyWindows';

/** The kinds of `ui.dialog` that are settings windows: screens on the phone (ADR-0073, owner 07.10). */
export const SETTINGS_DIALOG_KINDS: readonly string[] = ['settings', 'workspace-settings', 'room-settings'];

/**
 * A settings window (app, workspace, room, board) as a screen of the phone stack: the same
 * SettingsWindow, rendered in place instead of a sheet — the list of sections, or one section.
 * The window to show is the dialog / board request that pushed the screen (services/phoneNav.ts).
 */
export function SettingsScreen({ section }: { section: string | null }): ReactNode {
  const d = useUi((s) => s.dialog);
  const board = useBoardsUi((s) => s.settingsFor?.boardId ?? null);
  const close = (): void => {
    useUi.getState().openDialog(null);
    useBoardsUi.getState().openSettings(null);
  };
  let node: ReactNode = null;
  if (d?.kind === 'settings') node = <AppSettingsWindow.Component onClose={close} tab={d.tab} />;
  else if (d?.kind === 'workspace-settings') node = <WorkspaceSettingsWindow.Component key={`${d.workspaceId}:${d.tab ?? ''}`} onClose={close} workspaceId={d.workspaceId} tab={d.tab} roomId={d.roomId} />;
  else if (d?.kind === 'room-settings') node = <RoomSettingsDialog onClose={close} roomId={d.roomId} tab={d.tab} />;
  else if (board) node = <BoardSettingsHost screen />;
  return <SettingsPageProvider value={{ section }}>{node}</SettingsPageProvider>;
}
