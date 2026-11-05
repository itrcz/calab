import type { WorkspaceApp, WorkspaceSnapshot } from '@calaba/protocol';
import { create } from 'zustand';
import type { WebAppNavState } from '../../shared/ipc';

/**
 * Web apps of my workspaces (ADR-0050): from the snapshot (READY, WORKSPACE_CREATE) and
 * WORKSPACE_APP_UPSERT / DELETE; guests get none. `open` is the app shown instead of the room
 * column and the chat (it belongs to the active workspace); `nav` — the desktop view's state for
 * the navigation strip, pushed by main (no polling). Rows read their app by id.
 */
interface WebAppsState {
  byId: Record<string, WorkspaceApp>;
  /** Workspace id → its app ids by position. */
  order: Record<string, string[]>;
  open: string | null;
  nav: Record<string, WebAppNavState>;
  /** «Перезагрузить» from the rail menu: the open app's screen reloads when it changes. */
  reloadKey: number;
  /** The app the rail asked to reload; its desktop view reloads once it is on screen, also when it opens only now. */
  reloadApp: string | null;
  bumpReload: (appId?: string) => void;
  setWorkspace: (workspaceId: string, apps: readonly WorkspaceApp[]) => void;
  upsert: (a: WorkspaceApp) => void;
  remove: (workspaceId: string, appId: string) => void;
  dropWorkspace: (workspaceId: string) => void;
  /** Local order after a drop (the server's answer / events follow). */
  reorder: (workspaceId: string, ids: string[]) => void;
  setOpen: (appId: string | null) => void;
  setNav: (s: WebAppNavState) => void;
  reset: () => void;
}

const byPosition = (list: WorkspaceApp[]): string[] =>
  list.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)).map((a) => a.id);

function orderOf(byId: Record<string, WorkspaceApp>, wsId: string): string[] {
  return byPosition(Object.values(byId).filter((a) => a.workspaceId === wsId));
}

export const useWebApps = create<WebAppsState>()((set) => ({
  byId: {},
  order: {},
  open: null,
  nav: {},
  reloadKey: 0,
  reloadApp: null,
  bumpReload: (appId) => set((s) => ({ reloadKey: s.reloadKey + 1, reloadApp: appId ?? null })),
  setWorkspace: (wsId, apps) =>
    set((s) => {
      const byId = Object.fromEntries(Object.entries(s.byId).filter(([, a]) => a.workspaceId !== wsId));
      for (const a of apps) byId[a.id] = a;
      const open = s.open && byId[s.open] ? s.open : null;
      return { byId, order: { ...s.order, [wsId]: orderOf(byId, wsId) }, open };
    }),
  upsert: (a) =>
    set((s) => {
      const byId = { ...s.byId, [a.id]: a };
      const prev = s.byId[a.id];
      // Only a new app or a move changes the order (a rename keeps the array).
      const order = !prev || prev.position !== a.position ? { ...s.order, [a.workspaceId]: orderOf(byId, a.workspaceId) } : s.order;
      return { byId, order };
    }),
  remove: (wsId, id) =>
    set((s) => {
      if (!(id in s.byId)) return s;
      const byId = { ...s.byId };
      delete byId[id];
      const nav = { ...s.nav };
      delete nav[id];
      return { byId, nav, order: { ...s.order, [wsId]: (s.order[wsId] ?? []).filter((x) => x !== id) }, open: s.open === id ? null : s.open };
    }),
  dropWorkspace: (wsId) =>
    set((s) => {
      const byId = Object.fromEntries(Object.entries(s.byId).filter(([, a]) => a.workspaceId !== wsId));
      const order = { ...s.order };
      delete order[wsId];
      return { byId, order, open: s.open && byId[s.open] ? s.open : null };
    }),
  reorder: (wsId, ids) => set((s) => ({ order: { ...s.order, [wsId]: ids } })),
  setOpen: (appId) => set((s) => (s.open === appId ? s : { open: appId })),
  setNav: (n) => set((s) => ({ nav: { ...s.nav, [n.appId]: n } })),
  reset: () => set({ byId: {}, order: {}, open: null, nav: {}, reloadApp: null }),
}));

/** The apps of a snapshot (READY, WORKSPACE_CREATE); a guest's snapshot carries none. */
export function applySnapshotApps(snap: WorkspaceSnapshot): void {
  if (snap.workspace) useWebApps.getState().setWorkspace(snap.workspace.id, snap.apps);
}

const NONE: string[] = [];

/** The app ids of a workspace by position (the same array while unchanged). */
export function useWorkspaceAppIds(wsId: string): string[] {
  return useWebApps((s) => s.order[wsId] ?? NONE);
}

/** The open app of workspace `wsId`, or null (another workspace's app is not «open» here). */
export function useOpenApp(wsId: string | null): string | null {
  return useWebApps((s) => (s.open && wsId && s.byId[s.open]?.workspaceId === wsId ? s.open : null));
}
