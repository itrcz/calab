import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { WorkspaceRole, type ListMemberAchievementsResponse } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { Award, Ellipsis, Undo2 } from 'lucide-react';
import { memo, useCallback, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { invalidateMemberAchievements, memberAchievementsKey, useAchievement } from '../../lib/achievementCatalog';
import { stackGrants, thumbsRow, type AchievementStack } from '../../lib/achievements';
import { fmt } from '../../lib/format';
import { useAchievementUi } from '../../stores/achievementUi';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { memberName, rolesOf, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem } from '../shell/menu';
import { AchievementImg } from './AchievementImg';
import { canGrantAchievement } from './members';

/**
 * Achievements in the profile (ADR-0061 §5, docs/08 «Ачивки»): a thumbs row in the profile card
 * (≤ 6 at 28 px overlapping, «+N») and the «Достижения» section of the profile sheet (tiles with
 * «×N» for repeats, a click opens the viewer; MANAGE_MEMBERS: «⋯ → Отозвать» and «Вручить ещё»).
 * The grants load when the profile opens (react-query by member), and reload when the member's
 * `achievementCount` changes (WORKSPACE_MEMBER_UPDATE, services/dispatch). Selectors return
 * primitives: presence / voice changes of the workspace do not re-render them.
 */

const selectStacks = (d: ListMemberAchievementsResponse): AchievementStack[] => stackGrants(d.items);

function useStacks(workspaceId: string, userId: string, enabled: boolean) {
  return useQuery({
    queryKey: memberAchievementsKey(workspaceId, userId),
    queryFn: ({ signal }) => api.achievements.list(workspaceId, userId, signal),
    select: selectStacks,
    enabled,
    staleTime: 60_000,
  });
}

/** May I grant / revoke achievements of this member (MANAGE_MEMBERS, not self / guest / bot)? */
function useCanGrant(workspaceId: string, userId: string): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => {
    const e = s.byId[workspaceId];
    const m = e?.members[userId];
    return !!m && canGrantAchievement(rolesOf(e, me), m, userId === me);
  });
}

/** Members who can hold achievements at all: not guests, not bots. */
function useReceives(workspaceId: string, userId: string): boolean {
  return useWorkspaces((s) => {
    const m = s.byId[workspaceId]?.members[userId];
    return !!m && m.role !== WorkspaceRole.GUEST && !m.user?.isGuest && !m.user?.isBot;
  });
}

const openStack = (workspaceId: string, userId: string, s: AchievementStack): void =>
  useAchievementUi.getState().openView({ achievementId: s.achievementId, workspaceId, userId, grants: s.grants });

// ---------------------------------------------------------------- the profile card row

/** «Достижения» pair of the profile card: only when the member has any. */
export function ProfileCardAchievements({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const count = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.achievementCount ?? 0);
  const q = useStacks(workspaceId, userId, count > 0);
  if (count === 0) return null;
  const stacks = q.data ?? [];
  const { shown, more } = thumbsRow(stacks);
  return (
    <>
      <dt className="text-muted">{t('ach.section')}</dt>
      <dd className="flex min-w-0 items-center" data-testid="profile-card-achievements">
        {q.isLoading ? <Spinner className="size-4" /> : null}
        {shown.map((s, i) => (
          <Thumb key={s.achievementId} workspaceId={workspaceId} userId={userId} stack={s} first={i === 0} />
        ))}
        {more > 0 ? <span className="ml-1 inline-flex h-5 items-center rounded-full bg-hover px-1.5 text-micro font-semibold text-fg">{t('ach.moreCount', { n: more })}</span> : null}
      </dd>
    </>
  );
}

const Thumb = memo(function Thumb({ workspaceId, userId, stack, first }: { workspaceId: string; userId: string; stack: AchievementStack; first: boolean }): ReactNode {
  const a = useAchievement(workspaceId, stack.achievementId);
  return (
    <button
      type="button"
      title={a?.title}
      aria-label={a?.title ?? t('ach.unknown')}
      onClick={() => openStack(workspaceId, userId, stack)}
      className={cx('relative shrink-0 rounded-full transition-transform duration-[var(--motion-fast)] hover:z-10 hover:-translate-y-0.5', !first && '-ml-1.5')}
    >
      <AchievementImg achievement={a} size={28} />
    </button>
  );
});

// ---------------------------------------------------------------- the profile sheet section

export function ProfileDialogAchievements({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const self = useSession((s) => s.me?.user?.id) === userId;
  const receives = useReceives(workspaceId, userId);
  const canGrant = useCanGrant(workspaceId, userId);
  const q = useStacks(workspaceId, userId, receives);
  const stacks = q.data ?? [];
  const grant = useCallback(() => useAchievementUi.getState().openGrant({ workspaceId, userId }), [workspaceId, userId]);
  if (!receives) return null;
  // Mine and empty: no section at all (ADR-0061 §5).
  if (self && q.isSuccess && stacks.length === 0) return null;
  return (
    <section className="mt-5" data-testid="profile-achievements">
      <h3 className="mb-1.5 flex items-center justify-between gap-2 text-caption font-semibold text-muted">
        <span>{t('ach.section')}</span>
        {canGrant ? (
          <Button size="sm" variant="ghost" onClick={grant} data-testid="profile-grant-achievement">
            <Award className="size-3.5" aria-hidden />
            {stacks.length ? t('ach.grantMore') : t('ach.grant')}
          </Button>
        ) : null}
      </h3>
      {q.isLoading ? (
        <Spinner className="mx-auto my-2" />
      ) : stacks.length === 0 ? (
        <p className="text-body text-muted">{t('ach.empty')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {stacks.map((s) => (
            <Tile key={s.achievementId} workspaceId={workspaceId} userId={userId} stack={s} canRevoke={canGrant} />
          ))}
        </ul>
      )}
    </section>
  );
}

const Tile = memo(function Tile({ workspaceId, userId, stack, canRevoke }: { workspaceId: string; userId: string; stack: AchievementStack; canRevoke: boolean }): ReactNode {
  const a = useAchievement(workspaceId, stack.achievementId);
  const g = stack.grants[0];
  const by = useMemberName(workspaceId, g?.grantedBy ?? '');
  if (!g) return null;
  const n = stack.grants.length;
  return (
    <li className="group relative flex flex-col items-center gap-1 rounded-[var(--radius-card)] bg-[var(--color-card)] px-2 pb-2 pt-3 text-center" data-testid="profile-achievement">
      <button type="button" className="flex w-full min-w-0 flex-col items-center gap-1 rounded-[var(--radius-control)]" onClick={() => openStack(workspaceId, userId, stack)}>
        <span className="relative">
          <AchievementImg achievement={a} size={64} />
          {n > 1 ? (
            <span className="absolute -bottom-1 -right-2 inline-flex h-4 items-center rounded-full bg-accent-strong px-1.5 text-micro font-semibold leading-4 text-accent-fg" data-testid="achievement-times">
              {t('ach.times', { n })}
            </span>
          ) : null}
        </span>
        <span className="w-full truncate text-body font-semibold" title={a?.title}>
          {a?.title ?? t('ach.unknown')}
        </span>
        <span className="w-full truncate text-caption text-muted">{g.grantedAt ? t('ach.tileCaption', { date: fmt.shortDate(new Date(g.grantedAt)), name: by }) : by}</span>
        <span className="w-full truncate text-caption" title={g.note}>
          «{g.note}»
        </span>
      </button>
      {canRevoke ? <TileMenu workspaceId={workspaceId} userId={userId} grantId={g.id} title={a?.title ?? ''} /> : null}
    </li>
  );
});

function TileMenu({ workspaceId, userId, grantId, title }: { workspaceId: string; userId: string; grantId: string; title: string }): ReactNode {
  const revoke = async (): Promise<void> => {
    const ok = await confirmAction(t('ach.revokeTitle'), t('ach.revokeText', { title, name: memberName(workspaceId, userId) }), t('ach.revoke'));
    if (!ok) return;
    try {
      await api.achievements.revoke(workspaceId, userId, grantId);
      invalidateMemberAchievements(workspaceId, userId);
      toast.info(t('ach.revoked'));
    } catch (e) {
      toast.fail(e, t('ach.revokeFailed'));
    }
  };
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          aria-label={t('ach.tileMenu')}
          className="absolute right-1 top-1 grid size-6 place-items-center rounded-full text-muted opacity-0 transition-opacity duration-[var(--motion-fast)] hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 mobile:opacity-100"
        >
          <Ellipsis className="size-4" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={4} collisionPadding={16} className={menuBox}>
          <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void revoke()} data-testid="achievement-revoke">
            <Undo2 className="size-4" aria-hidden />
            {t('ach.revoke')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

