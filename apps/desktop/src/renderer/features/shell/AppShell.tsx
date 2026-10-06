import { ReconnectBanner } from './ReconnectBanner';
import { WorkspaceLock, LockedWorkspacePicker } from '../identity/WorkspaceLock';
import { useIdentity } from '../../stores/identity';
import { accessLocked, localAuthority } from '../identity/model';
import { Compass, Plus } from 'lucide-react';
import { MessagesSquare } from 'lucide-react';
import { WorkspaceRole } from '@calaba/protocol';
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayArrangeRooms } from '../../lib/permissions';
import { installAfk } from '../../services/afk';
import { installPresenceTimer } from '../../services/presenceTimer';
import { installHotkeys } from '../../services/hotkeys';
import { installEmail } from '../../services/email';
import { VerifyBanner } from '../auth/VerifyEmail';
import { SuspendedBanner } from '../workspace/SuspendedBanner';
import { UpdateBar } from './UpdateBar';
import { defaultRoom, roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useMobile } from '../../lib/mobile';
import { showBottomIsland } from '../../lib/webApps';
import { MobileShell } from './MobileShell';
import { MEMBERS_COLUMN_MIN, useUi } from '../../stores/ui';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { ChatPane } from '../chat/ChatPane';
import { DmPick, useActiveDm } from '../dm/DmHome';
import { DmSidebar } from '../dm/DmSidebar';
import { HOME } from '../../stores/dms';
import { OnboardingLazy, preloadWindows } from './lazyWindows';
import { whenIdle } from '../../lib/lazyPreload';
import { MembersPanel } from './MembersPanel';
import { DayView } from '../calendar/DayView';
import { BoardsView } from '../boards/BoardsView';
import { CreateTaskDialog } from '../boards/CreateTaskDialog';
import { useBoardsUi } from '../../stores/boardsUi';
import { EventPanel } from '../calendar/EventCard';
import { BottomIsland } from './BottomIsland';
import { WindowVibrancy } from './WindowVibrancy';
import { Sidebar } from './Sidebar';
import { ArchivedChat } from '../chat/ArchivedChat';
import { useArchiveView } from '../../stores/archiveView';
import { TitleBar } from './TitleBar';
import { SectionRail } from './SectionRail';
import { AppScreen } from '../webapps/AppScreen';
import { installWebApps } from '../../services/webApps';
import { useOpenApp } from '../../stores/webApps';
import { StreamPopout } from '../voice/StreamArea';
import { SearchResultsPanel } from '../search/SearchResultsPanel';
import { useSearchPanel } from '../../stores/searchPanel';

export function AppShell(): ReactNode {
  return (
    <>
      <ShellLayout />
      <StreamPopout />
    </>
  );
}

/**
 * Main layout (docs/08, «Layout»; docs/09 #1–#2):
 * title bar 38 px across the window, then
 * rail 72 px │ rooms 256 px (200–320, resizable) │ content (opaque) │ members (optional).
 */
function ShellLayout(): ReactNode {
  const ready = useSession((s) => s.ready);
  const onboarded = usePrefs((s) => s.onboarded);
  const wsId = useUi((s) => s.activeWorkspaceId);
  const local = useSession((s) => localAuthority(s.authority));
  const locked = useIdentity((s) => !!wsId && accessLocked(s.access[wsId]));
  const home = wsId === HOME && local;
  const hasWs = useWorkspaces((s) => (wsId && !home ? !!s.byId[wsId] : false));
  const roomId = useActiveRoom(home ? null : wsId);
  const dmId = useActiveDm();
  // ≥ 1200 px: a column next to the chat; narrower: a floating panel over it (docs/08, Layout).
  const wide = useMediaQuery(`(min-width: ${MEMBERS_COLUMN_MIN}px)`);
  const columnOpen = useUi((s) => s.membersPanel);
  const overlayOpen = useUi((s) => s.membersOverlay);
  const width = useUi((s) => s.sidebarWidth);
  const calDay = useUi((s) => (home ? null : s.calDay));
  const calEvent = useUi((s) => s.calEvent);
  // The meeting dialog is open: from 1200 px the members column stands beside it (instead of the
  // card) so a member can be dragged in — also while editing a selected meeting.
  const eventDialog = useUi((s) => s.dialog?.kind === 'event');
  // Boards mode (ADR-0042 §5): the column lists boards, the centre shows one; guests have none.
  const guestWs = useWorkspaces((s) => (wsId ? s.byId[wsId]?.role === WorkspaceRole.GUEST : false));
  const boards = useBoardsUi((s) => s.active) && !home && !!wsId && !guestWs;
  // «Открыть историю» of an archived temporary room (ADR-0044) in place of the room.
  const archived = useArchiveView((s) => (s.room && s.room.workspaceId === wsId ? s.room : null));
  // A web app of this workspace (ADR-0050 §3) replaces the room column and the chat.
  const appId = useOpenApp(home ? null : wsId);
  // «Результаты поиска» (ADR-0062 §4): the right panel in place of the members list.
  const searchOpen = useSearchPanel((s) => s.open);
  const searchSeq = useSearchPanel((s) => s.seq);

  // Short reconnects (a server deploy re-IDENTIFYs in 1–5 s) don't flash the banner; it goes
  // away the moment READY/RESUMED arrives (lib/gateway/banner.ts).
  const showReconnect = useSession((s) => s.ready && s.reconnectBanner);

  const mobile = useMobile();

  useEffect(() => installHotkeys(), []);
  useEffect(() => installAfk(), []);
  useEffect(() => installPresenceTimer(), []);
  useEffect(() => installEmail(), []);
  useEffect(() => installWebApps(), []);
  const superadmin = useSession((s) => s.me?.isSuperadmin === true);
  useEffect(() => (ready ? whenIdle(() => preloadWindows(superadmin)) : undefined), [ready, superadmin]);

  if (!onboarded && local) return <OnboardingLazy.Component />;
  if (mobile) {
    // Phone layout (ADR-0073): tabs and a stack of screens; the shell decides what is on screen.
    return (
      <>
        <MobileShell
          showReconnect={showReconnect}
          welcome={
            <div className="mat-content flex flex-1 flex-col items-center justify-center gap-4">
              <LockedWorkspacePicker />
              <Welcome />
            </div>
          }
        />
        {ready ? <CreateTaskDialog /> : null}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col" style={{ ['--sidebar-width' as string]: `${width}px` }}>
      <WindowVibrancy />
      <TitleBar />
      {/* ADR-0023: «Подтвердите почту» over the main content until the code is entered. */}
      <VerifyBanner />
      <SuspendedBanner />
      {showReconnect ? <ReconnectBanner /> : null}
      {/* An update waits: the accent bar under the title bar (docs/08 «Обновление», docs/09 #125). */}
      <UpdateBar />
      {/* The rail sits on the window layer (same material as the title bar); the room column and
          the chat are one inset panel with a 12 px top-left corner and a quiet edge (docs/08
          «Слои окна», owner 07.10). The bottom island (me + the call) floats over the foot of the
          rail and the column. */}
      <div className="mat-rail relative flex min-h-0 flex-1">
        <SectionRail />
        {!ready ? (
          <div className="mat-content grid flex-1 place-items-center mobile:px-6">
            <div className="flex flex-col items-center gap-3 text-body text-muted">
              <Spinner className="size-6" />
              {t('gateway.connecting')}
            </div>
          </div>
        ) : locked && wsId ? (
          <WorkspaceLock workspaceId={wsId} />
        ) : home ? (
          // «Личные» (ADR-0020): the DM list in the room column, the DM chat without members/voice.
          <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-[var(--radius-panel)] border-l border-t border-[var(--color-panel-edge)]" data-testid="main-island">
            <DmSidebar />
            <ResizeHandle />
            <div className="mat-content relative flex min-w-0 flex-1">
              {dmId ? <ChatPane key={dmId} workspaceId="" roomId={dmId} /> : <DmPick />}
              {searchOpen ? <SearchResultsPanel key={searchSeq} floating={!wide} /> : null}
            </div>
          </div>
        ) : hasWs && wsId && appId ? (
          <AppScreen key={appId} appId={appId} />
        ) : hasWs && wsId ? (
          <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-[var(--radius-panel)] border-l border-t border-[var(--color-panel-edge)]" data-testid="main-island">
            <Sidebar workspaceId={wsId} />
            <ResizeHandle />
            <div className="mat-content relative flex min-w-0 flex-1">
              {boards ? (
                <BoardsView workspaceId={wsId} wide={wide} />
              ) : calDay ? (
                // Calendar (ADR-0038 §7): the day instead of the room, the selected meeting instead of the
                // members (a column from 1200 px, floating below); no meeting selected — the members, so
                // one can be dragged into a meeting (and while the meeting dialog is open).
                <>
                  <DayView workspaceId={wsId} />
                  {calEvent && !(wide && eventDialog) ? (
                    <EventPanel occ={calEvent} floating={!wide} />
                  ) : wide && (columnOpen || eventDialog) ? (
                    <MembersPanel workspaceId={wsId} />
                  ) : null}
                </>
              ) : archived ? (
                <ArchivedChat key={archived.id} workspaceId={wsId} room={archived} />
              ) : (
                <>
                  {roomId ? <ChatPane key={roomId} workspaceId={wsId} roomId={roomId} /> : <NoRoom workspaceId={wsId} />}
                  {searchOpen ? (
                    <SearchResultsPanel key={searchSeq} floating={!wide} />
                  ) : (
                    <>
                      {roomId && wide && columnOpen ? <MembersPanel workspaceId={wsId} /> : null}
                      {roomId && !wide && overlayOpen ? <MembersPanel workspaceId={wsId} floating /> : null}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="mat-content flex flex-1 flex-col items-center justify-center gap-4">
            <LockedWorkspacePicker />
            <Welcome />
          </div>
        )}
        {ready && (home || (hasWs && wsId)) ? <IslandSlot appOpen={!!appId} workTab={boards || (calDay !== null && !guestWs)} /> : null}
        {ready ? <CreateTaskDialog /> : null}
      </div>
    </div>
  );
}

/**
 * Web apps use the entire content area, including while a voice call continues.
 */
function IslandSlot({ appOpen, workTab }: { appOpen: boolean; workTab: boolean }): ReactNode {
  return showBottomIsland(appOpen, workTab) ? <BottomIsland /> : null;
}

/**
 * The room shown for a workspace (docs/09 #11): the remembered one if it still exists, else the
 * first text room (remembered without adding a history step). Undefined only without rooms.
 */
function useActiveRoom(wsId: string | null): string | undefined {
  const remembered = useUi((s) => (wsId ? s.lastRoom[wsId] : undefined));
  const byId = useRooms((s) => s.byId);
  const categories = useRooms((s) => s.categories);
  const valid = !!remembered && byId[remembered]?.workspaceId === wsId;
  const fallback = useMemo(() => {
    if (!wsId || valid) return undefined;
    return defaultRoom(
      roomsOfWorkspace(byId, wsId),
      Object.values(categories).filter((c) => c.workspaceId === wsId),
    )?.id;
  }, [wsId, valid, byId, categories]);
  useEffect(() => {
    if (wsId && fallback) useUi.getState().selectDefaultRoom(wsId, fallback);
  }, [wsId, fallback]);
  return valid ? remembered : fallback;
}

/** Drag the right edge of the room column (200–320 px). */
function ResizeHandle(): ReactNode {
  const setWidth = useUi((s) => s.setSidebarWidth);
  const start = useRef<{ x: number; w: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    start.current = { x: e.clientX, w: useUi.getState().sidebarWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (start.current) setWidth(start.current.w + e.clientX - start.current.x);
  };
  const onUp = (): void => {
    start.current = null;
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('shell.resize')}
      aria-valuemin={200}
      aria-valuemax={320}
      aria-valuenow={useUi.getState().sidebarWidth}
      tabIndex={0}
      onKeyDown={(e) => {
        const w = useUi.getState().sidebarWidth;
        if (e.key === 'ArrowLeft') setWidth(w - 8);
        if (e.key === 'ArrowRight') setWidth(w + 8);
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      // Zero layout width: the 6 px grab area overlaps both panes, so the column and the chat touch
      // (a visible 3 px strip of the window layer showed between them otherwise).
      className="relative z-[var(--z-sticky)] -ml-[3px] -mr-[3px] w-[6px] shrink-0 cursor-col-resize after:absolute after:inset-y-0 after:left-[2.5px] after:w-px after:bg-line hover:after:bg-accent focus-visible:after:bg-accent"
    />
  );
}

/** Only for a workspace without any rooms (otherwise a room is always open, docs/09 #11). */
function NoRoom({ workspaceId }: { workspaceId: string }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const manage = mayArrangeRooms(useMemberRoles(workspaceId, me));
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-body text-muted">
      <MessagesSquare className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
      <p>{manage ? t('shell.noRooms') : t('shell.noRoomsMember')}</p>
      {manage ? (
        <Button onClick={() => open({ kind: 'room-create', workspaceId, voice: false })}>{t('shell.createFirstRoom')}</Button>
      ) : null}
    </div>
  );
}

function Welcome(): ReactNode {
  const local = useSession((s) => localAuthority(s.authority));
  const open = useUi((s) => s.openDialog);
  // The create / join dialogs cover this block; hide it meanwhile so its accent button never
  // peeks out beside the (narrower) dialog.
  const covered = useUi((s) => s.dialog !== null);
  if (!local) return <p className="max-w-md p-6 text-body text-muted">{t('identity.scope')}</p>;
  return (
    <div className="mat-content grid flex-1 place-items-center mobile:px-6">
      <div className={cx('flex max-w-sm flex-col items-center gap-2 text-center', covered && 'invisible')}>
        <h1 className="text-title font-semibold">{t('shell.welcome')}</h1>
        <p className="text-body text-muted">{t('shell.welcomeText')}</p>
        {/* Phones: the two actions stacked full width, the primary one on top. */}
        <div className="mt-4 flex gap-2 mobile:w-full mobile:flex-col-reverse">
          <Button variant="secondary" onClick={() => open({ kind: 'join-workspace' })}>
            <Compass className="size-4" strokeWidth={1.75} />
            {t('ws.join')}
          </Button>
          <Button onClick={() => open({ kind: 'create-workspace' })}>
            <Plus className="size-4" strokeWidth={1.75} />
            {t('ws.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}
