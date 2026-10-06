import { WorkspaceRole } from '@calaba/protocol';
import { CalendarDays, Compass, MessageCircle, MessagesSquare, SquareKanban, Volume2, type LucideIcon } from 'lucide-react';
import { memo, useRef, type ComponentPropsWithRef, type ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { localAuthority } from '../identity/model';
import { currentSection, dmBadge, UNREAD_DOT, workspaceBadge, type Badge, type Section } from '../../lib/sections';
import { unreadCount, useBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';
import { useCalendar } from '../../stores/calendar';
import { HOME } from '../../stores/dms';
import { useRooms } from '../../stores/rooms';
import { useContextWorkspace } from '../../stores/sections';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useOpenApp } from '../../stores/webApps';
import { useWorkspaces } from '../../stores/workspaces';
import { useHomeDrop } from '../notes/HomeDrop';
import { WorkspaceAppsColumn } from '../webapps/AppRail';
import { RailContextMenu } from './RailContextMenu';
import { openSection } from './sectionNav';

/** 48 px tile: squircle radius 16 → 12 on hover / active (the workspace tile's morph, 160 ms). */
const tile =
  'relative grid size-12 place-items-center rounded-[16px] transition-[border-radius,background-color,color] duration-[var(--motion)] ease-out hover:rounded-[12px]';

/**
 * The sections rail (ADR-0074 §1): 72 px, rail material — «Чаты» (the rooms of the context
 * workspace), «Личные» (DMs and notes), «Календарь», «Доски», then the workspace's web apps
 * (ADR-0050), «Найти пространство» at the bottom. The workspace itself is picked in the title bar
 * (WorkspaceSwitcher). Re-renders: the rail reads two primitives (the section on screen and the
 * context workspace); each tile subscribes to its own counter, so a new message re-renders one tile.
 */
export function SectionRail(): ReactNode {
  const local = useSession((s) => localAuthority(s.authority));
  const ws = useContextWorkspace();
  const guestWs = useWorkspaces((s) => (ws ? s.byId[ws]?.role === WorkspaceRole.GUEST : false));
  const section = useSection(ws);

  // The wrapper carries the island fade (styles.css `.island-fade`): a pseudo-element inside the
  // scroller would scroll away with the icons.
  return (
    <div className="island-fade island-fade-rail flex w-[var(--rail-width)] shrink-0 flex-col">
      <nav
        className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden pt-3"
        // The bottom island (AppShell) spans the rail too: the icons end above it.
        style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}
        aria-label={t('mobile.tabs')}
        data-testid="section-rail"
      >
        {ws ? <ChatsTile ws={ws} active={section === 'chats'} /> : null}
        {local ? <DmsTile active={section === 'dms'} /> : null}
        {ws && !guestWs ? <CalendarTile active={section === 'calendar'} /> : null}
        {ws && !guestWs ? <BoardsTile ws={ws} active={section === 'boards'} /> : null}
        {/* The context workspace's web apps (ADR-0050 §3): the column draws only for the open workspace. */}
        {ws ? <WorkspaceAppsColumn wsId={ws} lead={APPS_LINE} /> : null}
        <div className="flex-1" aria-hidden />
        {local ? <FindTile /> : null}
      </nav>
    </div>
  );
}

/** The section on screen (a string): the rail re-renders when it changes, not on other state. */
function useSection(ws: string | null): Section | null {
  const home = useUi((s) => s.activeWorkspaceId === HOME);
  const calendar = useUi((s) => s.calDay !== null);
  const boards = useBoardsUi((s) => s.active);
  const app = useOpenApp(home ? null : ws) !== null;
  return currentSection({ home, boards, calendar, app });
}

/** The hairline above the web apps: drawn by the apps column, only when it has something to show. */
const APPS_LINE = <div className="my-0.5 h-0.5 w-8 shrink-0 rounded-full bg-line" aria-hidden />;

// ---------------------------------------------------------------- tiles

interface TileProps {
  section: Section;
  icon: LucideIcon;
  /** Accessible name: the label with its counter («Чаты, 2 упоминания»). */
  name: string;
  active: boolean;
  count?: number;
  /** Red (mentions, DMs) or accent (tasks, today's meetings). */
  tone?: 'danger' | 'accent';
  inVoice?: boolean;
  testId: string;
}

/**
 * The tile as a button. A tooltip / context menu wraps it from outside (Radix `asChild`): their
 * ref and handlers arrive as props and land on the button (React 19 passes `ref` as a prop).
 */
function TileButton({
  section,
  icon: Icon,
  name,
  active,
  count = 0,
  tone = 'danger',
  inVoice = false,
  testId,
  ring = false,
  ...trigger
}: TileProps & { ring?: boolean } & Omit<ComponentPropsWithRef<'button'>, 'children'>): ReactNode {
  return (
    <button
      {...trigger}
      type="button"
      onClick={(e) => {
        trigger.onClick?.(e);
        openSection(section);
      }}
      aria-current={active ? 'page' : undefined}
      aria-label={name}
      data-testid={testId}
      className={cx(
        tile,
        active ? 'rounded-[12px] bg-accent-strong text-accent-fg' : 'bg-hover text-muted hover:bg-accent-strong hover:text-accent-fg',
        ring && 'ring-2 ring-accent',
      )}
    >
      <Icon className="size-6" strokeWidth={1.75} aria-hidden />
      {/* As on the workspace tiles before: «in voice» top-right (green), the count bottom-right. */}
      {inVoice ? (
        <span
          className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full border-2 border-[var(--color-rail)] bg-ok-fill text-white"
          data-testid="rail-voice-badge"
          aria-hidden
        >
          <Volume2 className="size-2.5" strokeWidth={2.75} />
        </span>
      ) : null}
      {count > 0 ? (
        <span
          className={cx(
            'absolute -bottom-1 -right-1 min-w-5 rounded-full border-[3px] border-[var(--color-rail)] px-1 text-center text-micro font-bold leading-[14px]',
            tone === 'danger' ? 'bg-danger-fill text-white' : 'bg-accent-strong text-accent-fg',
          )}
          data-testid={`${testId}-count`}
          aria-hidden
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </button>
  );
}

/** The slot: the left pill (40 px active, 8 px unread, 20 px hover) and the tile. */
function Slot({ active, dot = false, children, ...rest }: { active: boolean; dot?: boolean; children: ReactNode } & Record<`data-${string}`, unknown>): ReactNode {
  return (
    <div className="group relative flex w-full shrink-0 justify-center" {...rest}>
      <span
        aria-hidden
        className={cx(
          'absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-fg transition-[height,opacity] duration-[var(--motion)] ease-out',
          active ? 'h-10' : dot ? 'h-2 group-hover:h-5' : 'h-0 opacity-0 group-hover:h-5 group-hover:opacity-100',
        )}
      />
      {children}
    </div>
  );
}

/**
 * «Чаты»: the rooms of the context workspace. Its badge is that workspace's (mentions, else the
 * unread pill); the green speaker while I am in its voice. Right click — the workspace's menu
 * (mark read, invite, members, settings, leave; docs/09 #21), as on the old workspace icon.
 */
const ChatsTile = memo(function ChatsTile({ ws, active }: { ws: string; active: boolean }): ReactNode {
  useLocale();
  const badge: Badge = useRooms((s) => workspaceBadge(s, ws));
  const inVoice = useVoice((s) => s.workspaceId === ws && s.roomId !== null);
  const label = t('mobile.tabChats');
  const name = [label, badge > 0 ? plural('shell.unreadMentions', badge) : badge === UNREAD_DOT ? t('ws.unread') : '', inVoice ? t('shell.inVoice') : '']
    .filter(Boolean)
    .join(', ');
  return (
    <Slot active={active} dot={badge === UNREAD_DOT}>
      <RailContextMenu workspaceId={ws} tip={label}>
        <TileButton section="chats" icon={MessagesSquare} name={name} active={active} count={Math.max(0, badge)} inVoice={inVoice} testId="section-chats" />
      </RailContextMenu>
    </Slot>
  );
});

/**
 * «Личные» (ADR-0020): DMs and notes; the badge is the unread DM messages. Guest accounts have no
 * DMs and no tile. During a message drag the tile leads into «Заметки» (features/notes/HomeDrop):
 * a drop saves into the first shelf, holding opens the list of shelves.
 */
const DmsTile = memo(function DmsTile({ active }: { active: boolean }): ReactNode {
  const guest = useSession((s) => !!s.me?.user?.isGuest);
  if (guest) return null;
  return <DmsTileBody active={active} />;
});

function DmsTileBody({ active }: { active: boolean }): ReactNode {
  useLocale();
  const count = useRooms(dmBadge);
  const ref = useRef<HTMLDivElement>(null);
  const home = useHomeDrop(ref);
  const label = t('mobile.tabDms');
  const name = count > 0 ? t('dm.homeUnread', { n: count }) : t('dm.home');
  return (
    <Slot active={active} data-testid="rail-home" data-over={home.over || undefined}>
      <div ref={ref} className="flex" {...home.handlers}>
        {home.flyout}
        <Tip label={label} side="right">
          <TileButton section="dms" icon={MessageCircle} name={name} active={active} count={count} testId="section-dms" ring={home.over} />
        </Tip>
      </div>
    </Slot>
  );
}

/** «Календарь»: the day view and the mini month; the accent count is today's meetings (as the old tab). */
const CalendarTile = memo(function CalendarTile({ active }: { active: boolean }): ReactNode {
  useLocale();
  const today = useCalendar((s) => s.todayCount);
  const label = t('cal.open');
  return (
    <Slot active={active}>
      <Tip label={label} side="right">
        <TileButton section="calendar" icon={CalendarDays} name={today > 0 ? plural('cal.todayCount', today) : label} active={active} count={today} tone="accent" testId="section-calendar" />
      </Tip>
    </Slot>
  );
});

/** «Доски»: the boards of the context workspace; the accent count is its unread tasks (as the old tab). */
const BoardsTile = memo(function BoardsTile({ ws, active }: { ws: string; active: boolean }): ReactNode {
  useLocale();
  const unread = useBoards((s) => unreadCount(s, ws));
  const label = t('shell.modeBoards');
  return (
    <Slot active={active}>
      <Tip label={label} side="right">
        <TileButton section="boards" icon={SquareKanban} name={unread > 0 ? plural('boards.unreadCount', unread) : label} active={active} count={unread} tone="accent" testId="section-boards" />
      </Tip>
    </Slot>
  );
});

/** «Найти пространство»: join by an invite or browse the open ones. */
function FindTile(): ReactNode {
  const open = useUi((s) => s.openDialog);
  const label = t('shell.findWorkspace');
  return (
    <div className="group relative flex w-full shrink-0 justify-center">
      <Tip label={label} side="right">
        <button
          type="button"
          onClick={() => open({ kind: 'join-workspace' })}
          aria-label={label}
          data-testid="section-find"
          className={cx(tile, 'bg-hover text-muted hover:bg-accent-strong hover:text-accent-fg active:bg-accent-strong active:text-accent-fg')}
        >
          <Compass className="size-6" strokeWidth={1.75} aria-hidden />
        </button>
      </Tip>
    </div>
  );
}
