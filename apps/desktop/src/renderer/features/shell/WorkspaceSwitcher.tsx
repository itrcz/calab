import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { WorkspaceRole } from '@calaba/protocol';
import { Check, ChevronDown, Compass, LockKeyhole, Plus, Volume2 } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { workspaceInitials } from '../../lib/initials';
import { otherWorkspacesBadge, UNREAD_DOT, workspaceBadge } from '../../lib/sections';
import { useIdentity } from '../../stores/identity';
import { useRooms } from '../../stores/rooms';
import { useContextWorkspace } from '../../stores/sections';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { accessLocked, localAuthority, lockTitleKey } from '../identity/model';
import { menuBox, menuItem, menuLabel, menuSeparator } from './menu';
import { openWorkspace } from './sectionNav';
import { WorkspaceMenuItems } from './WorkspaceMenu';

/**
 * The workspace switcher (ADR-0074 §2): the title bar's «Команда Calab ⌄» is the one place a
 * workspace is picked. The list — icon, name, unread / mention badge, «в голосе» — then «Создать
 * пространство» / «Найти пространство», then the context workspace's own items (invite, settings,
 * members, notifications, leave: the former workspace menu, docs/09 #140). A dot (or the mention
 * count) beside the name while other workspaces have unread. «Calab» before any workspace exists.
 * At rest the trigger reads the name and one primitive badge; the rows mount only while it is open.
 */
export function WorkspaceSwitcher({ testId, phone = false }: { testId?: string; phone?: boolean }): ReactNode {
  const ws = useContextWorkspace();
  const name = useWorkspaces((s) => (ws ? s.byId[ws]?.ws.name : undefined));
  const iconFileId = useWorkspaces((s) => (ws ? (s.byId[ws]?.ws.iconFileId ?? '') : ''));
  // A guest sees one workspace: nothing to switch, no menu (ADR-0073, owner 07.10).
  const single = useWorkspaces((s) => phone && s.order.length <= 1 && (ws ? s.byId[ws]?.role === WorkspaceRole.GUEST : false));
  const others = useRooms((s) => otherWorkspacesBadge(s, ws));
  const title = name ?? 'Calab';
  const label = [title, others > 0 ? plural('shell.unreadMentions', others) : others === UNREAD_DOT ? t('shell.otherUnread') : ''].filter(Boolean).join(', ');
  if (single) {
    return (
      <div className="flex h-10 min-w-0 flex-1 items-center gap-2 px-2 text-headline font-semibold text-fg" data-testid={testId}>
        <WorkspaceIcon name={title} iconFileId={iconFileId} />
        <h1 className="min-w-0 truncate">{title}</h1>
      </div>
    );
  }
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          title={t('shell.wsSwitcher')}
          aria-label={label}
          data-testid={testId}
          className={cx(
            'group flex min-w-0 items-center gap-1 rounded-[var(--radius-row)] font-semibold text-fg transition-colors duration-[var(--motion-fast)] hover:bg-hover data-[state=open]:bg-active',
            phone ? 'h-10 flex-1 gap-2 px-2 text-left text-headline' : 'no-drag h-7 max-w-[240px] px-2 text-body',
          )}
        >
          {phone ? <WorkspaceIcon name={title} iconFileId={iconFileId} /> : null}
          <span className={cx('min-w-0 truncate', phone && 'flex-1')}>{title}</span>
          {others > 0 ? (
            <span className="min-w-4 shrink-0 rounded-full bg-danger-fill px-1 text-center text-micro font-bold leading-4 text-white" data-testid="switcher-badge" aria-hidden>
              {others > 99 ? '99+' : others}
            </span>
          ) : others === UNREAD_DOT ? (
            <span className="size-2 shrink-0 rounded-full bg-fg" data-testid="switcher-dot" aria-hidden />
          ) : null}
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform duration-[var(--motion-fast)] group-data-[state=open]:rotate-180" aria-hidden />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-72')} sideOffset={4} align="start" collisionPadding={16} data-testid="workspace-switcher">
          <SwitcherItems ws={ws} name={name} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** The content: mounted only while the switcher is open (Radix), so its subscriptions cost nothing at rest. */
function SwitcherItems({ ws, name }: { ws: string | null; name: string | undefined }): ReactNode {
  const order = useWorkspaces((s) => s.order);
  const owner = useWorkspaces((s) => (ws ? s.byId[ws]?.role === WorkspaceRole.OWNER : false));
  const local = useSession((s) => localAuthority(s.authority));
  // Workspaces locked by the identity provider that have no data here (ADR-0035): their lock row.
  const locked = useIdentity((s) =>
    Object.entries(s.access)
      .filter(([, a]) => accessLocked(a))
      .map(([id, a]) => `${id}:${a.reason}`)
      .join('|'),
  );
  const known = new Set(order);
  const open = useUi((s) => s.openDialog);
  return (
    <>
      <Dropdown.Label className={menuLabel}>{t('ws.list')}</Dropdown.Label>
      <div className="max-h-[min(360px,50vh)] overflow-y-auto" role="group" aria-label={t('ws.list')}>
        {order.map((id) => (
          <SwitchRow key={id} id={id} current={id === ws} />
        ))}
        {locked
          ? locked.split('|').map((entry) => {
              const [id = '', reason] = entry.split(':');
              if (known.has(id)) return null;
              return (
                <Dropdown.Item key={id} className={menuItem} onSelect={() => useUi.getState().setWorkspace(id)}>
                  <LockKeyhole className="size-4" aria-hidden /> <span className="min-w-0 truncate">{t(lockTitleKey(Number(reason)))}</span>
                </Dropdown.Item>
              );
            })
          : null}
      </div>
      {local ? (
        <>
          <Dropdown.Separator className={menuSeparator} />
          <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'create-workspace' })} data-testid="switcher-create">
            <Plus className="size-4" aria-hidden /> {t('ws.create')}
          </Dropdown.Item>
          <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'join-workspace' })}>
            <Compass className="size-4" aria-hidden /> {t('shell.findWorkspace')}
          </Dropdown.Item>
        </>
      ) : null}
      {ws && name !== undefined ? (
        <>
          <Dropdown.Separator className={menuSeparator} />
          <Dropdown.Label className={cx(menuLabel, 'truncate')}>{name}</Dropdown.Label>
          <WorkspaceMenuItems workspaceId={ws} name={name} owner={owner} />
        </>
      ) : null}
    </>
  );
}

/** One workspace: its icon, name, «в голосе», the badge and a check on the current one. Selectors by id. */
const SwitchRow = memo(function SwitchRow({ id, current }: { id: string; current: boolean }): ReactNode {
  const name = useWorkspaces((s) => s.byId[id]?.ws.name);
  const iconFileId = useWorkspaces((s) => s.byId[id]?.ws.iconFileId ?? '');
  const inVoice = useVoice((s) => s.workspaceId === id && s.roomId !== null);
  const badge = useRooms((s) => workspaceBadge(s, id));
  if (name === undefined) return null;
  const label = [name, badge > 0 ? plural('shell.unreadMentions', badge) : badge === UNREAD_DOT ? t('ws.unread') : '', inVoice ? t('shell.inVoice') : '']
    .filter(Boolean)
    .join(', ');
  return (
    <Dropdown.Item
      className={cx(menuItem, 'h-9 gap-2.5')}
      onSelect={() => openWorkspace(id)}
      aria-label={label}
      aria-current={current ? 'true' : undefined}
      data-testid="switcher-row"
    >
      <WorkspaceIcon name={name} iconFileId={iconFileId} />
      <span className={cx('min-w-0 flex-1 truncate', badge !== 0 && 'font-semibold')}>{name}</span>
      {inVoice ? (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-ok-fill text-white" data-testid="switcher-voice" aria-hidden>
          <Volume2 className="size-2.5" strokeWidth={2.75} />
        </span>
      ) : null}
      {badge > 0 ? (
        <span className="min-w-5 shrink-0 rounded-full bg-danger-fill px-1 text-center text-micro font-bold leading-4 text-white" aria-hidden>
          {badge > 99 ? '99+' : badge}
        </span>
      ) : badge === UNREAD_DOT ? (
        <span className="size-2 shrink-0 rounded-full bg-current opacity-70" aria-hidden />
      ) : null}
      <Check className={cx('size-4 shrink-0', current ? 'opacity-100' : 'opacity-0')} aria-hidden />
    </Dropdown.Item>
  );
});

/** The workspace's picture (or its initials): 24 px square, the same in the list and on the phone's header. */
function WorkspaceIcon({ name, iconFileId }: { name: string; iconFileId: string }): ReactNode {
  return (
    <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-hover text-micro font-semibold text-fg">
      {iconFileId ? <MediaImg path={thumbnailPath(iconFileId)} alt="" draggable={false} className="size-full object-cover" /> : <span aria-hidden>{workspaceInitials(name)}</span>}
    </span>
  );
}
