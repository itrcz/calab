// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { descriptionToDoc, docToDescription } from '../../features/boards/descriptionDoc';
import { asBlock, flattenTables, hasTable, htmlTableToMarkdown } from './table';

const TABLE = '| Name | Qty |\n| --- | --- |\n| Apple | 3 |\n| Pear | 5 |';

describe('table messages', () => {
  it('detects a pipe table, not plain pipes or a fenced one', () => {
    expect(hasTable(`see\n\n${TABLE}`)).toBe(true);
    expect(hasTable('a | b')).toBe(false);
    expect(hasTable('```\n| a | b |\n| --- | --- |\n```')).toBe(false);
    // A stray pipe over a rule, or a separator of another width, is ordinary chat text.
    expect(hasTable('a | b\n---')).toBe(false);
    expect(hasTable('a | b | c\n--- | ---')).toBe(false);
    expect(hasTable('a | b\n--- | ---')).toBe(true);
  });
  it('round-trips a comment with an image and a table through the description doc', () => {
    const md = `look\n![shot.png](calaba-file:abc-123)\n\n${TABLE}`;
    expect(docToDescription(descriptionToDoc(md))).toBe(md);
  });
  it('flattens a table for previews and leaves other text alone', () => {
    expect(flattenTables(`hi\n${TABLE}`)).toBe('hi\nName | Qty · Apple | 3 · Pear | 5');
    expect(flattenTables('just text')).toBe('just text');
  });
  it('turns one pasted HTML table into a pipe table, plain paste otherwise', () => {
    const sheet = '<google-sheets-html-origin><style>td{border:1px}</style><table><tr><td>Name</td><td>Qty</td></tr><tr><td>a|b</td><td>3</td></tr></table>';
    expect(htmlTableToMarkdown(sheet)).toBe('| Name | Qty |\n| --- | --- |\n| a\\|b | 3 |');
    expect(htmlTableToMarkdown('<table><tr><td>one cell</td></tr></table>')).toBeNull();
    expect(htmlTableToMarkdown('<p>intro</p><table><tr><td>a</td><td>b</td></tr></table>')).toBeNull();
    expect(htmlTableToMarkdown('<b>no table</b>')).toBeNull();
    expect(htmlTableToMarkdown(sheet, 10)).toBeNull();
  });
  it('puts a pasted table on lines of its own', () => {
    expect(asBlock('T', '', 0)).toBe('T');
    expect(asBlock('T', 'hi', 2)).toBe('\n\nT');
    expect(asBlock('T', 'hi\nyo', 3)).toBe('\nT\n\n');
  });
});
