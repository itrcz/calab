/**
 * Search-hit splitting shared by the quick switcher and the in-room search: the query's words
 * (≥ 2 characters, case-insensitive, «е» = «ё») cut `text` into alternating plain / hit parts.
 * Odd indices are hits.
 */
export function searchWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/**
 * The search key of a text (CBF-169, as the server's searchq.Fold): lower case, «ё» → «е». Keeps
 * the length, so an index in the key is an index in the text.
 */
export function foldSearch(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

/** A word as a regex source: special characters escaped, «е» and «ё» matching each other. */
const wordPattern = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/gi, '[её]');

export function splitHits(text: string, words: string[]): string[] {
  if (!words.length || !text) return [text];
  const re = new RegExp(`(${words.map(wordPattern).join('|')})`, 'gi');
  return text.split(re);
}
