import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { NotificationLevel, WorkspaceRole } from '@calaba/protocol';
import { Bell, BellOff, Check, ChevronDown, ChevronRight, LogOut, Settings, UserPlus, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { errorText } from '../../lib/api/errors';
import { mayInviteMembers, mayOpenWorkspaceSettings } from '../../lib/permissions';
import { setWorkspaceNotifications, setWorkspaceTaskLevel } from '../../services/mentions';
import { boardVisible } from '../../lib/boards/access';
import { useBoards } from '../../stores/boards';
import { useRooms, workspaceNotify, workspaceTaskLevel } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { LEVEL_LABEL, NotifyMenuItems, type LevelOption } from '../chat/NotifyMenu';
import { menuBox, menuItem, menuLabel, menuSeparator } from './menu';

/**
 * The workspace menu (docs/09 #140): the workspace name with «⌄» — its items also close the desktop title
 * bar's workspace switcher (ADR-0074); the phone's list header and top bar. «Пригласить» and
 * «Настройки пространства» (any settings right, ADR-0048), «Участники», «Уведомления» ▸, «Скрывать без
 * уведомлений», «Покинуть» (disabled for the owner, with the reason). Creating rooms and
 * categories lives in the room column's «+». Selectors: the name and the role only (the entry
 * changes on every voice state).
 */
export function WorkspaceMenu({ workspaceId, variant, testId }: { workspaceId: string; variant: 'titlebar' | 'drawer' | 'topbar'; testId?: string }): ReactNode {
  const name = useWorkspaces((s) => s.byId[workspaceId]?.ws.name);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  if (name === undefined) return null;
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          title={name}
          data-testid={testId}
          className={cx(
            'group flex min-w-0 items-center gap-1 rounded-[var(--radius-row)] font-semibold text-fg transition-colors duration-[var(--motion-fast)] hover:bg-hover data-[state=open]:bg-active',
            variant === 'titlebar' ? 'no-drag h-7 max-w-[220px] px-2 text-body' : variant === 'topbar' ? 'h-10 px-2 text-list' : 'h-8 w-full px-2 text-left text-list',
          )}
        >
          <span className={cx('min-w-0 truncate', variant === 'drawer' && 'flex-1')}>{name}</span>
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform duration-[var(--motion-fast)] group-data-[state=open]:rotate-180" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="start" collisionPadding={16}>
          <WorkspaceMenuItems workspaceId={workspaceId} name={name} owner={role === WorkspaceRole.OWNER} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** The items: mounted only while the menu is open (Radix), so the role subscriptions cost nothing at rest. */
export function WorkspaceMenuItems({ workspaceId, name, owner }: { workspaceId: string; name: string; owner: boolean }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const hideMuted = useUi((s) => s.hideMuted);
  const setHideMuted = useUi((s) => s.setHideMuted);
  const me = useSession((s) => s.me?.user?.id ?? '');
  // Settings: any tab beyond «Участники» (ADR-0048 split the admin rights); invites: INVITE_MEMBERS (ADR-0043).
  const roles = useMemberRoles(workspaceId, me);
  const admin = mayOpenWorkspaceSettings(roles);
  const inviter = mayInviteMembers(roles);

  const leave = async (): Promise<void> => {
    if (!(await confirmAction(t('ws.leave'), t('ws.leaveConfirm', { name }), t('ws.leave')))) return;
    try {
      await api.workspaces.removeMember(workspaceId, '@me');
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <>
      {inviter ? (
        <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'invites' })}>
          <UserPlus className="size-4" /> {t('ws.invite')}
        </Dropdown.Item>
      ) : null}
      {admin ? (
        <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId })}>
          <Settings className="size-4" /> {t('ws.settings')}
        </Dropdown.Item>
      ) : null}
      <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'members' })}>
        <Users className="size-4" /> {t('ws.members')}
      </Dropdown.Item>
      <WorkspaceNotifyMenu workspaceId={workspaceId} />
      <Dropdown.CheckboxItem className={cx(menuItem, 'relative pl-7')} checked={hideMuted} onCheckedChange={setHideMuted}>
        <Dropdown.ItemIndicator className="absolute left-2">
          <Check className="size-3.5" aria-hidden />
        </Dropdown.ItemIndicator>
        {t('shell.hideMuted')}
      </Dropdown.CheckboxItem>
      <Dropdown.Separator className={menuSeparator} />
      {/* The owner cannot leave (ownership is not transferable yet): shown, disabled, with the reason. */}
      <Dropdown.Item className={cx(menuItem, 'text-danger-text')} disabled={owner} title={owner ? t('shell.ownerCannotLeave') : undefined} onSelect={() => void leave()}>
        <LogOut className="size-4" /> {t('ws.leaveItem')}
      </Dropdown.Item>
    </>
  );
}

/**
 * «Уведомления» in the workspace menu (docs/09 item 22): my level for the workspace — what its
 * rooms left at «Как в пространстве» follow (default «Только упоминания») — and «Заглушить» for
 * the whole workspace. One server-synced setting, not a write per room.
 */
function WorkspaceNotifyMenu({ workspaceId }: { workspaceId: string }): ReactNode {
  const stored = useRooms((s) => s.wsNotify[workspaceId]);
  const n = workspaceNotify(stored);
  const quiet = n.mutedUntil !== null || n.level === NotificationLevel.NONE;
  const options: LevelOption[] = [NotificationLevel.ALL, NotificationLevel.MENTIONS, NotificationLevel.NONE].map((level) => ({
    level,
    label: t(LEVEL_LABEL[level] ?? 'chat.notifyAll'),
  }));
  return (
    <Dropdown.Sub>
      <Dropdown.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
        {quiet ? <BellOff className="size-4" aria-hidden /> : <Bell className="size-4" aria-hidden />}
        <span className="flex-1">{t('shell.wsNotify')}</span>
        <ChevronRight className="size-4" aria-hidden />
      </Dropdown.SubTrigger>
      <Dropdown.Portal>
        <Dropdown.SubContent className={cx(menuBox, 'w-60')} sideOffset={4} collisionPadding={16}>
          <NotifyMenuItems
            title={t('shell.wsNotifyAll')}
            options={options}
            value={n.level}
            mutedUntil={n.mutedUntil}
            defaultLevel={NotificationLevel.MENTIONS}
            onChange={(level, until) => void setWorkspaceNotifications(workspaceId, level, until)}
          />
          <TaskNotifyItems workspaceId={workspaceId} />
        </Dropdown.SubContent>
      </Dropdown.Portal>
    </Dropdown.Sub>
  );
}

const TASK_LEVELS: ReadonlyArray<{ level: NotificationLevel; label: 'boards.notifyAll' | 'boards.notifyMentions' | 'boards.notifyNone' }> = [
  { level: NotificationLevel.ALL, label: 'boards.notifyAll' },
  { level: NotificationLevel.MENTIONS, label: 'boards.notifyMentions' },
  { level: NotificationLevel.NONE, label: 'boards.notifyNone' },
];

/**
 * «Задачи» (ADR-0042 §4) under the workspace's levels: task notifications of its boards —
 * everything (assigned, @me, comments, status of my tasks), only assigned / @me, or nothing.
 * Shown once the workspace has a board the viewer sees.
 */
function TaskNotifyItems({ workspaceId }: { workspaceId: string }): ReactNode {
  const level = useRooms((s) => workspaceTaskLevel(s.wsNotify[workspaceId]));
  const any = useBoards((s) => Object.values(s.boards).some((b) => b.workspaceId === workspaceId && boardVisible(b)));
  if (!any) return null;
  return (
    <>
      <Dropdown.Separator className={menuSeparator} />
      <Dropdown.Label className={menuLabel}>{t('boards.notifyTasks')}</Dropdown.Label>
      <Dropdown.RadioGroup value={String(level)} onValueChange={(v) => void setWorkspaceTaskLevel(workspaceId, Number(v))}>
        {TASK_LEVELS.map((o) => (
          <Dropdown.RadioItem key={o.level} value={String(o.level)} className={menuItem} data-testid={`task-level-${o.level}`}>
            <span className="grid w-4 place-items-center">
              <Dropdown.ItemIndicator>
                <Check className="size-4" aria-hidden />
              </Dropdown.ItemIndicator>
            </span>
            <span className="truncate">{t(o.label)}</span>
          </Dropdown.RadioItem>
        ))}
      </Dropdown.RadioGroup>
    </>
  );
}
