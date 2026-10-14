import { describe, expect, it } from 'vitest';
import { fromMarkdown, looksLikeMarkdown, toMarkdown, type PmNode } from './markdown';

const t = (text: string, ...marks: string[]): PmNode => (marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text });
const p = (...content: PmNode[]): PmNode => ({ type: 'paragraph', content });
const doc = (...content: PmNode[]): PmNode => ({ type: 'doc', content });
const UID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('toMarkdown', () => {
  it('writes headings, paragraphs and marks', () => {
    const md = toMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [t('Plan')] },
        p(t('a '), t('bold', 'bold'), t(' and '), t('both', 'bold', 'italic'), t(' '), t('x', 'strike'), t(' '), t('a`b', 'code')),
      ),
    );
    expect(md).toBe('## Plan\n\na **bold** and **_both_** ~~x~~ ``a`b``\n');
  });

  it('keeps a mark open across adjacent text nodes', () => {
    expect(toMarkdown(doc(p(t('ab', 'bold'), t('cd', 'bold', 'italic'))))).toBe('**ab_cd_**\n');
  });

  it('writes links, mentions, hard breaks and escapes', () => {
    const link = { type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href: 'https://x.io' } }] };
    const md = toMarkdown(doc(p(link, t(' '), { type: 'mention', attrs: { id: UID, label: 'Анна' } }, { type: 'hardBreak' }, t('1*2_3'))));
    expect(md).toBe('[site](https://x.io) @Анна\\\n1\\*2\\_3\n');
    expect(toMarkdown(doc(p(t('# not a heading'))))).toBe('\\# not a heading\n');
  });

  it('writes lists, task lists and nesting', () => {
    const li = (...c: PmNode[]): PmNode => ({ type: 'listItem', content: c });
    const md = toMarkdown(
      doc(
        { type: 'bulletList', content: [li(p(t('one')), { type: 'orderedList', content: [li(p(t('sub')))] }), li(p(t('two')))] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] }, { type: 'taskItem', attrs: { checked: false }, content: [p(t('todo'))] }] },
      ),
    );
    expect(md).toBe('- one\n  1. sub\n- two\n\n- [x] done\n- [ ] todo\n');
  });

  it('writes quotes, code, rules, tables, images, callouts and toggles', () => {
    const cell = (type: string, s: string): PmNode => ({ type, content: [p(t(s))] });
    const md = toMarkdown(
      doc(
        { type: 'blockquote', content: [p(t('q1')), p(t('q2'))] },
        { type: 'codeBlock', attrs: { language: 'go' }, content: [t('a := 1\n```')] },
        { type: 'horizontalRule' },
        { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'A'), cell('tableHeader', 'B|C')] }, { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', '2')] }] },
        { type: 'image', attrs: { fileId: 'f1', alt: 'pic' } },
        { type: 'callout', attrs: { icon: '⚠️' }, content: [p(t('careful'))] },
        { type: 'toggle', content: [p(t('More')), p(t('hidden'))] },
      ),
      { title: 'Page' },
    );
    expect(md).toBe(
      [
        '# Page',
        '',
        '> q1\n>\n> q2',
        '',
        '````go\na := 1\n```\n````',
        '',
        '---',
        '',
        '| A | B\\|C |\n| --- | --- |\n| 1 | 2 |',
        '',
        '![pic](/api/files/f1)',
        '',
        '> ⚠️ careful',
        '',
        '<details>\n<summary>More</summary>\n\nhidden\n\n</details>',
        '',
      ].join('\n'),
    );
  });
});

describe('fromMarkdown', () => {
  it('parses blocks', () => {
    const d = fromMarkdown('# Title\n\nSome **bold** text\nnext line\n\n> quote\n\n---\n\n```ts\nconst a = 1;\n```');
    expect(d.content).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [t('Title')] },
      p(t('Some '), t('bold', 'bold'), t(' text'), { type: 'hardBreak' }, t('next line')),
      { type: 'blockquote', content: [p(t('quote'))] },
      { type: 'horizontalRule' },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;')] },
    ]);
  });

  it('parses nested, ordered and task lists', () => {
    const d = fromMarkdown('- a\n  - b\n- c\n\n3. x\n4. y\n\n- [ ] todo\n- [x] done');
    expect(d.content).toEqual([
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p(t('a')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('b'))] }] }] },
          { type: 'listItem', content: [p(t('c'))] },
        ],
      },
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p(t('x'))] }, { type: 'listItem', content: [p(t('y'))] }] },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: false }, content: [p(t('todo'))] },
          { type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] },
        ],
      },
    ]);
  });

  it('parses tables, links and mentions; never makes images', () => {
    const d = fromMarkdown(`| A | B |\n|---|---|\n| 1 | [x](https://x.io) |\n\n@${UID} ![img](https://evil/x.png)`, { mentionLabel: () => 'Анна' });
    const [table, para] = d.content ?? [];
    expect(table?.type).toBe('table');
    expect(table?.content?.[0]?.content?.[0]).toEqual({ type: 'tableHeader', content: [p(t('A'))] });
    expect(table?.content?.[1]?.content?.[1]?.content?.[0]?.content?.[0]).toEqual({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'https://x.io' } }] });
    expect(para?.content?.[0]).toEqual({ type: 'mention', attrs: { id: UID, label: 'Анна' } });
    expect(JSON.stringify(d)).not.toContain('"image"');
  });

  it('round-trips the serializer output', () => {
    const src = doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('H')] },
      p(t('plain '), t('b', 'bold'), t(' '), t('c', 'code')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }] },
      { type: 'codeBlock', attrs: { language: 'js' }, content: [t('x()')] },
    );
    expect(fromMarkdown(toMarkdown(src))).toEqual(src);
  });

  it('returns one empty paragraph for empty input', () => {
    expect(fromMarkdown('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });
});

describe('looksLikeMarkdown', () => {
  it('detects block and inline syntax', () => {
    expect(looksLikeMarkdown('# Title\ntext')).toBe(true);
    expect(looksLikeMarkdown('- a\n- b')).toBe(true);
    expect(looksLikeMarkdown('see **this**')).toBe(true);
    expect(looksLikeMarkdown('just a sentence')).toBe(false);
    expect(looksLikeMarkdown('two\nplain lines')).toBe(false);
  });
});
