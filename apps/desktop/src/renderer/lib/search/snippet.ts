/**
 * Highlighted snippets of GET /api/search (ADR-0062 §1): plain text where a match is wrapped in
 * U+0002 … U+0003. The client cuts it into parts and renders the hits as <mark> elements —
 * never as HTML (the text may hold anything, «<script>» included).
 */

export const HL_START = '\u0002';
export const HL_END = '\u0003';

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/**
 * Parts of a snippet, alternating plain / hit, without empty parts. Tolerant of broken input: a
 * start inside a hit and an end outside one are dropped, an unclosed hit runs to the end. The
 * markers are single UTF-16 units, so surrogate pairs (emoji) are never split.
 */
export function snippetParts(s: string): SnippetPart[] {
  const out: SnippetPart[] = [];
  let hit = false;
  let from = 0;
  const flush = (to: number): void => {
    if (to <= from) return;
    const text = s.slice(from, to);
    const last = out.at(-1);
    if (last && last.hit === hit) last.text += text;
    else out.push({ text, hit });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== HL_START && c !== HL_END) continue;
    flush(i);
    from = i + 1;
    hit = c === HL_START;
  }
  flush(s.length);
  return out;
}

/** The snippet as plain text (markers removed). */
export function snippetText(s: string): string {
  return s.replaceAll(HL_START, '').replaceAll(HL_END, '');
}

/** Whether the snippet marks anything. */
export function snippetHasHit(s: string): boolean {
  return snippetParts(s).some((p) => p.hit);
}
