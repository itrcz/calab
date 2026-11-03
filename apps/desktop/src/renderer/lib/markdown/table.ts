/**
 * GFM pipe tables in messages and task comments (board #148). A comment is a chat message whose
 * text is markdown-lite; a table in it is the same `| a | b |` text the task description keeps
 * (packages/wiki-doc), drawn with the description's renderer. Pure helpers: the paste of an HTML
 * table (a sheet, a web page) becomes that text, a message with a table is detected, and previews
 * flatten it to one line.
 */
const SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const isRow = (line: string | undefined): boolean => !!line && line.includes('|') && !!line.trim();

/** Cells of a pipe row (escaped `\|` stays inside a cell). */
const cellCount = (line: string): number => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).length;

/**
 * A header + separator pair as GFM reads it: the separator has a pipe and as many columns as the
 * header. Stricter than the description parser on purpose: an ordinary chat line with a stray `|`
 * followed by `---` stays chat text.
 */
const isTableHead = (head: string | undefined, sep: string | undefined): boolean =>
  isRow(head) && !!sep && sep.includes('|') && sep.includes('-') && SEP_RE.test(sep) && cellCount(sep) === cellCount(head ?? '');

/** Start line indexes of the tables in `text` (a header row followed by a separator row), outside code fences. */
function tableStarts(text: string): number[] {
  const lines = text.split('\n');
  const out: number[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && isTableHead(line, lines[i + 1])) out.push(i);
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

/** Larger clipboard HTML is not parsed: the plain-text paste takes over (a whole sheet is not a message). */
const MAX_HTML = 512 * 1024;
const MAX_ROWS = 200;

/**
 * A pasted HTML table as a GFM pipe table (null: no table, or one a pipe table should not hold).
 * Only when the clipboard is exactly one table with more than one cell: a single copied cell, a page
 * fragment with text around the table, or several tables paste as plain text, nothing is dropped.
 * The HTML goes into an inert DOMParser document (no scripts run, nothing is fetched, nothing is
 * attached to the page); only cell text is read. `max`: the result's length limit (the field's).
 */
export function htmlTableToMarkdown(html: string, max = Infinity): string | null {
  if (!html || html.length > MAX_HTML || !/<table[\s>]/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Sheets put their CSS in the body (Google Sheets: <style> before the table): not text.
  for (const el of doc.querySelectorAll('style, script, template, noscript, title')) el.remove();
  const tables = [...doc.querySelectorAll('table')].filter((el) => !el.parentElement?.closest('table'));
  const table = tables[0];
  if (tables.length !== 1 || !table) return null;
  // Text outside the table (a paragraph copied along with it) would be lost: plain paste then.
  if (doc.body.textContent.replace(table.textContent, '').trim()) return null;
  const trs = [...table.rows];
  if (trs.length > MAX_ROWS) return null;
  const rows = trs.map((tr) => [...tr.cells].map(cellText));
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (rows.length === 0 || width === 0 || rows.length * width < 2) return null;
  const line = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  const [head = [], ...body] = rows;
  const md = [line(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
  return md.length > max ? null : md;
}

/** `md` (a table) to insert at `caret` of `text`: on lines of its own, so neighbouring text does not join its rows. */
export function asBlock(md: string, text: string, caret: number): string {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = !after ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  return `${lead}${md}${tail}`;
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
