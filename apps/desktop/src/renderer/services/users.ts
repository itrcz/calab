import { api } from '../lib/api/endpoints';
import { formerKey, setUnknownUserHandler, useWorkspaces } from '../stores/workspaces';

/**
 * Profiles of people the snapshot does not carry (ADR-0097 §2): authors of old messages, task
 * assignees, event attendees who left. Unknown ids of one workspace are collected for 100 ms and
 * asked in one GET …/users?ids= (≤ 100 per request); an id in flight is not asked again, and one
 * the server did not return (not a past member / failed) is not asked again this session.
 */
export const RESOLVE_DEBOUNCE_MS = 100;
export const RESOLVE_BATCH = 100;

interface Queue {
  ids: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const queues = new Map<string, Queue>();
const inflight = new Set<string>();
const settled = new Set<string>(); // asked once (answered or not): the negative cache

const key = (wsId: string, id: string): string => `${wsId}:${id}`;

async function flush(wsId: string): Promise<void> {
  const q = queues.get(wsId);
  if (!q) return;
  queues.delete(wsId);
  const all = [...q.ids];
  for (let i = 0; i < all.length; i += RESOLVE_BATCH) {
    const ids = all.slice(i, i + RESOLVE_BATCH);
    for (const id of ids) inflight.add(key(wsId, id));
    try {
      const r = await api.workspaces.users(wsId, ids);
      useWorkspaces.getState().applyUserRefs(wsId, r.users);
    } catch {
      // network / forbidden: the name stays «Неизвестный»; no retry storm this session
    } finally {
      for (const id of ids) {
        inflight.delete(key(wsId, id));
        settled.add(key(wsId, id));
      }
    }
  }
}

/** Ask for the profiles of `ids` in `wsId` unless they are known, in flight or already answered. */
export function resolveUsers(wsId: string, ids: readonly string[]): void {
  const st = useWorkspaces.getState();
  for (const id of ids) {
    const k = key(wsId, id);
    if (!id || st.byId[wsId]?.members[id] || st.former[formerKey(wsId, id)] || inflight.has(k) || settled.has(k)) continue;
    let q = queues.get(wsId);
    if (!q) {
      q = { ids: new Set(), timer: undefined };
      queues.set(wsId, q);
    }
    q.ids.add(id);
    q.timer ??= setTimeout(() => void flush(wsId), RESOLVE_DEBOUNCE_MS);
  }
}

/** Tests: forget what was asked. */
export function resetResolver(): void {
  for (const q of queues.values()) clearTimeout(q.timer);
  queues.clear();
  inflight.clear();
  settled.clear();
}

setUnknownUserHandler((wsId, id) => resolveUsers(wsId, [id]));
