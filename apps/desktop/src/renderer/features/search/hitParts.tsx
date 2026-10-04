import { RoomType, type SearchHit } from '@calaba/protocol';
import { AudioLines, CalendarDays, FileText, Hash, Image, MessageSquareText, NotebookText, Paperclip, SquareCheckBig } from 'lucide-react';
import type { ReactNode } from 'react';
import { t, type MessageKey } from '../../i18n';
import { fmt } from '../../lib/format';
import { searchWords, splitHits } from '../../lib/markdown/highlight';
import { stamp } from '../../lib/meetingResult';
import { placeLine, type PlaceCtx } from '../../lib/search/place';
import type { SectionName } from '../../lib/search/sections';
import { snippetText } from '../../lib/search/snippet';
import { snippetNodes } from '../../lib/search/snippetNodes';
import { useBoards } from '../../stores/boards';
import { useNotes } from '../../stores/notes';
import { useRooms } from '../../stores/rooms';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { roomLabel } from '../chat/roomLabel';

/** Section titles (⌘K headers, the panel's tabs). */
export const SECTION_LABEL: Readonly<Record<SectionName, MessageKey>> = {
  messages: 'search.sec.messages',
  tasks: 'search.sec.tasks',
  task_comments: 'search.sec.comments',
  events: 'search.sec.events',
  files: 'search.sec.files',
  notes: 'search.sec.notes',
  transcripts: 'search.sec.transcripts',
};

const MARK = 'bg-transparent font-semibold text-accent-text';

/**
 * A highlighted snippet (U+0002 … U+0003 → <mark>): React text nodes only, never HTML. The
 * selected row is a neutral fill, the accent hits stay readable on it.
 */
export function Snippet({ text }: { text: string }): ReactNode {
  return snippetNodes(text, MARK);
}

/** Local highlight of the query's words (titles the server did not highlight). */
export function Words({ text, q }: { text: string; q: string }): ReactNode {
  const parts = splitHits(text, searchWords(q));
  if (parts.length === 1) return text;
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i} className={MARK}>{part}</mark> : part));
}

/** The hit's icon: its section's, an image / a document for files, a speech bubble for a DM message. */
export function HitIcon({ section, hit, className }: { section: SectionName; hit: SearchHit; className: string }): ReactNode {
  const p = { className, strokeWidth: 1.75, 'aria-hidden': true } as const;
  if (hit.ref.case === 'file') return /^image\//.test(hit.ref.value.mime) ? <Image {...p} /> : <FileText {...p} />;
  if (hit.ref.case === 'message' && useRooms.getState().byId[hit.ref.value.roomId]?.type === RoomType.DM) return <MessageSquareText {...p} />;
  switch (section) {
    case 'messages':
      return <Hash {...p} />;
    case 'tasks':
      return <SquareCheckBig {...p} />;
    case 'task_comments':
      return <MessageSquareText {...p} />;
    case 'events':
      return <CalendarDays {...p} />;
    case 'files':
      return <Paperclip {...p} />;
    case 'notes':
      return <NotebookText {...p} />;
    case 'transcripts':
      return <AudioLines {...p} />;
  }
}

/** The object's name line: the snippet itself when it is the title, else the title with the words marked. */
export function HitTitle({ hit, q }: { hit: SearchHit; q: string }): ReactNode {
  if (!hit.title) return <Snippet text={hit.snippet} />;
  if (snippetText(hit.snippet) === hit.title) return <Snippet text={hit.snippet} />;
  return <Words text={hit.title} q={q} />;
}

/** A separate fragment line is worth showing: a titled hit matched elsewhere (description, …). */
export function hasFragment(hit: SearchHit): boolean {
  return !!hit.title && !!hit.snippet && snippetText(hit.snippet) !== hit.title;
}

/** Names and formats for the place line, read from the stores at the moment of rendering. */
export function placeCtx(activeWorkspaceId: string | null): PlaceCtx {
  const rooms = useRooms.getState().byId;
  return {
    room: (id) => {
      const r = rooms[id];
      if (!r) return '';
      if (r.type === RoomType.NOTES) {
        const emoji = useNotes.getState().byRoom[id]?.emoji;
        return `${emoji || '📝'} ${r.name}`;
      }
      return roomLabel(r);
    },
    author: (ws, uid) => memberName(ws || null, uid),
    board: (id) => useBoards.getState().boards[id]?.name ?? '',
    workspace: (ws) => (ws && ws !== activeWorkspaceId ? (useWorkspaces.getState().byId[ws]?.ws.name ?? '') : ''),
    date: (ms) => fmt.listTime(new Date(ms)),
    when: (ms) => fmt.occurrence(new Date(ms)),
    offset: (ms) => stamp(ms),
    size: (n) => fmt.size(n),
  };
}

export function hitPlace(hit: SearchHit, activeWorkspaceId: string | null): string {
  return placeLine(hit, placeCtx(activeWorkspaceId));
}

/** «Все: 1000+» — the estimate is capped at 1000 by the server. */
export function totalText(n: number): string {
  return n >= 1000 ? `${fmt.number(1000)}+` : fmt.number(n);
}

export function sectionTitle(name: SectionName): string {
  return t(SECTION_LABEL[name]);
}
