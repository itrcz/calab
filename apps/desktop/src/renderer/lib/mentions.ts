/**
 * Composer mentions (docs/05, «Упоминания»). The wire format is `@<user_id>` (+ `@everyone`,
 * `@here`); the field shows `@Имя`. These pure helpers convert between the two and find the
 * `@query` under the caret. Code spans / blocks are never touched (the server ignores them too).
 */

import { getLocale } from '../i18n';
import { foldQuery } from './memberSearch';
import { mentionTargets, parseMarkdown } from './markdown/parse';
import { achievementForMe } from './achievements';
import type { Message } from '@calaba/protocol';

/**
 * True when a message mentions me (docs/05, «Упоминания»): `@<my id>`, or `@everyone` /
 * `@here` from an author holding MENTION_EVERYONE in that room (the server ignores them
 * otherwise). Never for my own messages; code spans / blocks don't count (the renderer's parser).
 * Never for a forwarded copy either (ADR-0033 §3: someone else's text notifies nobody by @).
 * An achievement card addressed to me counts (its author is me, the recipient: ADR-0061 §4).
 */
export function mentionsMe(
  m: { content: string; authorId: string; forward?: unknown; kind?: Message['kind']; system?: Message['system'] },
  myId: string,
  authorMayMentionAll = true,
): boolean {
  // An achievement card (ADR-0061 §4) is authored by its recipient and mentions them.
  if (achievementForMe(m, myId)) return true;
  if (!myId || m.authorId === myId || m.forward || !m.content.includes('@')) return false;
  const { users, everyone } = mentionTargets(parseMarkdown(m.content));
  return users.includes(myId.toLowerCase()) || (everyone && authorMayMentionAll);
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A character that glues a following `@` to a word (`mail@x`): same class as the server. */
const BLOCKER = /[\p{L}\p{N}_.@-]/u;
/** A character that continues a name: `@Анна` must not match inside `@Аннабель`. */
const NAME_CONT = /[\p{L}\p{N}_]/u;
const WIRE_RE = new RegExp(`@(${UUID})(?![A-Za-z0-9_])`, 'gi');
export const SPECIAL = ['everyone', 'here'] as const;
/** Longest query the popover follows (names are ≤ 32 chars + a little slack). */
const MAX_QUERY = 40;

/** [start, end) ranges of ```blocks``` and `spans`, as the server finds them. */
export function codeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const block = /```[\s\S]*?```/g;
  for (let m = block.exec(text); m; m = block.exec(text)) out.push([m.index, m.index + m[0].length]);
  // Spans are searched with the blocks blanked out (keeps the indices).
  let blanked = text;
  for (const [a, b] of out) blanked = blanked.slice(0, a) + ' '.repeat(b - a) + blanked.slice(b);
  const span = /`[^`\n]*`/g;
  for (let m = span.exec(blanked); m; m = span.exec(blanked)) out.push([m.index, m.index + m[0].length]);
  return out.sort((x, y) => x[0] - y[0]);
}

const inRanges = (i: number, ranges: Array<[number, number]>): boolean => ranges.some(([a, b]) => i >= a && i < b);
const atBoundary = (text: string, i: number): boolean => i === 0 || !BLOCKER.test(text[i - 1] ?? '');

/**
 * Field → wire: `@Имя` → `@<user_id>` for the names in `known` (name → user id), longest
 * names first, only at a mention boundary, only when the name is not continued by a letter.
 */
export function toWire(text: string, known: ReadonlyMap<string, string>): string {
  const names = [...known.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length || !text.includes('@')) return text;
  const code = codeRanges(text);
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '@' && atBoundary(text, i) && !inRanges(i, code)) {
      const name = names.find((n) => text.startsWith(n, i + 1) && !NAME_CONT.test(text[i + 1 + n.length] ?? ''));
      if (name) {
        out += `@${known.get(name) ?? ''}`;
        i += 1 + name.length;
        continue;
      }
    }
    out += text.charAt(i);
    i++;
  }
  return out;
}

/**
 * Wire → field (editing a sent message): `@<user_id>` → `@Имя`. Returns the text and the
 * name → id map to convert it back on save. Unknown ids stay as they are.
 */
export function fromWire(text: string, nameOf: (id: string) => string | undefined): { text: string; mentions: Map<string, string> } {
  const mentions = new Map<string, string>();
  const code = codeRanges(text);
  const out = text.replace(WIRE_RE, (whole, id: string, at: number) => {
    if (!atBoundary(text, at) || inRanges(at, code)) return whole;
    const name = nameOf(id.toLowerCase());
    if (!name) return whole;
    mentions.set(name, id.toLowerCase());
    return `@${name}`;
  });
  return { text: out, mentions };
}

/**
 * Names members can be mentioned by without the popover (typed exactly): each name that
 * belongs to exactly one member. `@everyone` / `@here` are never shadowed by a member name.
 */
export function exactNames(members: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const m of members) {
    if (!m.name || SPECIAL.some((s) => s === m.name.toLowerCase())) continue;
    const set = owners.get(m.name) ?? new Set<string>();
    set.add(m.id);
    owners.set(m.name, set);
  }
  const out = new Map<string, string>();
  for (const [name, ids] of owners) if (ids.size === 1) out.set(name, [...ids][0] ?? '');
  return out;
}

/** The `@query` being typed right before the caret, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const from = Math.max(0, caret - MAX_QUERY - 1);
  for (let i = caret - 1; i >= from; i--) {
    const ch = text[i] ?? '';
    if (ch === '\n' || ch === '`') return null;
    if (ch !== '@') continue;
    if (!atBoundary(text, i) || inRanges(i, codeRanges(text)) || inOpenCode(text.slice(0, i))) return null;
    const query = text.slice(i + 1, caret);
    // Names may contain single spaces («Анна Смирнова»), but not start with one.
    if (/^\s|\s\s|[^\p{L}\p{N}_.\-\s]/u.test(query)) return null;
    return { start: i, query };
  }
  return null;
}

/** True when `before` ends inside a not yet closed code block or span (the user is typing code). */
function inOpenCode(before: string): boolean {
  const blocks = before.split('```');
  if (blocks.length % 2 === 0) return true;
  const line = (blocks[blocks.length - 1] ?? '').split('\n').pop() ?? '';
  return (line.match(/`/g)?.length ?? 0) % 2 === 1;
}

export interface MentionCandidate {
  id: string;
  /** Shown and inserted (nickname-aware display name). */
  name: string;
  /** Other names the member is found by (profile name when a nickname is set). */
  alt: string[];
  /** Global nickname without «@» (ADR-0077): found by it too, shown as `@nick`; never inserted. */
  nick?: string;
}

const LATIN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`".split('');
const CYRILLIC = 'йцукенгшщзхъфывапролджэячсмитьбюё'.split('');
const TO_CYR = new Map<string, string>(LATIN.map((ch, i) => [ch, CYRILLIC[i] ?? ch]));
const TO_LAT = new Map<string, string>(CYRILLIC.map((ch, i) => [ch, LATIN[i] ?? ch]));

/**
 * The query as typed in the other keyboard layout (QWERTY ↔ ЙЦУКЕН, both ways, lower-case):
 * `fyyf` → `анна`, `фтт` → `ann`. A query mixing both scripts is left as is.
 */
export function layoutSwap(query: string): string {
  const q = query.toLowerCase();
  const chars = Array.from(q);
  const hasLat = chars.some((c) => TO_CYR.has(c) && /[a-z]/.test(c));
  const hasCyr = chars.some((c) => TO_LAT.has(c));
  if (hasLat === hasCyr) return q;
  const map = hasLat ? TO_CYR : TO_LAT;
  return chars.map((c) => map.get(c) ?? c).join('');
}

/**
 * Candidates for a query: a word of the name (or of an alt name) or the nickname starts with it
 * (also when it was typed in the other keyboard layout, ranked lower); best first.
 */
export function filterCandidates(query: string, list: readonly MentionCandidate[], limit = 8): MentionCandidate[] {
  // «ё» = «е» (CBF-169, the shared fold of lib/memberSearch.ts); @-mentions stay name-only: no contacts.
  const q = foldQuery(query);
  const swapped = q ? layoutSwap(q) : q;
  const skel = q ? skeleton(q) : '';
  const score = (c: MentionCandidate): number => {
    const names = [c.name, ...c.alt, ...(c.nick ? [c.nick] : [])].map(foldQuery);
    if (!q) return 1;
    const by = (x: string): number => (names.some((n) => n.startsWith(x)) ? 2 : names.some((n) => n.split(/[\s._-]+/).some((w) => w.startsWith(x))) ? 1 : 0);
    const raw = by(q);
    if (raw) return raw + 2;
    const lay = swapped !== q ? by(swapped) : 0;
    if (lay) return lay;
    // Transliteration comes last: «ruslan» → «Руслан» (keys are cached per name).
    return skel && translitKeys(names).some((k) => k.startsWith(skel)) ? 0.5 : 0;
  };
  return list
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name, getLocale()))
    .slice(0, limit)
    .map((x) => x.c);
}

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * A script-independent key for a name or a query (RU ↔ Latin transliteration, GOST/ICAO-like and
 * tolerant): Cyrillic goes to Latin, then the spellings of one sound are folded together
 * (й y/i/j, х h/kh, ц c/ts, ч ch, ш sh, щ sch/shch, ж zh, ю yu/iu, я ya/ia, ё/е e; ь ъ dropped),
 * so «Юлия» = yuliya = iuliia and «Ruslan» = руслан. Lower-case.
 */
export function skeleton(text: string): string {
  let s = '';
  for (const ch of text.toLowerCase()) s += CYR_TO_LAT[ch] ?? ch;
  return s
    .replace(/['’`]/g, '')
    .replace(/j/g, 'y')
    .replace(/shch|sch|shh/g, '1')
    .replace(/zh/g, '2')
    .replace(/kh/g, 'h')
    .replace(/ch/g, '3')
    .replace(/sh/g, '4')
    .replace(/ts|tc/g, 'c')
    .replace(/yu|iu/g, '5')
    .replace(/ya|ia/g, '6')
    .replace(/yo|ye/g, 'e')
    .replace(/y/g, 'i')
    .replace(/i+/g, 'i');
}

const KEY_CACHE = new Map<string, string[]>();
/** Skeletons of the whole name and of each of its words, cached per name (no per-keystroke work). */
function translitKeys(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    let ks = KEY_CACHE.get(n);
    if (!ks) {
      ks = [...new Set([skeleton(n), ...n.split(/[\s._-]+/).filter(Boolean).map(skeleton)])];
      if (KEY_CACHE.size > 4000) KEY_CACHE.clear();
      KEY_CACHE.set(n, ks);
    }
    out.push(...ks);
  }
  return out;
}

/** Whether `needle` (any script) is found inside one of the names by transliteration (⌘K member search). */
export function translitIncludes(names: readonly string[], needle: string): boolean {
  const k = needle.trim() ? skeleton(needle.trim()) : '';
  return !!k && translitKeys(names.map((n) => n.toLowerCase())).some((x) => x.includes(k));
}

/** `@everyone` / `@here` entries matching the query (also by Russian words «все», «здесь»). */
export function filterSpecial(query: string): Array<(typeof SPECIAL)[number]> {
  const q = query.trim().toLowerCase();
  const alias: Record<(typeof SPECIAL)[number], string[]> = { everyone: ['everyone', 'все'], here: ['here', 'здесь'] };
  return SPECIAL.filter((s) => alias[s].some((a) => a.startsWith(q)));
}

/** Replaces the `@query` at [start, caret) with `@name ` and returns the new text and caret. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const insert = `@${name}${after.startsWith(' ') ? '' : ' '}`;
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length + (after.startsWith(' ') ? 1 : 0) };
}
