import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  CreateWikiLinkRequestSchema,
  CreateWikiPageRequestSchema,
  EmptyWikiTrashResponseSchema,
  ListWikiPagesResponseSchema,
  SearchType,
  UpdateWikiPageRequestSchema,
  UpdateWikiPermissionsRequestSchema,
  UploadFileResponseSchema,
  WikiLinkResponseSchema,
  WikiPageResponseSchema,
  WikiPathResponseSchema,
  WikiPermissionsResponseSchema,
  WikiSettingsSchema,
  WikiVersionsResponseSchema,
  type FileMeta,
  type WikiLinkResponse,
  type WikiPage,
  type WikiPageRemove,
  type WikiPageUpsert,
  type WikiPermissionsResponse,
  type WikiVersionsResponse,
} from '@calaba/protocol';
import { confirmAction } from '../components/Confirm';
import { t } from '../i18n';
import { ApiError, body, call, callBytes, callEmpty, qs } from '../lib/api/client';
import { api, uploadInto } from '../lib/api/endpoints';
import { docHandle } from '../lib/wiki/docHandle';
import { ancestorsOf, childKey, exportName, TOP, trashKey } from '../lib/wiki/tree';
import { useWiki } from '../stores/wiki';
import { pageOf, useWikiUi } from '../stores/wikiUi';
import { toast, useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { pushOnTab } from '../lib/phoneNav';

/**
 * Wiki REST (ADR-0096 §8, proto/calaba/v1/wiki.proto) and the section's actions: the one module
 * that knows the routes; the screen (features/wiki) calls the actions, the stores hold the result.
 * Rights are the server's: a refusal comes back as a toast and an optimistic change is rolled back.
 * The page content never goes through here — only through the sync socket (lib/wikiSync.ts).
 */
const W = (ws: string): string => `/api/workspaces/${ws}/wiki`;
const P = (id: string): string => `/api/wiki/pages/${id}`;

/** At most this many pages of a list (≤ 200 each) are read in one go. */
const MAX_PAGES = 10;

export const wikiApi = {
  list: (ws: string, p: { parent?: string; trashed?: boolean; cursor?: string }) =>
    call('GET', `${W(ws)}/pages${qs({ parent: p.parent || undefined, trashed: p.trashed ? 1 : undefined, cursor: p.cursor })}`, ListWikiPagesResponseSchema),
  get: (id: string) => call('GET', P(id), WikiPageResponseSchema),
  path: (id: string) => call('GET', `${P(id)}/path`, WikiPathResponseSchema),
  create: (ws: string, parentId: string, title: string, icon = '') => call('POST', `${W(ws)}/pages`, WikiPageResponseSchema, body(CreateWikiPageRequestSchema, { parentId, title, icon })),
  update: (id: string, init: MessageInitShape<typeof UpdateWikiPageRequestSchema>) => call('PATCH', P(id), WikiPageResponseSchema, body(UpdateWikiPageRequestSchema, init)),
  trash: (id: string) => call('POST', `${P(id)}/trash`, WikiPageResponseSchema),
  restore: (id: string) => call('POST', `${P(id)}/restore`, WikiPageResponseSchema),
  remove: (id: string) => callEmpty('DELETE', P(id)),
  emptyTrash: (ws: string) => call('POST', `${W(ws)}/trash/empty`, EmptyWikiTrashResponseSchema),
  permissions: (id: string): Promise<WikiPermissionsResponse> => call('GET', `${P(id)}/permissions`, WikiPermissionsResponseSchema),
  setPermissions: (id: string, init: MessageInitShape<typeof UpdateWikiPermissionsRequestSchema>) => callEmpty('PUT', `${P(id)}/permissions`, body(UpdateWikiPermissionsRequestSchema, init)),
  /** A live link is updated in place and keeps its code (also how its URL is read). */
  createLink: (id: string, p: { expiresAtMs?: number | undefined; includeChildren: boolean }): Promise<WikiLinkResponse> =>
    call(
      'POST',
      `${P(id)}/link`,
      WikiLinkResponseSchema,
      body(CreateWikiLinkRequestSchema, {
        includeChildren: p.includeChildren,
        ...(p.expiresAtMs ? { expiresAt: timestampFromMs(p.expiresAtMs) } : {}),
      }),
    ),
  deleteLink: (id: string) => callEmpty('DELETE', `${P(id)}/link`),
  versions: (id: string, cursor?: string): Promise<WikiVersionsResponse> => call('GET', `${P(id)}/versions${qs({ cursor })}`, WikiVersionsResponseSchema),
  /** A version's Yjs state (application/octet-stream). */
  versionState: (id: string, vid: string): Promise<Uint8Array> => callBytes(`${P(id)}/versions/${vid}`),
  /** GET / PUT …/wiki/settings — `WikiSettings { trash_days }` (0 = never; PUT needs WIKI_MANAGE). */
  trashDays: async (ws: string): Promise<number> => (await call('GET', `${W(ws)}/settings`, WikiSettingsSchema)).trashDays,
  setTrashDays: (ws: string, days: number) => callEmpty('PUT', `${W(ws)}/settings`, body(WikiSettingsSchema, { trashDays: days })),
  /** A picture into the page (`wiki_page_files`): the editor's images and the cover. */
  upload: (id: string, file: File, onProgress: (f: number) => void = () => undefined) => uploadInto(`${P(id)}/files`, UploadFileResponseSchema, (r) => r.file, file, file.name, onProgress),
};

// ---------------------------------------------------------------- loading

async function readAll(ws: string, p: { parent?: string; trashed?: boolean }): Promise<WikiPage[]> {
  const out: WikiPage[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await wikiApi.list(ws, { ...p, ...(cursor ? { cursor } : {}) });
    out.push(...r.pages);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

const inflight = new Map<string, Promise<void>>();

/** Loads the children of a page (TOP = the top level). The old list stays on screen meanwhile. */
export function loadChildren(ws: string, parentId: string): Promise<void> {
  const key = childKey(ws, parentId);
  const running = inflight.get(key);
  if (running) return running;
  const st = useWiki.getState();
  if (!st.lists[key]) st.setLoad(key, 'loading');
  const p = readAll(ws, { parent: parentId })
    .then(
      (pages) => useWiki.getState().setList(key, pages),
      (e: unknown) => {
        // The parent is gone or hidden from me: it leaves the tree.
        if (parentId && e instanceof ApiError && e.status === 404) useWiki.getState().remove(parentId);
        useWiki.getState().setLoad(key, 'error');
      },
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The trash roots I can see, the newest deletion first. */
export async function loadTrash(ws: string): Promise<void> {
  const key = trashKey(ws);
  const st = useWiki.getState();
  if (!st.lists[key]) st.setLoad(key, 'loading');
  try {
    useWiki.getState().setList(key, await readAll(ws, { trashed: true }));
  } catch {
    useWiki.getState().setLoad(key, 'error');
  }
}

/**
 * The open page (its own bits) and its ancestors (the crumbs; their nodes expand so the page is
 * visible in the tree). A page that is gone or hidden from me closes.
 */
export async function loadPage(ws: string, id: string): Promise<void> {
  if (!id) return;
  try {
    const [r, path] = await Promise.all([wikiApi.get(id), wikiApi.path(id).catch(() => null)]);
    if (path) useWiki.getState().put(path.pages.filter((p) => p.id !== id));
    if (r.page) useWiki.getState().upsert(r.page);
    if (r.page && !r.page.trashedAt) {
      const ui = useWikiUi.getState();
      for (const a of ancestorsOf(useWiki.getState().pages, id)) ui.setExpanded(a, true);
    }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
      useWiki.getState().remove(id);
      if (pageOf(useWikiUi.getState(), ws) === id) useWikiUi.getState().openPage(ws, '');
    }
  }
}

/** The section opened: the top level, and the remembered page (else the first top-level page). */
export async function openWiki(ws: string): Promise<void> {
  const open = pageOf(useWikiUi.getState(), ws);
  if (open) void loadPage(ws, open);
  await loadChildren(ws, TOP);
  if (!pageOf(useWikiUi.getState(), ws)) {
    const first = useWiki.getState().lists[childKey(ws, TOP)]?.[0];
    if (first) useWikiUi.getState().openPage(ws, first);
  }
}

/** Opens a page from anywhere (a search hit, a subpage row, a crumb): the section, the workspace, the page. */
export function openWikiPage(ws: string, id: string): void {
  const ui = useWikiUi.getState();
  ui.openTrash(ws, false);
  ui.openPage(ws, id);
  if (!useWiki.getState().pages[id]) void loadPage(ws, id);
  // The phone pushes the page as a screen over the «Вики» tab (ADR-0096 §7).
  if (useUi.getState().phone.on) useUi.getState().setPhone((n) => pushOnTab(n, 'wiki', { kind: 'wiki', pageId: id }));
}

// ---------------------------------------------------------------- gateway (WIKI_PAGE_*)

/** The wiki of `ws` is on screen (the section open in that workspace). */
const onScreen = (ws: string): boolean => useWikiUi.getState().active && useUi.getState().activeWorkspaceId === ws;

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
    const lists = useWiki.getState().lists;
    for (const k of ks) {
      if (!lists[k]) continue;
      if (k === trashKey(ws)) void loadTrash(ws);
      else void loadChildren(ws, k.slice(ws.length + 1) === 'top' ? TOP : k.slice(ws.length + 1));
    }
  });
}

/**
 * WIKI_PAGE_UPSERT: applied at once. The gateway fills my_bits per recipient, but the event page
 * carries no link and no `shared` flag (those are for who may manage), so the known ones stay.
 * With the section on screen the touched lists are refetched (real positions of the siblings) only
 * when the structure changed (new, moved, trashed or restored) — a title, icon or preview update
 * costs no request. A hidden section keeps nothing fresh: its lists are dropped and reload on the
 * next open (no requests now).
 */
export function onWikiPageUpsert(e: WikiPageUpsert): void {
  const incoming = e.page;
  if (!incoming) return;
  const prev = useWiki.getState().pages[incoming.id];
  const page = prev ? { ...incoming, link: prev.link, shared: prev.shared } : incoming;
  if (!onScreen(e.workspaceId)) {
    useWiki.getState().forgetLists(e.workspaceId);
    if (prev) useWiki.getState().upsert(page, true);
    return;
  }
  useWiki.getState().upsert(page, true);
  const structural = !prev || prev.parentId !== page.parentId || prev.position !== page.position || !!prev.trashedAt !== !!page.trashedAt || prev.trashedRoot !== page.trashedRoot;
  if (structural) {
    const keys = [childKey(e.workspaceId, page.parentId), trashKey(e.workspaceId)];
    if (prev && prev.parentId !== page.parentId) keys.push(childKey(e.workspaceId, prev.parentId));
    refetch(e.workspaceId, keys);
  }
  // The open page: its link and sharing (not in the event) may have changed with the access.
  if (pageOf(useWikiUi.getState(), e.workspaceId) === page.id) void loadPage(e.workspaceId, page.id);
}

/** WIKI_PAGE_REMOVE: deleted forever or my access is gone; an open page inside it closes. */
export function onWikiPageRemove(e: WikiPageRemove): void {
  const st = useWiki.getState();
  const ui = useWikiUi.getState();
  const open = pageOf(ui, e.workspaceId);
  if (open && (open === e.pageId || ancestorsOf(st.pages, open).includes(e.pageId))) ui.openPage(e.workspaceId, '');
  st.remove(e.pageId);
  if (!onScreen(e.workspaceId)) useWiki.getState().forgetLists(e.workspaceId);
}

// ---------------------------------------------------------------- actions

const fail = (e: unknown, what: string): void => toast.fail(e, what);

/** «+ страница» (at the top level or under a page): created untitled, opened, its title focused. */
export async function createPage(ws: string, parentId: string): Promise<void> {
  try {
    const r = await wikiApi.create(ws, parentId, '');
    if (!r.page) return;
    useWiki.getState().upsert(r.page);
    if (parentId) useWikiUi.getState().setExpanded(parentId, true);
    titleFocus = r.page.id;
    openWikiPage(ws, r.page.id);
  } catch (e) {
    fail(e, t('wiki.err.create'));
  }
}

/** The page whose title takes the focus when it mounts (a page just created). */
let titleFocus: string | null = null;
export function takeTitleFocus(id: string): boolean {
  if (titleFocus !== id) return false;
  titleFocus = null;
  return true;
}

/** Renames (the title field debounces; the store is already optimistic). The old title comes back on a refusal. */
export async function renamePage(id: string, title: string, prevTitle: string): Promise<void> {
  const next = title.trim().slice(0, 200);
  if (next === prevTitle.trim()) return;
  try {
    const r = await wikiApi.update(id, { title: next });
    // The answer is applied only while nobody typed since (the field keeps its own text).
    const cur = useWiki.getState().pages[id];
    if (r.page && cur && cur.title.trim() === next) useWiki.getState().upsert({ ...r.page, title: cur.title });
  } catch (e) {
    const cur = useWiki.getState().pages[id];
    if (cur) useWiki.getState().upsert({ ...cur, title: prevTitle });
    fail(e, t('wiki.err.rename'));
  }
}

/** The title as typed (optimistic, before the debounced PATCH). */
export function setTitleLocal(id: string, title: string): void {
  const cur = useWiki.getState().pages[id];
  if (cur && cur.title !== title) useWiki.getState().upsert({ ...cur, title });
}

async function patch(id: string, init: MessageInitShape<typeof UpdateWikiPageRequestSchema>, optimistic: Partial<WikiPage>, what: string): Promise<boolean> {
  const prev = useWiki.getState().pages[id];
  if (!prev) return false;
  useWiki.getState().upsert({ ...prev, ...optimistic });
  try {
    const r = await wikiApi.update(id, init);
    if (r.page) useWiki.getState().upsert(r.page);
    return true;
  } catch (e) {
    useWiki.getState().upsert(prev);
    fail(e, what);
    return false;
  }
}

/** The page's emoji ('' removes it). */
export function setIcon(id: string, icon: string): void {
  void patch(id, { icon }, { icon }, t('wiki.err.update'));
}

/** Uploads a picture into the page and makes it the cover. */
export async function setCover(id: string, file: File): Promise<void> {
  try {
    const meta = await wikiApi.upload(id, file).promise;
    await patch(id, { coverFileId: meta.id }, { cover: meta }, t('wiki.err.update'));
  } catch (e) {
    fail(e, t('wiki.err.upload'));
  }
}

export function removeCover(id: string): void {
  void patch(id, { coverFileId: '' }, { cover: undefined }, t('wiki.err.update'));
}

/** Moves a page (a tree drop, «Переместить»): optimistic, both lists refetched after. */
export async function movePage(id: string, parentId: string, position: number): Promise<void> {
  const prev = useWiki.getState().pages[id];
  if (!prev) return;
  await patch(id, { parentId, position }, { parentId, position }, t('wiki.err.move'));
  if (parentId) useWikiUi.getState().setExpanded(parentId, true);
  refetch(prev.workspaceId, [childKey(prev.workspaceId, prev.parentId), childKey(prev.workspaceId, parentId)]);
}

/** «В корзину» with its subpages: the toast offers «Отменить». */
export async function trashPage(id: string): Promise<void> {
  try {
    const r = await wikiApi.trash(id);
    if (r.page) useWiki.getState().upsert(r.page);
    const name = r.page?.title || t('wiki.untitled');
    useToasts.getState().push('info', t('wiki.trashed', { name }), {
      label: t('wiki.undo'),
      run: () => void restorePage(id),
    });
  } catch (e) {
    fail(e, t('wiki.err.trash'));
  }
}

export async function restorePage(id: string): Promise<void> {
  try {
    const r = await wikiApi.restore(id);
    if (!r.page) return;
    useWiki.getState().upsert(r.page);
    refetch(r.page.workspaceId, [childKey(r.page.workspaceId, r.page.parentId), trashKey(r.page.workspaceId)]);
  } catch (e) {
    fail(e, t('wiki.err.restore'));
  }
}

/** «Удалить навсегда» (confirmed), with the subpages and their pictures. */
export async function deleteForever(id: string): Promise<void> {
  const page = useWiki.getState().pages[id];
  if (!page) return;
  if (!(await confirmAction(t('wiki.deleteTitle'), t('wiki.deleteText', { name: page.title || t('wiki.untitled') }), t('wiki.deleteForever')))) return;
  try {
    await wikiApi.remove(id);
    if (pageOf(useWikiUi.getState(), page.workspaceId) === id) useWikiUi.getState().openPage(page.workspaceId, '');
    useWiki.getState().remove(id);
  } catch (e) {
    fail(e, t('wiki.err.delete'));
  }
}

/** «Очистить корзину» (confirmed): everything I may delete goes for good. */
export async function emptyTrash(ws: string): Promise<void> {
  if (!(await confirmAction(t('wiki.emptyTitle'), t('wiki.emptyText'), t('wiki.emptyTrash')))) return;
  try {
    const r = await wikiApi.emptyTrash(ws);
    toast.success(t('wiki.emptied', { n: r.deleted }));
    const open = pageOf(useWikiUi.getState(), ws);
    if (open && useWiki.getState().pages[open]?.trashedAt) useWikiUi.getState().openPage(ws, '');
    void loadTrash(ws);
  } catch (e) {
    fail(e, t('wiki.err.empty'));
  }
}

/** «Экспорт в Markdown»: the live document serialized on this computer and saved as `<title>.md`. */
export function exportMarkdown(id: string): void {
  const page = useWiki.getState().pages[id];
  const md = docHandle(id)?.markdown(page?.title ?? '');
  if (!page || md == null) {
    toast.error(t('wiki.err.export'));
    return;
  }
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = exportName(page.title, t('wiki.untitled'));
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Restores a version into the live document (one transaction; co-authors see it as an edit). */
export async function restoreVersion(pageId: string, versionId: string): Promise<boolean> {
  const h = docHandle(pageId);
  if (!h?.writable()) {
    toast.error(t('wiki.err.restoreVersion'));
    return false;
  }
  try {
    const state = await wikiApi.versionState(pageId, versionId);
    h.restore(state);
    toast.success(t('wiki.versions.restored'));
    return true;
  } catch (e) {
    fail(e, t('wiki.err.restoreVersion'));
    return false;
  }
}

/** A picture pasted / dropped into the editor goes up into the page. */
export async function uploadImage(pageId: string, file: File): Promise<{ fileId: string; width: number; height: number }> {
  const meta: FileMeta = await wikiApi.upload(pageId, file).promise;
  return { fileId: meta.id, width: meta.width, height: meta.height };
}

/** Server search of page titles and text (ADR-0096 §7, `GET /api/search?type=wiki`): the tree's filter for pages not loaded yet. */
export async function searchPages(ws: string, q: string, signal?: AbortSignal): Promise<Array<{ id: string; title: string; icon: string }>> {
  const r = await api.search({ q, scope: ws, type: 'wiki', limit: '20' }, signal);
  const out: Array<{ id: string; title: string; icon: string }> = [];
  for (const s of r.sections) {
    if (s.type !== SearchType.WIKI) continue;
    for (const h of s.items)
      if (h.ref.case === 'wiki')
        out.push({
          id: h.ref.value.pageId,
          title: h.title,
          icon: h.ref.value.icon,
        });
  }
  return out;
}
