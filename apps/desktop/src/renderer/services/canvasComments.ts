import {
  CanvasCommentResponseSchema,
  CanvasMentionAccessResponseSchema,
  CreateCanvasCommentRequestSchema,
  ListCanvasCommentsResponseSchema,
  PresenceStatus,
  UpdateCanvasCommentRequestSchema,
  type CanvasComment,
  type CanvasCommentDelete,
  type CanvasCommentMention,
  type CanvasCommentUpsert,
} from '@calaba/protocol';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { t } from '../i18n';
import { body, call, callEmpty, qs } from '../lib/api/client';
import { fromWire } from '../lib/mentions';
import { showNotification } from '../lib/notifyHold';
import { toSource } from '../lib/notifyClick';
import { platform } from '../platform';
import { itemOf, useCanvasUi } from '../stores/canvasUi';
import { useCanvasComments } from '../stores/canvasComments';
import { prefs } from '../stores/prefs';
import { myUserId } from '../stores/session';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { memberName } from '../stores/workspaces';
import { openCanvasHit, openPhoneItem } from './canvas';

/**
 * Canvas comments (ADR-0127 wave 4, proto/calaba/v1/canvas.proto «comments»): the REST routes, the
 * CANVAS_COMMENT_* events and the @mention notice. Rights are the server's (CANVAS_VIEW reads,
 * CANVAS_WRITE writes, the author / the owner of the canvas / CANVAS_MANAGE edit and delete): a
 * refusal comes back as a toast. The text holds mentions as `@<user_id>` like a chat message.
 */
const C = (id: string): string => `/api/canvas/items/${id}/comments`;
const K = (id: string): string => `/api/canvas/comments/${id}`;

/** A canvas holds ≤ 500 comments: 10 pages of 100 threads cover it. */
const MAX_PAGES = 10;

export const canvasCommentsApi = {
  list: (canvasId: string, cursor?: string) => call('GET', `${C(canvasId)}${qs({ cursor, limit: 100 })}`, ListCanvasCommentsResponseSchema),
  create: (canvasId: string, init: MessageInitShape<typeof CreateCanvasCommentRequestSchema>) =>
    call('POST', C(canvasId), CanvasCommentResponseSchema, body(CreateCanvasCommentRequestSchema, init)),
  update: (id: string, init: MessageInitShape<typeof UpdateCanvasCommentRequestSchema>) =>
    call('PATCH', K(id), CanvasCommentResponseSchema, body(UpdateCanvasCommentRequestSchema, init)),
  remove: (id: string) => callEmpty('DELETE', K(id)),
  mentionAccess: (canvasId: string, userIds: readonly string[]) =>
    call('GET', `${C(canvasId)}/mention-access${qs({ user_ids: userIds.join(',') })}`, CanvasMentionAccessResponseSchema),
};

/** Server limits (canvas_comments CHECK; the server answers 422 past them). */
export const COMMENT_MAX = 2000;
export const COMMENT_MENTIONS_MAX = 10;

const inflight = new Map<string, Promise<void>>();
/**
 * Events that came while a canvas's list was being read: the list may predate them. After the read, a comment the
 * list lacks is added and a deleted one goes (an edit of one it holds may be older than the list: not replayed).
 */
const missed = new Map<string, Array<{ upsert: CanvasComment } | { remove: string }>>();

/** Reads every thread of a canvas (once at a time per canvas). */
export function loadComments(canvasId: string): Promise<void> {
  const running = inflight.get(canvasId);
  if (running) return running;
  useCanvasComments.getState().setFailed(canvasId, false);
  missed.set(canvasId, []);
  const p = (async () => {
    const all: CanvasComment[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await canvasCommentsApi.list(canvasId, cursor);
      all.push(...page.comments);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const st = useCanvasComments.getState();
    st.setCanvas(canvasId, all);
    for (const m of missed.get(canvasId) ?? []) {
      if ('remove' in m) st.remove(canvasId, m.remove);
      else if (!useCanvasComments.getState().byId[m.upsert.id]) st.upsert(m.upsert);
    }
  })()
    .catch(() => useCanvasComments.getState().setFailed(canvasId, true)) // the panel offers a retry
    .finally(() => {
      inflight.delete(canvasId);
      missed.delete(canvasId);
    });
  inflight.set(canvasId, p);
  return p;
}

// ---------------------------------------------------------------- mention access

const TTL_MS = 60_000;
const BATCH = 200;
const access = new Map<string, { at: number; see: ReadonlySet<string> }>();

/** Who of `userIds` sees the canvas (the @ list): asked once a minute per canvas, in batches of 200. Null on failure. */
export async function canvasMentionAccess(canvasId: string, userIds: readonly string[], now = Date.now()): Promise<ReadonlySet<string> | null> {
  const hit = access.get(canvasId);
  if (hit && now - hit.at < TTL_MS) return hit.see;
  try {
    const see = new Set<string>();
    for (let i = 0; i < userIds.length; i += BATCH) {
      const r = await canvasCommentsApi.mentionAccess(canvasId, userIds.slice(i, i + BATCH));
      for (const id of r.seeIds) see.add(id);
    }
    access.set(canvasId, { at: Date.now(), see });
    return see;
  } catch {
    return null;
  }
}

/** The cached answer, if fresh. */
export function cachedCanvasMentionAccess(canvasId: string, now = Date.now()): ReadonlySet<string> | undefined {
  const hit = access.get(canvasId);
  return hit && now - hit.at < TTL_MS ? hit.see : undefined;
}

// ---------------------------------------------------------------- actions

const fail = (e: unknown, what: string): void => toast.fail(e, what);

/** A new thread at the draft's pin. True when written. */
export async function createThread(canvasId: string, text: string, pin: { objectId: string; x: number; y: number }): Promise<CanvasComment | null> {
  try {
    const r = await canvasCommentsApi.create(canvasId, { body: text, objectId: pin.objectId, x: pin.x, y: pin.y });
    if (r.comment) useCanvasComments.getState().upsert(r.comment);
    return r.comment ?? null;
  } catch (e) {
    fail(e, t('canvasComments.err.create'));
    return null;
  }
}

export async function replyTo(canvasId: string, rootId: string, text: string): Promise<boolean> {
  try {
    const r = await canvasCommentsApi.create(canvasId, { body: text, parentId: rootId });
    if (r.comment) useCanvasComments.getState().upsert(r.comment);
    return true;
  } catch (e) {
    fail(e, t('canvasComments.err.create'));
    return false;
  }
}

export async function editComment(id: string, text: string): Promise<boolean> {
  try {
    const r = await canvasCommentsApi.update(id, { body: text });
    if (r.comment) useCanvasComments.getState().upsert(r.comment);
    return true;
  } catch (e) {
    fail(e, t('canvasComments.err.edit'));
    return false;
  }
}

/** «Решить» / «Открыть снова»: optimistic, rolled back on a refusal. */
export async function resolveThread(id: string, resolved: boolean): Promise<void> {
  const st = useCanvasComments.getState();
  const prev = st.byId[id];
  if (prev) st.upsert({ ...prev, resolved });
  try {
    const r = await canvasCommentsApi.update(id, { resolved });
    if (r.comment) useCanvasComments.getState().upsert(r.comment);
  } catch (e) {
    if (prev) useCanvasComments.getState().upsert(prev);
    fail(e, t('canvasComments.err.resolve'));
  }
}

export async function deleteComment(c: CanvasComment): Promise<void> {
  try {
    await canvasCommentsApi.remove(c.id);
    useCanvasComments.getState().remove(c.canvasId, c.id);
  } catch (e) {
    fail(e, t('canvasComments.err.delete'));
  }
}

/** Opens a canvas at a thread (a notification, a link): the section, the canvas, the panel; the view centres on the pin. */
export async function openCanvasComment(ws: string, canvasId: string, threadId: string): Promise<void> {
  const st = useCanvasComments.getState();
  st.setFocus({ canvasId, threadId });
  st.setActive(threadId);
  st.setPanel(true);
  await openCanvasHit(ws, { itemId: canvasId, folder: false });
  if (useUi.getState().phone.on) openPhoneItem(canvasId);
}

// ---------------------------------------------------------------- gateway

/** CANVAS_COMMENT_UPSERT: to a canvas whose comments are held (the others read fresh when opened). */
export function onCanvasCommentUpsert(e: CanvasCommentUpsert): void {
  if (!e.comment) return;
  missed.get(e.comment.canvasId)?.push({ upsert: e.comment });
  useCanvasComments.getState().upsert(e.comment);
}

/** CANVAS_COMMENT_DELETE. */
export function onCanvasCommentDelete(e: CanvasCommentDelete): void {
  missed.get(e.canvasId)?.push({ remove: e.commentId });
  useCanvasComments.getState().remove(e.canvasId, e.commentId);
}

/** A fresh READY (events may have been missed): the canvases whose comments are held read them again. */
export function resyncCanvasComments(): void {
  for (const id of Object.keys(useCanvasComments.getState().loaded)) void loadComments(id);
}

/** The canvas left my reach (CANVAS_ITEM_REMOVE): its comments go too. */
export function forgetCanvasComments(canvasId: string): void {
  useCanvasComments.getState().forget(canvasId);
}

/** The notice's text with mentions as names (the server sent it only where it may be shown). */
export function noticeBody(e: Pick<CanvasCommentMention, 'workspaceId' | 'actorId' | 'text'>): string {
  const actor = memberName(e.workspaceId, e.actorId);
  if (!e.text) return t('canvasComments.notice.mentioned', { name: actor });
  const text = fromWire(e.text, (id) => memberName(e.workspaceId, id)).text;
  return `${actor}: ${text}`;
}

/**
 * CANVAS_COMMENT_MENTION: a system notification unless I am looking at that canvas («не беспокоить» silences
 * it); a click opens the canvas at the pin.
 */
export function onCanvasCommentMention(e: CanvasCommentMention): void {
  if (e.actorId === myUserId()) return;
  if (prefs().presence === PresenceStatus.DND) return;
  const ui = useCanvasUi.getState();
  const looking = document.hasFocus() && ui.active && useUi.getState().activeWorkspaceId === e.workspaceId && itemOf(ui, e.workspaceId) === e.canvasId;
  if (looking) return;
  try {
    const title = t('canvasComments.notice.title', { name: e.canvasName || t('canvas.untitled') });
    const note = showNotification(title, { body: noticeBody(e), silent: true, tag: `canvas-comment:${e.commentId}` });
    note.onclick = toSource(() => void openCanvasComment(e.workspaceId, e.canvasId, e.threadId));
  } catch {
    // notifications unavailable
  }
  platform.app.attention();
}
