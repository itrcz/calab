import { describe, expect, it } from 'vitest';
import { descriptionToDoc, docToDescription } from '../../features/boards/descriptionDoc';
import { flattenTables, hasTable } from './table';

const TABLE = '| Name | Qty |\n| --- | --- |\n| Apple | 3 |\n| Pear | 5 |';

describe('table messages', () => {
  it('detects a pipe table, not plain pipes or a fenced one', () => {
    expect(hasTable(`see\n\n${TABLE}`)).toBe(true);
    expect(hasTable('a | b')).toBe(false);
    expect(hasTable('```\n| a | b |\n| --- | --- |\n```')).toBe(false);
  });
  it('round-trips a comment with an image and a table through the description doc', () => {
    const md = `look\n![shot.png](calaba-file:abc-123)\n\n${TABLE}`;
    expect(docToDescription(descriptionToDoc(md))).toBe(md);
  });
  it('flattens a table for previews and leaves other text alone', () => {
    expect(flattenTables(`hi\n${TABLE}`)).toBe('hi\nName | Qty · Apple | 3 · Pear | 5');
    expect(flattenTables('just text')).toBe('just text');
  });
});
