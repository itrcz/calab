import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Modal } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { formerKey, useFormerInfo, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { ProfileDialog } from './ProfileDialog';
import { formerReasonText } from './former';
import { FormerChipView } from './MemberBits';

/**
 * Profile card of a former member (ADR-0097 §4): name, «Бывший участник · ушёл 12.10.2026» and
 * nothing to act on — no «Написать» / «Позвонить» (their DM history stays under «Личные»).
 */
export function FormerProfileDialog({ workspaceId, userId, onClose }: { workspaceId: string; userId: string; onClose: () => void }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const info = useFormerInfo(workspaceId, userId);
  const fileId = useWorkspaces((s) => s.users[userId]?.avatarFileId);
  const line = info?.leftAt
    ? t('former.profile', { what: formerReasonText(info.reason), date: fmt.date(new Date(info.leftAt)) })
    : t('former.profileNoDate');
  return (
    <Modal open onClose={onClose} title={name} description={line}>
      <div data-testid="former-profile" className="flex items-center gap-3">
        <Avatar userId={userId} name={name} fileId={fileId || undefined} size={56} former ring="var(--color-popover-solid)" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-headline font-semibold" title={name}>
              {name}
            </span>
            <FormerChipView leftAt={info?.leftAt ?? 0} />
          </div>
          <div className="text-caption text-muted">{line}</div>
        </div>
      </div>
      <p className="mt-3 text-caption text-faint">{t('former.noActions')}</p>
    </Modal>
  );
}

/** The profile dialog: a former member's card when the person is gone, the full profile otherwise. */
export function ProfileRoute({ workspaceId, userId, focusNote, onClose }: { workspaceId: string; userId: string; focusNote: boolean; onClose: () => void }): ReactNode {
  const gone = useWorkspaces((s) => !s.byId[workspaceId]?.members[userId] && formerKey(workspaceId, userId) in s.former);
  return gone ? (
    <FormerProfileDialog workspaceId={workspaceId} userId={userId} onClose={onClose} />
  ) : (
    <ProfileDialog workspaceId={workspaceId} userId={userId} focusNote={focusNote} onClose={onClose} />
  );
}
