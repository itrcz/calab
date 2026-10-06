import { ReconnectBanner } from './ReconnectBanner';
import { WorkspaceRole } from '@calaba/protocol';
import { CalendarDays, MessageCircle, MessagesSquare, SquareKanban } from 'lucide-react';
import { memo, useEffect, useRef, type ReactNode, type TouchEvent } from 'react';
import { PhoneHeader } from '../../components/PhoneHeader';
import { Spinner, cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { topScreen, type PhoneScreen, type PhoneTab } from '../../lib/phoneNav';
import { isStandalone } from '../../lib/mobile';
import { installPhoneNav, openTab, phoneBack } from '../../services/phoneNav';
import { useArchiveView } from '../../stores/archiveView';
import { unreadCount, useBoards } from '../../stores/boards';
import { HOME, isDm } from '../../stores/dms';
import { showsUnread, useRooms } from '../../stores/rooms';
import { useSearchPanel } from '../../stores/searchPanel';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { useIdentity } from '../../stores/identity';
import { accessLocked } from '../identity/model';
import { WorkspaceLock } from '../identity/WorkspaceLock';
import { VerifyBanner } from '../auth/VerifyEmail';
import { SuspendedBanner } from '../workspace/SuspendedBanner';
import { ChatPane } from '../chat/ChatPane';
import { ArchivedChat } from '../chat/ArchivedChat';
import { DmSidebar } from '../dm/DmSidebar';
import { DayView } from '../calendar/DayView';
import { EventPanel } from '../calendar/EventCard';
import { BoardsList } from '../boards/BoardsList';
import { BoardsView } from '../boards/BoardsView';
import { SearchResultsPanel } from '../search/SearchResultsPanel';
import { MembersPanel } from './MembersPanel';
import { MobileVoiceStrip } from './MobileVoiceStrip';
import { PhoneProfile, ProfileButton } from './PhoneProfile';
import { ScreenTransition } from './ScreenTransition';
import { SettingsScreen } from './SettingsScreen';
import { PhoneRoomList } from './PhoneRoomList';
import { UpdateBar } from './UpdateBar';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/** A horizontal swipe longer than this (and mostly horizontal) is a swipe. */
const SWIPE_PX = 56;
/** A «back» swipe starts this close to the left edge. */
const EDGE_PX = 28;

/**
 * Phone layout of the web client (ADR-0073, ≤ 768 px, lib/mobile.ts): root tabs «Чаты · Личные ·
 * Доски · Календарь» with a bottom tab bar, and screens pushed over them (a room, a DM, the members,
 * search results, a meeting, a board / task, the profile) without the tab bar, each with its «←» header. Only
 * the top screen is mounted; back = the browser history (services/phoneNav.ts): Android back, the
 * browser's back, «←» and a swipe from the left edge.
 *  - «Чаты»: the workspace rail (no «Личные» icon — it is a tab) and the room list on the rest;
 *  - in voice, the call strip sits at the bottom: above the tab bar on a root, under the screen
 *    otherwise (MobileVoiceStrip).
 * iOS safe areas: the top inset on the shell, the bottom one on whatever is last (tab bar, strip
 * or composer).
 */
export function MobileShell({ showReconnect, welcome }: { showReconnect: boolean; welcome: ReactNode }): ReactNode {
  const ready = useSession((s) => s.ready);
  const inVoice = useVoice((s) => s.roomId !== null);
  const tab = useUi((s) => s.phone.tab);
  const top = useUi((s) => topScreen(s.phone));
  const on = useUi((s) => s.phone.on);
  const depth = useUi((s) => s.phone.stack.length);
  useEffect(() => installPhoneNav(), []);
  const root = !top;
  const strip = ready && inVoice;
  const swipe = useSwipe((dir, fromEdge) => {
    if (dir === 'right' && fromEdge && !nativeBackSwipe() && useUi.getState().phone.stack.length > 0) phoneBack();
  });

  return (
    <div
      className="mat-rail relative flex h-full flex-col overflow-hidden pl-[var(--safe-left)] pr-[var(--safe-right)] pt-[var(--safe-top)]"
      data-layout="mobile"
      data-testid="mobile-shell"
      data-phone-tab={root ? tab : undefined}
      data-phone-screen={top?.kind}
      // The composer carries the bottom safe-area inset unless the voice strip is below it.
      style={{ ['--composer-safe' as string]: strip ? '0px' : 'var(--safe-bottom, 0px)' }}
      {...swipe}
    >
      {showReconnect ? <ReconnectBanner /> : null}
      {/* Web: «Доступна версия X · Обновить страницу» when the server is newer (docs/09 #125). */}
      <UpdateBar />
      <VerifyBanner />
      <SuspendedBanner />
      <main className="mat-content relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <ScreenTransition depth={depth}>
          {!on ? null : !ready ? (
            <div className="grid flex-1 place-items-center">
              <div className="flex flex-col items-center gap-3 text-body text-muted">
                <Spinner className="size-6" />
                {t('gateway.connecting')}
              </div>
            </div>
          ) : top ? (
            <PushedScreen screen={top} />
          ) : (
            <TabRoot tab={tab} welcome={welcome} />
          )}
        </ScreenTransition>
      </main>
      {strip ? <MobileVoiceStrip aboveTabs={root} /> : null}
      {root && ready ? <TabBar tab={tab} /> : null}
    </div>
  );
}

/**
 * iOS Safari in a tab has its own edge swipe back (it fires popstate): ours would go back twice.
 * The home-screen app and the Calab app's WebView (no «Safari/» in its UA) have none.
 */
function nativeBackSwipe(): boolean {
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) && /Safari\//.test(ua) && !isStandalone();
}

// ---------------------------------------------------------------- tab roots

function TabRoot({ tab, welcome }: { tab: PhoneTab; welcome: ReactNode }): ReactNode {
  switch (tab) {
    case 'chats':
      return <ChatsRoot welcome={welcome} />;
    case 'dms':
      return <DmsRoot />;
    case 'boards':
      return <BoardsRoot welcome={welcome} />;
    case 'calendar':
      return <CalendarRoot welcome={welcome} />;
  }
}

/** The workspace on «Чаты» / «Календарь»: the open one, unless it is «Личные». */
function useRootWorkspace(): { ws: string | null; locked: boolean } {
  const wsId = useUi((s) => (s.activeWorkspaceId === HOME ? null : s.activeWorkspaceId));
  const has = useWorkspaces((s) => (wsId ? !!s.byId[wsId] : false));
  const locked = useIdentity((s) => !!wsId && accessLocked(s.access[wsId]));
  return { ws: wsId && (has || locked) ? wsId : null, locked };
}

/** «Чаты»: the room list at full width; the workspace is picked in its header (the switcher, ADR-0074). */
function ChatsRoot({ welcome }: { welcome: ReactNode }): ReactNode {
  const { ws, locked } = useRootWorkspace();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="phone-chats">
      {locked && ws ? <WorkspaceLock workspaceId={ws} /> : ws ? <PhoneRoomList workspaceId={ws} /> : welcome}
    </div>
  );
}

/** «Доски»: the boards of the open workspace (the one picked on «Чаты»); a board is a pushed screen. */
function BoardsRoot({ welcome }: { welcome: ReactNode }): ReactNode {
  const { ws, locked } = useRootWorkspace();
  const name = useWorkspaces((s) => (ws ? s.byId[ws]?.ws.name : undefined));
  const guest = useWorkspaces((s) => (ws ? s.byId[ws]?.role === WorkspaceRole.GUEST : false));
  if (!ws || locked || guest || name === undefined) return <div className="flex min-h-0 flex-1 flex-col" data-testid="phone-boards-empty">{welcome}</div>;
  return (
    <section className="mat-sidebar flex min-h-0 flex-1 flex-col" data-testid="phone-boards">
      <header className="mat-toolbar flex h-12 shrink-0 items-center gap-1 border-b border-line pl-2 pr-2">
        <WorkspaceSwitcher phone testId="phone-ws-switcher" />
      </header>
      <BoardsList workspaceId={ws} />
    </section>
  );
}

/** «Личные»: notes and DMs at full width; my avatar at the right opens «Профиль». */
function DmsRoot(): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ ['--sidebar-width' as string]: '100%' }} data-testid="phone-dms">
      <RootTitle title={t('dm.home')}>
        <ProfileButton tab="dms" />
      </RootTitle>
      <div className="flex min-h-0 flex-1">
        <DmSidebar />
      </div>
    </div>
  );
}

/** «Календарь»: the day of the open workspace (guests have none: no tab). */
function CalendarRoot({ welcome }: { welcome: ReactNode }): ReactNode {
  const { ws } = useRootWorkspace();
  const day = useUi((s) => s.calDay);
  useEffect(() => {
    // The tab without a day (a stale state): today.
    if (ws && day === null) openTab('calendar');
  }, [ws, day]);
  if (!ws) return welcome;
  return day ? <DayView workspaceId={ws} /> : <div className="flex-1" />;
}

/** The title of a tab root without its own header (iOS large-title look, one line). */
export function RootTitle({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <header className="mat-toolbar flex h-12 shrink-0 items-center gap-1 border-b border-line pl-4 pr-2">
      <h1 className="min-w-0 flex-1 truncate text-headline font-semibold">{title}</h1>
      {children}
    </header>
  );
}

// ---------------------------------------------------------------- pushed screens

function PushedScreen({ screen }: { screen: PhoneScreen }): ReactNode {
  switch (screen.kind) {
    case 'room':
      return <ChatPane key={screen.room} workspaceId={screen.ws} roomId={screen.room} />;
    case 'dm':
      return <ChatPane key={screen.room} workspaceId="" roomId={screen.room} />;
    case 'members':
      return <MembersPage workspaceId={screen.ws} roomId={screen.room} />;
    case 'search':
      return <SearchScreen />;
    case 'event':
      return <EventPanel occ={screen.key} page />;
    case 'findTime':
      return <ActiveWorkspace>{(ws) => <DayView workspaceId={ws} />}</ActiveWorkspace>;
    case 'board':
      return <BoardsView workspaceId={screen.ws} wide={false} mobile />;
    case 'task':
      return <ActiveWorkspace>{(ws) => <BoardsView workspaceId={ws} wide={false} mobile />}</ActiveWorkspace>;
    case 'archived':
      return <ArchivedScreen />;
    case 'profile':
      return <ProfileScreen />;
    case 'settings':
      return <SettingsScreen section={screen.section} />;
  }
}

function ActiveWorkspace({ children }: { children: (ws: string) => ReactNode }): ReactNode {
  const ws = useUi((s) => (s.activeWorkspaceId === HOME ? null : s.activeWorkspaceId));
  return ws ? children(ws) : null;
}

function SearchScreen(): ReactNode {
  const seq = useSearchPanel((s) => s.seq);
  return <SearchResultsPanel key={seq} page />;
}

function ArchivedScreen(): ReactNode {
  const room = useArchiveView((s) => s.room);
  return room ? <ArchivedChat key={room.id} workspaceId={room.workspaceId} room={room} /> : null;
}

/** «Профиль»: the former «Я» tab, a screen over «Личные». */
function ProfileScreen(): ReactNode {
  return (
    <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="profile-page">
      <PhoneHeader title={t('mobile.profile')} />
      <PhoneProfile />
    </section>
  );
}

/** «Участники» of a room: a screen with the unified header (it was the right drawer). */
function MembersPage({ workspaceId, roomId }: { workspaceId: string; roomId: string }): ReactNode {
  const roomName = useRooms((s) => s.byId[roomId]?.name ?? '');
  return (
    <section className="mat-content flex min-h-0 flex-1 flex-col" data-testid="members-page">
      <PhoneHeader title={t('shell.members')} subtitle={roomName} />
      <MembersPanel workspaceId={workspaceId} drawer />
    </section>
  );
}

// ---------------------------------------------------------------- tab bar

/**
 * The bottom tab bar (ADR-0073 §1): «Чаты · Личные · Доски · Календарь», 56 px targets over the home
 * indicator, the unread count of rooms (mentions) on «Чаты», of DMs on «Личные» and of tasks on
 * «Доски» (the open workspace's, as the old «Голос · Доски» switch showed). «Личные» only for
 * accounts with DMs, «Календарь» not for guests.
 */
function TabBar({ tab }: { tab: PhoneTab }): ReactNode {
  const dms = useSession((s) => !s.me?.user?.isGuest);
  const calendar = useWorkspaces((s) => s.order.some((id) => s.byId[id] && s.byId[id].role !== WorkspaceRole.GUEST));
  return (
    <nav
      aria-label={t('mobile.tabs')}
      data-testid="phone-tabbar"
      className="mat-toolbar flex shrink-0 border-t border-line pb-[var(--safe-bottom,0px)] [.kb-open_&]:hidden"
    >
      <TabButton tab="chats" active={tab === 'chats'} label={t('mobile.tabChats')} icon={<MessagesSquare className="size-6" strokeWidth={1.75} />} badge={<ChatsBadge />} />
      {dms ? <TabButton tab="dms" active={tab === 'dms'} label={t('mobile.tabDms')} icon={<MessageCircle className="size-6" strokeWidth={1.75} />} badge={<DmsBadge />} /> : null}
      <TabButton tab="boards" active={tab === 'boards'} label={t('shell.modeBoards')} icon={<SquareKanban className="size-6" strokeWidth={1.75} />} badge={<BoardsBadge />} />
      {calendar ? <TabButton tab="calendar" active={tab === 'calendar'} label={t('cal.open')} icon={<CalendarDays className="size-6" strokeWidth={1.75} />} /> : null}
    </nav>
  );
}

const TabButton = memo(function TabButton({ tab, active, label, icon, badge }: { tab: PhoneTab; active: boolean; label: string; icon: ReactNode; badge?: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      onClick={() => openTab(tab)}
      aria-current={active ? 'page' : undefined}
      data-testid={`phone-tab-${tab}`}
      className={cx('relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-micro font-medium', active ? 'text-accent-text' : 'text-muted')}
    >
      <span className="relative flex">
        {icon}
        {badge}
      </span>
      <span className="max-w-full truncate px-1">{label}</span>
    </button>
  );
});

function TabBadge({ count, dot, label }: { count: number; dot: boolean; label: string }): ReactNode {
  if (count <= 0 && !dot) return null;
  return count > 0 ? (
    <span role="img" aria-label={label} className="absolute -right-2.5 -top-1 min-w-[18px] rounded-full border-2 border-[var(--color-toolbar,var(--color-bg))] bg-danger-fill px-1 text-center text-micro font-bold leading-[14px] text-white">
      {count > 99 ? '99+' : count}
    </span>
  ) : (
    <span role="img" aria-label={label} className="absolute -right-1 -top-0.5 size-2.5 rounded-full border-2 border-[var(--color-toolbar,var(--color-bg))] bg-fg" />
  );
}

/** Mentions across the workspaces' rooms (primitive selectors: re-renders only on a change). */
function ChatsBadge(): ReactNode {
  const count = useRooms((s) => {
    let n = 0;
    for (const id in s.mentions) {
      const r = s.byId[id];
      if (r && !isDm(r) && r.workspaceId !== '') n += s.mentions[id] ?? 0;
    }
    return n;
  });
  const dot = useRooms((s) => count === 0 && Object.values(s.byId).some((r) => r.workspaceId !== '' && !isDm(r) && showsUnread(r.id, s)));
  return <TabBadge count={count} dot={dot} label={count > 0 ? plural('shell.unreadMentions', count) : t('ws.unread')} />;
}

/** Unread tasks of the open workspace (the number the boards icon of the old switch showed). */
function BoardsBadge(): ReactNode {
  const open = useUi((s) => (s.activeWorkspaceId === HOME ? null : s.activeWorkspaceId));
  const first = useWorkspaces((s) => s.order[0] ?? null);
  const wsId = open ?? first;
  const count = useBoards((s) => (wsId ? unreadCount(s, wsId) : 0));
  return <TabBadge count={count} dot={false} label={plural('boards.unreadCount', count)} />;
}

/** Unread DM messages: every one counts (docs/05), as on the rail's «Личные». */
function DmsBadge(): ReactNode {
  const count = useRooms((s) => {
    let n = 0;
    for (const id in s.mentions) if (isDm(s.byId[id])) n += s.mentions[id] ?? 0;
    return n;
  });
  return <TabBadge count={count} dot={false} label={t('dm.homeUnread', { n: count })} />;
}

// ---------------------------------------------------------------- swipe

type SwipeDir = 'left' | 'right';

/** Touch handlers reporting one horizontal swipe per gesture (vertical scrolling wins ties). */
function useSwipe(on: (dir: SwipeDir, fromEdge: boolean) => void): {
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: () => void;
} {
  const start = useRef<{ x: number; y: number; edge: boolean; done: boolean } | null>(null);
  return {
    onTouchStart: (e) => {
      const p = e.touches[0];
      if (!p || e.touches.length > 1) {
        start.current = null;
        return;
      }
      start.current = { x: p.clientX, y: p.clientY, edge: p.clientX <= EDGE_PX, done: false };
    },
    onTouchMove: (e) => {
      const s = start.current;
      const p = e.touches[0];
      if (!s || s.done || !p) return;
      const dx = p.clientX - s.x;
      const dy = p.clientY - s.y;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
        start.current = null; // a scroll, not a swipe
        return;
      }
      if (Math.abs(dx) < SWIPE_PX) return;
      s.done = true;
      on(dx > 0 ? 'right' : 'left', s.edge);
    },
    onTouchEnd: () => {
      start.current = null;
    },
  };
}
