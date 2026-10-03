import type { ReactNode } from 'react';
import { useAchievementUi } from '../../stores/achievementUi';
import { AchievementView } from './AchievementView';
import { GrantAchievementDialog } from './GrantAchievementDialog';

const closeView = (): void => useAchievementUi.getState().openView(null);
const closeGrant = (): void => useAchievementUi.getState().openGrant(null);

/**
 * The achievement viewer and the grant dialog (ADR-0061 §5), above any open dialog: the grant
 * dialog is opened from the member menu and the profile, the viewer from the chat card, the
 * profile and the superadmin catalog. Mounted by features/shell/Dialogs (before ConfirmHost, so a
 * confirmation stays on top).
 */
export function AchievementLayers(): ReactNode {
  const view = useAchievementUi((s) => s.view);
  const grant = useAchievementUi((s) => s.grant);
  return (
    <>
      {grant ? <GrantAchievementDialog key={`${grant.workspaceId}:${grant.userId}`} workspaceId={grant.workspaceId} userId={grant.userId} initial={grant.achievementId} onClose={closeGrant} /> : null}
      {view ? <AchievementView key={view.achievementId} req={view} onClose={closeView} /> : null}
    </>
  );
}
