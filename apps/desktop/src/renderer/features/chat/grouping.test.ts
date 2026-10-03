import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { MessageKind, MessageSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../stores/messages';
import { buildMetas, createMetaBuilder, rowMeta, userColorIndex, type RowMeta } from './grouping';

const T0 = Date.parse('2026-01-14T09:00:00');
const at = (min: number): number => T0 + min * 60_000;
function m(id: string, author: string, ms: number, status: ChatMessage['status'] = 'sent'): ChatMessage {
  return { key: id, status, msg: create(MessageSchema, { id, roomId: 'r', authorId: author, createdAt: timestampFromMs(ms) }) };
}
const flags = (x: RowMeta): string => `${x.day ? 'D' : ''}${x.isNew ? 'N' : ''}${x.first ? 'F' : ''}${x.last ? 'L' : ''}`;

describe('grouping (Telegram: same author within 5 min)', () => {
  it('groups consecutive messages and marks first/last', () => {
    const items = [m('01', 'a', at(0)), m('02', 'a', at(1)), m('03', 'a', at(4.9)), m('04', 'b', at(5)), m('05', 'b', at(11))];
    expect(items.map((_, i) => flags(rowMeta(items, i, '', 'me')))).toEqual(['DF', '', 'L', 'FL', 'FL']);
  });

  it('a new day or the «new» marker breaks a group', () => {
    const items = [m('01', 'a', at(0)), m('02', 'a', at(1)), m('03', 'a', at(2)), m('04', 'a', at(24 * 60))];
    expect(items.map((_, i) => flags(rowMeta(items, i, '02', 'me')))).toEqual(['DF', 'L', 'NFL', 'DFL']);
  });

  it('a system card (ADR-0025) breaks the group of its author', () => {
    const sys = m('02', 'a', at(1));
    sys.msg.kind = MessageKind.SYSTEM;
    const items = [m('01', 'a', at(0)), sys, m('03', 'a', at(2))];
    expect(items.map((_, i) => flags(rowMeta(items, i, '', 'me')))).toEqual(['DFL', 'FL', 'FL']);
  });

  it('the «new» pill is never shown before my own message', () => {
    const items = [m('01', 'a', at(0)), m('02', 'me', at(1)), m('03', 'a', at(2))];
    expect(items.map((x, i) => rowMeta(items, i, '01', 'me').isNew)).toEqual([false, false, false]);
  });

  it('pending messages group with my previous ones', () => {
    const items = [m('01', 'me', at(0)), m('local:x', 'me', at(0.5), 'pending')];
    expect(items.map((_, i) => flags(rowMeta(items, i, '', 'me')))).toEqual(['DF', 'L']);
  });

  it('buildMetas reuses unchanged objects; a new message only touches its predecessor', () => {
    const cache = new Map<string, RowMeta>();
    const a = [m('01', 'a', at(0)), m('02', 'a', at(1))];
    const first = buildMetas(a, '', 'me', cache);
    const b = [...a, m('03', 'a', at(2))];
    const second = buildMetas(b, '', 'me', cache);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]); // was last, now in the middle
    expect(flags(second[2] as RowMeta)).toBe('L');
  });

  it('userColorIndex is stable and within the palette', () => {
    expect(userColorIndex('00000000-0000-7000-8001-000000000002')).toBe(userColorIndex('00000000-0000-7000-8001-000000000002'));
    for (const id of ['a', 'b', 'c', 'дина']) expect(userColorIndex(id)).toBeGreaterThanOrEqual(0);
    for (const id of ['a', 'b', 'c', 'дина']) expect(userColorIndex(id)).toBeLessThan(8);
  });

  it('the incremental builder equals a full recomputation on random edit sequences', () => {
    let x = 11;
    const rand = (): number => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x / 0x7fffffff;
    };
    const authors = ['a', 'b', 'me'];
    let seq = 0;
    const fresh = (minute: number): ChatMessage => {
      seq++;
      const row = m(String(seq).padStart(6, '0'), authors[Math.floor(rand() * 3)] ?? 'a', at(minute));
      if (rand() < 0.05) row.msg.kind = MessageKind.SYSTEM;
      return row;
    };
    for (let run = 0; run < 20; run++) {
      const build = createMetaBuilder();
      let items: ChatMessage[] = Array.from({ length: 20 }, (_, i) => fresh(i * 3));
      let marker = '';
      let me = 'me';
      let prevMetas = build(items, marker, me);
      let prevKeys = items.map((c) => c.key);
      for (let step = 0; step < 120; step++) {
        const r = rand();
        const i = Math.floor(rand() * items.length);
        const minute = rand() < 0.2 ? 24 * 60 * Math.floor(rand() * 3) : rand() * 12;
        if (r < 0.15) items = [...Array.from({ length: 1 + Math.floor(rand() * 5) }, () => fresh(-minute)), ...items]; // older page
        else if (r < 0.3) items = [...items, fresh(minute + 100)]; // new message
        else if (r < 0.45 && items.length > 1) items = items.filter((_, j) => j !== i); // delete
        else if (r < 0.6 && items[i]) {
          // edit / reaction: a new row object, same key
          const c = items[i];
          items = items.slice();
          items[i] = { ...c, msg: { ...c.msg, content: `${c.msg.content}!` } };
        } else if (r < 0.7) items = items.slice(Math.floor(rand() * 4)); // window cap: oldest dropped
        else if (r < 0.75) items = items.slice(0, Math.max(1, items.length - Math.floor(rand() * 4))); // newest dropped
        else if (r < 0.8 && items.length > 2) {
          // a row's time changes (a new object) between two others
          const c = items[i];
          if (c) {
            items = items.slice();
            items[i] = { ...c, msg: { ...c.msg, createdAt: timestampFromMs(at(rand() * 600)) } };
          }
        } else if (r < 0.85) marker = items[Math.floor(rand() * items.length)]?.key ?? '';
        else if (r < 0.88) me = me === 'me' ? 'a' : 'me';
        else if (r < 0.9) items = Array.from({ length: 5 + Math.floor(rand() * 20) }, (_, k) => fresh(k)); // a jump
        const got = build(items, marker, me);
        const want = items.map((_, k) => rowMeta(items, k, marker, me));
        expect(got.map(flags)).toEqual(want.map(flags));
        // Unchanged metas keep their objects (memoised rows skip their render).
        for (let k = 0; k < items.length; k++) {
          const c = items[k];
          const j = c ? prevKeys.indexOf(c.key) : -1;
          if (j >= 0 && flags(got[k] as RowMeta) === flags(prevMetas[j] as RowMeta)) expect(got[k]).toBe(prevMetas[j]);
        }
        prevMetas = got;
        prevKeys = items.map((c) => c.key);
      }
    }
  });
});
