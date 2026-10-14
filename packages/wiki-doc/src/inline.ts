/**
 * markdown-lite: **bold**, *italic* / _italic_, ~~strike~~, `code`, ```code blocks```,
 * [text](https://…), bare http(s) links, mentions (@<user_id>, @everyone, @here), line breaks.
 * Produces an AST rendered by React (text is always escaped; no HTML is ever interpreted).
 */
export type MdNode =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'codeblock'; v: string; lang: string }
  | { t: 'b' | 'i' | 's'; c: MdNode[] }
  | { t: 'link'; href: string; c: MdNode[] }
  /** v: a lower-case user id, 'everyone' or 'here' (docs/05, «Упоминания»). */
  | { t: 'mention'; v: string }
  | { t: 'br' };

/**
 * Mirrors the server (apps/server/internal/messages/mentions.go): the token starts at a
 * non-word boundary ("mail@x" is not a mention) and ends at an ASCII word boundary.
 */
const MENTION_RE = /^@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|everyone|here)(?![A-Za-z0-9_])/i;
const MENTION_BLOCKER = /[\p{L}\p{N}_.@-]/u;
const URL_RE = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/;
const MAX_DEPTH = 8;

export function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** A code block in the source: [start, end) of the whole fence and its parsed parts. */
export interface Fence {
  start: number;
  end: number;
  lang: string;
  code: string;
  /** False when the message ends inside it (no closing fence). */
  closed: boolean;
}

/** Length of the backtick run starting at `i`. */
function runAt(src: string, i: number): number {
  let j = i;
  while (src.charCodeAt(j) === 96) j++;
  return j - i;
}

/** Start of the next run of exactly `n` backticks at or after `from`, or -1. */
function findRun(src: string, from: number, n: number): number {
  let i = src.indexOf('`', from);
  while (i !== -1) {
    const len = runAt(src, i);
    if (len === n) return i;
    i = src.indexOf('`', i + len);
  }
  return -1;
}

/** The language after an opening fence: only when the rest of that line is a bare word. */
const INFO_RE = /^[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*$/;

/**
 * Code blocks (docs/08, «Код в сообщениях»): a run of ≥ 3 backticks opens a block and only a
 * run of the same length closes it (so ```` can wrap text with ``` inside). `lang` is the word
 * right after the opening fence when the line ends there (```js⏎); on one line (```a b```) all of
 * it is code. An unclosed fence that ends its line runs to the end of the message (the author
 * forgot to close it); any other unmatched run of backticks is plain text.
 */
export function findFences(src: string): Fence[] {
  const out: Fence[] = [];
  let i = src.indexOf('```');
  while (i !== -1) {
    const n = runAt(src, i);
    const nl = src.indexOf('\n', i + n);
    const info = INFO_RE.exec(src.slice(i + n, nl === -1 ? src.length : nl));
    const onOwnLine = !!info && nl !== -1;
    const body = onOwnLine ? nl + 1 : i + n;
    const close = findRun(src, body, n);
    if (close === -1 && !onOwnLine) {
      i = src.indexOf('```', i + n);
      continue;
    }
    const end = close === -1 ? src.length : close + n;
    const code = src.slice(body, close === -1 ? src.length : close).replace(/\n$/, '');
    out.push({ start: i, end, lang: onOwnLine ? (info[1] ?? '') : '', code, closed: close !== -1 });
    i = src.indexOf('```', end);
  }
  return out;
}

/**
 * True when `pos` (a caret) is inside a code block not closed before it: typing there is code.
 * A fence right before the caret (```js|) counts as opened — the next line is its first.
 */
export function inCodeBlock(src: string, pos: number): boolean {
  return findFences(`${src.slice(0, pos)}\n`).some((f) => !f.closed);
}

/** Number of lines and the first `max` of them (without scanning the rest twice). */
export function clipLines(code: string, max: number): { lines: number; head: string } {
  let lines = 1;
  let cut = -1;
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) {
    if (lines === max) cut = i;
    lines++;
  }
  return { lines, head: cut === -1 ? code : code.slice(0, cut) };
}

export function parseMarkdown(src: string): MdNode[] {
  const out: MdNode[] = [];
  // Code blocks first: their content is never parsed further.
  let last = 0;
  for (const f of findFences(src)) {
    if (f.start > last) out.push(...parseInline(src.slice(last, f.start), 0));
    out.push({ t: 'codeblock', lang: f.lang, v: f.code });
    last = f.end;
  }
  if (last < src.length) out.push(...parseInline(src.slice(last), 0));
  return mergeText(out);
}

function mergeText(nodes: MdNode[]): MdNode[] {
  const res: MdNode[] = [];
  for (const n of nodes) {
    const prev = res[res.length - 1];
    if (n.t === 'text' && prev?.t === 'text') prev.v += n.v;
    else res.push(n);
  }
  return res;
}

interface Delim {
  open: string;
  t: 'b' | 'i' | 's';
}

const DELIMS: Delim[] = [
  { open: '**', t: 'b' },
  { open: '__', t: 'b' },
  { open: '~~', t: 's' },
  { open: '*', t: 'i' },
  { open: '_', t: 'i' },
];

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** `before`: the character preceding `src` in the message (mention boundary of nested runs). */
export function parseInline(src: string, depth: number, before = ''): MdNode[] {
  const out: MdNode[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    const rest = src.slice(i);

    if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()@]/.test(src[i + 1] ?? '')) {
      buf += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      // A span opens with a run of n backticks and closes with a run of exactly n
      // (``a`b`` keeps the inner backtick); one space padding on both sides is dropped.
      const n = runAt(src, i);
      const end = findRun(src, i + n, n);
      if (end > i + n) {
        let v = src.slice(i + n, end);
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1);
        flush();
        out.push({ t: 'code', v });
        i = end + n;
        continue;
      }
      buf += src.slice(i, i + n);
      i += n;
      continue;
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
      if (m && m[1] && m[2]) {
        flush();
        out.push({ t: 'link', href: m[2], c: depth < MAX_DEPTH ? parseInline(m[1], depth + 1, '[') : [{ t: 'text', v: m[1] }] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === 'h' && !isWordChar(src[i - 1])) {
      const m = URL_RE.exec(rest);
      if (m) {
        flush();
        out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '@' && !MENTION_BLOCKER.test((i ? src[i - 1] : before) || ' ')) {
      const m = MENTION_RE.exec(rest);
      if (m?.[1]) {
        flush();
        out.push({ t: 'mention', v: m[1].toLowerCase() });
        i += m[0].length;
        continue;
      }
    }
    if (depth < MAX_DEPTH) {
      const d = DELIMS.find((x) => rest.startsWith(x.open));
      if (d) {
        // Intraword underscores (snake_case) are not emphasis.
        const intraword = d.open.startsWith('_') && isWordChar(src[i - 1]);
        const after = src[i + d.open.length];
        if (!intraword && after !== undefined && !/\s/.test(after)) {
          const close = findClose(src, i + d.open.length, d.open);
          if (close > 0) {
            flush();
            out.push({ t: d.t, c: parseInline(src.slice(i + d.open.length, close), depth + 1, d.open.slice(-1)) });
            i = close + d.open.length;
            continue;
          }
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function findClose(src: string, from: number, delim: string): number {
  let j = src.indexOf(delim, from);
  while (j > from) {
    const before = src[j - 1];
    const afterClose = src[j + delim.length];
    const single = delim.length === 1;
    // "**" must not close a single "*"; the closer must follow a non-space.
    const doubled = single && (afterClose === delim || src[j - 1] === delim);
    const wordAfter = delim.startsWith('_') && isWordChar(afterClose);
    if (before !== undefined && !/\s/.test(before) && !doubled && !wordAfter) {
      // "***": the double closer takes the last two chars so the inner "*" can close italic.
      if (!single) while (src[j + delim.length] === delim[0]) j++;
      return j;
    }
    j = src.indexOf(delim, j + 1);
  }
  return -1;
}

/** Plain-text preview (notifications, reply snippets); `mention` renders a mention (default `@<v>`). */
export function toPlainText(nodes: MdNode[], mention: (v: string) => string = (v) => `@${v}`): string {
  return previewParts(nodes, mention)
    .map((p) => p.v)
    .join('');
}

/** A code block squeezed into one line for previews: whitespace runs (incl. newlines) → one space. */
export function oneLine(code: string): string {
  return code.replace(/\s+/g, ' ').trim();
}

/** A run of a one-line preview: plain text or code (drawn monospace). */
export interface PreviewPart {
  code: boolean;
  v: string;
}

/**
 * One-line preview of a message as runs (reply quote, pinned bar, DM list): text as in
 * toPlainText, inline code and code blocks as code runs — blocks on one line without the fences.
 * `max` caps the total length.
 */
export function previewParts(nodes: MdNode[], mention: (v: string) => string = (v) => `@${v}`, max = Infinity): PreviewPart[] {
  const out: PreviewPart[] = [];
  // A code block reads as a phrase of its own: a space separates it from the text around it.
  let afterBlock = false;
  const push = (code: boolean, v: string, block = false): void => {
    if (!v) return;
    const prev = out[out.length - 1];
    if (prev && !prev.code && block && !/\s$/.test(prev.v)) prev.v += ' ';
    if (!code && afterBlock && !/^\s/.test(v)) v = ` ${v}`;
    afterBlock = block;
    if (prev && !prev.code && !code) prev.v += v;
    else out.push({ code, v });
  };
  const walk = (ns: MdNode[]): void => {
    for (const n of ns) {
      if (n.t === 'code') push(true, n.v);
      else if (n.t === 'codeblock') push(true, oneLine(n.v), true);
      else if (n.t === 'text') push(false, n.v);
      else if (n.t === 'br') push(false, ' ');
      else if (n.t === 'mention') push(false, mention(n.v));
      else walk(n.c);
    }
  };
  walk(nodes);
  const res: PreviewPart[] = [];
  let left = max;
  for (const p of out) {
    if (left <= 0) break;
    const v = p.v.slice(0, left);
    left -= v.length;
    res.push({ code: p.code, v });
  }
  return res;
}

/** Mentions of a message: user ids (lower case, unique) and whether it mentions everyone (@everyone / @here). */
export function mentionTargets(nodes: MdNode[]): { users: string[]; everyone: boolean } {
  const users = new Set<string>();
  let everyone = false;
  const walk = (ns: MdNode[]): void => {
    for (const n of ns) {
      if (n.t === 'mention') {
        if (n.v === 'everyone' || n.v === 'here') everyone = true;
        else users.add(n.v);
      } else if (n.t === 'b' || n.t === 'i' || n.t === 's' || n.t === 'link') walk(n.c);
    }
  };
  walk(nodes);
  return { users: [...users], everyone };
}

/** First http(s) link of a message (link preview candidate), or undefined. */
export function firstLink(nodes: MdNode[]): string | undefined {
  for (const n of nodes) {
    if (n.t === 'link') return n.href;
    if (n.t === 'b' || n.t === 'i' || n.t === 's') {
      const inner = firstLink(n.c);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** True when the text is only 1–3 emoji (rendered large, without a bubble, like Telegram). */
export function isEmojiOnly(src: string): boolean {
  const s = src.trim();
  if (!s || s.length > 32) return false;
  const re = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;
  return re.test(s);
}
