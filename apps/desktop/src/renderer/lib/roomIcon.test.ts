import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { RoomSchema, RoomType, type Room } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRooms } from '../stores/rooms';
import { roomGlyph, roomIconFile, roomIsPrivate } from './roomIcon';

/**
 * Re-renders of a room picture change (ADR-0092, CLAUDE.md «Ререндеры»), proven on the store: the
 * selectors every RoomIcon subscribes with are evaluated for 100 rooms before and after a
 * ROOM_UPDATE of one room; an icon re-renders only when its selector's result changes.
 */
const ids = Array.from({ length: 100 }, (_, i) => `r${i}`);

function snapshot(): Map<string, unknown> {
  const s = useRooms.getState();
  const out = new Map<string, unknown>();
  for (const id of ids) {
    out.set(`file ${id}`, roomIconFile(s, id));
    out.set(`glyph ${id}`, roomGlyph(s, id));
    out.set(`private ${id}`, roomIsPrivate(s, id));
  }
  return out;
}

function room(id: string): Room {
  const r = useRooms.getState().byId[id];
  if (!r) throw new Error(`no room ${id}`);
  return r;
}

const changed = (a: Map<string, unknown>, b: Map<string, unknown>): string[] => [...a.keys()].filter((k) => !Object.is(a.get(k), b.get(k)));

beforeEach(() => {
  useRooms.getState().reset();
  useRooms.getState().upsertMany(ids.map((id, i) => create(RoomSchema, { id, workspaceId: 'w', type: i % 2 ? RoomType.VOICE : RoomType.TEXT, name: id })));
});

describe('RoomIcon selectors', () => {
  it('a picture change of one room changes only that room’s selector', () => {
    const before = snapshot();
    useRooms.getState().upsert({ ...room('r7'), iconFileId: 'f1' });
    expect(changed(before, snapshot())).toEqual(['file r7']);
  });

  it('a rename or a topic change of a room re-renders no icon', () => {
    const before = snapshot();
    useRooms.getState().upsert({ ...room('r3'), name: 'renamed', topic: 'new' });
    expect(changed(before, snapshot())).toEqual([]);
  });

  it('glyphs: text, voice, a temporary room; a room missing from the store uses the given info', () => {
    const s = useRooms.getState();
    expect(roomGlyph(s, 'r0')).toBe('text');
    expect(roomGlyph(s, 'r1')).toBe('voice');
    s.upsert({ ...room('r1'), expiresAt: timestampFromMs(Date.now() + 60_000) });
    expect(roomGlyph(useRooms.getState(), 'r1')).toBe('temp');
    const info = { type: RoomType.VOICE, isPrivate: true, iconFileId: 'x' };
    expect([roomGlyph(s, 'nope', info), roomIsPrivate(s, 'nope', info), roomIconFile(s, 'nope', info)]).toEqual(['voice', true, 'x']);
  });
});
