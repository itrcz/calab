import { SearchType, type SearchHit, type SearchResponse, type SearchSection } from '@calaba/protocol';

/** Query-string names of the sections (ADR-0062 §1). */
export type SectionName = 'messages' | 'task_comments' | 'tasks' | 'events' | 'files' | 'notes' | 'transcripts';

/** The order of the sections in ⌘K and of the panel's tabs (ADR-0062 §4). */
export const SECTION_ORDER: readonly SectionName[] = ['messages', 'tasks', 'task_comments', 'events', 'files', 'notes', 'transcripts'];

const BY_TYPE: Readonly<Record<number, SectionName>> = {
  [SearchType.MESSAGES]: 'messages',
  [SearchType.TASK_COMMENTS]: 'task_comments',
  [SearchType.TASKS]: 'tasks',
  [SearchType.EVENTS]: 'events',
  [SearchType.FILES]: 'files',
  [SearchType.NOTES]: 'notes',
  [SearchType.TRANSCRIPTS]: 'transcripts',
};

export function sectionName(t: SearchType): SectionName | null {
  return BY_TYPE[t] ?? null;
}

export function isSectionName(s: string): s is SectionName {
  return (SECTION_ORDER as readonly string[]).includes(s);
}

/** Message-like sections: their hits are messages of a room (the «Только с файлами» filter applies). */
export function messageLike(s: SectionName): boolean {
  return s === 'messages' || s === 'task_comments' || s === 'notes';
}

/** A summary's sections by name, in SECTION_ORDER, absent ones skipped. */
export function orderedSections(r: Pick<SearchResponse, 'sections'>): Array<{ name: SectionName; section: SearchSection }> {
  const by = new Map<SectionName, SearchSection>();
  for (const s of r.sections) {
    const n = sectionName(s.type);
    if (n) by.set(n, s);
  }
  return SECTION_ORDER.flatMap((name) => {
    const section = by.get(name);
    return section ? [{ name, section }] : [];
  });
}

/** A stable id of a hit (row keys, dedupe across feed pages). */
export function hitId(h: SearchHit): string {
  const r = h.ref;
  switch (r.case) {
    case 'message':
    case 'note':
      return `${r.case}:${r.value.messageId}`;
    case 'taskComment':
      return `c:${r.value.messageId}`;
    case 'task':
      return `t:${r.value.taskId}`;
    case 'event':
      return `e:${r.value.eventId}`;
    case 'file':
      return `f:${r.value.fileId}:${r.value.messageId}`;
    case 'transcript':
      return `r:${r.value.recordingId}`;
    default:
      return `?:${h.snippet}`;
  }
}

/** Total shown for a section: the estimate, at least the hits we hold ("1000" means 1000+). */
export function sectionTotal(s: Pick<SearchSection, 'totalEstimate' | 'items'>): number {
  return Math.max(s.totalEstimate, s.items.length);
}

/** A task key typed as the whole query (ABC-12, case-insensitive), upper-cased; null otherwise. */
export function taskKeyOf(q: string): string | null {
  const m = /^\s*([a-z][a-z0-9]{0,9})-(\d{1,9})\s*$/i.exec(q);
  return m ? `${(m[1] ?? '').toUpperCase()}-${m[2] ?? ''}` : null;
}
