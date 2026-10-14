import { create } from '@bufbuild/protobuf';
import { PublicWikiPageRefSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { outlineRows } from './publicOutline';

const ref = (id: string, parentId: string, title = id) => create(PublicWikiPageRefSchema, { id, parentId, title });

describe('outlineRows', () => {
  it('lists the root, then subpages depth-first with their depth', () => {
    const rows = outlineRows({ id: 'r', title: 'Root', icon: '📘' }, [ref('a', 'r'), ref('b', 'r'), ref('a1', 'a'), ref('a1x', 'a1')]);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['r', 0],
      ['a', 1],
      ['a1', 2],
      ['a1x', 3],
      ['b', 1],
    ]);
  });
  it('drops refs outside the branch and loops', () => {
    const rows = outlineRows({ id: 'r', title: 'Root', icon: '' }, [ref('x', 'nope'), ref('a', 'r'), ref('r', 'a')]);
    expect(rows.map((r) => r.id)).toEqual(['r', 'a']);
  });
});
