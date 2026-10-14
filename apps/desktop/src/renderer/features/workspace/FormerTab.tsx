import { WorkspaceRole, type FormerMember } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { memo, useEffect, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, Card, Empty, Input, Spinner, Toggle } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { fmt } from '../../lib/format';
import { showFormerTasks } from '../../services/formerTasks';
import { useUi } from '../../stores/ui';
import { memberName } from '../../stores/workspaces';
import { formerReasonText } from '../people/former';
import { openProfile } from '../people/actions';

export const formerMembersKey = (workspaceId: string) => ['former-members', workspaceId] as const;

const ROLE_KEY: Partial<Record<WorkspaceRole, MessageKey>> = {
  [WorkspaceRole.OWNER]: 'role.owner',
  [WorkspaceRole.ADMIN]: 'role.admin',
  [WorkspaceRole.MEMBER]: 'role.member',
  [WorkspaceRole.GUEST]: 'role.guest',
};

/**
 * Workspace settings → «Бывшие» (ADR-0097 §3; MANAGE_MEMBERS, like «Забаненные»): who left, why,
 * when and who removed them; guests hidden unless asked for (ADR-0098 §4). «Открытых задач: N»
 * jumps to the boards with the filter «Исполнитель: бывшие участники»; «Пригласить снова» opens
 * the invite links.
 */
export function FormerTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [guests, setGuests] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  const list = useInfiniteQuery({
    queryKey: [...formerMembersKey(workspaceId), { q, guests }],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => api.workspaces.formerMembers(workspaceId, { guests, q, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    getNextPageParam: (page) => page.nextCursor || undefined,
    refetchOnWindowFocus: false,
  });
  const rows = list.data?.pages.flatMap((p) => p.members) ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-48 flex-1 items-center">
          <Input aria-label={t('former.search')} placeholder={t('former.search')} value={text} onChange={(e) => setText(e.target.value)} icon={<Search className="size-3.5" />} />
        </label>
        <label className="flex items-center gap-2 text-body">
          <Toggle checked={guests} onChange={setGuests} label={t('former.showGuests')} />
          {t('former.showGuests')}
        </label>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <Empty>{errorText(list.error)}</Empty>
      ) : rows.length === 0 ? (
        <Empty>{t('former.none')}</Empty>
      ) : (
        <Card title={t('former.card', { n: rows.length })} {...(guests ? { footer: t('former.guestsHint') } : {})}>
          {rows.map((m) => (
            <FormerRow key={m.user?.userId ?? ''} workspaceId={workspaceId} m={m} />
          ))}
          {list.hasNextPage ? (
            <div className="flex justify-center p-2">
              <Button variant="secondary" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('former.more')}
              </Button>
            </div>
          ) : null}
        </Card>
      )}
    </>
  );
}

const FormerRow = memo(function FormerRow({ workspaceId, m }: { workspaceId: string; m: FormerMember }): ReactNode {
  const u = m.user;
  if (!u) return null;
  const name = m.nickname || u.displayName;
  const when = u.leftAt ? fmt.shortDate(timestampDate(u.leftAt)) : '—';
  const meta = [formerReasonText(u.reason), when, m.removedBy ? t('former.by', { who: memberName(workspaceId, m.removedBy) }) : ''].filter(Boolean).join(' · ');
  return (
    <div className="flex min-h-12 items-center gap-3 px-3 py-2 mobile:flex-wrap mobile:gap-y-2" data-testid="ws-former-row" data-user={u.userId}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left mobile:basis-full" aria-label={t('people.openProfile', { name })} onClick={() => openProfile(workspaceId, u.userId)}>
        <Avatar userId={u.userId} name={name} fileId={u.avatarFileId || undefined} size={32} former ring="var(--color-card)" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium" title={name}>
            {name}
            <span className="ml-2 text-caption font-normal text-muted">{t(ROLE_KEY[m.role] ?? 'role.member')}</span>
          </div>
          <div className="truncate text-caption text-faint" title={meta}>
            {meta}
          </div>
        </div>
      </button>
      {m.openTasks > 0 ? (
        <button
          type="button"
          onClick={() => showFormerTasks(workspaceId)}
          className="shrink-0 rounded-full border border-line px-2 py-0.5 text-caption text-accent-text hover:bg-hover"
          aria-label={t('former.openTasksOpen', { n: m.openTasks })}
          data-testid="former-open-tasks"
        >
          {t('former.openTasks', { n: m.openTasks })}
        </button>
      ) : null}
      <Button size="sm" variant="secondary" aria-label={t('former.inviteFor', { name })} onClick={() => useUi.getState().openDialog({ kind: 'workspace-settings', workspaceId, tab: 'invites' })}>
        {t('former.invite')}
      </Button>
    </div>
  );
});
