import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  CanvasActivityPageSchema,
  CanvasItemKind,
  CanvasItemResponseSchema,
  CanvasLinkResponseSchema,
  CanvasPathResponseSchema,
  CanvasPermissionsResponseSchema,
  CanvasSettingsSchema,
  CanvasVersionsResponseSchema,
  CreateCanvasItemRequestSchema,
  CreateCanvasLinkRequestSchema,
  EmptyCanvasTrashResponseSchema,
  ListCanvasItemsResponseSchema,
  SearchType,
  UpdateCanvasItemRequestSchema,
  UpdateCanvasPermissionsRequestSchema,
  UploadFileResponseSchema,
  type CanvasActivityPage,
  type CanvasItem,
  type CanvasItemRemove,
  type CanvasItemUpsert,
  type CanvasLinkResponse,
  type CanvasPermissionsResponse,
  type CanvasVersionsResponse,
  type SearchCanvasRef,
  WorkspaceRole,
} from '@calaba/protocol';
import { confirmAction } from '../components/Confirm';
import { showMode } from '../features/shell/sectionNav';
import { t } from '../i18n';
import { ApiError, body, call, callBytes, callEmpty, qs } from '../lib/api/client';
import { api, uploadInto } from '../lib/api/endpoints';
import { canvasDocHandle } from '../lib/canvas/docHandle';
import { ancestorsOf, childKey, isFolder, TOP, trashKey } from '../lib/canvas/tree';
import { pushOnTab } from '../lib/phoneNav';
import { useCanvas } from '../stores/canvas';
import { useCanvasComments } from '../stores/canvasComments';
import { itemOf, useCanvasUi } from '../stores/canvasUi';
import { toast, useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';
import { reportPlanError } from './plan';

/**
 * Canvas REST (ADR-0126 §7, proto/calaba/v1/canvas.proto) and the section's actions: the one module
 * that knows the routes; the screen (features/canvas) calls the actions, the stores hold the result.
 * Rights are the server's: a refusal comes back as a toast and an optimistic change is rolled back.
 * The canvas content never goes through here — only through the sync socket (lib/canvasSync.ts).
 */
const W = (ws: string): string => `/api/workspaces/${ws}/canvas`;
const C = (id: string): string => `/api/canvas/items/${id}`;

/** At most this many pages of a list (≤ 200 each) are read in one go. */
const MAX_PAGES = 10;

export const canvasApi = {
  list: (ws: string, p: { parent?: string; trashed?: boolean; cursor?: string }) =>
    call('GET', `${W(ws)}/items${qs({ parent: p.parent || undefined, trashed: p.trashed ? 1 : undefined, cursor: p.cursor })}`, ListCanvasItemsResponseSchema),
  get: (id: string) => call('GET', C(id), CanvasItemResponseSchema),
  path: (id: string) => call('GET', `${C(id)}/path`, CanvasPathResponseSchema),
  create: (ws: string, parentId: string, kind: CanvasItemKind, name: string) =>
    call('POST', `${W(ws)}/items`, CanvasItemResponseSchema, body(CreateCanvasItemRequestSchema, { parentId, kind, name })),
  update: (id: string, init: MessageInitShape<typeof UpdateCanvasItemRequestSchema>) => call('PATCH', C(id), CanvasItemResponseSchema, body(UpdateCanvasItemRequestSchema, init)),
  trash: (id: string) => call('POST', `${C(id)}/trash`, CanvasItemResponseSchema),
  restore: (id: string) => call('POST', `${C(id)}/restore`, CanvasItemResponseSchema),
  remove: (id: string) => callEmpty('DELETE', C(id)),
  /** «Сделать меня владельцем» of a former member's private item: the owner with «Владелец видит приватное». */
  takeOver: (id: string) => call('POST', `${C(id)}/take-over`, CanvasItemResponseSchema),
  emptyTrash: (ws: string) => call('POST', `${W(ws)}/trash/empty`, EmptyCanvasTrashResponseSchema),
  permissions: (id: string): Promise<CanvasPermissionsResponse> => call('GET', `${C(id)}/permissions`, CanvasPermissionsResponseSchema),
  setPermissions: (id: string, init: MessageInitShape<typeof UpdateCanvasPermissionsRequestSchema>) => callEmpty('PUT', `${C(id)}/permissions`, body(UpdateCanvasPermissionsRequestSchema, init)),
  versions: (id: string, cursor?: string): Promise<CanvasVersionsResponse> => call('GET', `${C(id)}/versions${qs({ cursor })}`, CanvasVersionsResponseSchema),
  /** A version's Yjs state (application/octet-stream). */
  versionState: (id: string, vid: string): Promise<Uint8Array> => callBytes(`${C(id)}/versions/${vid}`),
  /** The item's journal (CANVAS_VIEW), newest first. */
  activity: (id: string, cursor?: string): Promise<CanvasActivityPage> => call('GET', `${C(id)}/activity${qs({ cursor })}`, CanvasActivityPageSchema),
  /** The workspace's journal (CANVAS_MANAGE), optionally of one actor. */
  workspaceActivity: (ws: string, p: { actor?: string; cursor?: string } = {}): Promise<CanvasActivityPage> =>
    call('GET', `${W(ws)}/activity${qs({ actor: p.actor, cursor: p.cursor })}`, CanvasActivityPageSchema),
  /** GET / PUT …/canvas/settings — `CanvasSettings { trash_days }` (0 = never; PUT needs CANVAS_MANAGE). */
  trashDays: async (ws: string): Promise<number> => (await call('GET', `${W(ws)}/settings`, CanvasSettingsSchema)).trashDays,
  setTrashDays: (ws: string, days: number) => callEmpty('PUT', `${W(ws)}/settings`, body(CanvasSettingsSchema, { trashDays: days })),
  /** The public read-only link (ADR-0127 wave 5; the owner or CANVAS_MANAGE): `link` unset when there is none. */
  link: (id: string): Promise<CanvasLinkResponse> => call('GET', `${C(id)}/link`, CanvasLinkResponseSchema),
  /** Makes the link, or changes the expiry of the live one (its code stays). `days` 0 = never, 1, 7, 30. */
  createLink: (id: string, days: number): Promise<CanvasLinkResponse> =>
    call('POST', `${C(id)}/link`, CanvasLinkResponseSchema, body(CreateCanvasLinkRequestSchema, { expiresInDays: days })),
  deleteLink: (id: string) => callEmpty('DELETE', `${C(id)}/link`),
  /** A picture pasted or dropped on the board (CANVAS_WRITE): stored with the canvas, read with CANVAS_VIEW on it. */
  upload: (id: string, file: File) => uploadInto(`${C(id)}/files`, UploadFileResponseSchema, (r) => r.file, file, file.name, () => undefined),
};

/** Uploads a picture for canvas `id`: its media path and pixel size for the board's image object. */
export async function uploadCanvasImage(id: string, file: File): Promise<{ path: string; width: number; height: number }> {
  const meta = await canvasApi.upload(id, file).promise;
  return { path: `/api/files/${meta.id}`, width: meta.width, height: meta.height };
}

// ---------------------------------------------------------------- loading

async function readAll(ws: string, p: { parent?: string; trashed?: boolean }): Promise<CanvasItem[]> {
  const out: CanvasItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await canvasApi.list(ws, { ...p, ...(cursor ? { cursor } : {}) });
    out.push(...r.items);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

const inflight = new Map<string, Promise<void>>();

/** Loads the children of a folder (TOP = the top level). The old list stays on screen meanwhile. */
export function loadChildren(ws: string, parentId: string): Promise<void> {
  const key = childKey(ws, parentId);
  const running = inflight.get(key);
  if (running) return running;
  const st = useCanvas.getState();
  if (!st.lists[key]) st.setLoad(key, 'loading');
  const p = readAll(ws, { parent: parentId })
    .then(
      (items) => useCanvas.getState().setList(key, items),
      (e: unknown) => {
        // The folder is gone or hidden from me: it leaves the tree.
        if (parentId && e instanceof ApiError && e.status === 404) useCanvas.getState().remove(parentId);
        useCanvas.getState().setLoad(key, 'error');
      },
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The trash roots I can see, the newest deletion first. */
export async function loadTrash(ws: string): Promise<void> {
  const key = trashKey(ws);
  const st = useCanvas.getState();
  if (!st.lists[key]) st.setLoad(key, 'loading');
  try {
    useCanvas.getState().setList(key, await readAll(ws, { trashed: true }));
  } catch {
    useCanvas.getState().setLoad(key, 'error');
  }
}

/**
 * The open canvas (its own bits) and its ancestors (the crumbs; their nodes expand so the canvas is
 * visible in the tree). A canvas that is gone or hidden from me closes. `failed`: the read did not get an answer
 * (the network), so whoever waits for it can offer a retry.
 */
export async function loadItem(ws: string, id: string): Promise<'ok' | 'gone' | 'failed'> {
  if (!id) return 'gone';
  try {
    const [r, path] = await Promise.all([canvasApi.get(id), canvasApi.path(id).catch(() => null)]);
    if (path) useCanvas.getState().put(path.items.filter((i) => i.id !== id));
    if (r.item) useCanvas.getState().upsert(r.item);
    if (r.item && !r.item.trashedAt) {
      const ui = useCanvasUi.getState();
      for (const a of ancestorsOf(useCanvas.getState().items, id)) ui.setExpanded(a, true);
    }
    return r.item ? 'ok' : 'gone';
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
      useCanvas.getState().remove(id);
      if (itemOf(useCanvasUi.getState(), ws) === id) useCanvasUi.getState().openItem(ws, '');
      return 'gone';
    }
    return 'failed';
  }
}

/** The section opened: the top level, and the remembered canvas (else the first top-level canvas). */
export async function openCanvasSection(ws: string): Promise<void> {
  const open = itemOf(useCanvasUi.getState(), ws);
  if (open) void loadItem(ws, open);
  await loadChildren(ws, TOP);
  if (!itemOf(useCanvasUi.getState(), ws)) {
    const st = useCanvas.getState();
    const first = (st.lists[childKey(ws, TOP)] ?? []).find((id) => !isFolder(st.items[id]));
    if (first) useCanvasUi.getState().openItem(ws, first);
  }
}

/** Opens a canvas from anywhere (a search hit, a tree row, a crumb): the workspace, the canvas. */
export function openCanvas(ws: string, id: string): void {
  const ui = useCanvasUi.getState();
  ui.openTrash(ws, false);
  ui.openItem(ws, id);
  if (!useCanvas.getState().items[id]) void loadItem(ws, id);
  if (useUi.getState().phone.on) openPhoneItem(id);
}

/** The phone pushes a folder or a canvas as a screen over the «Холст» tab (view only, ADR-0126 §5). */
export function openPhoneItem(id: string): void {
  useUi.getState().setPhone((n) => pushOnTab(n, 'canvas', { kind: 'canvas', itemId: id }));
}

/**
 * A ⌘K hit (ADR-0126 §6): the Canvas section of the hit's workspace with the canvas open, or — for a
 * folder — the tree with the folder and everything above it expanded. An item that is gone, trashed or
 * hidden from me says so. Guests have no Canvas section: nothing to open. The phone has none yet (H6):
 * the choice is remembered for when it opens.
 */
export async function openCanvasHit(ws: string, ref: Pick<SearchCanvasRef, 'itemId' | 'folder'>): Promise<void> {
  if (!ws || useWorkspaces.getState().byId[ws]?.role === WorkspaceRole.GUEST) return;
  await loadItem(ws, ref.itemId);
  const item = useCanvas.getState().items[ref.itemId];
  if (!item || item.trashedAt) {
    toast.info(t('canvas.err.gone'));
    return;
  }
  const ui = useUi.getState();
  if (ui.activeWorkspaceId !== ws) ui.setWorkspace(ws);
  if (!ui.phone.on) showMode('canvas');
  const cui = useCanvasUi.getState();
  cui.openTrash(ws, false);
  if (ref.folder || isFolder(item)) {
    cui.setExpanded(item.id, true);
    void loadChildren(ws, item.id);
  } else cui.openItem(ws, item.id);
}

// ---------------------------------------------------------------- gateway (CANVAS_ITEM_*)

/** The section of `ws` is on screen. */
const onScreen = (ws: string): boolean => useCanvasUi.getState().active && useUi.getState().activeWorkspaceId === ws;

/** Lists to refetch, per workspace, once per synchronous burst of events (a trashed subtree sends many). */
const queued = new Map<string, Set<string>>();
function refetch(ws: string, keys: readonly string[]): void {
  const set = queued.get(ws);
  if (set) {
    for (const k of keys) set.add(k);
    return;
  }
  queued.set(ws, new Set(keys));
  queueMicrotask(() => {
    const ks = queued.get(ws) ?? new Set<string>();
    queued.delete(ws);
    const lists = useCanvas.getState().lists;
    for (const k of ks) {
      if (!lists[k]) continue;
      if (k === trashKey(ws)) void loadTrash(ws);
      else void loadChildren(ws, k.slice(ws.length + 1) === 'top' ? TOP : k.slice(ws.length + 1));
    }
  });
}

/**
 * A READY after a reconnect: events missed while away are not replayed. The section on screen
 * refetches its loaded lists and the open canvas (its my_bits); a hidden one drops its lists, which
 * reload on the next open — the same rule as the events.
 */
export function resyncCanvasTree(): void {
  const byWs = new Map<string, string[]>();
  for (const key of Object.keys(useCanvas.getState().lists)) {
    const ws = key.slice(0, key.indexOf('/'));
    byWs.set(ws, [...(byWs.get(ws) ?? []), key]);
  }
  for (const [ws, keys] of byWs) {
    if (!onScreen(ws)) {
      useCanvas.getState().forgetLists(ws);
      continue;
    }
    refetch(ws, keys);
    const open = itemOf(useCanvasUi.getState(), ws);
    if (open) void loadItem(ws, open);
  }
}

/**
 * CANVAS_ITEM_UPSERT: applied at once. The gateway fills my_bits per recipient. With the section on
 * screen the touched lists are refetched (real positions of the siblings) only when the structure
 * changed (new, moved, trashed or restored) — a rename or a preview update costs no request. A
 * hidden section keeps nothing fresh: its lists are dropped and reload on the next open (no
 * requests now).
 */
export function onCanvasItemUpsert(e: CanvasItemUpsert): void {
  const incoming = e.item;
  if (!incoming) return;
  const prev = useCanvas.getState().items[incoming.id];
  const item = prev ? { ...incoming, shared: incoming.shared || prev.shared } : incoming;
  if (!onScreen(e.workspaceId)) {
    useCanvas.getState().forgetLists(e.workspaceId);
    if (prev) useCanvas.getState().upsert(item, true);
    return;
  }
  useCanvas.getState().upsert(item, true);
  const structural = !prev || prev.parentId !== item.parentId || prev.position !== item.position || !!prev.trashedAt !== !!item.trashedAt || prev.trashedRoot !== item.trashedRoot;
  if (structural) {
    const keys = [childKey(e.workspaceId, item.parentId), trashKey(e.workspaceId)];
    if (prev && prev.parentId !== item.parentId) keys.push(childKey(e.workspaceId, prev.parentId));
    refetch(e.workspaceId, keys);
  }
}

/** CANVAS_ITEM_REMOVE: deleted forever or my access is gone; an open canvas inside it closes. */
export function onCanvasItemRemove(e: CanvasItemRemove): void {
  const st = useCanvas.getState();
  const ui = useCanvasUi.getState();
  const open = itemOf(ui, e.workspaceId);
  if (open && (open === e.itemId || ancestorsOf(st.items, open).includes(e.itemId))) ui.openItem(e.workspaceId, '');
  // The comments of the item and of every canvas below it that are held go with it (ADR-0127 wave 4).
  const cs = useCanvasComments.getState();
  for (const id of Object.keys(cs.loaded)) if (id === e.itemId || ancestorsOf(st.items, id).includes(e.itemId)) cs.forget(id);
  st.remove(e.itemId);
  if (!onScreen(e.workspaceId)) useCanvas.getState().forgetLists(e.workspaceId);
}

// ---------------------------------------------------------------- actions

const fail = (e: unknown, what: string): void => toast.fail(e, what);

/** «+ холст» / «+ папка» (at the top level or inside a folder): created untitled, a canvas opens, its row in rename. */
export async function createItem(ws: string, parentId: string, kind: CanvasItemKind): Promise<void> {
  try {
    const r = await canvasApi.create(ws, parentId, kind, '');
    if (!r.item) return;
    useCanvas.getState().upsert(r.item);
    const ui = useCanvasUi.getState();
    if (parentId) ui.setExpanded(parentId, true);
    if (kind === CanvasItemKind.CANVAS) openCanvas(ws, r.item.id);
    // Named in place right away (Enter / blur keeps «Без названия»).
    ui.setRenaming(r.item.id);
  } catch (e) {
    // 409 PLAN_LIMIT: the plan's canvas cap (Free 3, Team 30, Business 100) -> the plan toast, as the Wiki.
    if (reportPlanError(e, ws)) return;
    fail(e, kind === CanvasItemKind.FOLDER ? t('canvas.err.createFolder') : t('canvas.err.create'));
  }
}

/** Renames (the row's field commits). The old name comes back on a refusal. */
export async function renameItem(id: string, name: string, prevName: string): Promise<void> {
  const next = name.trim().slice(0, 200);
  if (next === prevName.trim()) return;
  const prev = useCanvas.getState().items[id];
  if (prev) useCanvas.getState().upsert({ ...prev, name: next });
  try {
    const r = await canvasApi.update(id, { name: next });
    const cur = useCanvas.getState().items[id];
    if (r.item && cur && cur.name === next) useCanvas.getState().upsert(r.item);
  } catch (e) {
    const cur = useCanvas.getState().items[id];
    if (cur) useCanvas.getState().upsert({ ...cur, name: prevName });
    fail(e, t('canvas.err.rename'));
  }
}

/** Sets the item's emoji ("" = back to the icon): optimistic, as a rename. */
export async function setItemEmoji(id: string, emoji: string): Promise<void> {
  const prev = useCanvas.getState().items[id];
  if (!prev || prev.emoji === emoji) return;
  useCanvas.getState().upsert({ ...prev, emoji });
  try {
    const r = await canvasApi.update(id, { emoji });
    const cur = useCanvas.getState().items[id];
    if (r.item && cur && cur.emoji === emoji) useCanvas.getState().upsert(r.item);
  } catch (e) {
    const cur = useCanvas.getState().items[id];
    if (cur) useCanvas.getState().upsert({ ...cur, emoji: prev.emoji });
    fail(e, t('canvas.err.emoji'));
  }
}

/** Moves an item (a tree drop, «Переместить»): optimistic, both lists refetched after. */
export async function moveItem(id: string, parentId: string, position: number): Promise<void> {
  const { items, lists } = useCanvas.getState();
  const prev = items[id];
  if (!prev) return;
  // position is an index among the new siblings; the store orders by the server's sparse
  // positions, so the optimistic copy takes one between its new neighbours.
  const sib = (lists[childKey(prev.workspaceId, parentId)] ?? []).filter((x) => x !== id).map((x) => items[x]?.position ?? 0);
  const lo = position > 0 ? sib[Math.min(position, sib.length) - 1] : undefined;
  const hi = position < sib.length ? sib[position] : undefined;
  const at = lo === undefined ? (hi === undefined ? 0 : hi - 1) : hi === undefined ? lo + 1 : (lo + hi) / 2;
  useCanvas.getState().upsert({ ...prev, parentId, position: at });
  try {
    const r = await canvasApi.update(id, { parentId, position });
    if (r.item) useCanvas.getState().upsert(r.item);
  } catch (e) {
    useCanvas.getState().upsert(prev);
    fail(e, t('canvas.err.move'));
    return;
  }
  if (parentId) useCanvasUi.getState().setExpanded(parentId, true);
  refetch(prev.workspaceId, [childKey(prev.workspaceId, prev.parentId), childKey(prev.workspaceId, parentId)]);
}

/** «В корзину» (a folder with everything in it): the toast offers «Отменить». */
export async function trashItem(id: string): Promise<boolean> {
  try {
    const r = await canvasApi.trash(id);
    if (r.item) useCanvas.getState().upsert(r.item);
    const name = r.item?.name || t('canvas.untitled');
    useToasts.getState().push('info', t('canvas.trashed', { name }), {
      label: t('canvas.undo'),
      run: () => void restoreItem(id),
    });
    return true;
  } catch (e) {
    fail(e, t('canvas.err.trash'));
    return false;
  }
}

export async function restoreItem(id: string): Promise<void> {
  try {
    const r = await canvasApi.restore(id);
    if (!r.item) return;
    useCanvas.getState().upsert(r.item);
    refetch(r.item.workspaceId, [childKey(r.item.workspaceId, r.item.parentId), trashKey(r.item.workspaceId)]);
  } catch (e) {
    // The canvases coming back take seats of the plan's cap (ADR-0126 addendum 23.10).
    if (reportPlanError(e, useCanvas.getState().items[id]?.workspaceId)) return;
    fail(e, t('canvas.err.restore'));
  }
}

/** «Удалить навсегда» (confirmed), with everything inside a folder. */
export async function deleteForever(id: string): Promise<void> {
  const item = useCanvas.getState().items[id];
  if (!item) return;
  if (!(await confirmAction(t('canvas.deleteTitle'), t('canvas.deleteText', { name: item.name || t('canvas.untitled') }), t('canvas.deleteForever')))) return;
  try {
    await canvasApi.remove(id);
    const open = itemOf(useCanvasUi.getState(), item.workspaceId);
    if (open && (open === id || ancestorsOf(useCanvas.getState().items, open).includes(id))) useCanvasUi.getState().openItem(item.workspaceId, '');
    useCanvas.getState().remove(id);
  } catch (e) {
    fail(e, t('canvas.err.delete'));
  }
}

/** «Очистить корзину» (confirmed): everything I may delete goes for good. */
export async function emptyTrash(ws: string): Promise<void> {
  if (!(await confirmAction(t('canvas.emptyTitle'), t('canvas.emptyText'), t('canvas.emptyTrash')))) return;
  try {
    const r = await canvasApi.emptyTrash(ws);
    toast.success(t('canvas.emptied', { n: r.deleted }));
    const open = itemOf(useCanvasUi.getState(), ws);
    if (open && useCanvas.getState().items[open]?.trashedAt) useCanvasUi.getState().openItem(ws, '');
    void loadTrash(ws);
  } catch (e) {
    fail(e, t('canvas.err.empty'));
  }
}

/**
 * Restores a version into the live document (one transaction; co-authors see it as an edit). The
 * canvas view registers the handle (lib/canvas/docHandle.ts); without it (not open, read-only) the
 * button is disabled and this refuses.
 */
export async function restoreVersion(canvasId: string, versionId: string): Promise<boolean> {
  const h = canvasDocHandle(canvasId);
  if (!h?.writable()) {
    toast.error(t('canvas.err.restoreVersion'));
    return false;
  }
  try {
    const state = await canvasApi.versionState(canvasId, versionId);
    // The canvas may have closed or turned read-only while the version loaded.
    if (canvasDocHandle(canvasId) !== h || !h.writable() || !h.restore(state)) {
      toast.error(t('canvas.err.restoreVersion'));
      return false;
    }
    toast.success(t('canvas.versions.restored'));
    return true;
  } catch (e) {
    fail(e, t('canvas.err.restoreVersion'));
    return false;
  }
}

/** Server search of names and text (ADR-0126 §6, `GET /api/search?type=canvas`): the tree's filter for items not loaded yet. */
export async function searchItems(ws: string, q: string, signal?: AbortSignal): Promise<Array<{ id: string; name: string; folder: boolean }>> {
  const r = await api.search({ q, scope: ws, type: 'canvas', limit: '20' }, signal);
  const out: Array<{ id: string; name: string; folder: boolean }> = [];
  for (const s of r.sections) {
    if (s.type !== SearchType.CANVAS) continue;
    for (const h of s.items) if (h.ref.case === 'canvas') out.push({ id: h.ref.value.itemId, name: h.title, folder: h.ref.value.folder });
  }
  return out;
}
