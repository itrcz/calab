import { create } from '@bufbuild/protobuf';
import { SearchResponseSchema, SearchType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { appendPage, dmHitRows, dmSearchParams, firstPage, matchPeers } from './dmSearch';
import { paramsKey } from './query';

const msg = (id: string) => ({ snippet: `s ${id}`, ref: { case: 'message' as const, value: { messageId: id, roomId: 'dm1' } } });
const page = (ids: string[], next = '') => create(SearchResponseSchema, { sections: [{ type: SearchType.MESSAGES, items: ids.map(msg), nextCursor: next }] });
const at = (): number => 5;

describe('DM column search', () => {
  it('asks the messages feed of my DMs, newest first, with a cursor on later pages', () => {
    expect(dmSearchParams('  план ')).toEqual({ q: 'план', scope: 'dms', type: 'messages', sort: 'new' });
    expect(dmSearchParams('план', 'c1')['cursor']).toBe('c1');
    expect(paramsKey(dmSearchParams('a'))).not.toBe(paramsKey(dmSearchParams('a', 'c')));
  });

  it('maps message hits to rows and drops anything else', () => {
    const note = { snippet: 'n', ref: { case: 'note' as const, value: { messageId: 'n1', roomId: 'r' } } };
    const items = create(SearchResponseSchema, { sections: [{ items: [msg('1'), note, msg('2')] }] }).sections.flatMap((x) => x.items);
    expect(dmHitRows(items, at).map((r) => [r.id, r.roomId, r.messageId, r.at])).toEqual([
      ['message:1', 'dm1', '1', 5],
      ['message:2', 'dm1', '2', 5],
    ]);
  });

  it('pages: appends by the cursor, skips a repeated hit, ignores a stale request', () => {
    const f1 = firstPage('k', page(['1', '2'], 'c1'), at);
    expect(f1).toMatchObject({ cursor: 'c1', done: false });
    const f2 = appendPage(f1, 'k', page(['2', '3']), at);
    expect(f2.rows.map((r) => r.messageId)).toEqual(['1', '2', '3']);
    expect(f2).toMatchObject({ cursor: '', done: true });
    expect(appendPage(f1, 'other', page(['9']), at)).toBe(f1);
    expect(firstPage('k', create(SearchResponseSchema, {}), at)).toMatchObject({ rows: [], done: true });
  });

  it('matches the peer by every word of the name', () => {
    const dms = [{ peerId: 'a' }, { peerId: 'b' }, { peerId: 'c' }];
    const names: Record<string, string> = { a: 'Екатерина HRBP', b: 'Скрепка', c: 'Борис Петров' };
    const n = (id: string): string => names[id] ?? '';
    expect(matchPeers(dms, n, 'скреп')).toEqual([{ peerId: 'b' }]);
    expect(matchPeers(dms, n, 'екатерина hr')).toEqual([{ peerId: 'a' }]);
    expect(matchPeers(dms, n, 'р')).toHaveLength(3);
    expect(matchPeers(dms, n, '  ')).toEqual([]);
    expect(matchPeers(dms, n, 'р', 2)).toHaveLength(2);
  });
});
