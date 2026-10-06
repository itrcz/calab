import { useIdentity } from '../../stores/identity';
import { localAuthority, accessLocked, lockTitleKey } from '../identity/model';
import { LockKeyhole } from 'lucide-react';
import { Compass, Plus, Volume2 } from 'lucide-react';
import { Fragment, useMemo, useRef, type ReactNode } from 'react';
import { Logo } from '../../components/Logo';
import { MediaImg } from '../../components/MediaImg';
import { Tip, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { workspaceInitials } from '../../lib/initials';
import { HOME, isDm } from '../../stores/dms';
import { showsUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { openWorkspaceVoice } from './railNav';
import { RailContextMenu } from './RailContextMenu';
import { useHomeDrop } from '../notes/HomeDrop';
import { useWorkspaces } from '../../stores/workspaces';
import { useOpenApp } from '../../stores/webApps';
import { WorkspaceAppsColumn } from '../webapps/AppRail';

/** 48 px tile: squircle radius 16 → 12 on hover/active (Discord-like morph, 160 ms). */
const tile =
  'relative grid size-12 place-items-center rounded-[16px] text-list font-semibold transition-[border-radius,background-color,color] duration-[var(--motion)] ease-out hover:rounded-[12px]';

/**
 * Workspace rail (docs/09 #2): 72 px, rail material. Left pill = state (8 px unread, 20 px
 * hover, 40 px active), red mention badge, green speaker where I am in voice; tooltips on the
 * right; «+» (create) and «Обзор» (join / discover) at the bottom of the list. On top —
 * «Личные» (ADR-0020, Discord Home): the DM list, with the unread DM messages as its badge (`home`;
 * the phone has it in the tab bar).
 */
export function WorkspaceRail({ home = true }: { home?: boolean } = {}): ReactNode {
  const local = useSession((s) => localAuthority(s.authority));
  const lockedIds = useIdentity((s) =>
    Object.entries(s.access)
      .filter(([, a]) => accessLocked(a))
      .map(([id, a]) => `${id}:${a.reason}`)
      .join('|'),
  );
  const order = useWorkspaces((s) => s.order);
  const open = useUi((s) => s.openDialog);

  // The wrapper carries the island fade (styles.css `.island-fade`): a pseudo-element inside the
  // scroller would scroll away with the icons.
  return (
    <div className="island-fade island-fade-rail flex w-[var(--rail-width)] shrink-0 flex-col">
      <nav
        className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden pt-3"
        // The bottom island (AppShell) spans the rail too: the icons end above it.
        style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}
        aria-label={t('ws.list')}
      >
        {/* Phone (ADR-0073): «Личные» is a tab of the tab bar, not a rail icon. */}
        {local && home ? <HomeItem /> : null}
        {lockedIds
          ? lockedIds.split('|').map((entry) => {
              const [id = '', reason] = entry.split(':');
              return (
                <RailAction
                  key={id}
                  label={t(lockTitleKey(Number(reason)))}
                  onClick={() => useUi.getState().setWorkspace(id)}
                >
                  <LockKeyhole className="size-5" />
                </RailAction>
              );
            })
          : null}
        <div className="my-0.5 h-0.5 w-8 shrink-0 rounded-full bg-line" aria-hidden />
        {order.map((id) => (
          <Fragment key={id}>
            <RailItem id={id} />
            {/* Web apps of the active workspace (ADR-0050 §3), right under its icon. */}
            <WorkspaceAppsColumn wsId={id} />
          </Fragment>
        ))}
        {order.length ? <div className="my-0.5 h-0.5 w-8 shrink-0 rounded-full bg-line" aria-hidden /> : null}
        {local ? (
          <>
            <RailAction label={t('ws.create')} onClick={() => open({ kind: 'create-workspace' })}>
              <Plus className="size-6" strokeWidth={1.75} />
            </RailAction>
            <RailAction label={t('shell.explore')} onClick={() => open({ kind: 'join-workspace' })}>
              <Compass className="size-6" strokeWidth={1.75} />
            </RailAction>
          </>
        ) : null}
      </nav>
    </div>
  );
}

function RailItem({ id }: { id: string }): ReactNode {
  const w = useWorkspaces((s) => s.byId[id]?.ws);
  const isActive = useUi((s) => s.activeWorkspaceId === id);
  const inVoice = useVoice((s) => s.workspaceId === id && s.roomId !== null);
  // One of its web apps is open (ADR-0050): the app's icon carries the full pill.
  const appOpen = useOpenApp(isActive ? id : null) !== null;
  const byId = useRooms((s) => s.byId);
  const readState = useRooms((s) => s.readState);
  const lastMessage = useRooms((s) => s.lastMessage);
  const unreadMap = useRooms((s) => s.unread);
  const mentionMap = useRooms((s) => s.mentions);
  // A muted room / workspace shows no unread dot, only its mentions (docs/09 item 22).
  const notify = useRooms((s) => s.notify);
  const wsNotify = useRooms((s) => s.wsNotify);
  const { unread, mentions } = useMemo(() => {
    const list = Object.values(byId).filter((r) => r.workspaceId === id);
    return {
      unread: list.some((r) => showsUnread(r.id, { readState, lastMessage, unread: unreadMap, byId, notify, wsNotify })),
      mentions: list.reduce((n, r) => n + (mentionMap[r.id] ?? 0), 0),
    };
  }, [byId, readState, lastMessage, unreadMap, mentionMap, notify, wsNotify, id]);
  if (!w) return null;

  const label = [w.name, mentions > 0 ? plural('shell.unreadMentions', mentions) : unread ? t('ws.unread') : '', inVoice ? t('shell.inVoice') : '']
    .filter(Boolean)
    .join(', ');

  return (
    <div className="group relative flex w-full shrink-0 justify-center">
      <span
        aria-hidden
        className={cx(
          'absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-fg mobile:hidden transition-[height,opacity] duration-[var(--motion)] ease-out',
          isActive && !appOpen ? 'h-10' : isActive ? 'h-5' : unread ? 'h-2 group-hover:h-5' : 'h-0 opacity-0 group-hover:h-5 group-hover:opacity-100',
        )}
      />
      <RailContextMenu workspaceId={id} tip={w.name}>
        <button
          type="button"
          onClick={() => openWorkspaceVoice(id)}
          aria-current={isActive ? 'page' : undefined}
          aria-label={label}
          className={cx(
            tile,
            w.iconFileId ? 'bg-transparent' : isActive ? 'bg-accent-strong text-accent-fg' : 'bg-hover text-fg hover:bg-accent-strong hover:text-accent-fg',
            isActive && 'rounded-[12px]',
          )}
        >
          {w.iconFileId ? (
            <MediaImg path={thumbnailPath(w.iconFileId)} alt="" draggable={false} className="size-full rounded-[inherit] object-cover" />
          ) : (
            <span aria-hidden>{workspaceInitials(w.name)}</span>
          )}
          {/* Discord: the «in voice» badge sits top-right (green, speaker), the mention count
              bottom-right — they never cover each other. 16 px disc + a 2 px ring in the rail colour. */}
          {inVoice ? (
            <span
              className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full border-2 border-[var(--color-rail)] bg-ok-fill text-white"
              data-testid="rail-voice-badge"
              aria-hidden
            >
              <Volume2 className="size-2.5" strokeWidth={2.75} />
            </span>
          ) : null}
          {mentions > 0 ? (
            <span
              className="absolute -bottom-1 -right-1 min-w-5 rounded-full border-[3px] border-[var(--color-rail)] bg-danger-fill px-1 text-center text-micro font-bold leading-[14px] text-white"
              aria-hidden
            >
              {mentions > 99 ? '99+' : mentions}
            </span>
          ) : null}
        </button>
      </RailContextMenu>
    </div>
  );
}

/** «Личные»: the app icon; guest accounts have no DMs (ADR-0016/0020) and don't see it. */
function HomeItem(): ReactNode {
  const guest = useSession((s) => !!s.me?.user?.isGuest);
  const isActive = useUi((s) => s.activeWorkspaceId === HOME);
  const setWs = useUi((s) => s.setWorkspace);
  const byId = useRooms((s) => s.byId);
  const readState = useRooms((s) => s.readState);
  const lastMessage = useRooms((s) => s.lastMessage);
  const unreadMap = useRooms((s) => s.unread);
  const mentionMap = useRooms((s) => s.mentions);
  // A muted room / workspace shows no unread dot, only its mentions (docs/09 item 22).
  const notify = useRooms((s) => s.notify);
  const wsNotify = useRooms((s) => s.wsNotify);
  const { unread, count } = useMemo(() => {
    const list = Object.values(byId).filter(isDm);
    return {
      unread: list.some((r) => showsUnread(r.id, { readState, lastMessage, unread: unreadMap, byId, notify, wsNotify })),
      // Every DM message counts as a mention (docs/05): the badge = unread DM messages.
      count: list.reduce((n, r) => n + (mentionMap[r.id] ?? 0), 0),
    };
  }, [byId, readState, lastMessage, unreadMap, mentionMap, notify, wsNotify]);
  if (guest) return null;
  return <HomeTile isActive={isActive} unread={unread} count={count} onOpen={() => setWs(HOME)} />;
}

/**
 * The tile itself; during a message drag it also leads into «Заметки» (features/notes/HomeDrop):
 * a drop saves into the first shelf, holding opens the list of shelves.
 */
function HomeTile({
  isActive,
  unread,
  count,
  onOpen,
}: {
  isActive: boolean;
  unread: boolean;
  count: number;
  onOpen: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const home = useHomeDrop(ref);
  const label = count > 0 ? t('dm.homeUnread', { n: count }) : t('dm.home');
  return (
    <div ref={ref} className="group relative flex w-full shrink-0 justify-center" data-testid="rail-home" data-over={home.over || undefined} {...home.handlers}>
      {home.flyout}
      <span
        aria-hidden
        className={cx(
          'absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-fg mobile:hidden transition-[height,opacity] duration-[var(--motion)] ease-out',
          isActive ? 'h-10' : unread ? 'h-2 group-hover:h-5' : 'h-0 opacity-0 group-hover:h-5 group-hover:opacity-100',
        )}
      />
      <Tip label={t('dm.home')} side="right">
        <button
          type="button"
          onClick={onOpen}
          aria-current={isActive ? 'page' : undefined}
          aria-label={label}
          className={cx(tile, 'bg-transparent', (isActive || home.over) && 'rounded-[12px]', home.over && 'ring-2 ring-accent')}
        >
          <Logo size={48} className="size-full rounded-[inherit] object-cover" />
          {count > 0 ? (
            <span
              className="absolute -bottom-1 -right-1 min-w-5 rounded-full border-[3px] border-[var(--color-rail)] bg-danger-fill px-1 text-center text-micro font-bold leading-[14px] text-white"
              aria-hidden
            >
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </button>
      </Tip>
    </div>
  );
}

function RailAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <div className="group relative flex w-full shrink-0 justify-center">
      <Tip label={label} side="right">
        <button type="button" onClick={onClick} aria-label={label} className={cx(tile, 'bg-hover text-muted hover:bg-accent-strong hover:text-accent-fg active:bg-accent-strong active:text-accent-fg')}>
          {children}
        </button>
      </Tip>
    </div>
  );
}
