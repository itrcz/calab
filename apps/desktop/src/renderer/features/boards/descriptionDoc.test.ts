import { wikiSchema } from '@calaba/wiki-doc/schema';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../lib/markdown/parse';
import { descriptionToDoc, docImageIds, docToDescription } from './descriptionDoc';
import { splitDescription } from './inlineImages';

const UID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const FILE = '0192f0aa-1111-7222-8333-444455556666';

const pass = (md: string): string => docToDescription(descriptionToDoc(md, () => 'Анна'));

/** What the task view shows: picture lines and the markdown-lite AST of the text between them (blank-line runs aside). */
const view = (md: string): unknown =>
  splitDescription(md).map((s) => (s.k === 'img' ? ['img', s.id, s.name] : parseMarkdown(s.v.replace(/\n{2,}/g, '\n').trim())));

/** Real-world descriptions (shapes seen on boards, AI and bot output) that survive the editor unchanged. */
const STABLE: Array<[string, string]> = [
  ['plain', 'Просто текст задачи.'],
  ['line breaks', 'Первая строка\nвторая строка\nтретья'],
  ['paragraphs', 'Абзац один.\n\nАбзац два.'],
  ['marks', '**жирный**, *курсив*, ~~зачёркнутый~~ и `код`'],
  ['bold italic', '***оба*** и **жирный с *курсивом* внутри**'],
  ['links', 'Ссылка [документация](https://example.com/docs) и адрес https://example.com/a_b?x=1.'],
  ['bare link alone', 'https://github.com/org/repo/pull/12'],
  ['snake_case and stars', 'Поле user_id в таблице, 2*3 = 6'],
  ['escapes', '\\*не курсив\\* и \\_нет\\_'],
  ['mention', `@${UID} посмотри, пожалуйста`],
  ['everyone', '@everyone созвон в 15:00'],
  ['bullets', 'Сделать:\n- первый пункт\n- второй пункт\n  - вложенный\n  - ещё\n- третий'],
  ['ordered', 'Шаги:\n1. раз\n2. два\n3. три'],
  ['ordered from 3', '3. продолжение\n4. дальше'],
  ['checkboxes', '- [ ] открыть PR\n- [x] написать тесты\n- [ ] **выкатить**'],
  ['code fence', 'Пример:\n```go\nfunc main() {\n\n\tfmt.Println("hi")\n}\n```\nГотово.'],
  ['code no lang', '```\nnpm i\n```'],
  ['picture', `Скрин:\n![screen.png](calaba-file:${FILE})\nПосле картинки`],
  ['picture alone', `![Снимок экрана 2026-10-23 в 12.00.png](calaba-file:${FILE})`],
  ['heading', '# Цель\nСделать хорошо\n## Детали\nтекст'],
  ['quote', '> цитата клиента\nнаш ответ'],
  ['table', '| Поле | Тип |\n| --- | --- |\n| id | uuid |'],
  ['table with marks, links and empty cells', '| Поле | **Тип** | Ссылка |\n| --- | --- | --- |\n| `id` | *uuid* | [док](https://example.com/a) |\n| имя |  | ~~старое~~ |'],
  ['table between text', 'Поля:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nИтого две.'],
  ['table with escaped pipe', '| a | b |\n| --- | --- |\n| x \\| y | 2 |'],
  ['mixed list and text', '**Контекст**\nКлиент жалуется.\n\n**Что сделать**\n- [ ] воспроизвести\n- [ ] починить\nСрок — пятница.'],
  ['one typed empty line', 'Абзац один.\n\n\nАбзац два.'],
  ['three typed empty lines', 'a\n\n\n\n\nb'],
  ['empty lines around a list and a heading', '# Цель\n\n\nТекст\n\n\n- a\n- b\n\n\nКонец'],
  ['link in list', '- [макет](https://figma.com/file/x)\n- https://example.com'],
];

/** Shapes the editor normalizes on the first save (same look in the task view, then stable). */
const NORMALIZED: Array<[string, string, string]> = [
  ['blank line before a list', 'Текст\n\n- a\n- b', 'Текст\n- a\n- b'],
  ['underscore emphasis', '__жирный__ и _курсив_', '**жирный** и *курсив*'],
  ['ordered with parens', '1) раз\n2) два', '1. раз\n2. два'],
  ['link to itself', '[https://x.io/a](https://x.io/a)', 'https://x.io/a'],
];

describe('task description ↔ editor doc', () => {
  it.each(STABLE)('keeps %s unchanged', (_name, md) => {
    expect(pass(md)).toBe(md);
  });

  it.each(NORMALIZED)('normalizes %s once, then is stable', (_name, md, once) => {
    expect(pass(md)).toBe(once);
    expect(pass(once)).toBe(once);
  });

  it.each([...STABLE.map(([n, md]) => [n, md]), ...NORMALIZED.map(([n, md]) => [n, md])])('keeps what the task view shows: %s', (_name, md) => {
    // «1)» → «1.» is the one visible change; `[url](url)` drew a link inside a link — now one link, same text.
    if (_name === 'ordered with parens' || _name === 'link to itself') return;
    expect(view(pass(md))).toEqual(view(md));
  });

  it.each([...STABLE, ...NORMALIZED.map(([n, md]) => [n, md] as [string, string])])('builds a valid wiki doc: %s', (_name, md) => {
    expect(() => wikiSchema().nodeFromJSON(descriptionToDoc(md)).check()).not.toThrow();
  });

  it('keeps a table as a table with a header row and every cell (board #134)', () => {
    const md = '| A | B |\n| :-- | --: |\n| 1 |  |';
    const t = descriptionToDoc(md).content?.[0];
    expect(t?.type).toBe('table');
    expect(t?.content?.map((r) => r.content?.map((c) => c.type))).toEqual([['tableHeader', 'tableHeader'], ['tableCell', 'tableCell']]);
    // Alignment is not stored (markdown-lite has none); the table itself survives a save.
    expect(pass(md)).toBe('| A | B |\n| --- | --- |\n| 1 |  |');
  });

  it('reads pictures as image blocks and mentions with labels; wiki addresses stay links', () => {
    const doc = descriptionToDoc(`@${UID} [стр](https://app.calab.io/wiki/${UID})\n![a.png](calaba-file:${FILE})`, () => 'Анна');
    expect(doc.content?.[0]?.content?.[0]).toEqual({ type: 'mention', attrs: { id: UID, label: 'Анна' } });
    expect(doc.content?.[0]?.content?.some((n) => n.type === 'wikiPageLink')).toBe(false);
    expect(doc.content?.[1]).toEqual({ type: 'image', attrs: { fileId: FILE, alt: 'a.png' } });
    expect(docImageIds(doc)).toEqual([FILE]);
  });

  it('writes what the editor makes: picture names without brackets, links, marks after an address', () => {
    const link = (text: string) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href: text } }] });
    const md = docToDescription({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [link('https://x.io/a'), { type: 'text', text: '/b' }, { type: 'text', text: ' и ' }, link('https://y.io'), { type: 'text', text: ', всё' }] },
        { type: 'image', attrs: { fileId: FILE, alt: 'a [1].png' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'итог', marks: [{ type: 'italic' }] }] },
      ],
    });
    expect(md).toBe(`[https://x.io/a](https://x.io/a)/b и https://y.io, всё\n![a  1 .png](calaba-file:${FILE})\n*итог*`);
  });

  it('writes the empty paragraphs the user typed between blocks (board #150)', () => {
    const p = (text?: string) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
    expect(docToDescription({ type: 'doc', content: [p('a'), p(), p('b')] })).toBe('a\n\n\nb');
    expect(docToDescription({ type: 'doc', content: [p('a'), p(), p(), p('b')] })).toBe('a\n\n\n\nb');
    // Leading and trailing empty lines are nothing.
    expect(docToDescription({ type: 'doc', content: [p(), p('a'), p()] })).toBe('a');
    const doc = descriptionToDoc('a\n\n\nb');
    expect(doc.content?.map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(doc.content?.[1]?.content).toBeUndefined();
    // One blank line (what bots and the API write) stays a plain gap.
    expect(descriptionToDoc('a\n\nb').content).toHaveLength(2);
  });

  it('an empty doc is an empty description', () => {
    expect(docToDescription({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('');
    expect(pass('')).toBe('');
  });
});
