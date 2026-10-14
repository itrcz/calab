/**
 * A readable «before → after» diff of two texts (ADR-0091 §2: the task history shows what a title,
 * a description or a comment was before an edit). Lines first (LCS over lines), then words inside
 * each changed block (LCS over words, whitespace and punctuation as their own tokens), so a
 * one-word fix in a long description stays one small strike-through. Pure.
 *
 * Above `DIFF_LIMIT` characters in total the history shows two blocks «Было / Стало» instead
 * (`diffable`); the counters still come from the line diff.
 */
export interface DiffOp {
  op: 'eq' | 'add' | 'del';
  text: string;
}

/** Beyond this many characters (before + after) the UI shows «Было / Стало» without a diff. */
export const DIFF_LIMIT = 20_000;

/** A table bigger than this many cells is not worth it: the block is replaced as a whole. */
const MAX_CELLS = 4_000_000;

export function diffable(before: string, after: string): boolean {
  return before.length + after.length <= DIFF_LIMIT;
}

/** Characters added and removed (the «+120 / −40» of a description row). */
export function diffStats(ops: readonly DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.op === 'add') added += o.text.length;
    else if (o.op === 'del') removed += o.text.length;
  }
  return { added, removed };
}

/** The diff of two texts, adjacent runs of one kind merged. Equal texts → one `eq` (or none). */
export function diffText(before: string, after: string): DiffOp[] {
  if (before === after) return before ? [{ op: 'eq', text: before }] : [];
  const lines = diffTokens(splitLines(before), splitLines(after));
  const out: DiffOp[] = [];
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = (): void => {
    if (dels.length && adds.length) out.push(...diffTokens(splitWords(dels.join('')), splitWords(adds.join(''))));
    else if (dels.length) out.push({ op: 'del', text: dels.join('') });
    else if (adds.length) out.push({ op: 'add', text: adds.join('') });
    dels = [];
    adds = [];
  };
  for (const o of lines) {
    if (o.op === 'del') dels.push(o.text);
    else if (o.op === 'add') adds.push(o.text);
    else {
      flush();
      out.push(o);
    }
  }
  flush();
  return merge(out);
}

/** Lines with their line breaks kept, so joining the tokens gives the text back. */
export function splitLines(s: string): string[] {
  return s ? s.split(/(?<=\n)/) : [];
}

/** Words, runs of whitespace and single punctuation marks. */
export function splitWords(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/** LCS diff of two token lists (common prefix and suffix trimmed first). Not merged. */
export function diffTokens(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffOp[] = a.slice(0, start).map((text) => ({ op: 'eq', text }));
  const tail: DiffOp[] = a.slice(endA).map((text) => ({ op: 'eq', text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const n = x.length;
  const m = y.length;
  let mid: DiffOp[];
  if (!n || !m || (n + 1) * (m + 1) > MAX_CELLS) {
    mid = [...x.map((text): DiffOp => ({ op: 'del', text })), ...y.map((text): DiffOp => ({ op: 'add', text }))];
  } else {
    // dp[i][j] = LCS length of x[i..] and y[j..].
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = x[i] === y[j] ? (dp[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + j + 1] ?? 0);
      }
    }
    mid = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        mid.push({ op: 'eq', text: x[i] ?? '' });
        i++;
        j++;
      } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + j + 1] ?? 0)) {
        mid.push({ op: 'del', text: x[i++] ?? '' });
      } else {
        mid.push({ op: 'add', text: y[j++] ?? '' });
      }
    }
    while (i < n) mid.push({ op: 'del', text: x[i++] ?? '' });
    while (j < m) mid.push({ op: 'add', text: y[j++] ?? '' });
  }
  return [...head, ...mid, ...tail];
}

/**
 * Adjacent ops of one kind joined; a whitespace-only `eq` between two changes is folded into them
 * («~~old words~~ new words» instead of a strike-through per word).
 */
function merge(ops: readonly DiffOp[]): DiffOp[] {
  const folded: DiffOp[] = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    if (!o) continue;
    const prev = folded.at(-1);
    const next = ops[k + 1];
    if (o.op === 'eq' && /^[ \t]+$/.test(o.text) && prev && prev.op !== 'eq' && next && next.op !== 'eq') {
      folded.push({ op: 'del', text: o.text }, { op: 'add', text: o.text });
      continue;
    }
    folded.push(o);
  }
  // Within a run of changes, dels first then adds; then join neighbours of one kind.
  const out: DiffOp[] = [];
  let k = 0;
  while (k < folded.length) {
    const o = folded[k];
    if (!o) break;
    if (o.op === 'eq') {
      const prev = out.at(-1);
      if (prev?.op === 'eq') prev.text += o.text;
      else out.push({ ...o });
      k++;
      continue;
    }
    let del = '';
    let add = '';
    while (k < folded.length && folded[k]?.op !== 'eq') {
      const c = folded[k];
      if (c?.op === 'del') del += c.text;
      else if (c) add += c.text;
      k++;
    }
    if (del) out.push({ op: 'del', text: del });
    if (add) out.push({ op: 'add', text: add });
  }
  return out;
}

/** One block (paragraph, list item, heading…) of a block diff; `ops` has no `add` on the before side and no `del` on the after side. */
export interface DiffBlock {
  changed: boolean;
  ops: DiffOp[];
}

/** Both texts as non-empty trimmed lines: the same normalisation on both sides, so spacing alone is never a change. */
export function normalizeBlocks(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Block diff for the side-by-side wiki history: blocks first (LCS over normalised lines), words
 * only inside changed blocks (the i-th removed block is paired with the i-th added one). Returns
 * one list per column, so both are drawn with identical block spacing.
 */
export function diffBlocks(before: string, after: string): { before: DiffBlock[]; after: DiffBlock[] } {
  const out = { before: [] as DiffBlock[], after: [] as DiffBlock[] };
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i];
      const a = adds[i];
      if (d !== undefined && a !== undefined) {
        const ops = diffText(d, a);
        out.before.push({ changed: true, ops: ops.filter((o) => o.op !== 'add') });
        out.after.push({ changed: true, ops: ops.filter((o) => o.op !== 'del') });
      } else if (d !== undefined) out.before.push({ changed: true, ops: [{ op: 'del', text: d }] });
      else if (a !== undefined) out.after.push({ changed: true, ops: [{ op: 'add', text: a }] });
    }
    dels = [];
    adds = [];
  };
  for (const o of diffTokens(normalizeBlocks(before), normalizeBlocks(after))) {
    if (o.op === 'del') dels.push(o.text);
    else if (o.op === 'add') adds.push(o.text);
    else {
      flush();
      out.before.push({ changed: false, ops: [o] });
      out.after.push({ changed: false, ops: [o] });
    }
  }
  flush();
  return out;
}
