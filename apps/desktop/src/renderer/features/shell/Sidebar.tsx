import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { create } from '@bufbuild/protobuf';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { NotificationLevel, RoomCategorySchema, WorkspaceRole, type Role, type Room, type RoomCategory, type VoiceState } from '@calaba/protocol';
import {
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Check,
  CalendarPlus,
  CheckCheck,
  CircleDot,
  CircleStop,
  Phone,
  Ellipsis,
  ChevronRight,
  FolderInput,
  FolderPlus,
  Hash,
  ListPlus,
  Loader2,
  Lock,
  Pencil,
  Plus,
  SlidersHorizontal,
  SquareKanban,
  Trash2,
  UserPlus,
  Users,
  MessageCircle,
  Video,
  Volume2,
  Link2,
  Timer,
} from 'lucide-react';
import { Fragment, createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../../components/Avatar';
import { SpeakerIdentity } from '../../components/SpeakerIdentity';
import { confirmAction } from '../../components/Confirm';
import { CreateButton, InlineAdd } from '../../components/CreateButton';
import { Badge, Button, CountBadge, Empty, Field, IconButton, Input, Modal, Tip, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { can, mayArrangeRooms, mayCreateBoards, mayCreateTempRooms, mayInviteMembers, mayManageRoomWith, mayMoveMembersIn, mayMoveVoice, mayRoomInvite, roomPerms } from '../../lib/permissions';
import { expiresMs, extendTo, formatRemaining, isExpiring, sortTempRooms } from '../../lib/tempRooms';
import { addTempRoomMeeting, copyTempRoomLink, deleteTempRoom, extendTempRoom } from '../../services/tempRooms';
import { useCalendar } from '../../stores/calendar';
import { voice } from '../../services/voice';
import { groupRooms, isUnread, isVoice, roomNotify, roomsOfWorkspace, showsUnread, useRooms, workspaceNotify } from '../../stores/rooms';
import { setRoomNotifications } from '../../services/mentions';
import { KnockBadge } from '../guests/KnockBadge';
import { LEVEL_LABEL, NotifyMenuItems, type LevelOption } from '../chat/NotifyMenu';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { memberName, rolesOf, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { useConnectingRing, useVoiceStates } from '../../stores/voicePending';
import { joinButton, joinOutcome } from '../../lib/voiceEntry';
import { formatDuration, pad2, useNow } from './voiceFormat';
import { menuBox, menuItem, menuLabel, menuSeparator } from './menu';
import { useBoards, workspaceBoards } from '../../stores/boards';
import { MemberContextMenu } from '../people/MemberContextMenu';
import { JustJoinedDot } from '../voice/JustJoinedDot';
import { joinedAtMs } from '../../lib/justJoined';
import { moveMember } from '../people/actions';
import { errorText } from '../../lib/api/errors';
import { VoiceInviteRow, VoiceStatusLine, useStatusLine } from './VoiceRoomRows';
import { MusicianIcon, VoiceStateIcons } from '../voice/VoiceStateIcons';
import { isMobileNow, useMobile } from '../../lib/mobile';
import { useChatDrop } from '../chat/useChatDrop';
import { applyChatDrop } from '../notes/dropActions';
import type { DropAction, DropTarget } from '../../lib/messageDrag';
import { roomLabel } from '../chat/roomLabel';
import { categoryDropAt, roomDropAt, stepTarget, type RoomTarget, type Slot } from '../../lib/roomOrder';
import { createCategoryFirst, moveCategoryTo, moveRoomTo, workspaceCategories, workspaceLayout } from '../../services/roomOrder';
import { useLocalTimeTag } from '../../services/timezone';
import { roomMenuGroups, type RoomMenuItem } from '../../lib/roomMenu';
import { RoomRecBadge } from '../voice/Recording';
import { useRecordings } from '../../stores/recordings';
import { useSipCalls } from '../../stores/sipCalls';
import { SipCallRow, useCanDial, useTelephonyOnPlan } from '../voice/Sip';
import { planToast } from '../../services/plan';
import { dialFromMenu } from '../../lib/dialFromMenu';
import { useSipDial } from '../../stores/sipDial';
import { startRecording, stopRecording } from '../../services/recording';
import { MiniCalendar } from '../calendar/MiniCalendar';
import { CREATE_TASKS, hasBit } from '../boards/model';
import { openBoard } from '../../services/boards';
import { useShallow } from 'zustand/react/shallow';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { ColumnHeader, ColumnTitle, GROUP_LABEL, GroupChevron, ROW_HOVER, ROW_SELECTED } from './ColumnHeader';
import { BoardsList, NewCategoryDialog } from '../boards/BoardsList';
import { useBoardsUi } from '../../stores/boardsUi';
import { RoomEventBadge } from '../calendar/RoomEvent';
import { newEvent } from '../calendar/actions';
import { DRAG_ROOM, dropRoomAt, hoverRoomAt } from '../calendar/dragState';
import { RestrictedMark } from '../workspace/AccessLevel';

export { menuBox, menuItem };

const errText = (e: unknown): string => errorText(e);

/** Drag payloads: a voice participant onto a voice room (docs/09 #32); a room or a category to a new place (P1 #19). */
interface DragMember {
  type: 'member';
  userId: string;
  fromRoomId: string;
  name: string;
}
interface DragRoom {
  type: 'room';
  roomId: string;
  name: string;
  voice: boolean;
  isPrivate: boolean;
}
interface DragCategory {
  type: 'category';
  categoryId: string;
  name: string;
}
type DragData = DragMember | DragRoom | DragCategory;
interface DropRoom {
  roomId: string;
  canMove: boolean;
}

/**
 * Room column (docs/09 #4, P1 #19): the header with the section name (ADR-0074) and «+» (#135); rooms as one flat
 * list in `position` order, then user categories (collapsible) — no built-in sections. Rooms and
 * categories are dragged to a new place with MANAGE_ROOM (accent line, Esc cancels); voice
 * participants between voice rooms with MOVE_MEMBERS. Then the voice panel and the self panel.
 */
export function Sidebar({ workspaceId }: { workspaceId: string }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  // Server voice states + me while connecting (optimistic join, docs/05).
  const voiceStates = useVoiceStates(workspaceId);
  const roomsById = useRooms((s) => s.byId);
  const categoriesById = useRooms((s) => s.categories);
  const notify = useRooms((s) => s.notify);
  const hideMuted = useUi((s) => s.hideMuted);
  const activeRoom = useUi((s) => s.lastRoom[workspaceId]);
  const voiceRoom = useVoice((s) => s.roomId);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const open = useUi((s) => s.openDialog);
  const mobile = useMobile();
  const listRef = useRef<HTMLDivElement>(null);
  const [catDialog, setCatDialog] = useState(false);
  const myRoles = useMemberRoles(workspaceId, me);
  // The mini calendar under the header (ADR-0038 §7) while the «Календарь» tab is on (docs/09 #140);
  // guests see no calendar.
  const calOpen = useUi((s) => s.calDay !== null);
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  // Boards mode (ADR-0042 §5): the column lists the boards instead of the rooms.
  const boards = useBoardsUi((s) => s.active) && !guest;
  // Workspace invites (rows' «Пригласить»): INVITE_MEMBERS (ADR-0043), a custom role's included.
  const admin = mayInviteMembers(myRoles);
  const manageRooms = mayArrangeRooms(myRoles);
  // Pointer reordering on the desktop layout only: on a phone a drag would fight the scroll
  // (the room menu's «Переместить вверх/вниз» works everywhere).
  const canDrag = manageRooms && !mobile;
  const { groups, temps } = useMemo(() => {
    let rooms = roomsOfWorkspace(roomsById, workspaceId);
    // «Скрыть заглушённые»: the open room and my voice room stay (Discord).
    if (hideMuted) rooms = rooms.filter((r) => r.id === activeRoom || r.id === voiceRoom || roomNotify(notify[r.id]).mutedUntil === null);
    const cats = Object.values(categoriesById).filter((c) => c.workspaceId === workspaceId);
    // Temporary rooms (ADR-0044): the virtual «Временные» group under the categories, by expiry.
    return { groups: groupRooms(rooms, cats, manageRooms), temps: sortTempRooms(rooms.filter((r) => !!r.expiresAt)) };
  }, [roomsById, categoriesById, workspaceId, manageRooms, hideMuted, notify, activeRoom, voiceRoom]);
  if (!entry) return null;
  // Calendar mode (owner, 02.10): the column is the header and the mini calendar only — no room list.
  const calList = calOpen && !guest && !boards;
  const empty = groups.length === 0 && temps.length === 0;

  return (
    <aside className="mat-sidebar island-fade flex w-[var(--sidebar-width)] shrink-0 flex-col" aria-label={t('room.list')}>
      <WorkspaceHeader workspaceId={workspaceId} onCreateCategory={() => setCatDialog(true)} />
      {calList ? <MiniCalendar workspaceId={workspaceId} /> : null}
      {boards ? <BoardsList workspaceId={workspaceId} /> : null}
      {boards || calList ? null : (
      <SidebarDnd workspaceId={workspaceId} listRef={listRef}>
        <SidebarMenu workspaceId={workspaceId} onCreateCategory={() => setCatDialog(true)}>
          {/* The bottom island (AppShell) floats over the column's foot: the list ends above it. */}
          <div
            ref={listRef}
            className="scrollbar-none relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pt-1"
            style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}
            data-testid="room-list"
          >
            {empty ? (
              <Empty
                action={
                  manageRooms ? (
                    <Button size="sm" onClick={() => open({ kind: 'room-create', workspaceId, voice: false })}>
                      <Plus className="size-3.5" /> {t('room.create')}
                    </Button>
                  ) : undefined
                }
              >
                {manageRooms ? t('shell.noRooms') : t('shell.noRoomsMember')}
              </Empty>
            ) : null}
            {groups.map((g) => {
              const container = g.category?.id ?? '';
              return (
                <CategoryGroup key={g.category?.id ?? 'none'} category={g.category} workspaceId={workspaceId} canManage={manageRooms} canDrag={canDrag}>
                  {g.rooms.map((r) =>
                    isVoice(r) ? (
                      <VoiceRoomRow
                        key={r.id}
                        room={r}
                        workspaceId={workspaceId}
                        me={me}
                        role={myRoles}
                        admin={admin}
                        voiceStates={voiceStates}
                        container={container}
                        canOrder={manageRooms}
                        canDrag={canDrag}
                      />
                    ) : (
                      <TextRoomRow
                        key={r.id}
                        room={r}
                        workspaceId={workspaceId}
                        me={me}
                        role={myRoles}
                        admin={admin}
                        container={container}
                        canOrder={manageRooms}
                        canDrag={canDrag}
                      />
                    ),
                  )}
                </CategoryGroup>
              );
            })}
            {temps.length ? (
              <TempGroup workspaceId={workspaceId}>
                {temps.map((r) => (
                  <VoiceRoomRow
                    key={r.id}
                    room={r}
                    workspaceId={workspaceId}
                    me={me}
                    role={myRoles}
                    admin={admin}
                    voiceStates={voiceStates}
                    container=""
                    canOrder={false}
                    canDrag={false}
                  />
                ))}
              </TempGroup>
            ) : null}
            <DropLine />
          </div>
        </SidebarMenu>
      </SidebarDnd>
      )}
      {catDialog ? <CategoryDialog workspaceId={workspaceId} onClose={() => setCatDialog(false)} /> : null}
    </aside>
  );
}

/**
 * Context menu on the empty part of the room list (Discord): «Скрыть заглушённые» ☐ · «Создать
 * комнату» · «Создать категорию» · «Пригласить», by permission. Rows, headers and participants
 * have their own menus (Radix stops at the innermost trigger).
 */
function SidebarMenu({ workspaceId, onCreateCategory, children }: { workspaceId: string; onCreateCategory: () => void; children: ReactNode }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const hideMuted = useUi((s) => s.hideMuted);
  const setHideMuted = useUi((s) => s.setHideMuted);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const myRoles = useMemberRoles(workspaceId, me);
  const admin = mayInviteMembers(myRoles);
  const manageRooms = mayArrangeRooms(myRoles);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-56')}>
          <ContextMenu.CheckboxItem className={cx(menuItem, 'relative pl-7')} checked={hideMuted} onCheckedChange={setHideMuted}>
            <ContextMenu.ItemIndicator className="absolute left-2">
              <Check className="size-3.5" aria-hidden />
            </ContextMenu.ItemIndicator>
            {t('shell.hideMuted')}
          </ContextMenu.CheckboxItem>
          {manageRooms ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'room-create', workspaceId, voice: false })}>
                <Plus className="size-4" /> {t('room.create')}
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItem} onSelect={onCreateCategory}>
                <FolderPlus className="size-4" /> {t('shell.categoryCreate')}
              </ContextMenu.Item>
            </>
          ) : null}
          {admin ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'invites' })}>
                <UserPlus className="size-4" /> {t('ws.invite')}
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// ---------------------------------------------------------------- header

export function WorkspaceHeader({ workspaceId, onCreateCategory }: { workspaceId: string; onCreateCategory: () => void }): ReactNode {
  // The role, not the whole entry (it changes on every voice state).
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const myRoles = useMemberRoles(workspaceId, me);
  const mobile = useMobile();
  if (role === undefined) return null;
  const guest = role === WorkspaceRole.GUEST;
  // Invites: INVITE_MEMBERS (ADR-0043, the server's check), a custom role's included.
  const inviter = mayInviteMembers(myRoles);
  const manageRooms = mayArrangeRooms(myRoles);

  const create =
    manageRooms || inviter || !guest ? (
      <CreateMenu
        workspaceId={workspaceId}
        onCreateCategory={onCreateCategory}
        rooms={manageRooms}
        temp={mayCreateTempRooms(myRoles)}
        invite={inviter}
        meeting={!guest}
        tasks={!guest}
      />
    ) : null;

  // Phone (ADR-0073 §1): one row — the workspace switcher (ADR-0074 §2, no rail) and «+». No «Голос · Доски» switch (the boards
  // are a tab) and no calendar one (a tab too). The profile is the last tab.
  if (mobile) {
    return (
      <div className="flex h-12 shrink-0 items-center justify-between gap-1 border-b border-line pl-2 pr-2">
        <WorkspaceSwitcher phone testId="phone-ws-switcher" />
        {create}
      </div>
    );
  }

  // Desktop (ADR-0074 §3): the section is picked on the rail; the header names it, and «+» is the
  // section's create action. Guests have no calendar or boards (the rail hides them).
  return <SectionHeader workspaceId={workspaceId} guest={guest} rooms={create} />;
}

/**
 * The column header on the desktop (ADR-0074 §3; owner 07.10, Codex reference): the section's
 * name large on the left («Команда», «Календарь», «Доски»; the workspace switcher stays in the title
 * bar), then the quiet search and the section's «+»: the rooms' create menu, «Добавить
 * встречу» on the calendar, «Новая доска» on the boards (CREATE_BOARDS).
 * Primitive selectors only: switching the section re-renders the header, not the list.
 */
function SectionHeader({ workspaceId, guest, rooms }: { workspaceId: string; guest: boolean; rooms: ReactNode }): ReactNode {
  const boardsOn = useBoardsUi((s) => s.active) && !guest;
  const calendarOn = useUi((s) => s.calDay !== null) && !guest && !boardsOn;
  const me = useSession((s) => s.me?.user?.id ?? '');
  const boardCreator = mayCreateBoards(useMemberRoles(workspaceId, me));
  const [newCat, setNewCat] = useState(false);
  const add = boardsOn ? (
    boardCreator ? (
      <>
        {/* «Новая категория»: quiet, left of the accent «+» (owner, 07.10). */}
        <IconButton label={t('boards.cat.new')} onClick={() => setNewCat(true)} data-testid="board-category-new">
          <FolderPlus className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </IconButton>
        <CreateButton label={t('boards.newBoard')} data-testid="section-create-board" onClick={() => useBoardsUi.getState().openSettings({ boardId: '', workspaceId })} />
        {newCat ? <NewCategoryDialog workspaceId={workspaceId} onClose={() => setNewCat(false)} /> : null}
      </>
    ) : null
  ) : calendarOn ? (
    <CreateButton label={t('shell.addMeeting')} data-testid="section-create-event" onClick={() => newEvent(workspaceId, nextQuarter())} />
  ) : (
    rooms
  );
  const title = boardsOn ? t('shell.modeBoards') : calendarOn ? t('cal.open') : t('mobile.tabChats');
  return <ColumnHeader title={<ColumnTitle>{title}</ColumnTitle>}>{add}</ColumnHeader>;
}

/**
 * «+» in the column header (owner, 28.09 / 29.09, docs/09 #135) — the header's only action button:
 * «Создать комнату» (the room dialog, text by default — it has the voice switch) and «Создать
 * категорию» (goes on top) with MANAGE_ROOM; after a separator «Временная комната» (CREATE_TEMP_ROOMS,
 * ADR-0044: the create dialog with its link), «Добавить встречу» (members, not
 * guests: the meeting dialog for today, the next quarter hour), «Создать задачу» (docs/09 #140: with
 * CREATE_TASKS on some board of the workspace — one board goes straight to it, several are a
 * submenu; the boards tab opens on that board with the create dialog) and, last, «Пригласить в
 * пространство» (MANAGE_WORKSPACE) — the former separate «Пригласить» icon.
 */
function CreateMenu({
  workspaceId,
  onCreateCategory,
  rooms,
  temp,
  invite,
  meeting,
  tasks,
}: {
  workspaceId: string;
  onCreateCategory: () => void;
  rooms: boolean;
  /** CREATE_TEMP_ROOMS (ADR-0044): «Временная комната». */
  temp: boolean;
  invite: boolean;
  meeting: boolean;
  tasks: boolean;
}): ReactNode {
  const open = useUi((s) => s.openDialog);
  // Boards of this workspace where I may create tasks: ids only (a shallow-compared slice).
  const taskBoards = useBoards(useShallow((s) => (tasks ? workspaceBoards(s.boards, workspaceId).filter((b) => hasBit(b.permissions, CREATE_TASKS)).map((b) => b.id) : NO_BOARDS)));
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <CreateButton label={t('shell.create')} data-testid="sidebar-create" />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-64')} sideOffset={4} align="end" collisionPadding={16}>
          {rooms ? (
            <>
              <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'room-create', workspaceId, voice: false })}>
                <Hash className="size-4" /> {t('room.create')}
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} onSelect={onCreateCategory}>
                <FolderPlus className="size-4" /> {t('shell.categoryCreate')}
              </Dropdown.Item>
            </>
          ) : null}
          {rooms && (temp || meeting || invite || taskBoards.length > 0) ? <Dropdown.Separator className={menuSeparator} /> : null}
          {temp ? (
            <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'temp-room-create', workspaceId })} data-testid="sidebar-new-temp">
              <Timer className="size-4" /> {t('temp.create')}
            </Dropdown.Item>
          ) : null}
          {meeting ? (
            <Dropdown.Item className={menuItem} onSelect={() => newEvent(workspaceId, nextQuarter())} data-testid="sidebar-new-event">
              <CalendarPlus className="size-4" /> {t('shell.addMeeting')}
            </Dropdown.Item>
          ) : null}
          {taskBoards.length === 1 ? (
            <Dropdown.Item className={menuItem} onSelect={() => createTaskOn(workspaceId, taskBoards[0] ?? '')} data-testid="sidebar-new-task">
              <ListPlus className="size-4" /> {t('shell.createTask')}
            </Dropdown.Item>
          ) : taskBoards.length > 1 ? (
            <Dropdown.Sub>
              <Dropdown.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')} data-testid="sidebar-new-task">
                <ListPlus className="size-4" aria-hidden />
                <span className="flex-1">{t('shell.createTask')}</span>
                <ChevronRight className="size-4" aria-hidden />
              </Dropdown.SubTrigger>
              <Dropdown.Portal>
                <Dropdown.SubContent className={cx(menuBox, 'w-56')} sideOffset={4} collisionPadding={16} data-testid="sidebar-task-boards">
                  <Dropdown.Label className={menuLabel}>{t('shell.createTaskOn')}</Dropdown.Label>
                  {taskBoards.map((id) => (
                    <TaskBoardItem key={id} workspaceId={workspaceId} boardId={id} />
                  ))}
                </Dropdown.SubContent>
              </Dropdown.Portal>
            </Dropdown.Sub>
          ) : null}
          {invite ? (
            <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'invites' })} data-testid="sidebar-invite">
              <UserPlus className="size-4" /> {t('shell.inviteToWorkspace')}
            </Dropdown.Item>
          ) : null}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

const NO_BOARDS: readonly string[] = [];

/** A board in «Создать задачу ▸»: its emoji and name. */
function TaskBoardItem({ workspaceId, boardId }: { workspaceId: string; boardId: string }): ReactNode {
  const name = useBoards((s) => s.boards[boardId]?.name ?? '');
  const emoji = useBoards((s) => s.boards[boardId]?.emoji ?? '');
  return (
    <Dropdown.Item className={menuItem} onSelect={() => createTaskOn(workspaceId, boardId)}>
      {emoji ? <span className="grid w-4 place-items-center text-body leading-none">{emoji}</span> : <SquareKanban className="size-4" aria-hidden />}
      <span className="min-w-0 truncate">{name}</span>
    </Dropdown.Item>
  );
}

/** «Создать задачу»: the boards tab on that board, then its create dialog (reused, no new requests). */
function createTaskOn(workspaceId: string, boardId: string): void {
  if (!boardId) return;
  openBoard(workspaceId, boardId);
  useBoardsUi.getState().openCreate({ boardId });
}

/** «Добавить встречу»: today, from the next quarter hour, 30 minutes (the dialog's default length). */
function nextQuarter(): { start: number; end: number } {
  const q = 15 * 60_000;
  const start = Math.ceil((Date.now() + 60_000) / q) * q;
  return { start, end: start + 30 * 60_000 };
}

// ---------------------------------------------------------------- categories

function CategoryGroup({
  category,
  workspaceId,
  canManage,
  canDrag,
  children,
}: {
  /** null = the top level: a plain list, no header. */
  category: RoomCategory | null;
  workspaceId: string;
  canManage: boolean;
  canDrag: boolean;
  children: ReactNode[];
}): ReactNode {
  const collapsed = useUi((s) => (category ? !!s.collapsed[category.id] : false));
  const toggle = useUi((s) => s.toggleCategory);
  const open = useUi((s) => s.openDialog);
  // Collapsed: keep the open room and my voice room visible (Discord behaviour).
  const activeRoom = useUi((s) => s.lastRoom[workspaceId]);
  const voiceRoom = useVoice((s) => s.roomId);
  const [editing, setEditing] = useState(false);
  const { setNodeRef: setDragRef, listeners: dragListeners, isDragging } = useDraggable({
    id: `catdrag:${category?.id ?? 'none'}`,
    data: { type: 'category', categoryId: category?.id ?? '', name: category?.name ?? '' } satisfies DragCategory,
    disabled: !category || !canDrag || editing,
  });
  if (!category) return <div className="mb-1 flex flex-col gap-px">{children}</div>;

  const visible = collapsed
    ? children.filter((c) => {
        const key = (c as { key?: string | null }).key;
        return key === activeRoom || key === voiceRoom;
      })
    : children;

  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('shell.categoryDelete'), t('shell.categoryDeleteConfirm', { name: category.name }), t('common.delete')))) return;
    try {
      await api.categories.remove(category.id);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const order = workspaceCategories(workspaceId);
  const at = order.findIndex((c) => c.id === category.id);
  const step = (dir: -1 | 1): void => void moveCategoryTo(workspaceId, category.id, at + dir);

  const header = (
    <div
      ref={setDragRef}
      {...(canDrag && !editing ? dragListeners : {})}
      data-cat-header={category.id}
      className="group/cat flex h-9 items-center pr-1 pt-2"
    >
      {editing ? (
        <CategoryNameEditor category={category} onDone={() => setEditing(false)} />
      ) : (
        <button
          type="button"
          onClick={() => toggle(category.id)}
          // Rename in place (Discord): the two clicks before it toggled twice — no net change.
          onDoubleClick={canManage ? () => setEditing(true) : undefined}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('shell.categoryExpand', { name: category.name }) : t('shell.categoryCollapse', { name: category.name })}
          className={cx('flex h-7 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-row)] pl-2 text-left transition-colors duration-[var(--motion-fast)] hover:text-fg', GROUP_LABEL)}
          title={category.name}
        >
          <span className="truncate">{category.name}</span>
          <GroupChevron collapsed={collapsed} />
        </button>
      )}
      {canManage && !editing ? (
        <InlineAdd
          label={t('room.create')}
          aria-label={t('shell.roomCreateIn', { name: category.name })}
          onClick={() => open({ kind: 'room-create', workspaceId, voice: false, categoryId: category.id })}
          className="opacity-0 focus-visible:opacity-100 group-hover/cat:opacity-100 mobile:opacity-100"
        />
      ) : null}
    </div>
  );

  return (
    <section className={cx('mb-1', isDragging && 'opacity-40')} aria-label={category.name} data-cat-section={category.id}>
      {canManage ? (
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger asChild>{header}</ContextMenu.Trigger>
          <ContextMenu.Portal>
            {/* No focus return to the header: it would blur (and end) the inline rename right away. */}
            <ContextMenu.Content className={menuBox} onCloseAutoFocus={(e) => e.preventDefault()}>
              <ContextMenu.Item className={menuItem} onSelect={() => setEditing(true)}>
                <Pencil className="size-4" /> {t('shell.categoryRename')}
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'room-create', workspaceId, voice: false, categoryId: category.id })}>
                <Plus className="size-4" /> {t('room.create')}
              </ContextMenu.Item>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={menuItem} disabled={at <= 0} onSelect={() => step(-1)}>
                <ArrowUp className="size-4" /> {t('shell.moveUp')}
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItem} disabled={at < 0 || at >= order.length - 1} onSelect={() => step(1)}>
                <ArrowDown className="size-4" /> {t('shell.moveDown')}
              </ContextMenu.Item>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
                <Trash2 className="size-4" /> {t('common.delete')}
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ) : (
        header
      )}
      {visible.length ? <div className="flex flex-col gap-px">{visible}</div> : null}
    </section>
  );
}

/**
 * Inline category rename (double click / menu): Enter or leaving the field saves, Esc cancels.
 * Optimistic; the old name comes back when the server refuses.
 */
function CategoryNameEditor({ category, onDone }: { category: RoomCategory; onDone: () => void }): ReactNode {
  const [value, setValue] = useState(category.name);
  const finished = useRef(false);
  const save = async (): Promise<void> => {
    if (finished.current) return;
    finished.current = true;
    onDone();
    const name = value.trim();
    if (!name || name === category.name) return;
    const rooms = useRooms.getState();
    rooms.upsertCategory(create(RoomCategorySchema, { ...category, name }));
    try {
      const r = await api.categories.update(category.id, { name });
      if (r.category) useRooms.getState().upsertCategory(r.category);
    } catch (e) {
      useRooms.getState().upsertCategory(category);
      toast.error(errText(e));
    }
  };
  return (
    <input
      autoFocus
      aria-label={t('shell.categoryName')}
      value={value}
      maxLength={100}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finished.current = true;
          onDone();
        }
      }}
      className="h-7 min-w-0 flex-1 rounded-[var(--radius-row)] bg-[var(--color-fill)] px-2 text-[13px] font-medium text-fg outline-none ring-1 ring-accent"
    />
  );
}

/** Create a category (MANAGE_ROOM); renaming is inline in the header. */
export function CategoryDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    const v = name.trim();
    if (!v) return;
    setBusy(true);
    try {
      // New categories go on top (owner, 28.09), optimistically, with one order batch.
      await createCategoryFirst(workspaceId, v);
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('shell.categoryCreate')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t('shell.categoryName')} error={error}>
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- room rows

/**
 * Row shell shared by text and voice rooms (owner, 07.10, Codex reference): 36 px, radius 8, a soft
 * grey plate when selected and a fainter one on hover; unread is the bold name (+ the mention badge),
 * no pills or borders; hover actions.
 */
const rowBox = 'group/row relative flex h-9 items-center rounded-[var(--radius-card)] transition-colors duration-[var(--motion-fast)]';

/**
 * Text room hover actions (invite, settings — no «chat»: the row itself opens it). Same 18 px
 * icons / 2 px gap as the voice rooms' CardActions, so the two lists don't look inconsistent
 * (owner, Discord reference); by permission, no reserved space when one is missing.
 */
function RoomActions({ room, canInvite, canSettings }: { room: Room; canInvite: boolean; canSettings: boolean }): ReactNode {
  const open = useUi((s) => s.openDialog);
  if (!canInvite && !canSettings) return null;
  const btn = 'grid size-6 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg';
  return (
    // Hover / focus only, the selected row too (owner, 07.10): the list stays quiet at rest.
    <span className="hidden shrink-0 items-center gap-0.5 group-has-[:focus-visible]/row:flex group-hover/row:flex">
      {canInvite ? (
        <Tip label={t('shell.invite')}>
          <button
            type="button"
            className={btn}
            aria-label={t('shell.inviteTo', { name: room.name })}
            onClick={() => open({ kind: 'workspace-settings', workspaceId: room.workspaceId, tab: 'invites', roomId: room.id })}
          >
            <UserPlus className="size-[18px]" aria-hidden />
          </button>
        </Tip>
      ) : null}
      {canSettings ? (
        <Tip label={t('room.settings')}>
          <button type="button" className={btn} aria-label={t('shell.roomSettingsOf', { name: room.name })} onClick={() => open({ kind: 'room-settings', roomId: room.id })}>
            <SlidersHorizontal className="size-[18px]" aria-hidden />
          </button>
        </Tip>
      ) : null}
    </span>
  );
}

/**
 * «Позвонить на номер» from the room menu: joins the room's call when needed (the normal join,
 * its errors stay), then asks the room header's dial popover (phone: the members drawer's sheet)
 * to open. The request is deferred a beat so the closing menu's focus return does not dismiss
 * the popover at once.
 */
function dialFromRoomMenu(room: Room): Promise<void> {
  const inCall = (): boolean => {
    const v = useVoice.getState();
    return v.roomId === room.id && (v.phase === 'connected' || v.phase === 'reconnecting');
  };
  return dialFromMenu({
    inCall,
    openRoom: () => useUi.getState().openRoom(room.workspaceId, room.id),
    join: () => voice.join(room.id, room.workspaceId),
    reveal: () => {
      if (isMobileNow()) useUi.getState().setMembersOverlay(true);
    },
    open: () => {
      setTimeout(() => useSipDial.getState().request(room.id), 60);
    },
  });
}

/**
 * The room menu (docs/09 #30): right click / long press on a room row, and the voice room's «…»
 * button (the same menu, opened at the button). Item set: lib/roomMenu.roomMenuGroups.
 */
export function RoomMenu({
  room,
  children,
  canManage,
  canOrder,
  admin,
  inviteRoom,
  guest,
  inside = false,
  prepend,
}: {
  room: Room;
  children: ReactNode;
  /** Opened inside the room (the phone header's «…»): no «Открыть чат». */
  inside?: boolean;
  /** Items before the room menu's own (the phone header's «Поиск в комнате»). */
  prepend?: ReactNode;
  canManage: boolean;
  canOrder: boolean;
  admin: boolean;
  /** INVITE_GUESTS or INVITE_MEMBERS in the room (ADR-0043): the room link dialog. */
  inviteRoom: boolean;
  guest: boolean;
}): ReactNode {
  const open = useUi((s) => s.openDialog);
  const openRoom = useUi((s) => s.openRoom);
  const temp = !!room.expiresAt;
  // «Добавить встречу» only while the temporary room has no meeting (ADR-0044); a primitive, and
  // permanent rooms answer false at once.
  const hasEvent = useCalendar((s) => temp && (!!s.active[room.id]?.length || Object.values(s.occ).some((e) => e.roomId === room.id)));
  const last = useRooms((s) => s.lastMessage[room.id]);
  const unread = useRooms((s) => isUnread(room.id, s));
  const mobile = useMobile();
  const voiceRoom = isVoice(room);
  const recording = useRecordings((s) => !!s.byRoom[room.id]);
  // «Позвонить на номер» (ADR-0046): the header button's gate minus «I am in the call».
  const dial = useCanDial(room.workspaceId, room.id, true) && voiceRoom;
  // Business only (ADR-0046, owner 02.10): a downgraded workspace sees the item locked.
  const dialOnPlan = useTelephonyOnPlan(room.workspaceId);
  // Categories are read when the menu renders (it mounts on open), like RoomOrderItems.
  const groups = roomMenuGroups({
    voice: voiceRoom,
    mobile: mobile && !inside,
    guest,
    admin,
    inviteRoom,
    dial,
    canManage,
    canOrder,
    hasCategories: canOrder && workspaceCategories(room.workspaceId).length > 0,
    temp,
    hasEvent,
  });
  const item = (id: RoomMenuItem): ReactNode => {
    switch (id) {
      case 'openChat':
        // A voice room's chat without joining (docs/09 #14): the phone has no hover actions.
        return (
          <ContextMenu.Item key={id} className={menuItem} onSelect={() => openRoom(room.workspaceId, room.id)}>
            <MessageCircle className="size-4" /> {t('voicePreview.openChat')}
          </ContextMenu.Item>
        );
      case 'invite':
        // Voice + a room invite right (ADR-0043): the room link (like the invite row); otherwise the workspace invite.
        return (
          <ContextMenu.Item
            key={id}
            className={menuItem}
            onSelect={() => (voiceRoom && inviteRoom ? open({ kind: 'room-invite', roomId: room.id }) : open({ kind: 'workspace-settings', workspaceId: room.workspaceId, tab: 'invites', roomId: room.id }))}
          >
            <UserPlus className="size-4" /> {t('shell.invite')}
          </ContextMenu.Item>
        );
      case 'record':
        // Meeting recording (ADR-0025): start, or stop the running one (any participant but a
        // guest); a room that forbids it keeps the item, disabled, so the option is discoverable.
        if (recording)
          return (
            <ContextMenu.Item key={id} className={menuItem} data-testid="room-menu-record" onSelect={() => void stopRecording(room.id)}>
              <CircleStop className="size-4 text-danger-text" /> {t('roomMenu.recordStop')}
            </ContextMenu.Item>
          );
        return (
          <ContextMenu.Item
            key={id}
            className={menuItem}
            disabled={!room.allowRecording}
            data-testid="room-menu-record"
            onSelect={() => void startRecording(room.id, room.workspaceId)}
          >
            <CircleDot className="size-4" /> <span className="flex-1">{t('roomMenu.record')}</span>
            {room.allowRecording ? null : <span className="text-micro text-muted">{t('roomMenu.recordOff')}</span>}
          </ContextMenu.Item>
        );
      case 'dial':
        if (!dialOnPlan) {
          const locked = t('plan.lockedFrom', { plan: t('plan.name.enterprise') });
          return (
            <ContextMenu.Item key={id} className={cx(menuItem, 'text-muted')} data-testid="room-menu-dial-locked" title={locked} onSelect={() => planToast(locked)}>
              <Phone className="size-4" /> <span className="flex-1">{t('sip.dial')}</span>
              <Lock className="size-3.5" aria-label={locked} />
            </ContextMenu.Item>
          );
        }
        // In this room's call: the dial popover; otherwise join first, then the popover (lib/dialFromMenu).
        return (
          <ContextMenu.Item key={id} className={menuItem} data-testid="room-menu-dial" onSelect={() => void dialFromRoomMenu(room)}>
            <Phone className="size-4" /> {t('sip.dial')}
          </ContextMenu.Item>
        );
      case 'settings':
        return (
          <ContextMenu.Item key={id} className={menuItem} onSelect={() => open({ kind: 'room-settings', roomId: room.id })}>
            <SlidersHorizontal className="size-4" /> {t('roomMenu.settings')}
          </ContextMenu.Item>
        );
      case 'markRead':
        return (
          <ContextMenu.Item
            key={id}
            className={menuItem}
            disabled={!last || !unread}
            onSelect={() => {
              if (last) {
                useRooms.getState().setRead(room.id, last);
                void api.messages.markRead(room.id, last).catch(() => undefined);
              }
            }}
          >
            <CheckCheck className="size-4" /> {t('room.markRead')}
          </ContextMenu.Item>
        );
      case 'notify':
        return <RoomNotifySub key={id} room={room} />;
      case 'copyLink':
        return (
          <ContextMenu.Item key={id} className={menuItem} data-testid="room-menu-copy-link" onSelect={() => void copyTempRoomLink(room)}>
            <Link2 className="size-4" /> {t('temp.copyLink')}
          </ContextMenu.Item>
        );
      case 'extend':
        return <TempExtendSub key={id} room={room} />;
      case 'addMeeting':
        return (
          <ContextMenu.Item key={id} className={menuItem} onSelect={() => addTempRoomMeeting(room)}>
            <CalendarPlus className="size-4" /> {t('temp.addMeeting')}
          </ContextMenu.Item>
        );
      case 'deleteRoom':
        return (
          <ContextMenu.Item key={id} className={cx(menuItem, 'text-danger-text')} data-testid="room-menu-delete" onSelect={() => void deleteTempRoom(room)}>
            <Trash2 className="size-4" /> {t('common.delete')}
          </ContextMenu.Item>
        );
      case 'moveUp':
      case 'moveDown':
      case 'toCategory':
        return null;
    }
  };
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-60')} collisionPadding={16} aria-label={t('roomMenu.moreOf', { name: room.name })}>
          {prepend ? (
            <>
              {prepend}
              <ContextMenu.Separator className={menuSeparator} />
            </>
          ) : null}
          {groups.map((g, i) => (
            <Fragment key={g.join()}>
              {i > 0 ? <ContextMenu.Separator className={menuSeparator} /> : null}
              {g.includes('moveUp') ? <RoomOrderItems room={room} /> : g.map(item)}
            </Fragment>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** «Уведомления ›» of the room menu: the same choices as the room header's bell (docs/09 #22). */
function RoomNotifySub({ room }: { room: Room }): ReactNode {
  const stored = useRooms((s) => s.notify[room.id]);
  const wsStored = useRooms((s) => s.wsNotify[room.workspaceId]);
  const n = roomNotify(stored);
  const ws = workspaceNotify(wsStored);
  const quiet = n.mutedUntil !== null || n.level === NotificationLevel.NONE;
  const options: LevelOption[] = [
    { level: NotificationLevel.INHERIT, label: t('chat.notifyInherit', { level: t(LEVEL_LABEL[ws.level] ?? 'chat.notifyMentions') }) },
    { level: NotificationLevel.ALL, label: t('chat.notifyAll') },
    { level: NotificationLevel.MENTIONS, label: t('chat.notifyMentions') },
    { level: NotificationLevel.NONE, label: t('chat.notifyNone') },
  ];
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
        {quiet ? <BellOff className="size-4" aria-hidden /> : <Bell className="size-4" aria-hidden />}
        <span className="flex-1">{t('chat.notify')}</span>
        <ChevronRight className="size-4" aria-hidden />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={cx(menuBox, 'w-60')} sideOffset={4} collisionPadding={16}>
          <NotifyMenuItems
            kit="context"
            title={t('chat.notify')}
            options={options}
            value={n.level}
            mutedUntil={n.mutedUntil}
            defaultLevel={NotificationLevel.INHERIT}
            onChange={(level, until) => void setRoomNotifications(room.id, level, until)}
          />
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

/** «Продлить ›» of a temporary room (ADR-0044): +1 ч / +1 день from its end (≤ 7 days from now), or a date. */
function TempExtendSub({ room }: { room: Room }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const by = (ms: number): void => void extendTempRoom(room.id, extendTo(expiresMs(room), ms, Date.now()));
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')} data-testid="room-menu-extend">
        <Timer className="size-4" aria-hidden />
        <span className="flex-1">{t('temp.extend')}</span>
        <ChevronRight className="size-4" aria-hidden />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={cx(menuBox, 'w-48')} sideOffset={4} collisionPadding={16}>
          <ContextMenu.Item className={menuItem} onSelect={() => by(3_600_000)}>
            {t('temp.extend1h')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => by(24 * 3_600_000)}>
            {t('temp.extend1d')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'temp-room-extend', roomId: room.id })}>
            {t('temp.extendDate')}
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

/**
 * Keyboard path of drag & drop (docs/09 P1 #19): «Переместить вверх/вниз» (across a category
 * edge too) and «В категорию ›» (to the end of it; «Без категории» = the top level).
 */
function RoomOrderItems({ room }: { room: Room }): ReactNode {
  const ws = room.workspaceId;
  const layout = workspaceLayout(ws);
  const cats = workspaceCategories(ws);
  const current = layout.find((c) => c.rooms.includes(room.id))?.categoryId ?? null;
  const up = stepTarget(layout, room.id, -1);
  const down = stepTarget(layout, room.id, 1);
  const go = (to: RoomTarget | null): void => {
    if (to) void moveRoomTo(ws, room.id, to);
  };
  const toEnd = (categoryId: string | null): void =>
    go({ categoryId, index: layout.find((c) => c.categoryId === categoryId)?.rooms.filter((id) => id !== room.id).length ?? 0 });
  return (
    <>
      <ContextMenu.Item className={menuItem} disabled={!up} onSelect={() => go(up)}>
        <ArrowUp className="size-4" /> {t('shell.moveUp')}
      </ContextMenu.Item>
      <ContextMenu.Item className={menuItem} disabled={!down} onSelect={() => go(down)}>
        <ArrowDown className="size-4" /> {t('shell.moveDown')}
      </ContextMenu.Item>
      {cats.length ? (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={cx(menuItem, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
            <FolderInput className="size-4" aria-hidden />
            <span className="flex-1">{t('shell.moveToCategory')}</span>
            <ChevronRight className="size-4" aria-hidden />
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className={cx(menuBox, 'w-52')} sideOffset={4} collisionPadding={16}>
              {[{ id: null, name: t('shell.noCategory') }, ...cats].map((c) => (
                <ContextMenu.Item key={c.id ?? 'none'} className={menuItem} disabled={c.id === current} onSelect={() => toEnd(c.id)}>
                  <span className="grid w-4 place-items-center">{c.id === current ? <Check className="size-4" aria-hidden /> : null}</span>
                  <span className="truncate">{c.name}</span>
                </ContextMenu.Item>
              ))}
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      ) : null}
    </>
  );
}

/**
 * A room row as a target of a dragged message (docs/05 «Заметки»): forwarded into the room
 * (ADR-0033) when I may send there. Native drag events — not dnd-kit's pointer drags of this list.
 */
function useMessageDrop(room: Room, canSend: boolean): ReturnType<typeof useChatDrop> {
  const target = useMemo<DropTarget | null>(() => (canSend ? { kind: 'room', roomId: room.id, files: false, canSend } : null), [room.id, canSend]);
  const onDrop = useCallback((a: DropAction, files: File[]) => applyChatDrop(a, files, roomLabel(room), false), [room]);
  return useChatDrop(target, onDrop);
}

/** A room row as a drag source (MANAGE_ROOM, desktop layout); the drop place is measured by `data-room-slot`. */
function useRoomDrag(room: Room, enabled: boolean): ReturnType<typeof useDraggable> {
  return useDraggable({
    id: `roomdrag:${room.id}`,
    data: { type: 'room', roomId: room.id, name: room.name, voice: isVoice(room), isPrivate: room.isPrivate } satisfies DragRoom,
    disabled: !enabled,
  });
}

/**
 * Actions on a voice room row, active or not (docs/09 #30, Discord reference): exactly two —
 * «чат» and «…» (the room menu: invite · recording · settings · the context-menu items); 18 px
 * icons, 10 px apart, 10 px from the row's right edge (the card's own px-2.5, or pr-2.5 on the
 * plain row), shown on hover / keyboard focus and while the menu is open (the call timer stands
 * there otherwise).
 */
function CardActions({ room }: { room: Room }): ReactNode {
  const btn =
    'grid size-6 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg';
  // «…» opens the row's own context menu (RoomMenu) under the button: one menu for the click, the
  // right click and the phone's long press — never two item lists drifting apart.
  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom + 4 }));
  };
  return (
    <span className="hidden shrink-0 items-center gap-0.5 group-has-[:focus-visible]/row:flex group-hover/row:flex group-data-[state=open]/row:flex">
      <Tip label={t('roomMenu.more')}>
        <button type="button" className={btn} aria-label={t('roomMenu.moreOf', { name: room.name })} aria-haspopup="menu" data-testid="room-more" onClick={openMenu}>
          <Ellipsis className="size-[18px]" aria-hidden />
        </button>
      </Tip>
    </span>
  );
}

/**
 * «Войти» (owner, 02.10): the voice room row's way into the call (the row itself opens the chat).
 * Shown on hover / focus-within (always on touch, never in a full room without MOVE_MEMBERS); when hidden its
 * wrapper is `sr-only`, so Tab still reaches it (and focus reveals it). The wrapper, not the button, toggles
 * `sr-only`/`not-sr-only`: `not-sr-only` resets padding and height, which stripped the button's own `px-2 h-5`.
 */
const JoinButton = memo(function JoinButton({ name, onJoin, always }: { name: string; onJoin: () => void; always: boolean }): ReactNode {
  useLocale();
  const mobile = useMobile();
  const label = t('shell.joinVoiceOf', { name });
  // Phone (owner, 05.10): a quiet round speaker button, not the accent pill — many rooms, many pills shout.
  // 32 px circle, hit area 44 px through the pseudo-element.
  if (mobile) {
    return (
      <IconButton
        label={label}
        title={t('shell.joinVoiceShort')}
        tip={false}
        data-testid="room-join"
        onClick={onJoin}
        className="relative size-8 rounded-full bg-hover before:absolute before:-inset-1.5 before:content-['']"
      >
        <Volume2 className="size-4" aria-hidden />
      </IconButton>
    );
  }
  return (
    <span className={cx('inline-flex shrink-0', !always && 'sr-only group-has-[:focus-visible]/row:not-sr-only group-hover/row:not-sr-only')}>
      <Button size="sm" aria-label={label} data-testid="room-join" onClick={onJoin} className="h-5 px-2 text-micro mobile:h-6">
        {t('shell.joinVoiceShort')}
      </Button>
    </span>
  );
});

export function MentionBadge({ n }: { n: number }): ReactNode {
  if (n <= 0) return null;
  return (
    <CountBadge count={n} className="group-hover/row:hidden" aria-label={plural('shell.unreadMentions', n)} />
  );
}

/** A row under a dragged message it would be forwarded to (the accent tint, as the shelves). */
const MSG_DROP = 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] shadow-[inset_0_0_0_1px_var(--color-accent)]';

interface RowOrder {
  /** Container the row is shown in ('' = top level), for the drop measurement. */
  container: string;
  /** Workspace-level MANAGE_ROOM: the reorder items in the room menu. */
  canOrder: boolean;
  /** …and pointer dragging (not on the phone layout). */
  canDrag: boolean;
}

/**
 * Memoised: the list re-renders on every voice state (the voice rooms' participants), which
 * text rooms do not show (docs/14 «Ререндеры в звонке»); a language switch still reaches it.
 */
const TextRoomRow = memo(function TextRoomRow({
  room,
  workspaceId,
  me,
  role,
  admin,
  container,
  canOrder,
  canDrag,
}: { room: Room; workspaceId: string; me: string; role: readonly Role[]; admin: boolean } & RowOrder): ReactNode {
  useLocale();
  const active = useUi((s) => s.lastRoom[workspaceId] === room.id && s.activeWorkspaceId === workspaceId);
  const openRoom = useUi((s) => s.openRoom);
  const unread = useRooms((s) => showsUnread(room.id, s));
  const mentions = useRooms((s) => s.mentions[room.id] ?? 0);
  const perms = roomPerms(role, me, room);
  const bright = active || unread;
  const { setNodeRef, listeners, isDragging } = useRoomDrag(room, canDrag);
  const [msgOver, msgDrop] = useMessageDrop(room, can(perms, 'SEND_MESSAGES'));
  return (
    <div ref={setNodeRef} {...(canDrag ? listeners : {})} {...msgDrop} data-room-slot={room.id} data-slot-category={container} className={cx(isDragging && 'opacity-40')}>
      <RoomMenu room={room} canManage={can(perms, 'MANAGE_ROOM')} canOrder={canOrder} admin={admin} inviteRoom={mayRoomInvite(perms)} guest={role.some((r) => r.builtin === WorkspaceRole.GUEST)}>
        <div className={cx(rowBox, msgOver ? MSG_DROP : active ? ROW_SELECTED : ROW_HOVER)} data-over={msgOver || undefined}>
          <button
            type="button"
            onClick={() => openRoom(workspaceId, room.id)}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] pl-2 pr-1 text-left text-list leading-5',
              bright ? 'text-fg' : 'text-muted group-hover/row:text-fg',
              unread && !active && 'font-semibold',
            )}
          >
            {/* A quiet «#» (owner, 07.10): same size, weight and colour as the voice rooms' speaker; a
                private room shows the lock in that slot. */}
            <span className="grid w-[18px] shrink-0 place-items-center">
              {room.isPrivate ? (
                <Lock className="size-4 text-faint" strokeWidth={1.75} aria-label={t('room.private')} role="img" />
              ) : (
                <Hash className="size-4 text-faint" strokeWidth={1.75} aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate" title={room.name}>
              {room.name}
            </span>
            {room.restricted ? <RestrictedMark /> : null}
          </button>
          <span className="flex shrink-0 items-center gap-1 pr-2.5">
            <KnockBadge roomId={room.id} />
            <MentionBadge n={mentions} />
            <RoomActions room={room} canInvite={admin} canSettings={can(perms, 'MANAGE_ROOM')} />
          </span>
        </div>
      </RoomMenu>
    </div>
  );
});

function VoiceRoomRow({
  room,
  workspaceId,
  me,
  role,
  admin,
  voiceStates,
  container,
  canOrder,
  canDrag,
}: {
  room: Room;
  workspaceId: string;
  me: string;
  role: readonly Role[];
  admin: boolean;
  voiceStates: Record<string, VoiceState>;
} & RowOrder): ReactNode {
  const active = useUi((s) => s.lastRoom[workspaceId] === room.id && s.activeWorkspaceId === workspaceId);
  const openRoom = useUi((s) => s.openRoom);
  const mobile = useMobile();
  const inRoom = useVoice((s) => s.roomId === room.id);
  const connecting = useVoice((s) => s.roomId === room.id && s.phase === 'connecting');
  const unread = useRooms((s) => showsUnread(room.id, s));
  const mentions = useRooms((s) => s.mentions[room.id] ?? 0);
  const perms = roomPerms(role, me, room);
  const people = useMemo(
    () =>
      Object.values(voiceStates)
        .filter((v) => v.roomId === room.id)
        .sort((a, b) => Number(a.joinedAt?.seconds ?? 0n) - Number(b.joinedAt?.seconds ?? 0n) || a.userId.localeCompare(b.userId)),
    [voiceStates, room.id],
  );
  const canConnect = can(perms, 'CONNECT');
  // The room's phone line (ADR-0046): one more row under the people, drawn from the SipCall.
  const sipLine = useSipCalls((s) => !!s.byRoom[room.id]);
  const canMove = mayMoveMembersIn(role, me, room);
  // A temporary room (ADR-0044): its creator manages it too; it sits in «Временные», not in the
  // reorder layout (no drop slot).
  const expires = expiresMs(room);
  const temp = expires > 0;
  const canManage = mayManageRoomWith(perms, role, me, room);
  const statusLine = useStatusLine(room.id, inRoom, canConnect, canManage);
  const card = statusLine.shown;
  const limit = room.userLimit;
  // Unlike the click guard (joinOutcome: never blocks re-entering my own room), the invite row (docs/09 #10) hides whenever the room is actually at its limit, me included.
  const atCapacity = limit > 0 && people.length >= limit;
  const { setNodeRef, isOver, active: dragging } = useDroppable({ id: `room:${room.id}`, data: { roomId: room.id, canMove } satisfies DropRoom });
  const dragData = dragging?.data.current as DragData | undefined;
  // Only a participant drag highlights a room (a dragged room shows the accent line instead).
  const dropOk = isOver && canMove && dragData?.type === 'member' && dragData.fromRoomId !== room.id;
  const { setNodeRef: setDragRef, listeners: dragListeners, isDragging } = useRoomDrag(room, canDrag);
  const [msgOver, msgDrop] = useMessageDrop(room, can(perms, 'SEND_MESSAGES'));
  const refs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      setDragRef(node);
    },
    [setNodeRef, setDragRef],
  );

  // The row opens the room's chat and never joins (owner, 02.10); «Войти» is the one way into the voice.
  const click = (): void => openRoom(workspaceId, room.id);
  const join = (): void => {
    const next = joinOutcome({ inRoom, canConnect, canMove, people: people.length, limit });
    if (next === 'full') toast.info(t('shell.roomFull'));
    else if (next === 'join') {
      void voice.join(room.id, workspaceId);
      // Nothing open in this workspace yet: show the room's chat next to the call.
      if (!useUi.getState().lastRoom[workspaceId]) openRoom(workspaceId, room.id);
    }
  };
  const joinUi = joinButton({ inRoom, canConnect, canMove, people: people.length, limit, touch: mobile });

  return (
    <div
      ref={refs}
      data-room-slot={temp ? undefined : room.id}
      data-slot-category={temp ? undefined : container}
      {...msgDrop}
      className={cx(
        'rounded-[var(--radius-card)] transition-colors duration-[var(--motion-fast)]',
        (dropOk || msgOver) && 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] outline outline-1 outline-accent',
        isDragging && 'opacity-40',
      )}
    >
      {/* The drag handle is the room line / card only: participants below drag themselves. Without
          the right to reorder, the row is a native drag of the room (onto a meeting's room field). */}
      <div
        {...(canDrag
          ? dragListeners
          : {
              draggable: true,
              onDragStart: (e: ReactDragEvent) => {
                e.dataTransfer.setData(DRAG_ROOM, room.id);
                e.dataTransfer.effectAllowed = 'copy';
              },
            })}
      >
        <RoomMenu room={room} canManage={canManage} canOrder={canOrder} admin={admin} inviteRoom={mayRoomInvite(perms)} guest={role.some((r) => r.builtin === WorkspaceRole.GUEST)}>
          {/* With a status line the room is one raised two-line card (Discord): name + status. */}
          <div
            className={cx(
              // pl-2 = the plain row's: the name starts at 32 px in both, where the participants' avatars start.
              card ? 'group/row relative flex flex-col gap-0.5 rounded-[var(--radius-card)] py-2 pl-2 pr-2.5' : rowBox,
              card ? (active ? ROW_SELECTED : 'bg-row-hover') : active ? ROW_SELECTED : ROW_HOVER,
            )}
            data-testid={card ? 'voice-room-card' : undefined}
          >
            <div className={card ? 'flex h-5 min-w-0 items-center' : 'contents'}>
              <button
                type="button"
                onClick={click}
                // Desktop pointer only (the phone has the round speaker button): the same path as «Войти».
                onDoubleClick={joinUi.shown && !mobile ? join : undefined}
                aria-current={active ? 'page' : undefined}
                title={canConnect ? undefined : t('voice.noConnect')}
                className={cx(
                  'flex h-full select-none min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] pr-1 text-left text-list leading-5',
                  card ? 'pl-0' : 'pl-2',
                  active || unread || inRoom ? 'text-fg' : 'text-muted group-hover/row:text-fg',
                  unread && !active && 'font-semibold',
                )}
              >
                <span className="relative grid w-[18px] shrink-0 place-items-center">
                  {connecting ? (
                    <Loader2 className="size-4 animate-spin text-muted" aria-label={t('voice.connecting')} role="img" />
                  ) : temp ? (
                    <TempIcon expires={expires} inRoom={inRoom} />
                  ) : (
                    <Volume2 className={cx('size-4', inRoom ? 'text-ok' : 'text-faint')} strokeWidth={1.75} aria-hidden />
                  )}
                  {/* Private (Discord): a small lock badge on the speaker icon, not a separate icon
                      competing with the card actions for space on the right. */}
                  {!connecting && room.isPrivate ? (
                    <span role="img" aria-label={t('room.private')} className="absolute -bottom-0.5 -right-0.5 grid size-2.5 place-items-center rounded-full bg-[var(--color-fill-hover)]">
                      <Lock className="size-1.5 text-fg" aria-hidden />
                    </span>
                  ) : null}
                </span>
                <span className={cx('min-w-0 truncate', !temp && !room.restricted && 'flex-1')} title={room.name}>
                  {room.name}
                </span>
                {room.restricted ? <RestrictedMark className={temp ? undefined : 'mr-auto'} /> : null}
                {temp ? <TempLeft expires={expires} /> : null}
              </button>
              <span className={cx('flex shrink-0 items-center gap-1', !card && 'pr-2.5')}>
                <KnockBadge roomId={room.id} />
                <MentionBadge n={mentions} />
                {/* Hover / focus swaps the timer and N/M for the actions (Discord; «чат» is always there,
                    docs/09 #14), so the name keeps ≥ 120 px. On the card the timer stays green on the name line. */}
                <span className={cx('flex items-center gap-2', 'group-has-[:focus-visible]/row:hidden group-hover/row:hidden group-data-[state=open]/row:hidden')}>
                  {/* REC (docs/09 #30): on a plain row just the dot before the call timer (the name keeps
                      its width); the card shows «● REC 12:34» on its status line, right under the timer. */}
                  {card ? null : <RoomRecBadge roomId={room.id} compact />}
                  {people.length ? (
                    <CallTimer roomId={room.id} className={card ? cx('text-[13px]', inRoom ? 'text-[var(--color-green-text)]' : 'text-fg') : 'text-micro text-muted'} />
                  ) : null}
                  {limit > 0 || people.length > 0 ? <PeoplePill n={people.length} max={limit} quiet /> : null}
                </span>
                {/* The «…» action whether the room is active (card) or not, on hover
                    (owner, Discord reference): no separate action set for either. */}
                {joinUi.shown ? <JoinButton name={room.name} onJoin={join} always={joinUi.always} /> : null}
                <CardActions room={room} />
              </span>
            </div>
            {card ? (
              <div className="flex min-w-0 items-center gap-2">
                <VoiceStatusLine roomId={room.id} canEdit={statusLine.canEdit} status={statusLine.status} />
                <RoomRecBadge roomId={room.id} className="text-[13px]" />
              </div>
            ) : null}
          </div>
        </RoomMenu>
      </div>
      {/* A meeting here within 15 minutes / now (ADR-0038 §6): «Планёрка в 15:00» → its card. */}
      <RoomEventBadge roomId={room.id} variant="row" />
      {people.length > 0 || sipLine ? (
        <ul className="flex flex-col gap-px pb-1" aria-label={room.name}>
          {people.map((v) => (
            <VoiceMember
              key={v.userId}
              state={v}
              room={room}
              workspaceId={workspaceId}
              isMe={v.userId === me}
              canMove={canMove}
            />
          ))}
          {sipLine ? <SipCallRow workspaceId={workspaceId} roomId={room.id} /> : null}
        </ul>
      ) : null}
      {inRoom && mayRoomInvite(perms) ? <VoiceInviteRow roomId={room.id} full={atCapacity} /> : null}
    </div>
  );
}

/** Re-render cadence of the temporary rooms' countdown (ADR-0044): one shared 30 s ticker. */
const TEMP_TICK = 30_000;

/**
 * The temporary room's icon (ADR-0044): `Timer` instead of the speaker — green while I am in it,
 * the attention colour under 10 minutes. A leaf with its own 30 s clock: the row does not tick.
 */
const TempIcon = memo(function TempIcon({ expires, inRoom }: { expires: number; inRoom: boolean }): ReactNode {
  const now = useNow(TEMP_TICK);
  const soon = isExpiring(expires - now);
  return (
    <Timer
      className={cx('size-[18px]', soon ? 'text-attention' : inRoom ? 'text-ok' : 'text-muted')}
      aria-label={t('temp.icon')}
      role="img"
      data-testid="temp-icon"
      data-expiring={soon || undefined}
    />
  );
});

/** «1 ч 20 м» after a temporary room's name: secondary, tabular; the attention colour under 10 minutes. */
const TempLeft = memo(function TempLeft({ expires }: { expires: number }): ReactNode {
  useLocale();
  const now = useNow(TEMP_TICK);
  const left = expires - now;
  const text = formatRemaining(left, remainingUnits);
  return (
    <span
      className={cx('shrink-0 text-micro font-medium tabular-nums', isExpiring(left) ? 'text-attention' : 'text-muted')}
      aria-label={t('temp.left', { left: text })}
      data-testid="temp-left"
    >
      {text}
    </span>
  );
});

const remainingUnits = {
  d: (n: number) => t('temp.unit.d', { n }),
  h: (n: number) => t('temp.unit.h', { n }),
  m: (n: number) => t('temp.unit.m', { n }),
};

/**
 * «Временные» (ADR-0044): a virtual group under the categories — not a DB category, not dragged,
 * hidden when empty. Collapsible like a category (the open room and my voice room stay visible).
 */
function TempGroup({ workspaceId, children }: { workspaceId: string; children: ReactNode[] }): ReactNode {
  const key = `temp:${workspaceId}`;
  const collapsed = useUi((s) => !!s.collapsed[key]);
  const toggle = useUi((s) => s.toggleCategory);
  const activeRoom = useUi((s) => s.lastRoom[workspaceId]);
  const voiceRoom = useVoice((s) => s.roomId);
  const title = t('temp.group');
  const visible = collapsed
    ? children.filter((c) => {
        const k = (c as { key?: string | null }).key;
        return k === activeRoom || k === voiceRoom;
      })
    : children;
  return (
    <section className="mb-1" aria-label={title} data-testid="temp-group">
      <div className="group/cat flex h-9 items-center pr-1 pt-2">
        <button
          type="button"
          onClick={() => toggle(key)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('shell.categoryExpand', { name: title }) : t('shell.categoryCollapse', { name: title })}
          className={cx('flex h-7 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-row)] pl-2 text-left transition-colors duration-[var(--motion-fast)] hover:text-fg', GROUP_LABEL)}
        >
          <span className="truncate">{title}</span>
          <GroupChevron collapsed={collapsed} />
        </button>
      </div>
      {visible.length ? <div className="flex flex-col gap-px">{visible}</div> : null}
    </section>
  );
}

/**
 * People in a voice room. Without a limit: one muted pill with the people icon — «2» (shown only
 * while someone is inside). With a limit (docs/09 #9, Discord reference): a two-segment pill —
 * «00 ⁄ 99», current on the left and the limit on the right, both zero-padded to two digits, a
 * ~15° slanted divider (the right segment one step darker/lighter than the pill fill), red left
 * segment when full. The call timer stands apart from it (review: «02 | 04» read as noise).
 */
export function PeoplePill({ n, max, quiet = false }: { n: number; max: number; quiet?: boolean }): ReactNode {
  if (max <= 0) {
    return (
      <span
        // Primary text on the fill: muted grey fell under 4.5:1 on the selected card (axe). `quiet`
        // (the desktop list, owner 07.10): no fill, secondary text — ≥ 4.5:1 on the row plates.
        className={cx(
          'flex items-center gap-0.5 rounded-full py-px pl-1 pr-1.5 text-micro font-medium tabular-nums leading-4',
          quiet ? 'text-muted' : 'bg-[var(--color-fill)] text-fg',
        )}
        aria-label={t('shell.peopleIn', { n })}
        role="img"
        data-testid="room-limit"
      >
        <Users className="size-3" aria-hidden />
        {n}
      </span>
    );
  }
  const full = n >= max;
  return (
    <span
      // Compact, like Discord's own (owner comparison): 18 px tall, 11 px tabular-nums, 6 px
      // segment padding — «02 ⁄ 04» lands ~46–50 px wide at 1x.
      className={cx('flex h-[18px] items-center overflow-hidden rounded-full text-micro font-medium tabular-nums', quiet ? 'bg-row-hover' : 'bg-[var(--color-fill)]')}
      aria-label={t('shell.userLimit', { n, max })}
      role="img"
      data-testid="room-limit"
    >
      {/* bg-danger-fill + text-white (the same solid pairing as the mention badge below), not
          text-danger-text on the ambient fill: that read 3.64 on axe (< 4.5) — the accent-on-tint
          color only works on the plain window background it was tuned for. */}
      <span className={cx('flex h-full items-center px-1.5', full ? 'bg-danger-fill text-white' : quiet ? 'text-muted' : 'text-fg')}>{pad2(n)}</span>
      {/* clip-path skews the segment's left edge ~15° (6 px over the 18 px pill height), rather
          than a separate divider element, so the angled boundary always matches the pill height.
          text-fg, not text-muted: muted grey on --color-fill-hover fails 4.5:1 (axe), same reason
          the no-limit pill above uses text-fg on the plainer --color-fill. */}
      <span
        className={cx('flex h-full items-center px-1.5', quiet ? 'bg-[var(--color-fill)] text-muted' : 'bg-[var(--color-fill-hover)] text-fg')}
        style={{ clipPath: 'polygon(6px 0, 100% 0, 100% 100%, 0 100%)' }}
      >
        {pad2(max)}
      </span>
    </span>
  );
}

export function CallTimer({ roomId, className }: { roomId: string; className?: string }): ReactNode {
  // Room.voice_started_at from the server (READY snapshot + ROOM_UPDATE); unset = no call.
  const startedAt = useRooms((s) => s.byId[roomId]?.voiceStartedAt);
  const now = useNow();
  if (!startedAt) return null;
  const text = formatDuration(Math.max(0, now - timestampMs(startedAt)));
  return (
    // One 20 px line box, centred like the name and the 18 px people pill next to it (no baseline drift).
    <span className={cx('inline-flex h-5 items-center tabular-nums leading-none', className ?? 'text-micro text-fg')} aria-label={t('shell.callTime', { time: text })}>
      {text}
    </span>
  );
}

// ---------------------------------------------------------------- voice participants

function VoiceMember({
  state,
  room,
  workspaceId,
  isMe,
  canMove,
}: {
  state: VoiceState;
  room: Room;
  workspaceId: string;
  isMe: boolean;
  canMove: boolean;
}): ReactNode {
  const speaking = useVoice((s) => s.speaking[state.userId] ?? false);
  const inSameRoom = useVoice((s) => s.roomId === room.id);
  // Only our own moderator mute is known (VoiceState has no server-mute flag yet).
  const serverMuted = useVoice((s) => s.serverMuted);
  const stream = useVoice((s) => s.streams.find((x) => x.userId === state.userId));
  const user = useWorkspaces((s) => s.users[state.userId]);
  const name = useWorkspaces(() => memberName(workspaceId, state.userId));
  const role = useWorkspaces((s) => s.byId[workspaceId]?.members[state.userId]?.role);
  // MOVE_MEMBERS in the room, and the server's move hierarchy (rtc.mayMove): an admin drags
  // anyone, admins and the owner included; others only members below admins.
  const myRole = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const draggable = canMove && mayMoveVoice(myRole, role, isMe);
  // Their local time «16:50» as a tag when their time zone differs from mine (User.timezone).
  const tz = useLocalTimeTag(state.userId);
  // Pending (optimistic join, docs/05) for more than 3 s: the «connecting» ring.
  const connectingRing = useConnectingRing(workspaceId, state.userId, state.pending);
  const talking = speaking && !state.muted && !connectingRing;
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `member:${room.id}:${state.userId}`,
    data: { type: 'member', userId: state.userId, fromRoomId: room.id, name } satisfies DragMember,
    disabled: !draggable,
  });

  const row = (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // Pointer drag only (the context menu «Переместить в…» is the keyboard path): keep list
      // semantics instead of dnd-kit's role="button"; focusable for the context menu key.
      role="listitem"
      aria-roledescription={undefined}
      tabIndex={0}
      aria-label={draggable ? `${name}. ${t('shell.dragHint')}` : name}
      onClick={() => {
        if (stream && inSameRoom) voice.watch(stream.trackSid);
      }}
      className={cx(
        // Discord (2x reference): 28 px rows, 24 px avatars (speaking ring inside) starting where
        // the room name starts (8 + 18 + 6 = 32 px), 8 px to the 14 px name.
        // Lighter than the rooms (owner, 07.10): 26 px rows, 20 px avatars, 13 px muted names.
        'group/member relative flex h-[26px] items-center gap-2 rounded-[var(--radius-row)] pl-8 pr-2.5 text-[13px] leading-[18px] transition-colors duration-[var(--motion-fast)] hover:bg-row-hover',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        isDragging && 'opacity-40',
      )}
      title={connectingRing ? `${name} · ${t('voice.pendingMember')}` : name}
      data-speaking={talking || undefined}
      data-pending={state.pending || undefined}
    >
      {/* «Только вошёл»: 6 px dot 4 px left of the 24 px avatar (32 px), outside the flex flow. */}
      <JustJoinedDot joinedAt={joinedAtMs(state.joinedAt)} className="absolute left-[22px] top-1/2 -translate-y-1/2" />
      <SpeakerIdentity userId={state.userId} name={name} fileId={user?.avatarFileId || undefined} size={20} talking={talking} pending={connectingRing} suffix={tz} role={role} workspaceId={workspaceId} />
      {state.streaming ? (
        <Badge tone="danger" title={t('voice.streaming')}>
          {t('shell.live')}
        </Badge>
      ) : null}
      {state.camera ? (
        inSameRoom ? (
          // ADR-0066 §3: my room — the call view with this person pinned.
          <button
            type="button"
            data-testid="voice-member-camera"
            title={t('video.openPinned', { name })}
            aria-label={t('video.openPinned', { name })}
            onClick={(e) => {
              e.stopPropagation();
              useUi.getState().openRoom(workspaceId, room.id);
              voice.pinTile(state.userId);
            }}
            className="-m-1 grid shrink-0 place-items-center rounded-[var(--radius-row)] p-1 text-muted transition-colors duration-[var(--motion-fast)] hover:bg-active hover:text-fg"
          >
            <Video className="size-4" aria-hidden />
          </button>
        ) : (
          <Video className="size-4 shrink-0 text-muted" aria-label={t('video.stateOn')} role="img" />
        )
      ) : null}
      {state.musician ? <MusicianIcon /> : null}
      <VoiceStateIcons muted={state.muted} deafened={state.deafened} serverMuted={state.serverMuted || (isMe && serverMuted)} />
    </li>
  );
  // Shared member menu (PEOPLE): profile (dialog), mention, volume, moderation, «Переместить в ›»…
  return (
    <MemberContextMenu workspaceId={workspaceId} userId={state.userId}>
      {row}
    </MemberContextMenu>
  );
}

// ---------------------------------------------------------------- drag & drop (docs/09 #32, P1 #19)

/** Content y of the accent drop line in the room list (null = none). */
const DropLineCtx = createContext<number | null>(null);

/** Discord's drop placeholder: a 2 px accent line between rows, over the list (no layout shift). */
function DropLine(): ReactNode {
  const y = useContext(DropLineCtx);
  if (y === null) return null;
  return (
    <div aria-hidden data-testid="drop-line" className="pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent" style={{ top: Math.max(0, y - 1) }} />
  );
}

/**
 * One DndContext for the column: participants onto voice rooms (droppables, MOVE_MEMBERS) and
 * rooms / categories to a new place (MANAGE_ROOM). For the latter the place comes from the
 * pointer and the measured rows (lib/roomOrder), not from droppables: a line between rows,
 * recomputed on pointer moves and on scroll (dnd-kit auto-scrolls the list near its edges).
 * Esc cancels (PointerSensor); the drop is applied at once and rolled back if the server refuses.
 */
function SidebarDnd({ workspaceId, listRef, children }: { workspaceId: string; listRef: RefObject<HTMLDivElement | null>; children: ReactNode }): ReactNode {
  // 6 px before a drag starts: a click on a participant or a room stays a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragged, setDragged] = useState<DragData | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [line, setLine] = useState<number | null>(null);
  const draggedRef = useRef<DragData | null>(null);
  const pointerY = useRef(0);
  const target = useRef<{ room?: RoomTarget; category?: number } | null>(null);

  // «Not allowed» cursor over a room where I cannot move members; grabbing otherwise.
  useEffect(() => {
    if (!dragged) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = blocked ? 'not-allowed' : 'grabbing';
    return () => {
      document.body.style.cursor = prev;
    };
  }, [dragged, blocked]);

  // The pointer is over a meeting's room drop target (ADR-0038): see onMove.
  const overRoomTarget = useRef(false);
  const measure = useCallback((): void => {
    const el = listRef.current;
    const d = draggedRef.current;
    if (!el || !d || d.type === 'member') return;
    const box = el.getBoundingClientRect();
    const pos = (n: Element): { top: number; bottom: number } => {
      const r = n.getBoundingClientRect();
      return { top: r.top - box.top + el.scrollTop, bottom: r.bottom - box.top + el.scrollTop };
    };
    const y = pointerY.current - box.top + el.scrollTop;
    if (d.type === 'room' && overRoomTarget.current) {
      // Over a meeting's room field / card: the drop goes there, no insertion line in the list.
      target.current = null;
      setLine(null);
      return;
    }
    if (d.type === 'room') {
      const slots: Slot[] = [...el.querySelectorAll<HTMLElement>('[data-room-slot],[data-cat-header]')].map((n) =>
        n.dataset.roomSlot !== undefined
          ? { kind: 'room', id: n.dataset.roomSlot, categoryId: n.dataset.slotCategory || null, ...pos(n) }
          : { kind: 'header', id: n.dataset.catHeader ?? '', ...pos(n) },
      );
      const drop = roomDropAt(workspaceLayout(workspaceId), slots, y, d.roomId);
      target.current = drop ? { room: { categoryId: drop.categoryId, index: drop.index } } : null;
      setLine(drop ? drop.lineY : null);
    } else {
      const sections = [...el.querySelectorAll<HTMLElement>('[data-cat-section]')].map((n) => ({ id: n.dataset.catSection ?? '', ...pos(n) }));
      const drop = categoryDropAt(sections, y, d.categoryId);
      target.current = drop ? { category: drop.index } : null;
      setLine(drop ? drop.lineY : null);
    }
  }, [listRef, workspaceId]);

  // Auto-scroll moves the rows under a still pointer: re-measure on scroll.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !dragged || dragged.type === 'member') return;
    el.addEventListener('scroll', measure, { passive: true });
    return () => el.removeEventListener('scroll', measure);
  }, [dragged, listRef, measure]);

  const reset = (): void => {
    overRoomTarget.current = false;
    hoverRoomAt(null);
    draggedRef.current = null;
    target.current = null;
    setDragged(null);
    setBlocked(false);
    setLine(null);
  };
  const onStart = (e: DragStartEvent): void => {
    const d = (e.active.data.current as DragData | undefined) ?? null;
    draggedRef.current = d;
    target.current = null;
    setDragged(d);
    setBlocked(false);
    const ev = e.activatorEvent as PointerEvent | MouseEvent;
    pointerY.current = ev.clientY;
  };
  const onMove = (e: DragMoveEvent): void => {
    const ev = e.activatorEvent as PointerEvent | MouseEvent;
    pointerY.current = ev.clientY + e.delta.y;
    const d = draggedRef.current;
    if (d?.type === 'room' && d.voice) overRoomTarget.current = hoverRoomAt(ev.clientX + e.delta.x, pointerY.current);
    measure();
  };
  const onOver = (e: DragOverEvent): void => {
    const d = e.active.data.current as DragData | undefined;
    if (d?.type !== 'member') return;
    const over = e.over?.data.current as DropRoom | undefined;
    setBlocked(!!over && over.roomId !== d.fromRoomId && !over.canMove);
  };
  const onEnd = (e: DragEndEvent): void => {
    const d = e.active.data.current as DragData | undefined;
    const drop = target.current;
    reset();
    if (d?.type === 'room') {
      // Released over the meeting dialog's room field or a meeting card (ADR-0038, owner 29.09): a
      // voice room becomes the meeting's room there, the list keeps its order.
      const ev = e.activatorEvent as PointerEvent | MouseEvent;
      if (d.voice && dropRoomAt(ev.clientX + e.delta.x, ev.clientY + e.delta.y, d.roomId)) return;
      if (drop?.room) void moveRoomTo(workspaceId, d.roomId, drop.room);
      return;
    }
    if (d?.type === 'category') {
      if (drop?.category !== undefined) void moveCategoryTo(workspaceId, d.categoryId, drop.category);
      return;
    }
    const over = e.over?.data.current as DropRoom | undefined;
    if (!d || !over || over.roomId === d.fromRoomId) return;
    if (!over.canMove) {
      toast.info(t('shell.moveNotAllowed'));
      return;
    }
    // The moved member needs VIEW_ROOM + CONNECT in the target (server moveMember).
    const dest = useRooms.getState().byId[over.roomId];
    if (!can(roomPerms(rolesOf(useWorkspaces.getState().byId[workspaceId], d.userId), d.userId, dest), 'CONNECT')) {
      toast.info(t('shell.moveNoAccess', { name: d.name }));
      return;
    }
    moveMember(workspaceId, d.fromRoomId, d.userId, over.roomId);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onStart} onDragMove={onMove} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={reset}>
      <DropLineCtx.Provider value={line}>{children}</DropLineCtx.Provider>
      {/* In <body>: the sidebar island (overflow, transforms) is a containing block for position:fixed
          and clips its overflow — the chip would land offset and cut off at the island's edge. */}
      {createPortal(<DragOverlay dropAnimation={null}>{dragged ? <DragChip data={dragged} /> : null}</DragOverlay>, document.body)}
    </DndContext>
  );
}

function DragChip({ data }: { data: DragData }): ReactNode {
  const user = useWorkspaces((s) => (data.type === 'member' ? s.users[data.userId] : undefined));
  if (data.type === 'category') {
    return (
      <div className="mat-popover flex h-7 w-max max-w-[220px] items-center gap-1 rounded-[var(--radius-row)] px-2 text-[13px] font-medium text-fg">
        <span className="truncate">{data.name}</span>
      </div>
    );
  }
  if (data.type === 'room') {
    const Icon = data.voice ? Volume2 : data.isPrivate ? Lock : Hash;
    return (
      <div className="mat-popover flex h-[34px] w-max max-w-[240px] items-center gap-1.5 rounded-[var(--radius-row)] pl-2 pr-3 text-list text-fg">
        <Icon className="size-[18px] shrink-0 text-muted" aria-hidden />
        <span className="truncate">{data.name}</span>
      </div>
    );
  }
  return (
    <div className="mat-popover flex h-8 w-max max-w-[220px] items-center gap-2 rounded-full pl-1 pr-3 text-body font-medium">
      <Avatar userId={data.userId} name={data.name} fileId={user?.avatarFileId || undefined} size={24} />
      <span className="truncate">{data.name}</span>
    </div>
  );
}
