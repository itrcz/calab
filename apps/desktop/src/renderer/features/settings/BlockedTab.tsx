import { memo, useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Avatar } from '../../components/Avatar';
import { Button, Card, Empty, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { loadBlockedUsers, setUserBlocked } from '../../services/blocks';
import { useBlocks } from '../../stores/blocks';
import { useWorkspaces } from '../../stores/workspaces';

/**
 * Settings → «Заблокированные» (ADR-0154): the people I blocked and «Разблокировать». The rows
 * subscribe to their own user (a primitive name / avatar), the list to the ids only.
 */
export function BlockedTab(): ReactNode {
  const ids = useBlocks(useShallow((s) => (s.ids ? Object.keys(s.ids) : null)));
  useEffect(() => {
    void loadBlockedUsers();
  }, []);
  if (ids === null) return <Spinner />;
  if (ids.length === 0) return <Empty>{t('block.none')}</Empty>;
  return (
    <Card title={t('block.card', { n: ids.length })} footer={t('block.hint')}>
      {ids.map((id) => (
        <BlockedRow key={id} userId={id} />
      ))}
    </Card>
  );
}

const BlockedRow = memo(function BlockedRow({ userId }: { userId: string }): ReactNode {
  const name = useWorkspaces((s) => s.users[userId]?.displayName ?? '');
  const avatar = useWorkspaces((s) => s.users[userId]?.avatarFileId ?? '');
  const shown = name || t('block.unknownUser');
  return (
    <div className="flex min-h-12 items-center gap-3 px-3 py-2" data-testid="blocked-row">
      <Avatar userId={userId} name={shown} fileId={avatar || undefined} size={32} />
      <div className="min-w-0 flex-1 truncate text-body font-medium">{shown}</div>
      <Button size="sm" variant="secondary" aria-label={t('block.unblockFor', { name: shown })} onClick={() => void setUserBlocked(userId, false)}>
        {t('block.unblock')}
      </Button>
    </div>
  );
});
