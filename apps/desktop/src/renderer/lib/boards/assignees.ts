/**
 * Task assignees (ADR-0042 §1, owner: «несколько людей и комменты, кто за что отвечает»): the list
 * the client sends to `PUT /tasks/{id}/assignees` is always the full one, ≤ 10 people, and has
 * exactly one lead when not empty (lead first). Every edit goes through `normalize` so the
 * invariant holds whatever the UI did. Pure.
 */
export interface AssigneeDraft {
  userId: string;
  isLead: boolean;
  /** «За что отвечает», ≤ 120 characters. */
  note: string;
}

export const MAX_ASSIGNEES = 10;
export const MAX_NOTE = 120;

/** One lead (the first flagged one, else the first person), lead first, no duplicates, ≤ 10. */
export function normalize(list: readonly AssigneeDraft[]): AssigneeDraft[] {
  const seen = new Set<string>();
  const uniq: AssigneeDraft[] = [];
  for (const a of list) {
    if (!a.userId || seen.has(a.userId)) continue;
    seen.add(a.userId);
    uniq.push({ userId: a.userId, isLead: a.isLead, note: a.note.slice(0, MAX_NOTE) });
  }
  const capped = uniq.slice(0, MAX_ASSIGNEES);
  if (capped.length === 0) return capped;
  const leadIdx = Math.max(0, capped.findIndex((a) => a.isLead));
  const lead = capped[leadIdx] as AssigneeDraft;
  return [{ ...lead, isLead: true }, ...capped.filter((_, i) => i !== leadIdx).map((a) => ({ ...a, isLead: false }))];
}

/** Adds a person (the first one becomes the lead); already there = unchanged. */
export function addAssignee(list: readonly AssigneeDraft[], userId: string, note = ''): AssigneeDraft[] {
  if (list.some((a) => a.userId === userId)) return normalize(list);
  return normalize([...list, { userId, isLead: list.length === 0, note }]);
}

/** Removes a person; removing the lead makes the next one the lead. */
export function removeAssignee(list: readonly AssigneeDraft[], userId: string): AssigneeDraft[] {
  return normalize(list.filter((a) => a.userId !== userId));
}

/** Adds or removes (the «Назначить…» menu's check marks). */
export function toggleAssignee(list: readonly AssigneeDraft[], userId: string): AssigneeDraft[] {
  return list.some((a) => a.userId === userId) ? removeAssignee(list, userId) : addAssignee(list, userId);
}

/** Makes `userId` the lead (the previous lead stays an assignee). */
export function setLead(list: readonly AssigneeDraft[], userId: string): AssigneeDraft[] {
  if (!list.some((a) => a.userId === userId)) return normalize(list);
  return normalize(list.map((a) => ({ ...a, isLead: a.userId === userId })));
}

export function setNote(list: readonly AssigneeDraft[], userId: string, note: string): AssigneeDraft[] {
  return normalize(list.map((a) => (a.userId === userId ? { ...a, note: note.trim() } : a)));
}

/** «Только я»: replaces everyone with one person (the lead). */
export function only(userId: string): AssigneeDraft[] {
  return [{ userId, isLead: true, note: '' }];
}

/** Drafts of a task's assignees (the server sends the lead first). */
export function draftsOf(list: ReadonlyArray<{ userId: string; isLead: boolean; note: string }>): AssigneeDraft[] {
  return normalize(list.map((a) => ({ userId: a.userId, isLead: a.isLead, note: a.note })));
}

/** Hands `from`'s place (lead flag and note included) to `to`; `to` already there = `from` just goes. */
export function replaceAssignee(list: readonly AssigneeDraft[], from: string, to: string): AssigneeDraft[] {
  if (list.some((a) => a.userId === to)) return removeAssignee(list, from);
  return normalize(list.map((a) => (a.userId === from ? { ...a, userId: to } : a)));
}
