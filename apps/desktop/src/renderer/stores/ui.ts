import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { emptyHistory, pushLoc, step, type History, type Loc } from '../lib/roomHistory';
import { emptyPhoneNav, openChat, visibleRoom, type PhoneNav } from '../lib/phoneNav';
import { HOME } from './dms';
import { RoomType } from '@calaba/protocol';
import { useRooms } from './rooms';
import type { LightboxImage } from '../lib/lightbox';
import { useBoardsUi } from './boardsUi';
import { useWebApps } from './webApps';

export type Dialog =
  | { kind: 'create-workspace' }
  | { kind: 'join-workspace'; code?: string }
  /** `roomId`: opened from a room («Пригласить», docs/09 #55) — the invites tab leads with its guest link. */
  | { kind: 'workspace-settings'; workspaceId: string; tab?: string; roomId?: string }
  | { kind: 'room-create'; workspaceId: string; voice: boolean; categoryId?: string }
  /** «Временная комната» (ADR-0044): name, lifetime, visibility, guests, meeting → the link. */
  | { kind: 'temp-room-create'; workspaceId: string }
  /** «Продлить › До даты…» of a temporary room. */
  | { kind: 'temp-room-extend'; roomId: string }
  | { kind: 'room-settings'; roomId: string; tab?: string }
  | { kind: 'settings'; tab?: string }
  | { kind: 'stream-picker' }
  | { kind: 'camera-preview' }
  /** The image viewer; `images` are the message's images (←/→), `index` the one opened; `inChat`: «Показать в чате». */
  | { kind: 'image'; images: LightboxImage[]; index: number; inChat?: { roomId: string; messageId: string } }
  /**
   * A meeting recording opened from a search hit at a segment (ADR-0062 §4): the player and the
   * summary from its card message (messageId, '' = gone), the transcript.
   */
  | { kind: 'transcript'; roomId: string; recordingId: string; messageId: string; offsetMs: number; startedAt: number }
  /** ⌘K search; `query` pre-fills it (typed into the room header's search field). */
  | { kind: 'quick-switcher'; query?: string }
  /** «Новое сообщение»: pick a person to write to (ADR-0020). */
  | { kind: 'new-dm' }
  /** «Переслать…» (ADR-0033): pick people / rooms to copy the message `messageId` of `roomId` into. */
  | { kind: 'forward'; roomId: string; messageId: string }
  /** «Пригласить в комнату»: pick members to invite by DM, or copy the room link (docs/09 #33). */
  | { kind: 'room-invite'; roomId: string }
  /** Member profile (docs/09 #20); `note` focuses «Заметка» («Добавить заметку» in the member menu). */
  | { kind: 'profile'; workspaceId: string; userId: string; note?: boolean }
  /** «Администрирование» (superadmins, ADR-0024); the web shows it at /admin. */
  | { kind: 'admin'; workspaceId?: string }
  /**
   * Create / edit a meeting (ADR-0038 §7). `eventKey`: the occurrence edited (its series is
   * changed); `draft`: prefilled values of a new one (a range selected on the grid, «Дублировать»).
   */
  | { kind: 'event'; workspaceId: string; eventKey?: string; draft?: EventDraftInit }
  /** Add (no `appId`) / edit a web app of the workspace (ADR-0050 §3). */
  | { kind: 'web-app'; workspaceId: string; appId?: string }
  /**
   * «Тариф и оплата» (ADR-0080): the plans side by side and the one pay path; `welcome` — the step
   * right after creating the workspace («Начать бесплатно» first).
   */
  | { kind: 'billing-plans'; workspaceId: string; welcome?: boolean };

/** Prefill of the meeting dialog (features/calendar/EventDialog.tsx). */
export interface EventDraftInit {
  start?: number;
  end?: number;
  allDay?: boolean;
  roomId?: string;
  /** Attendees (members) prefilled: «Подобрать время», a slot picked (ADR-0041 §3); me left out. */
  attendees?: readonly string[];
  /** Copy everything else from this occurrence («Дублировать»). */
  copyOf?: string;
  /** «Создать встречу в Calab» from an external event (ADR-0045 §3): its title, and the addresses of its attendees who are not members here. */
  title?: string;
  outside?: readonly string[];
}

interface UiState {
  /** The open workspace, or HOME (stores/dms.ts) for «Личные» — the DM list (ADR-0020). */
  activeWorkspaceId: string | null;
  /** Last opened room per workspace (HOME: the last opened DM). */
  lastRoom: Record<string, string>;
  dialog: Dialog | null;
  membersPanel: boolean;
  /** Narrow window (< MEMBERS_COLUMN_MIN): the members list floats over the chat; not persisted. */
  membersOverlay: boolean;
  setMembersOverlay: (open: boolean) => void;
  /**
   * Phone layout (ADR-0073): the tab and the stack of pushed screens; not persisted. Kept in step
   * with the browser history and the feature flags by services/phoneNav.ts.
   */
  phone: PhoneNav;
  setPhone: (update: (nav: PhoneNav) => PhoneNav) => void;
  /** Reply target per room. */
  replyTo: Record<string, string | undefined>;
  editing: string | null;
  /** Room column width (docs/08: 256 px by default, 200–320, resizable). */
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  setWorkspace: (id: string | null) => void;
  openRoom: (workspaceId: string, roomId: string) => void;
  /** Initial room of a workspace (last or first text room) — not a navigation step. */
  selectDefaultRoom: (workspaceId: string, roomId: string) => void;
  openDialog: (d: Dialog | null) => void;
  toggleMembers: () => void;
  setReply: (roomId: string, messageId: string | undefined) => void;
  setEditing: (id: string | null) => void;
  /** Room navigation history (title bar ← →); not persisted. */
  history: History;
  goBack: () => void;
  goForward: () => void;
  /** Collapsed room categories (category id → true), persisted. */
  collapsed: Record<string, true>;
  toggleCategory: (categoryId: string) => void;
  /** «Скрыть заглушённые» (docs/09 P1 #19): muted rooms leave the sidebar (open/voice room stays), persisted. */
  hideMuted: boolean;
  setHideMuted: (v: boolean) => void;
  /**
   * «Где настроить» (Settings → Звуки, docs/09 item 22): closes the dialog and asks the open
   * room's bell to open its notification menu (a counter the bell watches); not persisted.
   */
  notifyMenuReq: number;
  requestNotifyMenu: () => void;
  /**
   * Calendar (ADR-0038 §7), not persisted: the mini month under the column header, and the day
   * shown in the centre instead of the room (`YYYY-MM-DD`, the viewer's zone) with the selected
   * occurrence (`<event id>@<start ms>`) in the right panel. Opening a room closes the day view —
   * the room it covered is still `lastRoom`, so closing returns there.
   */
  miniCal: boolean;
  /** The mini calendar's month (`YYYY-MM`); null = the day view's / this month. */
  calMonth: string | null;
  calDay: string | null;
  calEvent: string | null;
  toggleMiniCal: (open?: boolean) => void;
  setCalMonth: (month: string | null) => void;
  openCalendarDay: (day: string, eventKey?: string | null) => void;
  selectCalEvent: (key: string | null) => void;
  closeCalendar: () => void;
}

/** Window width from which the members list is a column instead of a floating panel (docs/08: chat keeps ≥ ~600 px). */
export const MEMBERS_COLUMN_MIN = 1200;

/** Default room column: the self panel keeps ≥ 104 px for the name next to its three buttons. */
export const SIDEBAR_DEFAULT = 256;

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      lastRoom: {},
      dialog: null,
      membersPanel: true,
      membersOverlay: false,
      phone: emptyPhoneNav(),
      setPhone: (update) =>
        set((s) => {
          const phone = update(s.phone);
          return phone === s.phone ? {} : { phone };
        }),
      replyTo: {},
      editing: null,
      sidebarWidth: SIDEBAR_DEFAULT,
      setSidebarWidth: (w) => set({ sidebarWidth: Math.round(Math.max(200, Math.min(320, w))) }),
      history: emptyHistory(),
      collapsed: {},
      hideMuted: false,
      setHideMuted: (hideMuted) => set({ hideMuted }),
      notifyMenuReq: 0,
      requestNotifyMenu: () => set((s) => ({ dialog: null, notifyMenuReq: s.notifyMenuReq + 1 })),
      miniCal: false,
      calMonth: null,
      calDay: null,
      calEvent: null,
      toggleMiniCal: (open) => set((s) => ({ miniCal: open ?? !s.miniCal })),
      setCalMonth: (calMonth) => set({ calMonth }),
      openCalendarDay: (day, eventKey) =>
        set((s) => {
          if (useBoardsUi.getState().active) useBoardsUi.getState().setActive(false);
          return { calDay: day, calEvent: eventKey === undefined ? s.calEvent : eventKey, calMonth: day.slice(0, 7), membersOverlay: false, editing: null };
        }),
      selectCalEvent: (calEvent) => set({ calEvent }),
      closeCalendar: () => set({ calDay: null, calEvent: null }),
      setWorkspace: (id) =>
        set((s) => {
          // A click on a workspace (the open one too) leads back to its rooms (ADR-0050 §3).
          if (useWebApps.getState().open) useWebApps.getState().setOpen(null);
          return {
          calDay: null,
          calEvent: null,
          activeWorkspaceId: id,
          history: id ? pushLoc(s.history, here(s), { ws: id, room: s.lastRoom[id] ?? null }) : s.history,
          };
        }),
      openRoom: (wsId, roomId) =>
        set((s) => {
          // A room opened from anywhere (⌘K, a notification, a link) leaves the boards mode and
          // a web app (ADR-0050).
          if (useBoardsUi.getState().active) useBoardsUi.getState().setActive(false);
          if (useWebApps.getState().open) useWebApps.getState().setOpen(null);
          return {
          calDay: null,
          calEvent: null,
          activeWorkspaceId: wsId,
          lastRoom: { ...s.lastRoom, [wsId]: roomId },
          editing: null,
          membersOverlay: false,
          // Phone (ADR-0073 §1): the room / DM is pushed over its tab's root.
          phone: s.phone.on ? openChat(s.phone, wsId === HOME ? { kind: 'dm', room: roomId } : { kind: 'room', ws: wsId, room: roomId }) : s.phone,
          history: pushLoc(s.history, here(s), { ws: wsId, room: roomId }),
          };
        }),
      selectDefaultRoom: (wsId, roomId) => set((s) => ({ lastRoom: { ...s.lastRoom, [wsId]: roomId } })),
      goBack: () => set((s) => travel(s, -1)),
      goForward: () => set((s) => travel(s, 1)),
      toggleCategory: (id) =>
        set((s) => {
          const collapsed = { ...s.collapsed };
          if (collapsed[id]) delete collapsed[id];
          else collapsed[id] = true;
          return { collapsed };
        }),
      openDialog: (dialog) => set({ dialog }),
      toggleMembers: () => set((s) => ({ membersPanel: !s.membersPanel })),
      setMembersOverlay: (membersOverlay) => set({ membersOverlay }),
      setReply: (roomId, messageId) => set((s) => ({ replyTo: { ...s.replyTo, [roomId]: messageId } })),
      setEditing: (editing) => set({ editing }),
    }),
    {
      name: 'calaba-ui',
      version: 1,
      // v0 defaulted the column to 240: move untouched defaults to the new one.
      migrate: (old, version) => {
        const o = (old ?? {}) as Partial<UiState>;
        return (version < 1 && o.sidebarWidth === 240 ? { ...o, sidebarWidth: SIDEBAR_DEFAULT } : o) as UiState;
      },
      partialize: (s) => ({
        activeWorkspaceId: s.activeWorkspaceId,
        lastRoom: s.lastRoom,
        membersPanel: s.membersPanel,
        sidebarWidth: s.sidebarWidth,
        collapsed: s.collapsed,
        hideMuted: s.hideMuted,
      }),
    },
  ),
);

// The workspace modes are exclusive (docs/09 #140): the boards turned on from anywhere (the tab, a
// board link, «Мои задачи», a task) close the day view — as opening a day turns the boards off.
useBoardsUi.subscribe((s, prev) => {
  if (s.active && !prev.active && useUi.getState().calDay !== null) useUi.getState().closeCalendar();
});

function here(s: Pick<UiState, 'activeWorkspaceId' | 'lastRoom'>): Loc | null {
  return s.activeWorkspaceId ? { ws: s.activeWorkspaceId, room: s.lastRoom[s.activeWorkspaceId] ?? null } : null;
}

/** A history entry is still reachable: the room exists (or the entry is workspace-only). */
function reachable(l: Loc): boolean {
  const rooms = useRooms.getState().byId;
  if (l.ws === HOME) return !l.room || rooms[l.room]?.type === RoomType.DM || rooms[l.room]?.type === RoomType.NOTES;
  if (l.room) return rooms[l.room]?.workspaceId === l.ws;
  return Object.values(rooms).some((r) => r.workspaceId === l.ws);
}

function travel(s: UiState, dir: -1 | 1): Partial<UiState> {
  const r = step(s.history, here(s), dir, reachable);
  if (!r) return {};
  if (useWebApps.getState().open) useWebApps.getState().setOpen(null);
  const { ws, room } = r.to;
  return {
    calDay: null,
    calEvent: null,
    history: r.history,
    activeWorkspaceId: ws,
    lastRoom: room ? { ...s.lastRoom, [ws]: room } : s.lastRoom,
    editing: null,
    membersOverlay: false,
  };
}

export const canGoBack = (s: UiState): boolean => s.history.back.length > 0;
export const canGoForward = (s: UiState): boolean => s.history.forward.length > 0;

/** The room on screen: on a phone only while its screen is on top (the room list shows none). */
export function activeRoomId(): string | null {
  const s = useUi.getState();
  if (s.phone.on) return visibleRoom(s.phone);
  return s.activeWorkspaceId ? (s.lastRoom[s.activeWorkspaceId] ?? null) : null;
}
