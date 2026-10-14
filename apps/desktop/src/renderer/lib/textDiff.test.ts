import { describe, expect, it } from 'vitest';
import { DIFF_LIMIT, diffBlocks, diffStats, diffText, diffable, splitLines, splitWords, type DiffOp } from './textDiff';

const join = (ops: readonly DiffOp[], side: 'before' | 'after'): string => ops.filter((o) => o.op === 'eq' || o.op === (side === 'before' ? 'del' : 'add')).map((o) => o.text).join('');

describe('textDiff', () => {
  it('splits lines with their breaks and words with punctuation apart', () => {
    expect(splitLines('a\nb\n\nc')).toEqual(['a\n', 'b\n', '\n', 'c']);
    expect(splitLines('')).toEqual([]);
    expect(splitWords('Шаги, в  комментариях.')).toEqual(['Шаги', ',', ' ', 'в', '  ', 'комментариях', '.']);
  });

  it('equal texts are one eq, empty ones nothing', () => {
    expect(diffText('abc', 'abc')).toEqual([{ op: 'eq', text: 'abc' }]);
    expect(diffText('', '')).toEqual([]);
  });

  it('adds and removes whole texts', () => {
    expect(diffText('', 'новый')).toEqual([{ op: 'add', text: 'новый' }]);
    expect(diffText('старый', '')).toEqual([{ op: 'del', text: 'старый' }]);
  });

  it('a one-word fix inside a line is a small change', () => {
    const ops = diffText('Повторяется на Windows 11 с колонками.', 'Повторяется на Windows 10 с колонками.');
    expect(ops).toEqual([
      { op: 'eq', text: 'Повторяется на Windows ' },
      { op: 'del', text: '11' },
      { op: 'add', text: '10' },
      { op: 'eq', text: ' с колонками.' },
    ]);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 2 });
  });

  it('neighbouring changed words join into one strike-through', () => {
    const ops = diffText('a quick brown fox', 'a slow red fox');
    expect(ops).toEqual([
      { op: 'eq', text: 'a ' },
      { op: 'del', text: 'quick brown' },
      { op: 'add', text: 'slow red' },
      { op: 'eq', text: ' fox' },
    ]);
  });

  it('keeps untouched lines and diffs the changed block by words', () => {
    const before = 'Шаги:\n1. Открыть звонок\n2. Включить колонки\nКонец';
    const after = 'Шаги:\n1. Открыть звонок\n2. Включить внешние колонки\n3. Говорить\nКонец';
    const ops = diffText(before, after);
    expect(join(ops, 'before')).toBe(before);
    expect(join(ops, 'after')).toBe(after);
    expect(ops[0]).toEqual({ op: 'eq', text: 'Шаги:\n1. Открыть звонок\n2. Включить ' });
    expect(ops.filter((o) => o.op === 'del')).toEqual([]);
    expect(ops.filter((o) => o.op === 'add').map((o) => o.text)).toEqual(['внешние ', '\n3. Говорить']);
  });

  it('round-trips random edits', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', '\n', ' ', ',', 'эхо', 'звук'];
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 50; k++) {
      const a = Array.from({ length: rnd(40) }, () => words[rnd(words.length)]).join('');
      const b = Array.from({ length: rnd(40) }, () => words[rnd(words.length)]).join('');
      const ops = diffText(a, b);
      expect(join(ops, 'before')).toBe(a);
      expect(join(ops, 'after')).toBe(b);
    }
  });

  it('long texts are not diffable', () => {
    expect(diffable('a'.repeat(DIFF_LIMIT / 2), 'b'.repeat(DIFF_LIMIT / 2))).toBe(true);
    expect(diffable('a'.repeat(DIFF_LIMIT), 'b')).toBe(false);
  });
});

describe('diffBlocks', () => {
  it('ignores blank lines and spacing: equal texts have no changed block', () => {
    const d = diffBlocks('One\n\n\nTwo\n', '  One\nTwo');
    expect(d.before.some((b) => b.changed)).toBe(false);
    expect(d.before).toEqual(d.after);
  });

  it('marks only the changed block and diffs words inside it', () => {
    const d = diffBlocks('Intro\n\nHello old world\n\nEnd', 'Intro\nHello new world\nEnd\nAdded block');
    expect(d.before.map((b) => b.changed)).toEqual([false, true, false]);
    expect(d.after.map((b) => b.changed)).toEqual([false, true, false, true]);
    expect(d.before[1]?.ops.filter((o) => o.op === 'del').map((o) => o.text)).toEqual(['old']);
    expect(d.after[1]?.ops.filter((o) => o.op === 'add').map((o) => o.text)).toEqual(['new']);
    expect(d.after[3]?.ops).toEqual([{ op: 'add', text: 'Added block' }]);
  });
});
