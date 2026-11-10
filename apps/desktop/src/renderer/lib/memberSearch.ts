/*
 * The one people / picker matcher (CBF-175): names, nickname, email, phone, internal extension.
 * Case-, accent- and «ё»-insensitive (CBF-169); a multi-word query needs every word to match some
 * field; phones match by digits only (8 = +7). Haystacks are folded once per item and cached.
 * Pure: no React, no stores. Only fields the viewer's client already holds go in (the server
 * decides who receives a contact, ADR-0077) — this module never asks for more.
 */

/** Case-, accent- and «ё»-insensitive form used for matching. */
export function foldQuery(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .trim();
}

/** Digits of a stored phone with the Russian 8 / +7 prefix unified («8 (999) 123-45-67» = «+7 999 1234567»). */
export function phoneDigits(s: string): string {
  const d = s.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) return `7${d.slice(1)}`;
  if (d.length === 10 && d.startsWith('9')) return `7${d}`;
  return d;
}

/** Digits of a typed (possibly partial) phone: a leading 8 reads as +7. */
function queryDigits(s: string): string {
  const d = s.replace(/\D/g, '');
  return d.startsWith('8') ? `7${d.slice(1)}` : d;
}

/**
 * Whether stored phone digits contain the typed ones. A leading 8 is tried both as +7 and as itself:
 * a fragment from the middle of a number («812 55…», an «8xx» extension) is not a trunk prefix.
 */
function digitsHit(stored: string, canon: string, raw: string): boolean {
  return stored.includes(canon) || (raw !== canon && stored.includes(raw));
}

/** Fewest digits that count as a phone query (an extension is 3–4; fewer would match everything). */
const MIN_PHONE_DIGITS = 3;
const PHONE_LIKE = /^[+\d\s()\-.]*\d[+\d\s()\-.]*$/;
const PHONE_WORD = /^[+\d\-().]+$/;

/** A contact field kept out of the row (email, phone, extension): matched, shown when it is why. */
export interface HiddenField {
  raw: string;
  folded: string;
  digits: string;
}

export interface Haystack {
  /** Folded names (display name, nickname, username…). */
  names: readonly string[];
  hidden: readonly HiddenField[];
}

export function buildHaystack(names: readonly string[], hidden: readonly string[] = []): Haystack {
  return {
    names: names.map(foldQuery).filter(Boolean),
    hidden: hidden.filter(Boolean).map((raw) => ({ raw, folded: foldQuery(raw), digits: phoneDigits(raw) })),
  };
}

const cache = new WeakMap<object, { hidden: readonly string[] | undefined; h: Haystack }>();
/**
 * The haystack of an item, built once per `key` object (the item's `search` array); rebuilt when the
 * same `search` array comes with another `hidden` array, so a reused name list never keeps old contacts.
 */
export function haystackOf(key: readonly string[], hidden: readonly string[] | undefined): Haystack {
  const hit = cache.get(key);
  if (hit && hit.hidden === hidden) return hit.h;
  const h = buildHaystack(key, hidden);
  cache.set(key, { hidden, h });
  return h;
}

export interface ParsedQuery {
  words: string[];
  /** The whole query folded (single spaces). */
  whole: string;
  /** Canonical digits when the query reads as a phone number, else ''. */
  phone: string;
  /** The typed digits as they are (no 8 → 7), tried as well; '' when not a phone query. */
  phoneRaw: string;
}

export function parseQuery(q: string): ParsedQuery {
  const whole = foldQuery(q).replace(/\s+/g, ' ');
  const words = whole ? whole.split(' ') : [];
  const phoneLike = PHONE_LIKE.test(whole);
  const d = phoneLike ? queryDigits(whole) : '';
  const ok = d.length >= MIN_PHONE_DIGITS;
  return { words, whole, phone: ok ? d : '', phoneRaw: ok ? whole.replace(/\D/g, '') : '' };
}

export interface Match {
  /** 0 exact name, 1 name starts with, 2 a word of a name starts with, 3 inside a name, 4 contact field. */
  rank: number;
  /** The contact that matched when no name did (shown as the row's secondary line). */
  hint: string;
}

const WORD_EDGE = /[\s._@-]/;

function nameRank(names: readonly string[], w: string): number {
  let best = -1;
  for (const n of names) {
    const at = n.indexOf(w);
    if (at < 0) continue;
    const r = n === w ? 0 : at === 0 ? 1 : WORD_EDGE.test(n[at - 1] ?? '') ? 2 : 3;
    if (best < 0 || r < best) best = r;
    if (best === 0) break;
  }
  return best;
}

function hiddenHit(hidden: readonly HiddenField[], w: string): HiddenField | undefined {
  const digits = PHONE_WORD.test(w) ? queryDigits(w) : '';
  const raw = digits ? w.replace(/\D/g, '') : '';
  return hidden.find((f) => f.folded.includes(w) || (digits.length >= MIN_PHONE_DIGITS && digitsHit(f.digits, digits, raw)));
}

/** Match of a haystack against a parsed query; null = no match; an empty query matches (rank 0). */
export function matchHaystack(h: Haystack, q: ParsedQuery): Match | null {
  if (!q.words.length) return { rank: 0, hint: '' };
  // A whole-query phone («+7 (999) 123-45-67»): spaces and brackets would split it into junk words.
  if (q.phone) {
    const f = h.hidden.find((x) => digitsHit(x.digits, q.phone, q.phoneRaw));
    if (f) return { rank: 4, hint: f.raw };
  }
  // The whole query as the start of a name beats word-by-word matching («иван пет» → «Иван Петров»).
  if (q.words.length > 1 && h.names.some((n) => n.startsWith(q.whole))) return { rank: 1, hint: '' };
  let rank = 0;
  let hint = '';
  for (const w of q.words) {
    const r = nameRank(h.names, w);
    if (r >= 0) {
      rank = Math.max(rank, r);
      continue;
    }
    const f = hiddenHit(h.hidden, w);
    if (!f) return null;
    rank = 4;
    hint ||= f.raw;
  }
  return { rank, hint };
}

/** Match a plain list of strings (names, then contacts) against a query: no caching, for one-offs and tests. */
export function matchStrings(names: readonly string[], hidden: readonly string[], query: string): Match | null {
  return matchHaystack(buildHaystack(names, hidden), parseQuery(query));
}
