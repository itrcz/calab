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
  CheckCheck,
  ChevronDown,
  CircleDot,
  CircleStop,
  Ellipsis,
  ChevronRight,
  FolderInput,
  FolderPlus,
  Hash,
  Loader2,
  Lock,
  LogOut,
  Pencil,
  Plus,
  Settings,
  Trash2,
  UserPlus,
  Users,
  MessageCircle,
  Video,
  Volume2,
} from 'lucide-react';
import { Fragment, createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../../components/Avatar';
import { SpeakerIdentity } from '../../components/SpeakerIdentity';
import { confirmAction } from '../../components/Confirm';
import { Badge, Button, Empty, Field, Input, Modal, Tip, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { can, mayArrangeRooms, mayManageWorkspace, mayMoveMembersIn, mayMoveVoice, roomPerms } from '../../lib/permissions';
import { voice } from '../../services/voice';
import { groupRooms, isUnread, isVoice, roomNotify, roomsOfWorkspace, showsUnread, useRooms, workspaceNotify } from '../../stores/rooms';
import { setRoomNotifications, setWorkspaceNotifications } from '../../services/mentions';
import { LEVEL_LABEL, NotifyMenuItems, type LevelOption } from '../chat/NotifyMenu';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { memberName, rolesOf, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { useConnectingRing, useVoiceStates } from '../../stores/voicePending';
import { joinOutcome } from '../../lib/voiceEntry';
import { formatDuration, pad2, useNow } from './voiceFormat';
import { menuBox, menuItem, menuSeparator } from './menu';
import { MemberContextMenu } from '../people/MemberContextMenu';
import { moveMember } from '../people/actions';
import { errorText } from '../../lib/api/errors';
import { VoiceInviteRow, VoiceStatusLine, useStatusLine } from './VoiceRoomRows';
import { VoiceStateIcons } from '../voice/VoiceStateIcons';
import { useMobile } from '../../lib/mobile';
import { categoryDropAt, roomDropAt, stepTarget, type RoomTarget, type Slot } from '../../lib/roomOrder';
import { moveCategoryTo, moveRoomTo, workspaceCategories, workspaceLayout } from '../../services/roomOrder';
import { useLocalTimeTag } from '../../services/timezone';
import { roomMenuGroups, type RoomMenuItem } from '../../lib/roomMenu';
import { RoomRecBadge } from '../voice/Recording';
import { useRecordings } from '../../stores/recordings';
import { startRecording, stopRecording } from '../../services/recording';

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
 * Room column (docs/09 #4, P1 #19): workspace header with ▾ menu and «invite»; rooms as one flat
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
  // Workspace invites (rows' «Пригласить»): MANAGE_WORKSPACE, a custom role's included.
  const admin = mayManageWorkspace(myRoles);
  const manageRooms = mayArrangeRooms(myRoles);
  // Pointer reordering on the desktop layout only: on a phone a drag would fight the scroll
  // (the room menu's «Переместить вверх/вниз» works everywhere).
  const canDrag = manageRooms && !mobile;
  const groups = useMemo(() => {
    let rooms = roomsOfWorkspace(roomsById, workspaceId);
    // «Скрыть заглушённые»: the open room and my voice room stay (Discord).
    if (hideMuted) rooms = rooms.filter((r) => r.id === activeRoom || r.id === voiceRoom || roomNotify(notify[r.id]).mutedUntil === null);
    const cats = Object.values(categoriesById).filter((c) => c.workspaceId === workspaceId);
    return groupRooms(rooms, cats, manageRooms);
  }, [roomsById, categoriesById, workspaceId, manageRooms, hideMuted, notify, activeRoom, voiceRoom]);
  if (!entry) return null;
  const empty = groups.length === 0;

  return (
    <aside className="mat-sidebar flex w-[var(--sidebar-width)] shrink-0 flex-col" aria-label={t('room.list')}>
      <WorkspaceHeader workspaceId={workspaceId} onCreateCategory={() => setCatDialog(true)} />
      <SidebarDnd workspaceId={workspaceId} listRef={listRef}>
        <SidebarMenu workspaceId={workspaceId} onCreateCategory={() => setCatDialog(true)}>
          {/* The bottom island (AppShell) floats over the column's foot: the list ends above it. */}
          <div
            ref={listRef}
            className="scrollbar-none relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pt-2"
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
            <DropLine />
          </div>
        </SidebarMenu>
      </SidebarDnd>
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
  const admin = mayManageWorkspace(myRoles);
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

function WorkspaceHeader({ workspaceId, onCreateCategory }: { workspaceId: string; onCreateCategory: () => void }): ReactNode {
  // ws and role, not the whole entry (it changes on every voice state).
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const open = useUi((s) => s.openDialog);
  const hideMuted = useUi((s) => s.hideMuted);
  const setHideMuted = useUi((s) => s.setHideMuted);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const myRoles = useMemberRoles(workspaceId, me);
  if (!ws) return null;
  // Invites and settings: MANAGE_WORKSPACE (the server's check), a custom role's included.
  const admin = mayManageWorkspace(myRoles);
  const manageRooms = mayArrangeRooms(myRoles);

  const leave = async (): Promise<void> => {
    if (!(await confirmAction(t('ws.leave'), t('ws.leaveConfirm', { name: ws.name }), t('ws.leave')))) return;
    try {
      await api.workspaces.removeMember(workspaceId, '@me');
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pl-2 pr-2">
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            className="group flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-left text-list font-semibold text-fg transition-colors duration-[var(--motion-fast)] hover:bg-hover data-[state=open]:bg-active"
            title={ws.name}
          >
            <span className="min-w-0 flex-1 truncate">{ws.name}</span>
            <ChevronDown
              className="size-4 shrink-0 text-muted transition-transform duration-[var(--motion-fast)] group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="start">
            {admin ? (
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
            {manageRooms ? (
              <>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'room-create', workspaceId, voice: false })}>
                  <Plus className="size-4" /> {t('room.create')}
                </Dropdown.Item>
                <Dropdown.Item className={menuItem} onSelect={onCreateCategory}>
                  <FolderPlus className="size-4" /> {t('shell.categoryCreate')}
                </Dropdown.Item>
              </>
            ) : null}
            <Dropdown.Separator className={menuSeparator} />
            {/* The owner cannot leave (ownership is not transferable yet): shown, disabled, with the reason. */}
            <Dropdown.Item
              className={cx(menuItem, 'text-danger-text')}
              disabled={role === WorkspaceRole.OWNER}
              title={role === WorkspaceRole.OWNER ? t('shell.ownerCannotLeave') : undefined}
              onSelect={() => void leave()}
            >
              <LogOut className="size-4" /> {t('ws.leave')}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {admin ? (
        <Tip label={t('shell.invite')}>
          <button
            type="button"
            aria-label={t('ws.invite')}
            onClick={() => open({ kind: 'workspace-settings', workspaceId, tab: 'invites' })}
            className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg"
          >
            <UserPlus className="size-[18px]" aria-hidden />
          </button>
        </Tip>
      ) : null}
    </div>
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
        </Dropdown.SubContent>
      </Dropdown.Portal>
    </Dropdown.Sub>
  );
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
  if (!category) return <div className="mb-2 flex flex-col gap-px">{children}</div>;

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
      className="group/cat flex h-7 items-center pr-1 pt-1"
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
          className="flex h-6 min-w-0 flex-1 items-center gap-0.5 rounded-[4px] pl-0.5 text-left text-micro font-semibold uppercase tracking-[0.04em] text-muted transition-colors duration-[var(--motion-fast)] hover:text-fg"
          title={category.name}
        >
          <ChevronDown className={cx('size-3 shrink-0 transition-transform duration-[var(--motion-fast)]', collapsed && '-rotate-90')} strokeWidth={2.25} aria-hidden />
          <span className="truncate">{category.name}</span>
        </button>
      )}
      {canManage && !editing ? (
        <Tip label={t('room.create')}>
          <button
            type="button"
            onClick={() => open({ kind: 'room-create', workspaceId, voice: false, categoryId: category.id })}
            aria-label={t('shell.roomCreateIn', { name: category.name })}
            className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 transition-opacity duration-[var(--motion-fast)] hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/cat:opacity-100"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </Tip>
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
                <Trash2 className="size-4" /> {t('shell.categoryDelete')}
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ) : (
        header
      )}
      {visible.length ? <div className="mt-0.5 flex flex-col gap-px">{visible}</div> : null}
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
      className="h-6 min-w-0 flex-1 rounded-[4px] bg-[var(--color-fill)] px-1.5 text-micro font-semibold uppercase tracking-[0.04em] text-fg outline-none ring-1 ring-accent"
    />
  );
}

/** Create a category (MANAGE_ROOM); renaming is inline in the header. */
function CategoryDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    const v = name.trim();
    if (!v) return;
    setBusy(true);
    try {
      const r = await api.categories.create(workspaceId, { name: v });
      if (r.category) useRooms.getState().upsertCategory(r.category);
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

/** Row shell shared by text and voice rooms: 34 px, hover background, unread pill, hover actions. */
const rowBox = 'group/row relative flex h-[34px] items-center rounded-[var(--radius-row)] transition-colors duration-[var(--motion-fast)]';

function UnreadPill({ show }: { show: boolean }): ReactNode {
  // A whole 4 × 8 pill just inside the column (a half-dot on the seam read as a glitch).
  return show ? <span aria-hidden className="absolute -left-1.5 top-1/2 h-2 w-1 -translate-y-1/2 rounded-full bg-fg" /> : null;
}

/**
 * Text room hover actions (invite, settings — no «chat»: the row itself opens it). Same 18 px
 * icons / 10 px gap as the voice rooms' CardActions, so the two lists don't look inconsistent
 * (owner, Discord reference); by permission, no reserved space when one is missing.
 */
function RoomActions({ room, canInvite, canSettings, active }: { room: Room; canInvite: boolean; canSettings: boolean; active: boolean }): ReactNode {
  const open = useUi((s) => s.openDialog);
  if (!canInvite && !canSettings) return null;
  const btn = 'grid size-6 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg';
  return (
    <span className={cx('shrink-0 items-center gap-2.5', active ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex')}>
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
            <Settings className="size-[18px]" aria-hidden />
          </button>
        </Tip>
      ) : null}
    </span>
  );
}

/**
 * The room menu (docs/09 #30): right click / long press on a room row, and the voice room's «…»
 * button (the same menu, opened at the button). Item set: lib/roomMenu.roomMenuGroups.
 */
function RoomMenu({
  room,
  children,
  canManage,
  canOrder,
  admin,
  guest,
}: {
  room: Room;
  children: ReactNode;
  canManage: boolean;
  canOrder: boolean;
  admin: boolean;
  guest: boolean;
}): ReactNode {
  const open = useUi((s) => s.openDialog);
  const openRoom = useUi((s) => s.openRoom);
  const last = useRooms((s) => s.lastMessage[room.id]);
  const unread = useRooms((s) => isUnread(room.id, s));
  const mobile = useMobile();
  const voiceRoom = isVoice(room);
  const recording = useRecordings((s) => !!s.byRoom[room.id]);
  // Categories are read when the menu renders (it mounts on open), like RoomOrderItems.
  const groups = roomMenuGroups({
    voice: voiceRoom,
    mobile,
    guest,
    admin,
    canManage,
    canOrder,
    hasCategories: canOrder && workspaceCategories(room.workspaceId).length > 0,
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
        // Voice + MANAGE_ROOM: the room link (ADR-0016, like the invite row); otherwise the workspace invite.
        return (
          <ContextMenu.Item
            key={id}
            className={menuItem}
            onSelect={() => (voiceRoom && canManage ? open({ kind: 'room-invite', roomId: room.id }) : open({ kind: 'workspace-settings', workspaceId: room.workspaceId, tab: 'invites', roomId: room.id }))}
          >
            <UserPlus className="size-4" /> {voiceRoom ? t('roomMenu.invite') : t('shell.invite')}
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
      case 'settings':
        return (
          <ContextMenu.Item key={id} className={menuItem} onSelect={() => open({ kind: 'room-settings', roomId: room.id })}>
            <Settings className="size-4" /> {t('room.settings')}
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
function CardActions({ room, workspaceId }: { room: Room; workspaceId: string }): ReactNode {
  const openRoom = useUi((s) => s.openRoom);
  const btn =
    'grid size-6 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg';
  // «…» opens the row's own context menu (RoomMenu) under the button: one menu for the click, the
  // right click and the phone's long press — never two item lists drifting apart.
  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom + 4 }));
  };
  return (
    <span className="hidden shrink-0 items-center gap-2.5 group-focus-within/row:flex group-hover/row:flex group-data-[state=open]/row:flex">
      <Tip label={t('shell.roomChat')}>
        <button type="button" className={btn} aria-label={t('shell.roomChatOf', { name: room.name })} onClick={() => openRoom(workspaceId, room.id)}>
          <MessageCircle className="size-[18px]" aria-hidden />
        </button>
      </Tip>
      <Tip label={t('roomMenu.more')}>
        <button type="button" className={btn} aria-label={t('roomMenu.moreOf', { name: room.name })} aria-haspopup="menu" data-testid="room-more" onClick={openMenu}>
          <Ellipsis className="size-[18px]" aria-hidden />
        </button>
      </Tip>
    </span>
  );
}

function MentionBadge({ n }: { n: number }): ReactNode {
  if (n <= 0) return null;
  return (
    <span className="shrink-0 rounded-full bg-danger-fill px-1.5 text-micro font-bold leading-4 text-white group-hover/row:hidden" aria-label={plural('shell.unreadMentions', n)}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

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
  return (
    <div ref={setNodeRef} {...(canDrag ? listeners : {})} data-room-slot={room.id} data-slot-category={container} className={cx(isDragging && 'opacity-40')}>
      <RoomMenu room={room} canManage={can(perms, 'MANAGE_ROOM')} canOrder={canOrder} admin={admin} guest={role.some((r) => r.builtin === WorkspaceRole.GUEST)}>
        <div className={cx(rowBox, active ? 'bg-active' : 'hover:bg-hover')}>
          <UnreadPill show={unread && !active} />
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
            {room.isPrivate ? (
              <Lock className="size-[18px] shrink-0 text-muted" aria-label={t('room.private')} />
            ) : (
              <Hash className="size-[18px] shrink-0 text-muted" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate" title={room.name}>
              {room.name}
            </span>
          </button>
          <span className="flex shrink-0 items-center gap-1 pr-2.5">
            <MentionBadge n={mentions} />
            <RoomActions room={room} canInvite={admin} canSettings={can(perms, 'MANAGE_ROOM')} active={active} />
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
  const canMove = mayMoveMembersIn(role, me, room);
  const statusLine = useStatusLine(room.id, inRoom, canConnect, can(perms, 'MANAGE_ROOM'));
  const card = statusLine.shown;
  const limit = room.userLimit;
  // Unlike the click guard (joinOutcome: never blocks re-entering my own room), the invite row (docs/09 #10) hides whenever the room is actually at its limit, me included.
  const atCapacity = limit > 0 && people.length >= limit;
  const { setNodeRef, isOver, active: dragging } = useDroppable({ id: `room:${room.id}`, data: { roomId: room.id, canMove } satisfies DropRoom });
  const dragData = dragging?.data.current as DragData | undefined;
  // Only a participant drag highlights a room (a dragged room shows the accent line instead).
  const dropOk = isOver && canMove && dragData?.type === 'member' && dragData.fromRoomId !== room.id;
  const { setNodeRef: setDragRef, listeners: dragListeners, isDragging } = useRoomDrag(room, canDrag);
  const refs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      setDragRef(node);
    },
    [setNodeRef, setDragRef],
  );

  const click = (): void => {
    openRoom(workspaceId, room.id);
    const next = joinOutcome({ inRoom, canConnect, canMove, people: people.length, limit });
    if (next === 'full') toast.info(t('shell.roomFull'));
    else if (next === 'join') void voice.join(room.id, workspaceId);
  };

  return (
    <div
      ref={refs}
      data-room-slot={room.id}
      data-slot-category={container}
      className={cx(
        'rounded-[var(--radius-card)] transition-colors duration-[var(--motion-fast)]',
        dropOk && 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] outline outline-1 outline-accent',
        isDragging && 'opacity-40',
      )}
    >
      {/* The drag handle is the room line / card only: participants below drag themselves. */}
      <div {...(canDrag ? dragListeners : {})}>
        <RoomMenu room={room} canManage={can(perms, 'MANAGE_ROOM')} canOrder={canOrder} admin={admin} guest={role.some((r) => r.builtin === WorkspaceRole.GUEST)}>
          {/* With a status line the room is one raised two-line card (Discord): name + status. */}
          <div
            className={cx(
              // pl-2 = the plain row's: the name starts at 32 px in both, where the participants' avatars start.
              card ? 'group/row relative flex flex-col gap-0.5 rounded-[var(--radius-card)] py-2 pl-2 pr-2.5' : rowBox,
              card ? (active ? 'bg-active' : 'bg-hover') : active ? 'bg-active' : 'hover:bg-hover',
            )}
            data-testid={card ? 'voice-room-card' : undefined}
          >
            <UnreadPill show={unread && !active} />
            <div className={card ? 'flex h-5 min-w-0 items-center' : 'contents'}>
              <button
                type="button"
                onClick={click}
                aria-current={active ? 'page' : undefined}
                title={canConnect ? undefined : t('voice.noConnect')}
                className={cx(
                  'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] pr-1 text-left text-list leading-5',
                  card ? 'pl-0' : 'pl-2',
                  active || unread || inRoom ? 'text-fg' : 'text-muted group-hover/row:text-fg',
                  unread && !active && 'font-semibold',
                )}
              >
                <span className="relative inline-flex shrink-0">
                  {connecting ? (
                    <Loader2 className="size-[18px] animate-spin text-muted" aria-label={t('voice.connecting')} role="img" />
                  ) : (
                    <Volume2 className={cx('size-[18px]', inRoom ? 'text-ok' : 'text-muted')} aria-hidden />
                  )}
                  {/* Private (Discord): a small lock badge on the speaker icon, not a separate icon
                      competing with the card actions for space on the right. */}
                  {!connecting && room.isPrivate ? (
                    <span role="img" aria-label={t('room.private')} className="absolute -bottom-0.5 -right-0.5 grid size-2.5 place-items-center rounded-full bg-[var(--color-fill-hover)]">
                      <Lock className="size-1.5 text-fg" aria-hidden />
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 truncate" title={room.name}>
                  {room.name}
                </span>
              </button>
              <span className={cx('flex shrink-0 items-center gap-1', !card && 'pr-2.5')}>
                <MentionBadge n={mentions} />
                {/* Hover / focus swaps the timer and N/M for the actions (Discord; «чат» is always there,
                    docs/09 #14), so the name keeps ≥ 120 px. On the card the timer stays green on the name line. */}
                <span className={cx('flex items-center gap-2', 'group-focus-within/row:hidden group-hover/row:hidden group-data-[state=open]/row:hidden')}>
                  {/* REC (docs/09 #30): on a plain row just the dot before the call timer (the name keeps
                      its width); the card shows «● REC 12:34» on its status line, right under the timer. */}
                  {card ? null : <RoomRecBadge roomId={room.id} compact />}
                  {people.length ? <CallTimer roomId={room.id} className={card ? cx('text-[13px]', inRoom ? 'text-[var(--color-green-text)]' : 'text-fg') : undefined} /> : null}
                  {limit > 0 || people.length > 0 ? <PeoplePill n={people.length} max={limit} /> : null}
                </span>
                {/* Same two actions (chat · «…») whether the room is active (card) or not, on hover
                    (owner, Discord reference): no separate action set for either. */}
                <CardActions room={room} workspaceId={workspaceId} />
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
      {people.length > 0 ? (
        <ul className="flex flex-col gap-px pb-1 pt-0.5" aria-label={room.name}>
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
        </ul>
      ) : null}
      {inRoom && can(perms, 'MANAGE_ROOM') ? <VoiceInviteRow roomId={room.id} full={atCapacity} /> : null}
    </div>
  );
}

/**
 * People in a voice room. Without a limit: one muted pill with the people icon — «2» (shown only
 * while someone is inside). With a limit (docs/09 #9, Discord reference): a two-segment pill —
 * «00 ⁄ 99», current on the left and the limit on the right, both zero-padded to two digits, a
 * ~15° slanted divider (the right segment one step darker/lighter than the pill fill), red left
 * segment when full. The call timer stands apart from it (review: «02 | 04» read as noise).
 */
function PeoplePill({ n, max }: { n: number; max: number }): ReactNode {
  if (max <= 0) {
    return (
      <span
        // Primary text on the fill: muted grey fell under 4.5:1 on the selected card (axe).
        className="flex items-center gap-0.5 rounded-full bg-[var(--color-fill)] py-px pl-1 pr-1.5 text-micro font-medium tabular-nums leading-4 text-fg"
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
      className="flex h-[18px] items-center overflow-hidden rounded-full bg-[var(--color-fill)] text-micro font-medium tabular-nums"
      aria-label={t('shell.userLimit', { n, max })}
      role="img"
      data-testid="room-limit"
    >
      {/* bg-danger-fill + text-white (the same solid pairing as the mention badge below), not
          text-danger-text on the ambient fill: that read 3.64 on axe (< 4.5) — the accent-on-tint
          color only works on the plain window background it was tuned for. */}
      <span className={cx('flex h-full items-center px-1.5', full ? 'bg-danger-fill text-white' : 'text-fg')}>{pad2(n)}</span>
      {/* clip-path skews the segment's left edge ~15° (6 px over the 18 px pill height), rather
          than a separate divider element, so the angled boundary always matches the pill height.
          text-fg, not text-muted: muted grey on --color-fill-hover fails 4.5:1 (axe), same reason
          the no-limit pill above uses text-fg on the plainer --color-fill. */}
      <span className="flex h-full items-center bg-[var(--color-fill-hover)] px-1.5 text-fg" style={{ clipPath: 'polygon(6px 0, 100% 0, 100% 100%, 0 100%)' }}>
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
        'group/member flex h-7 items-center gap-2 rounded-[var(--radius-row)] pl-8 pr-2.5 text-body transition-colors duration-[var(--motion-fast)] hover:bg-hover',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        isDragging && 'opacity-40',
      )}
      title={connectingRing ? `${name} · ${t('voice.pendingMember')}` : name}
      data-speaking={talking || undefined}
      data-pending={state.pending || undefined}
    >
      <SpeakerIdentity userId={state.userId} name={name} fileId={user?.avatarFileId || undefined} size={24} talking={talking} pending={connectingRing} suffix={tz} role={role} />
      {state.streaming ? (
        <Badge tone="danger" title={t('voice.streaming')}>
          {t('shell.live')}
        </Badge>
      ) : null}
      {state.camera ? <Video className="size-4 shrink-0 text-muted" aria-label={t('video.stateOn')} role="img" /> : null}
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
      <div className="mat-popover flex h-7 w-max max-w-[220px] items-center gap-1 rounded-[var(--radius-row)] px-2 text-micro font-semibold uppercase tracking-[0.04em] text-fg">
        <ChevronDown className="size-3 shrink-0" strokeWidth={2.25} aria-hidden />
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
