import { WorkspaceRole } from '@calaba/protocol';
import { Volume2 } from 'lucide-react';
import { memo, useRef, type ComponentPropsWithRef, type ReactNode } from 'react';
import {
  BoardsActiveIcon,
  BoardsIdleIcon,
  CalendarActiveIcon,
  CalendarIdleIcon,
  PersonalActiveIcon,
  PersonalIdleIcon,
  TeamActiveIcon,
  TeamIdleIcon,
} from '../../assets/nav/icons';
import { CountBadge, Tip, cx } from '../../components/ui';
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

/** 40 px plate, radius 10 (docs/08, owner 07.10): no fill at rest, grey plate on hover and when active. */
const tile = 'relative grid size-10 place-items-center rounded-[10px] transition-[background-color,color] duration-[var(--motion-fast)] ease-out';

/**
 * The sections rail (ADR-0074 §1): 72 px, rail material — «Команда» (the rooms of the context
 * workspace), «Личные» (DMs and notes), «Календарь», «Доски», then the workspace's web apps
 * (ADR-0050). The workspace itself is picked — and found, created — in the title bar's switcher
 * (WorkspaceSwitcher; «Найти пространство» left the rail 07.10). Re-renders: the rail reads two primitives (the section on screen and the
 * context workspace); each tile subscribes to its own counter, so a new message re-renders one tile.
 */
export function SectionRail(): ReactNode {
  const local = useSession((s) => localAuthority(s.authority));
  const ws = useContextWorkspace();
  const guestWs = useWorkspaces((s) => (ws ? s.byId[ws]?.role === WorkspaceRole.GUEST : false));
  const section = useSection(ws);

  return (
    // The wrapper carries the island fade (styles.css `.island-fade`): a pseudo-element inside the
    // scroller would scroll away with the icons.
    <div className="island-fade island-fade-rail flex w-[var(--rail-width)] shrink-0 flex-col">
      <nav
        className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto overflow-x-hidden pt-3"
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
const APPS_LINE = <div className="my-1 h-px w-8 shrink-0 bg-line" aria-hidden />;

// ---------------------------------------------------------------- tiles

type NavIcon = (p: { className?: string }) => ReactNode;
type NavIcons = readonly [idle: NavIcon, active: NavIcon];
const TEAM: NavIcons = [TeamIdleIcon, TeamActiveIcon];
const PERSONAL: NavIcons = [PersonalIdleIcon, PersonalActiveIcon];
const CALENDAR: NavIcons = [CalendarIdleIcon, CalendarActiveIcon];
const BOARDS: NavIcons = [BoardsIdleIcon, BoardsActiveIcon];

function NavIcon({ icons, active, className }: { icons: NavIcons; active: boolean; className: string }): ReactNode {
  const Icon = icons[active ? 1 : 0];
  return <Icon className={className} />;
}

interface TileProps {
  section: Section;
  /** The owner's pair (assets/nav): outline at rest, filled while the section is open; same 44 box, no shift. */
  icons: NavIcons;
  /** Accessible name: the label with its counter («Команда, 2 упоминания»). */
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
  icons,
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
        active ? 'bg-hover text-fg' : 'text-muted hover:bg-active hover:text-fg',
        ring && 'ring-2 ring-accent',
      )}
    >
      <NavIcon icons={icons} active={active} className="size-6" />
      {/* As on the workspace tiles before: «in voice» top-right (green), the count bottom-right. */}
      {inVoice ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full border-2 border-[var(--color-rail)] bg-ok-fill text-white"
          data-testid="rail-voice-badge"
          aria-hidden
        >
          <Volume2 className="size-2" strokeWidth={2.75} />
        </span>
      ) : null}
      {count > 0 ? (
        <CountBadge count={count} tone={tone} className="absolute -right-1.5 -top-1.5" data-testid={`${testId}-count`} aria-hidden />
      ) : null}
    </button>
  );
}

/** The slot: the tile and, only while the section has unread without a count, the 8 px pill on the left edge. */
function Slot({ active, dot = false, children, ...rest }: { active: boolean; dot?: boolean; children: ReactNode } & Record<`data-${string}`, unknown>): ReactNode {
  return (
    <div className="group relative flex w-full shrink-0 justify-center" {...rest}>
      <span
        aria-hidden
        className={cx(
          'absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-fg transition-[height,opacity] duration-[var(--motion)] ease-out',
          dot && !active ? 'h-2' : 'h-0 opacity-0',
        )}
      />
      {children}
    </div>
  );
}

/**
 * «Команда»: the rooms of the context workspace. Its badge is that workspace's (mentions, else the
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
        <TileButton section="chats" icons={TEAM} name={name} active={active} count={Math.max(0, badge)} inVoice={inVoice} testId="section-chats" />
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
          <TileButton section="dms" icons={PERSONAL} name={name} active={active} count={count} testId="section-dms" ring={home.over} />
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
        <TileButton section="calendar" icons={CALENDAR} name={today > 0 ? plural('cal.todayCount', today) : label} active={active} count={today} tone="accent" testId="section-calendar" />
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
        <TileButton section="boards" icons={BOARDS} name={unread > 0 ? plural('boards.unreadCount', unread) : label} active={active} count={unread} tone="accent" testId="section-boards" />
      </Tip>
    </Slot>
  );
});
