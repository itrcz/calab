import { useUi } from '../../stores/ui';
import { showMode } from './sectionNav';

/**
 * A click on a workspace icon in the phone's rail: open the workspace on «Голос»
 * — its rooms and the last opened room — whatever it was showing (calendar, boards; a web app is
 * closed by `setWorkspace`, ADR-0050 §3).
 */
export function openWorkspaceVoice(id: string): void {
  useUi.getState().setWorkspace(id);
  showMode('voice');
}
