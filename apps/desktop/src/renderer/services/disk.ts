import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import {
  CreateDiskFolderRequestSchema,
  CreateOfficeFileRequestSchema,
  CreateDiskLinkRequestSchema,
  DiskActivityPageSchema,
  DiskItemResponseSchema,
  DiskLinkResponseSchema,
  DiskPathResponseSchema,
  DiskPermissionsResponseSchema,
  DiskSettingsSchema,
  DiskUsageSchema,
  EmptyDiskTrashResponseSchema,
  ListDiskItemsResponseSchema,
  UpdateDiskItemRequestSchema,
  UpdateDiskPermissionsRequestSchema,
  type DiskActivityPage,
  type DiskItem,
  type DiskItemRemove,
  type DiskItemUpsert,
  type DiskLinkResponse,
  type DiskPermissionsResponse,
  type DiskUsage,
  type SearchDiskRef,
  WorkspaceRole,
} from '@calaba/protocol';
import { confirmAction } from '../components/Confirm';
import { officeOpens } from '../features/disk/office/bridge';
import { openOfficeFile } from '../features/disk/office/fileTabs';
import type { CreateKind } from '../features/disk/office/caps';
import { showMode } from '../features/shell/sectionNav';
import { t } from '../i18n';
import { ApiError, body, call, callEmpty, qs } from '../lib/api/client';
import { errorText } from '../lib/api/errors';
import { fmt } from '../lib/format';
import { filePreview } from '../lib/filePreview';
import { previewKind } from '../lib/diskPreview';
import { pushOnTab, type PhoneScreen } from '../lib/phoneNav';
import { uploadInto } from '../lib/api/endpoints';
import { columnFolders, folderKey, isFolder, previewable, ROOT, trashKey, visibleIds, type DiskSort } from '../lib/disk';
import { getLocale } from '../i18n';
import { platform } from '../platform';
import { useDisk, useDiskUploads } from '../stores/disk';
import { folderOf, useDiskUi } from '../stores/diskUi';
import { prefs } from '../stores/prefs';
import { toast, useToasts } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useWorkspaces } from '../stores/workspaces';

/**
 * Disk REST (ADR-0094 §7, proto/calaba/v1/disk.proto) and the section's actions: the one module
 * that knows the routes; the screen (features/disk) calls the actions, the stores hold the
 * result. Rights are the server's: a refusal comes back as a toast and an optimistic change is
 * rolled back.
 */
const W = (ws: string): string => `/api/workspaces/${ws}/disk`;
const I = (id: string): string => `/api/disk/items/${id}`;

const collators = new Map<string, Intl.Collator>();
/** The name order of the current locale (numeric: «2» before «10», as in Finder). */
export function collator(): Intl.Collator {
  const l = getLocale();
  let c = collators.get(l);
  if (!c) {
    c = new Intl.Collator(l, { numeric: true, sensitivity: 'base' });
    collators.set(l, c);
  }
  return c;
}

/** At most this many pages of a listing (≤ 200 each) are read in one go. */
const MAX_PAGES = 25;

export const diskApi = {
  list: (ws: string, p: { parent?: string; trashed?: boolean; cursor?: string; sort?: DiskSort }) =>
    call('GET', `${W(ws)}/items${qs({ parent: p.parent || undefined, trashed: p.trashed ? 1 : undefined, cursor: p.cursor, sort: p.sort })}`, ListDiskItemsResponseSchema),
  get: (id: string) => call('GET', I(id), DiskItemResponseSchema),
  createFolder: (ws: string, parentId: string, name: string) => call('POST', `${W(ws)}/folders`, DiskItemResponseSchema, body(CreateDiskFolderRequestSchema, { parentId, name })),
  /** «Создать → Документ / Таблица / Презентация» (ADR-0143): a blank file from the server's template. */
  createOffice: (ws: string, parentId: string, extension: string, name: string, lang: string) =>
    call('POST', `/api/workspaces/${ws}/office/create`, DiskItemResponseSchema, body(CreateOfficeFileRequestSchema, { parentId, extension, name, lang })),
  update: (id: string, init: MessageInitShape<typeof UpdateDiskItemRequestSchema>) => call('PATCH', I(id), DiskItemResponseSchema, body(UpdateDiskItemRequestSchema, init)),
  trash: (id: string) => call('POST', `${I(id)}/trash`, DiskItemResponseSchema),
  restore: (id: string) => call('POST', `${I(id)}/restore`, DiskItemResponseSchema),
  remove: (id: string) => callEmpty('DELETE', I(id)),
  /** «Сделать меня владельцем» of a former member's private item: the owner with «Владелец видит приватное». */
  takeOver: (id: string) => call('POST', `${I(id)}/take-over`, DiskItemResponseSchema),
  emptyTrash: (ws: string) => call('POST', `${W(ws)}/trash/empty`, EmptyDiskTrashResponseSchema),
  permissions: (id: string): Promise<DiskPermissionsResponse> => call('GET', `${I(id)}/permissions`, DiskPermissionsResponseSchema),
  setPermissions: (id: string, init: MessageInitShape<typeof UpdateDiskPermissionsRequestSchema>) =>
    callEmpty('PUT', `${I(id)}/permissions`, body(UpdateDiskPermissionsRequestSchema, init)),
  /** A live link is returned as is (idempotent): also how the URL of an existing link is read. */
  createLink: (id: string, expiresAtMs?: number): Promise<DiskLinkResponse> =>
    call('POST', `${I(id)}/link`, DiskLinkResponseSchema, body(CreateDiskLinkRequestSchema, expiresAtMs ? { expiresAt: timestampFromMs(expiresAtMs) } : {})),
  deleteLink: (id: string) => callEmpty('DELETE', `${I(id)}/link`),
  usage: (ws: string): Promise<DiskUsage> => call('GET', `${W(ws)}/usage`, DiskUsageSchema),
  activity: (ws: string, cursor?: string, actor?: string): Promise<DiskActivityPage> => call('GET', `${W(ws)}/activity${qs({ cursor, actor })}`, DiskActivityPageSchema),
  itemActivity: (id: string, cursor?: string): Promise<DiskActivityPage> => call('GET', `${I(id)}/activity${qs({ cursor })}`, DiskActivityPageSchema),
  path: (id: string) => call('GET', `${I(id)}/path`, DiskPathResponseSchema),
  /** GET / PUT …/disk/settings — `DiskSettings { trash_days }` (0 = never; PUT needs DISK_MANAGE). */
  trashDays: async (ws: string): Promise<number> => (await call('GET', `${W(ws)}/settings`, DiskSettingsSchema)).trashDays,
  setTrashDays: (ws: string, days: number) => callEmpty('PUT', `${W(ws)}/settings`, body(DiskSettingsSchema, { trashDays: days })),
};

// ---------------------------------------------------------------- loading

async function readAll(ws: string, p: { parent?: string; trashed?: boolean }): Promise<DiskItem[]> {
  const out: DiskItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await diskApi.list(ws, { ...p, sort: prefs().diskSort, ...(cursor ? { cursor } : {}) });
    out.push(...r.items);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

/** Loads a folder's listing (or the trash). The old list stays on screen while it reloads. */
export async function loadListing(ws: string, folderId: string, trash: boolean): Promise<void> {
  const key = trash ? trashKey(ws) : folderKey(ws, folderId);
  const st = useDisk.getState();
  if (!st.lists[key]) st.setLoad(key, 'loading');
  try {
    const items = await readAll(ws, trash ? { trashed: true } : { parent: folderId });
    useDisk.getState().setListing(key, items);
  } catch (e) {
    // The open folder is gone or hidden from me (404): back to the root.
    if (!trash && folderId && e instanceof ApiError && e.status === 404) {
      useDiskUi.getState().openFolder(ws, ROOT);
      return;
    }
    useDisk.getState().setLoad(key, 'error');
  }
}

/** The crumbs of a folder (its ancestors and itself). */
export async function loadPath(folderId: string): Promise<void> {
  if (!folderId) return;
  try {
    const r = await diskApi.path(folderId);
    useDisk.getState().setPath(folderId, r.items);
  } catch {
    // The listing's own 404 handles a vanished folder; the crumbs just stay short.
  }
}

export async function loadUsage(ws: string): Promise<void> {
  try {
    useDisk.getState().setUsage(ws, await diskApi.usage(ws));
  } catch {
    // The meter is not drawn without data.
  }
}

/**
 * Refetches what the disk screen shows for `ws` — the open listing, the trash when it was
 * loaded, the usage — once per synchronous burst of events (a trashed subtree sends many).
 */
const queued = new Map<string, Set<string>>();
export function refreshDisk(ws: string, parents: readonly string[] = []): void {
  const pending = queued.get(ws);
  if (pending) {
    for (const p of parents) pending.add(p);
    return;
  }
  queued.set(ws, new Set(parents));
  queueMicrotask(() => {
    const touched = queued.get(ws) ?? new Set<string>();
    queued.delete(ws);
    const ui = useDiskUi.getState();
    const trash = !!ui.trashOf[ws];
    const folder = folderOf(ui, ws);
    void loadListing(ws, folder, trash);
    // The columns view shows the ancestors too: reload those an event touched (CBF-21).
    if (!trash && prefs().diskView === 'columns') {
      for (const f of columnFolders(folder, useDisk.getState().paths[folder])) if (f !== folder && touched.has(f)) void loadListing(ws, f, false);
    }
    if (!trash && useDisk.getState().lists[trashKey(ws)]) void loadListing(ws, ROOT, true);
    void loadUsage(ws);
  });
}

/** The disk of `ws` is on screen: the section open in that workspace, or the phone's «Диск» tab (it never turns the section on). */
const onScreen = (ws: string): boolean => {
  const ui = useUi.getState();
  return (useDiskUi.getState().active || (ui.phone.on && ui.phone.tab === 'disk')) && ui.activeWorkspaceId === ws;
};

/** Workspace → mounted storage meters (the disk footer, «Место», «Тариф»). */
const meters = new Map<string, number>();

/** A meter mounted: the usage is fetched now and follows WORKSPACE_UPDATE until it unmounts. */
export function watchUsage(ws: string): () => void {
  meters.set(ws, (meters.get(ws) ?? 0) + 1);
  void loadUsage(ws);
  return () => {
    const n = (meters.get(ws) ?? 1) - 1;
    if (n > 0) meters.set(ws, n);
    else meters.delete(ws);
  };
}

/**
 * WORKSPACE_UPDATE changed the workspace's storage usage: a mounted meter refetches; without one
 * nothing is requested (the next meter fetches on mount).
 */
export function onWorkspaceStorage(ws: string): void {
  if (meters.has(ws)) void loadUsage(ws);
}

// ---------------------------------------------------------------- gateway (DISK_ITEM_*)

/**
 * DISK_ITEM_UPSERT: applied at once (an event's item has my_bits = 0 — the known bits stay) and,
 * with the section on screen, the listing is refetched for the real bits. A hidden section holds
 * no subscriptions and keeps nothing fresh: its listings are dropped and reload on the next open.
 */
export function onDiskItemUpsert(e: DiskItemUpsert): void {
  if (!e.item) return;
  if (!onScreen(e.workspaceId)) {
    useDisk.getState().forgetLists(e.workspaceId);
    return;
  }
  // A move touches the old parent too.
  const before = useDisk.getState().items[e.item.id]?.parentId;
  useDisk.getState().upsert(e.item, true);
  refreshDisk(e.workspaceId, before === undefined ? [e.item.parentId] : [e.item.parentId, before]);
}

/** DISK_ITEM_REMOVE: deleted forever or my access is gone; the open folder inside it falls back to the root. */
export function onDiskItemRemove(e: DiskItemRemove): void {
  const st = useDisk.getState();
  const parent = st.items[e.itemId]?.parentId;
  st.remove(e.itemId);
  const ui = useDiskUi.getState();
  const open = folderOf(ui, e.workspaceId);
  if (open === e.itemId || (open && st.paths[open]?.some((p) => p.id === e.itemId))) ui.openFolder(e.workspaceId, ROOT);
  if (onScreen(e.workspaceId)) refreshDisk(e.workspaceId, parent === undefined ? [] : [parent]);
  else useDisk.getState().forgetLists(e.workspaceId);
}

// ---------------------------------------------------------------- actions

const fail = (e: unknown, what: string): void => toast.fail(e, what);

/** «Новая папка»: created with a free default name (the server adds «(2)»), then renamed in place. */
export async function createFolder(ws: string, parentId: string): Promise<void> {
  try {
    const r = await diskApi.createFolder(ws, parentId, t('disk.newFolderName'));
    if (!r.item) return;
    useDisk.getState().upsert(r.item);
    useDiskUi.getState().select(r.item.id);
    useDiskUi.getState().setRenaming(r.item.id);
  } catch (e) {
    fail(e, t('disk.err.create'));
  }
}

const NEW_NAME: Record<CreateKind, 'disk.new.docxName' | 'disk.new.xlsxName' | 'disk.new.pptxName'> = { docx: 'disk.new.docxName', xlsx: 'disk.new.xlsxName', pptx: 'disk.new.pptxName' };

/**
 * «Создать → Документ / Таблица / Презентация» (ADR-0143): a blank file from the server's template
 * in this folder («Новый документ.docx», a taken name gets « (2)»), opened at once in the editor.
 * The phone only views office files: the new file stays selected in the Disk with a note.
 */
export async function createOfficeFile(ws: string, parentId: string, ext: CreateKind): Promise<void> {
  try {
    const r = await diskApi.createOffice(ws, parentId, ext, t(NEW_NAME[ext]), getLocale());
    if (!r.item) return;
    useDisk.getState().upsert(r.item);
    useDiskUi.getState().select(r.item.id);
    if (useUi.getState().phone.on) toast.info(t('disk.new.phone', { name: r.item.name }));
    else openOfficeFile({ itemId: r.item.id }, r.item.name, r.item.workspaceId);
  } catch (e) {
    fail(e, t('disk.new.failed'));
  }
}

/** Uploads at once at most this many files; the rest wait their turn. */
const PARALLEL = 3;
let uploadSeq = 0;
const waiting: Array<() => void> = [];
let running = 0;

function slot(): Promise<void> {
  if (running < PARALLEL) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/** A 429 without Retry-After waits this long; a longer Retry-After is capped (seconds). */
const LIMIT_WAIT_S = 30;
const LIMIT_WAIT_MAX_S = 3600;

/** How long to wait after a 429 of the upload rate limit (ADR-0155), with a little spread so the parallel slots do not all knock at once. */
export function limitWaitMs(retryAfterS: number | undefined, jitter = Math.random()): number {
  const s = Math.min(Math.max(retryAfterS ?? LIMIT_WAIT_S, 1), LIMIT_WAIT_MAX_S);
  return s * 1000 + Math.round(jitter * 500);
}

/** The row's text for a refused upload: 413 FILE_TOO_LARGE names the limit (ApiError.limit, bytes). */
export function uploadErrorText(e: unknown): string {
  if (e instanceof ApiError && (e.code === 'ERROR_CODE_FILE_TOO_LARGE' || (e.status === 413 && e.code !== 'ERROR_CODE_FILE_QUOTA_EXCEEDED'))) {
    const limit = e.extra.limit;
    return limit ? t('disk.upload.tooLarge', { size: fmt.size(limit) }) : t('err.fileTooLarge');
  }
  return errorText(e);
}

/**
 * Uploads files into a folder (drag & drop from the system, «Загрузить файлы»), each with its own
 * progress row. A full storage (413) stops the rest and opens «Место» with «Докупить место». The
 * upload rate limit (429) does not fail a file: the row says «Ждёт лимита загрузок» and the file
 * goes up again after Retry-After, holding its slot so the queue behind it waits too (ADR-0155).
 */
export function uploadFiles(ws: string, parentId: string, files: readonly File[]): void {
  const ups = useDiskUploads.getState();
  let full = false;
  for (const f of files) {
    const id = `up${++uploadSeq}`;
    let handle: { abort(): void } | null = null;
    let wake: (() => void) | null = null;
    let aborted = false;
    ups.add({
      id,
      wsId: ws,
      parentId,
      name: f.name,
      progress: 0,
      error: null,
      abort: () => {
        aborted = true;
        handle?.abort();
        wake?.();
        useDiskUploads.getState().done(id);
      },
    });
    const send = async (): Promise<DiskItem | null> => {
      for (;;) {
        if (aborted || full) return null;
        const up = uploadInto(
          `${W(ws)}/upload${qs({ parent: parentId || undefined })}`,
          DiskItemResponseSchema,
          (r) => r.item,
          f,
          f.name,
          (p) => useDiskUploads.getState().progress(id, p),
        );
        handle = up;
        try {
          return await up.promise;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 429)) throw e;
          useDiskUploads.getState().wait(id, true);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, limitWaitMs(e.retryAfter));
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = null;
          useDiskUploads.getState().wait(id, false);
        }
      }
    };
    void slot().then(async () => {
      try {
        const item = await send();
        useDiskUploads.getState().done(id);
        if (!item) return;
        useDisk.getState().upsert(item);
        void loadUsage(ws);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (e instanceof ApiError && e.code === 'ERROR_CODE_FILE_QUOTA_EXCEEDED') {
          useDiskUploads.getState().done(id);
          if (!full) {
            full = true;
            void loadUsage(ws);
            useDiskUi.getState().openDialog({ kind: 'usage', wsId: ws, full: true });
          }
          return;
        }
        useDiskUploads.getState().fail(id, uploadErrorText(e));
      } finally {
        release();
      }
    });
  }
}

/** Renames in place (optimistic; the old name comes back on a refusal). */
export async function renameItem(id: string, name: string): Promise<void> {
  const prev = useDisk.getState().items[id];
  const next = name.trim();
  if (!prev || !next || next === prev.name) return;
  useDisk.getState().upsert({ ...prev, name: next });
  try {
    const r = await diskApi.update(id, { name: next });
    if (r.item) useDisk.getState().upsert(r.item);
  } catch (e) {
    useDisk.getState().upsert(prev);
    fail(e, t('disk.err.rename'));
  }
}

/** Moves items into a folder (drag onto a folder or a crumb, «Переместить…»); optimistic. */
export async function moveItems(ids: readonly string[], target: string): Promise<void> {
  for (const id of ids) {
    const prev = useDisk.getState().items[id];
    if (!prev || prev.parentId === target || prev.id === target) continue;
    useDisk.getState().upsert({ ...prev, parentId: target });
    try {
      const r = await diskApi.update(id, { parentId: target });
      if (r.item) useDisk.getState().upsert(r.item);
    } catch (e) {
      useDisk.getState().upsert(prev);
      fail(e, t('disk.err.move'));
      return;
    }
  }
}

/** «В корзину»: the toast offers «Отменить» (restore). */
export async function trashItems(ids: readonly string[]): Promise<void> {
  const done: string[] = [];
  for (const id of ids) {
    try {
      const r = await diskApi.trash(id);
      if (r.item) useDisk.getState().upsert(r.item);
      done.push(id);
    } catch (e) {
      fail(e, t('disk.err.trash'));
      break;
    }
  }
  if (!done.length) return;
  const ws = useDisk.getState().items[done[0] ?? '']?.workspaceId;
  if (ws) void loadUsage(ws);
  const name = done.length === 1 ? (useDisk.getState().items[done[0] ?? '']?.name ?? '') : '';
  const text = done.length === 1 ? t('disk.trashedOne', { name }) : t('disk.trashedMany', { n: done.length });
  useToasts.getState().push('info', text, { label: t('disk.undo'), run: () => void restoreItems(done) });
}

export async function restoreItems(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      const r = await diskApi.restore(id);
      if (r.item) useDisk.getState().upsert(r.item);
    } catch (e) {
      fail(e, t('disk.err.restore'));
      return;
    }
  }
  const ws = useDisk.getState().items[ids[0] ?? '']?.workspaceId;
  if (ws) refreshDisk(ws);
}

/** «Удалить навсегда» (confirmed): the quota is freed at once (ADR-0094 §4). */
export async function deleteForever(id: string): Promise<void> {
  const item = useDisk.getState().items[id];
  if (!item) return;
  if (!(await confirmAction(t('disk.deleteTitle'), t('disk.deleteText', { name: item.name }), t('disk.deleteForever')))) return;
  try {
    await diskApi.remove(id);
    useDisk.getState().remove(id);
    void loadUsage(item.workspaceId);
  } catch (e) {
    fail(e, t('disk.err.delete'));
  }
}

/** «Очистить корзину» (confirmed): everything I may delete goes for good. */
export async function emptyTrash(ws: string): Promise<void> {
  if (!(await confirmAction(t('disk.emptyTitle'), t('disk.emptyText'), t('disk.emptyTrash')))) return;
  try {
    const r = await diskApi.emptyTrash(ws);
    toast.success(t('disk.emptied', { size: fmt.size(r.freedBytes) }));
    void loadListing(ws, ROOT, true);
    void loadUsage(ws);
  } catch (e) {
    fail(e, t('disk.err.empty'));
  }
}

/** Saves a file through the platform (the same path as chat attachments: GET /api/files/{id}). */
export function downloadItem(item: DiskItem): void {
  if (!item.file) return;
  void platform.files.download({ fileId: item.file.id, name: item.name }).then(
    () => toast.success(t('chat.downloaded', { name: item.name })),
    (e: unknown) => toast.fail(e, t('err.ctx.download')),
  );
}

/**
 * «Открыть»: a folder opens, a picture goes to the Lightbox with the other pictures of the
 * listing (←/→), a video to the player card, a PDF to the PDF viewer, anything else opens the
 * file card (CBF-20: download / send to a chat / links) — a click never starts a download.
 */
export function openItem(item: DiskItem, siblings: readonly string[] = []): void {
  if (isFolder(item)) {
    // The phone pushes the folder as a screen (ADR-0094 §8); the desktop switches its panel.
    if (useUi.getState().phone.on) openPhoneDisk({ kind: 'disk', folderId: item.id });
    else useDiskUi.getState().openFolder(item.workspaceId, item.id);
    return;
  }
  const kind = previewable(item.file);
  if (kind === 'image') {
    const { items, lists } = useDisk.getState();
    const around = siblings.length ? siblings : visibleIds(lists[folderKey(item.workspaceId, item.parentId)], items, prefs().diskSort, '', collator());
    const pics = (around.length ? around : [item.id]).map((id) => items[id]).filter((x): x is DiskItem => !!x && previewable(x.file) === 'image');
    const index = Math.max(0, pics.findIndex((x) => x.id === item.id));
    useUi.getState().openDialog({
      kind: 'image',
      images: pics.map((x) => ({ fileId: x.file?.id ?? '', name: x.name, mime: x.file?.mime ?? '', width: x.file?.width ?? 0, height: x.file?.height ?? 0 })),
      index,
      diskItemIds: pics.map((x) => x.id),
    });
    return;
  }
  if (kind === 'video') {
    useDiskUi.getState().openDialog({ kind: 'preview', itemId: item.id });
    return;
  }
  // Office files in ONLYOFFICE Docs (ADR-0143; off unless the feature is on).
  if (officeOpens(item.name)) {
    openOfficeFile({ itemId: item.id }, item.name, item.workspaceId);
    return;
  }
  // A PDF opens in the PDF viewer (ADR-0103), like a task attachment.
  if (item.file && filePreview(item.file, useUi.getState().phone.on) === 'pdf') {
    useUi.getState().openDialog({ kind: 'pdf', file: { id: item.file.id, name: item.name, size: item.file.size }, diskItemId: item.id });
    return;
  }
  // Audio (the chat's player) and text-like files (read-only viewer, CBF-22): ←/→ among such siblings.
  const phone = useUi.getState().phone.on;
  if (previewKind(item.file, phone) === 'audio' || previewKind(item.file, phone) === 'text') {
    const { items, lists } = useDisk.getState();
    const around = siblings.length ? siblings : visibleIds(lists[folderKey(item.workspaceId, item.parentId)], items, prefs().diskSort, '', collator());
    const same = (around.length ? around : [item.id]).filter((id) => {
      const k = previewKind(items[id]?.file, phone);
      return id === item.id || k === 'audio' || k === 'text';
    });
    useUi.getState().openDialog({ kind: 'disk-view', itemId: item.id, siblings: same });
    return;
  }
  openFileCard(item.id);
}

/** The file card (CBF-20): details, «Скачать», «Отправить в чат», the links. Works on every surface. */
export function openFileCard(itemId: string): void {
  useUi.getState().openDialog({ kind: 'disk-file', itemId });
}

/** «Отправить в чат…» of a Disk file: the room / people picker, then the item's link goes as a message. */
export function openSendToChat(itemId: string): void {
  useUi.getState().openDialog({ kind: 'disk-send', itemId });
}

/** The link's page URL to the clipboard (POST returns the live link as is). */
export async function copyItemLink(id: string): Promise<void> {
  try {
    const r = await diskApi.createLink(id);
    await navigator.clipboard.writeText(r.url);
    toast.success(t('disk.link.copied'));
    if (r.link) {
      const it = useDisk.getState().items[id];
      if (it && !it.link) useDisk.getState().upsert({ ...it, link: r.link });
    }
  } catch (e) {
    fail(e, t('disk.err.link'));
  }
}

/** Pushes a disk screen (a folder or the trash) over the phone's «Диск» tab. */
export function openPhoneDisk(screen: Extract<PhoneScreen, { kind: 'disk' }>): void {
  useUi.getState().setPhone((n) => pushOnTab(n, 'disk', screen));
}

/** The viewer of a file that has one in the app: a picture, a video, a PDF (as «Открыть»). */
function hasViewer(item: DiskItem): boolean {
  return previewKind(item.file, useUi.getState().phone.on) !== 'card' || officeOpens(item.name);
}

/**
 * Quick Look (CBF-22): Space on a selected file opens its preview — picture, video, PDF, audio,
 * text — or else the file card; a folder does nothing. `siblings` are the folder's visible ids (←/→).
 */
export function quickLook(item: DiskItem, siblings: readonly string[] = []): void {
  if (isFolder(item) || item.trashedAt) return;
  // Space is a glance: an editor (a whole Document Server session) is «Открыть», not a preview.
  if (officeOpens(item.name)) openFileCard(item.id);
  else openItem(item, siblings);
}

/**
 * A Disk hit of the global search (ADR-0062, section «Диск»). A picture, a video or a PDF opens its
 * viewer in place (the results stay on screen); a folder opens in the Disk; any other file opens
 * the Disk at its folder with the file selected — a search click never starts a download. A guest
 * has no Disk screen: their files open in the viewer or are saved. The phone pushes the folder over
 * its «Диск» tab. The item is read by id: its folder may be hidden from the caller.
 */
export async function openDiskHit(ws: string, ref: Pick<SearchDiskRef, 'itemId' | 'parentId' | 'folder'>): Promise<void> {
  if (!ws) return;
  let item: DiskItem | undefined;
  try {
    item = (await diskApi.get(ref.itemId)).item;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) {
      fail(e, t('disk.err.load'));
      return;
    }
  }
  if (!item || item.trashedAt) {
    toast.info(t('disk.err.gone'));
    return;
  }
  useDisk.getState().upsert(item);
  if (!isFolder(item) && hasViewer(item)) {
    openItem(item, [item.id]);
    return;
  }
  revealDiskItem(item, false);
}

/**
 * The Disk at the item's folder with the item selected (a folder opens itself); `card` also opens
 * the file card on top (a chat link, CBF-20). A guest has no Disk screen: a file goes to the card
 * (or is saved by a search hit). The phone pushes the folder over its «Диск» tab.
 */
export function revealDiskItem(item: DiskItem, card: boolean): void {
  const ws = item.workspaceId;
  if (useWorkspaces.getState().byId[ws]?.role === WorkspaceRole.GUEST) {
    if (isFolder(item)) return;
    if (card) openFileCard(item.id);
    else downloadItem(item);
    return;
  }
  const ui = useUi.getState();
  if (ui.activeWorkspaceId !== ws) ui.setWorkspace(ws);
  const folder = isFolder(item) ? item.id : item.parentId;
  if (ui.phone.on) openPhoneDisk({ kind: 'disk', folderId: folder });
  else {
    showMode('disk');
    useDiskUi.getState().openFolder(ws, folder);
  }
  if (!isFolder(item)) useDiskUi.getState().select(item.id);
  if (card && !isFolder(item)) openFileCard(item.id);
}
