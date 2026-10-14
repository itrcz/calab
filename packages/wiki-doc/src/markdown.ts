/**
 * Wiki page ↔ Markdown (ADR-0096 §3): a pure serializer of the editor's ProseMirror JSON for
 * «Экспорт в Markdown», and a small parser used when markdown text is pasted. Both know only the
 * wiki schema (features/wiki/editor/extensions.ts); no editor code is imported here.
 *
 * The parser is deliberately simple (headings, lists incl. task lists, quotes, fences, rules,
 * GFM tables, paragraphs); inline marks come from the chat's markdown-lite (lib/markdown/parse).
 */
import { isSafeHref, parseMarkdown, type MdNode } from './inline';

export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  marks?: PmMark[];
  text?: string;
}

// ---------------------------------------------------------------- JSON → Markdown

/** A string attribute (numbers stringified); anything else → `d`. */
export const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);

export interface ToMarkdownOptions {
  /** URL written for an image (default: the API file path). */
  imageUrl?: (fileId: string) => string;
  /** Text written for a mention (default `@label`, `@id` without a label). */
  mention?: (id: string, label: string) => string;
}

const MARK_ORDER = ['link', 'bold', 'italic', 'strike', 'code'];

function escapeText(s: string): string {
  return s.replace(/([\\`*_~[\]])/g, '\\$1');
}

/** Escapes what would turn a line into a block marker. */
function escapeLineStart(s: string): string {
  return s.replace(/^(\s*)(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|---|```|\|)/, (_m, sp: string, mk: string) => `${sp}\\${mk}`);
}

function codeSpan(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

function sortedMarks(marks: PmMark[] | undefined): PmMark[] {
  return (marks ?? []).filter((m) => MARK_ORDER.includes(m.type)).sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

const sameMark = (a: PmMark, b: PmMark): boolean => a.type === b.type && (a.type !== 'link' || a.attrs?.['href'] === b.attrs?.['href']);

function openMark(m: PmMark): string {
  switch (m.type) {
    case 'bold':
      return '**';
    case 'italic':
      return '_';
    case 'strike':
      return '~~';
    case 'link':
      return '[';
    default:
      return '';
  }
}

function closeMark(m: PmMark): string {
  if (m.type === 'link') return `](${str(m.attrs?.['href'], '')})`;
  return openMark(m);
}

function inlineMd(nodes: PmNode[] | undefined, o: Required<ToMarkdownOptions>): string {
  let out = '';
  const active: PmMark[] = [];
  const closeTo = (keep: number): void => {
    while (active.length > keep) out += closeMark(active.pop() as PmMark);
  };
  for (const n of nodes ?? []) {
    const marks = n.type === 'text' ? sortedMarks(n.marks) : [];
    // Keep the common prefix of open marks, close the rest, open the new ones.
    let keep = 0;
    while (keep < active.length && keep < marks.length && sameMark(active[keep] as PmMark, marks[keep] as PmMark)) keep++;
    closeTo(keep);
    const code = marks.some((m) => m.type === 'code');
    for (const m of marks.slice(keep)) {
      if (m.type === 'code') continue;
      out += openMark(m);
      active.push(m);
    }
    if (n.type === 'text') out += code ? codeSpan(n.text ?? '') : escapeText(n.text ?? '');
    else if (n.type === 'hardBreak') out += '\\\n';
    else if (n.type === 'mention') out += o.mention(str(n.attrs?.['id'], ''), str(n.attrs?.['label'], ''));
  }
  closeTo(0);
  return out;
}

function plainInline(nodes: PmNode[] | undefined): string {
  return (nodes ?? []).map((n) => (n.type === 'text' ? (n.text ?? '') : n.type === 'mention' ? `@${str(n.attrs?.['label'], '')}` : '')).join('');
}

function indent(text: string, prefix: string, first = prefix): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? first + l : l ? prefix + l : l))
    .join('\n');
}

/** Every line quoted; empty lines become a bare `>` so the quote stays one block. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

function listMd(node: PmNode, o: Required<ToMarkdownOptions>): string {
  const ordered = node.type === 'orderedList';
  let n = Number(node.attrs?.['start'] ?? 1) || 1;
  return (node.content ?? [])
    .map((item) => {
      let marker = '- ';
      if (ordered) marker = `${n++}. `;
      else if (item.type === 'taskItem') marker = item.attrs?.['checked'] ? '- [x] ' : '- [ ] ';
      const body = blocksMd(item.content, o, '\n');
      return indent(body, ' '.repeat(marker.length), marker);
    })
    .join('\n');
}

function cellText(cell: PmNode, o: Required<ToMarkdownOptions>): string {
  return (cell.content ?? [])
    .map((b) => (b.type === 'paragraph' || b.type === 'heading' ? inlineMd(b.content, o) : plainInline(b.content)))
    .join('<br>')
    .replace(/\n/g, ' ')
    .replace(/\|/g, '\\|');
}

function tableMd(node: PmNode, o: Required<ToMarkdownOptions>): string {
  const rows = (node.content ?? []).map((r) => (r.content ?? []).map((c) => cellText(c, o)));
  const width = Math.max(1, ...rows.map((r) => r.length));
  const line = (cells: string[]): string => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const [head = [], ...body] = rows;
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
}

function blockMd(node: PmNode, o: Required<ToMarkdownOptions>): string {
  switch (node.type) {
    case 'paragraph':
      return escapeLineStart(inlineMd(node.content, o));
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.['level'] ?? 1)));
      return `${'#'.repeat(level)} ${inlineMd(node.content, o)}`;
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listMd(node, o);
    case 'blockquote':
      return quote(blocksMd(node.content, o));
    case 'horizontalRule':
      return '---';
    case 'codeBlock': {
      const code = plainInline(node.content);
      const longest = Math.max(2, ...(code.match(/`{3,}/g) ?? []).map((r) => r.length));
      const fence = '`'.repeat(longest + 1);
      return `${fence}${str(node.attrs?.['language'], '')}\n${code}\n${fence}`;
    }
    case 'table':
      return tableMd(node, o);
    case 'image': {
      const id = str(node.attrs?.['fileId'], '');
      return id ? `![${escapeText(str(node.attrs?.['alt'], ''))}](${o.imageUrl(id)})` : '';
    }
    case 'callout': {
      const icon = str(node.attrs?.['icon'], '💡');
      return quote(`${icon} ${blocksMd(node.content, o)}`);
    }
    case 'toggle': {
      const [summary, ...rest] = node.content ?? [];
      const head = `<details>\n<summary>${summary ? plainInline(summary.content).replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`) : ''}</summary>`;
      return rest.length ? `${head}\n\n${blocksMd(rest, o)}\n\n</details>` : `${head}\n</details>`;
    }
    default:
      return node.content ? blocksMd(node.content, o) : '';
  }
}

function blocksMd(nodes: PmNode[] | undefined, o: Required<ToMarkdownOptions>, sep = '\n\n'): string {
  return (nodes ?? [])
    .map((n) => blockMd(n, o))
    .filter((s) => s !== '')
    .join(sep);
}

/** The page as Markdown (export). `title` becomes a leading `# title` when given. */
export function toMarkdown(doc: PmNode, opts: ToMarkdownOptions & { title?: string } = {}): string {
  const o: Required<ToMarkdownOptions> = {
    imageUrl: opts.imageUrl ?? ((id) => `/api/files/${id}`),
    mention: opts.mention ?? ((id, label) => `@${label || id}`),
  };
  const body = blocksMd(doc.content, o).replace(/\n{3,}/g, '\n\n').trim();
  const title = opts.title?.trim();
  return `${title ? `# ${title}\n\n` : ''}${body}\n`;
}

// ---------------------------------------------------------------- Markdown → JSON

export interface FromMarkdownOptions {
  /** Label stored with a pasted `@<user_id>` mention. */
  mentionLabel?: (id: string) => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mdInline(nodes: MdNode[], marks: PmMark[], o: FromMarkdownOptions, out: PmNode[]): void {
  const text = (t: string, ms: PmMark[]): void => {
    if (!t) return;
    out.push(ms.length ? { type: 'text', text: t, marks: ms } : { type: 'text', text: t });
  };
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        text(n.v, marks);
        break;
      case 'code':
        text(n.v, [...marks.filter((m) => m.type === 'link'), { type: 'code' }]);
        break;
      case 'codeblock':
        text(n.v, [{ type: 'code' }]);
        break;
      case 'b':
        mdInline(n.c, [...marks, { type: 'bold' }], o, out);
        break;
      case 'i':
        mdInline(n.c, [...marks, { type: 'italic' }], o, out);
        break;
      case 's':
        mdInline(n.c, [...marks, { type: 'strike' }], o, out);
        break;
      case 'link':
        mdInline(n.c, isSafeHref(n.href) ? [{ type: 'link', attrs: { href: n.href } }, ...marks] : marks, o, out);
        break;
      case 'mention':
        if (UUID_RE.test(n.v)) out.push({ type: 'mention', attrs: { id: n.v.toLowerCase(), label: o.mentionLabel?.(n.v.toLowerCase()) ?? '' } });
        else text(`@${n.v}`, marks);
        break;
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
    }
  }
}

/** Inline content of one paragraph's lines (lines joined by hard breaks). */
function inlineFrom(lines: string[], o: FromMarkdownOptions): PmNode[] {
  const out: PmNode[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push({ type: 'hardBreak' });
    // Images: never inlined (only uploaded files are images); keep the alt text / URL as a link.
    const src = l.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => `[${alt || url}](${url})`);
    mdInline(parseMarkdown(src.replace(/\\$/, '')), [], o, out);
  });
  return out;
}

const para = (content: PmNode[]): PmNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX]?)\]\s+(.*)$|^\[([ xX]?)\]$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function parseBlocks(lines: string[], o: FromMarkdownOptions, depth: number): PmNode[] {
  const out: PmNode[] = [];
  let i = 0;
  let paraLines: string[] = [];
  const flush = (): void => {
    if (paraLines.length) out.push(para(inlineFrom(paraLines, o)));
    paraLines = [];
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const mark = fence[2] ?? '```';
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(mark)) body.push(lines[i++] ?? '');
      i++; // closing fence (or the end)
      const code = body.join('\n');
      out.push({ type: 'codeBlock', attrs: { language: fence[3] || null }, ...(code ? { content: [{ type: 'text', text: code }] } : {}) });
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      const content = inlineFrom([h[2] ?? ''], o);
      out.push({ type: 'heading', attrs: { level: Math.min(3, (h[1] ?? '#').length) }, ...(content.length ? { content } : {}) });
      i++;
      continue;
    }
    if (HR_RE.test(line) && !ITEM_RE.exec(line)?.[3]?.trim()) {
      flush();
      out.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line) && depth < 8) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) inner.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''));
      out.push({ type: 'blockquote', content: nonEmpty(parseBlocks(inner, o, depth + 1)) });
      continue;
    }
    if (line.includes('|') && TABLE_SEP_RE.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      flush();
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) rows.push(splitRow(lines[i++] ?? ''));
      const width = Math.max(...rows.map((r) => r.length));
      out.push({
        type: 'table',
        content: rows.map((r, ri) => ({
          type: 'tableRow',
          content: Array.from({ length: width }, (_, ci) => ({
            type: ri === 0 ? 'tableHeader' : 'tableCell',
            content: [para(inlineFrom([r[ci] ?? ''], o))],
          })),
        })),
      });
      continue;
    }
    const item = ITEM_RE.exec(line);
    if (item && depth < 8) {
      flush();
      const list = parseList(lines, i, o, depth);
      out.push(list.node);
      i = list.next;
      continue;
    }
    paraLines.push(line.trim());
    i++;
  }
  flush();
  return out;
}

const nonEmpty = (nodes: PmNode[]): PmNode[] => (nodes.length ? nodes : [{ type: 'paragraph' }]);

function parseList(lines: string[], start: number, o: FromMarkdownOptions, depth: number): { node: PmNode; next: number } {
  const first = ITEM_RE.exec(lines[start] ?? '');
  const baseIndent = (first?.[1] ?? '').length;
  const ordered = /\d/.test(first?.[2] ?? '');
  const task = !ordered && TASK_RE.test(first?.[3] ?? '');
  const items: PmNode[] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM_RE.exec(lines[i] ?? '');
    if (!m || (m[1] ?? '').length !== baseIndent || /\d/.test(m[2] ?? '') !== ordered) break;
    let text = m[3] ?? '';
    let checked = false;
    if (task) {
      const t = TASK_RE.exec(text);
      if (!t) break;
      checked = /x/i.test(t[1] ?? t[3] ?? '');
      text = t[2] ?? '';
    }
    const contentIndent = baseIndent + (m[2] ?? '').length + 1;
    const body: string[] = [text];
    i++;
    // Continuation: deeper-indented lines (nested lists, more paragraphs), blank lines inside.
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (!l.trim()) {
        const nextLine = lines[i + 1] ?? '';
        if (nextLine.trim() && nextLine.length - nextLine.trimStart().length > baseIndent) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      const ind = l.length - l.trimStart().length;
      if (ind <= baseIndent) break;
      body.push(l.slice(Math.min(ind, contentIndent)));
      i++;
    }
    const content = nonEmpty(parseBlocks(body, o, depth + 1));
    items.push(task ? { type: 'taskItem', attrs: { checked }, content } : { type: 'listItem', content });
  }
  const startNum = ordered ? Number.parseInt(first?.[2] ?? '1', 10) || 1 : 1;
  const type = task ? 'taskList' : ordered ? 'orderedList' : 'bulletList';
  return { node: { type, ...(ordered && startNum !== 1 ? { attrs: { start: startNum } } : {}), content: items }, next: i };
}

/** Markdown → a `doc` node of the wiki schema. */
export function fromMarkdown(md: string, opts: FromMarkdownOptions = {}): PmNode {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  return { type: 'doc', content: nonEmpty(parseBlocks(lines, opts, 0)) };
}

/** True when pasted plain text looks like Markdown (block markers or inline syntax). */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.includes('\n') && !/(\*\*|__|~~|`|\[[^\]]+\]\()/.test(text)) return false;
  return /^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|```|\|.*\|)/m.test(text) || /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\))/.test(text);
}
