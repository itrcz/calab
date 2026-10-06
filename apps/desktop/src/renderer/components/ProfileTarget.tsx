import type { MouseEvent, ReactNode } from 'react';
import { openProfile } from '../features/people/actions';
import { t } from '../i18n';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';
import { cx } from './ui';

/**
 * Click handler shared by every profile target: opens the member's profile (the one entry
 * point, features/people/actions openProfile) and keeps the click from reaching the row around
 * it (select a DM, watch a stream, jump to a message). Module-level and reading data attributes,
 * so no row creates a callback.
 */
export function openProfileFromClick(e: Pick<MouseEvent, 'stopPropagation' | 'currentTarget'>): void {
  e.stopPropagation();
  const el = e.currentTarget as HTMLElement | null;
  const ws = el?.dataset.profileWs;
  const uid = el?.dataset.profileUser;
  if (ws && uid) openProfile(ws, uid);
}

/**
 * A person's avatar / name as a button that opens their profile («Открыть профиль {name}»,
 * docs/08). The profile is a workspace member's: a user who is not a member of the workspace
 * (a DM peer from elsewhere, a deleted account) is not a target: the children render as they
 * are, no dead button. `workspaceId` defaults to the active workspace. The selectors return a
 * string / boolean, so member churn re-renders nothing. Out of the Tab order by default where the
 * row around it is the keyboard path (the feed); pass `tabbable` where it should be reachable.
 * Right click is left alone: the row's member menu still opens.
 */
export function ProfileTarget({
  userId,
  name,
  workspaceId,
  className,
  tabbable = false,
  children,
}: {
  userId: string;
  name: string;
  workspaceId?: string | undefined;
  className?: string | undefined;
  tabbable?: boolean | undefined;
  children: ReactNode;
}): ReactNode {
  const active = useUi((s) => s.activeWorkspaceId);
  // The workspace whose member card opens: the given / active one if they know the person, else
  // the first shared one (a DM peer). A string: member churn re-renders nothing.
  const ws = useWorkspaces((s) => {
    if (!userId) return '';
    for (const id of [workspaceId, active]) if (id && s.byId[id]?.members[userId]?.user) return id;
    for (const [id, e] of Object.entries(s.byId)) if (e.members[userId]?.user) return id;
    return '';
  });
  if (!ws) return children;
  return (
    <button
      type="button"
      tabIndex={tabbable ? 0 : -1}
      aria-label={t('people.openProfile', { name })}
      data-profile-ws={ws}
      data-profile-user={userId}
      className={cx('max-w-full cursor-pointer', className)}
      onClick={openProfileFromClick}
    >
      {children}
    </button>
  );
}
