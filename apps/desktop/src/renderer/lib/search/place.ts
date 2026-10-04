import { timestampMs } from '@bufbuild/protobuf/wkt';
import type { SearchHit } from '@calaba/protocol';

/**
 * The «place» line under a hit (ADR-0062 §4): where and when it is —
 *   message      «#разработка · Борис · 3 окт.»
 *   comment      «FNG-12 · Название задачи · Борис · 3 окт.»
 *   task         «FNG-12 · Доска»
 *   event        «Пт, 3 окт., 10:00 · #Созвон»
 *   file         «#общий · 1,2 МБ · 3 окт.»
 *   note         «📝 Идеи · 3 окт.»
 *   transcript   «#Созвон · 12:34 · 3 окт.»
 * plus the workspace's name when it is not the open one («Везде»). Pure: names and formats come
 * from the caller.
 */
export interface PlaceCtx {
  /** «#общий» for a room, the peer's name for a DM, «📝 Идеи» for a notes shelf; '' = unknown. */
  room: (roomId: string) => string;
  author: (workspaceId: string, userId: string) => string;
  board: (boardId: string) => string;
  /** The workspace's name when it differs from the active one, else ''. */
  workspace: (workspaceId: string) => string;
  /** A date of a hit («3 окт.»). */
  date: (ms: number) => string;
  /** The start of an event occurrence («Пт, 3 окт., 10:00»). */
  when: (ms: number) => string;
  /** An offset in a recording («12:34»). */
  offset: (ms: number) => string;
  size: (bytes: number) => string;
}

export function placeParts(h: SearchHit, c: PlaceCtx): string[] {
  const at = h.at ? timestampMs(h.at) : 0;
  const date = at ? c.date(at) : '';
  const who = h.authorId ? c.author(h.workspaceId, h.authorId) : '';
  const r = h.ref;
  let parts: string[];
  switch (r.case) {
    case 'message':
      parts = [c.room(r.value.roomId), who, date];
      break;
    case 'taskComment':
      parts = [r.value.taskKey, r.value.taskTitle, who, date];
      break;
    case 'task':
      parts = [r.value.key, c.board(r.value.boardId)];
      break;
    case 'event': {
      const start = r.value.occurrenceStart ? timestampMs(r.value.occurrenceStart) : at;
      parts = [start ? c.when(start) : '', r.value.roomId ? c.room(r.value.roomId) : ''];
      break;
    }
    case 'file':
      parts = [c.room(r.value.roomId), r.value.size > 0n ? c.size(Number(r.value.size)) : '', date];
      break;
    case 'note':
      parts = [c.room(r.value.roomId), date];
      break;
    case 'transcript':
      parts = [c.room(r.value.roomId), c.offset(Number(r.value.offsetMs)), date];
      break;
    default:
      parts = [date];
  }
  if (h.workspaceId) parts.push(c.workspace(h.workspaceId));
  return parts.filter((p) => p !== '');
}

export function placeLine(h: SearchHit, c: PlaceCtx): string {
  return placeParts(h, c).join(' · ');
}
