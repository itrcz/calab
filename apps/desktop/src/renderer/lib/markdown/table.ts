/**
 * GFM pipe tables in messages and task comments (board #148). A comment is a chat message whose
 * text is markdown-lite; a table in it is the same `| a | b |` text the task description keeps
 * (packages/wiki-doc), drawn with the description's renderer. Pure helpers: the paste of an HTML
 * table (a sheet, a web page) becomes that text, a message with a table is detected, and previews
 * flatten it to one line.
 */
const SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const isRow = (line: string | undefined): boolean => !!line && line.includes('|') && !!line.trim();

/** Start line indexes of the tables in `text` (a header row followed by a separator row), outside code fences. */
function tableStarts(text: string): number[] {
  const lines = text.split('\n');
  const out: number[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && isRow(line) && SEP_RE.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) out.push(i);
  }
  return out;
}

/** The text holds a pipe table (rendered as a table instead of plain lines). */
export function hasTable(text: string): boolean {
  return text.includes('|') && text.includes('---') && tableStarts(text).length > 0;
}

const cellText = (el: Element): string =>
  el.textContent
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');

/** A pasted HTML table as a GFM pipe table (null: no table, or one a pipe table cannot hold). Needs a DOM. */
export function htmlTableToMarkdown(html: string): string | null {
  if (!/<table[\s>]/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH').map(cellText));
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (rows.length === 0 || width === 0) return null;
  const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  const [head = [], ...body] = rows;
  return [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
}

/** A table message in one line for previews: rows joined by « · », cells by « | »; the separator row goes. */
export function flattenTables(text: string): string {
  if (!hasTable(text)) return text;
  const lines = text.split('\n');
  const starts = new Set(tableStarts(text));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!starts.has(i)) {
      out.push(lines[i] ?? '');
      continue;
    }
    const rows: string[] = [];
    let j = i;
    while (j < lines.length && (j === i + 1 ? true : isRow(lines[j]))) {
      if (j !== i + 1) rows.push((lines[j] ?? '').trim().replace(/^\|\s*/, '').replace(/\s*\|$/, '').replace(/\s*\|\s*/g, ' | '));
      j++;
    }
    out.push(rows.join(' · '));
    i = j - 1;
  }
  return out.join('\n');
}
