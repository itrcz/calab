import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { MessageSchema, RoomType, WorkspaceSnapshotSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRoomPreviews } from './roomPreviews';

const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const snap = (ws: string, rooms: string[], last: Record<string, { n: number; text: string; sticker?: string; files?: number }>) =>
  create(WorkspaceSnapshotSchema, {
    workspace: { id: ws },
    rooms: rooms.map((r) => ({ id: r, workspaceId: ws, type: RoomType.TEXT })),
    roomLastMessages: Object.fromEntries(
      Object.entries(last).map(([r, l]) => [
        r,
        { id: id(l.n), authorId: 'u', content: l.text, attachmentCount: l.files ?? 0, createdAt: timestampFromMs(l.n * 1000), stickerEmoji: l.sticker ?? '' },
      ]),
    ),
  });
const msg = (room: string, n: number, content = 'hi') =>
  create(MessageSchema, { id: id(n), roomId: room, authorId: 'p', content, createdAt: timestampFromMs(n * 1000) });

const st = () => useRoomPreviews.getState();

beforeEach(() => st().reset());

describe('room previews store', () => {
  it('READY fills every snapshot room: a preview, or null for a room without messages', () => {
    st().setAll([snap('w1', ['a', 'b'], { a: { n: 5, text: 'привет', files: 2 } }), snap('w2', ['c'], { c: { n: 7, text: '', sticker: '😀' } })]);
    const p = st().preview;
    expect(p['a']).toEqual({ messageId: id(5), authorId: 'u', content: 'привет', attachments: 2, at: 5000 });
    expect(p['b']).toBeNull();
    expect(p['c']?.content).toContain('😀'); // a sticker previews as its emoji
    expect(p['dm']).toBeUndefined();
    // A later READY replaces everything (a room gone from it is no longer known).
    st().setAll([snap('w1', ['a'], {})]);
    expect(st().preview).toEqual({ a: null });
  });

  it('a live message becomes the preview; an older or replayed one is ignored without a notification', () => {
    st().setAll([snap('w1', ['a', 'b'], { a: { n: 5, text: 'old' } })]);
    st().onMessage(msg('a', 6, 'new'));
    expect(st().preview['a']?.content).toBe('new');
    const before = st();
    const bRef = before.preview['b'];
    st().onMessage(msg('a', 4, 'older'));
    st().onMessage(msg('a', 6, 'new'));
    expect(st()).toBe(before); // no new state object: no subscriber is notified
    st().onMessage(msg('a', 8, 'newer'));
    expect(st().preview['b']).toBe(bRef); // only the touched key changes
  });

  it('an edit of the previewed message updates it; of another message changes nothing', () => {
    st().setAll([snap('w1', ['a'], { a: { n: 5, text: 'x' } })]);
    st().onChanged('a', id(5), msg('a', 5, 'edited'));
    expect(st().preview['a']?.content).toBe('edited');
    const before = st();
    st().onChanged('a', id(4), msg('a', 4, 'other'));
    expect(st()).toBe(before);
  });

  it('a deletion of the previewed message makes it unknown, then the refetch sets the next one', () => {
    st().setAll([snap('w1', ['a'], { a: { n: 5, text: 'x' } })]);
    st().onChanged('a', id(5), null);
    expect('a' in st().preview).toBe(false);
    st().setPreview('a', msg('a', 3, 'previous'));
    expect(st().preview['a']?.content).toBe('previous');
    st().setPreview('a', null);
    expect(st().preview['a']).toBeNull();
  });

  it('WORKSPACE_CREATE merges one workspace and keeps a newer live preview', () => {
    st().setAll([snap('w1', ['a'], { a: { n: 5, text: 'x' } })]);
    st().onMessage(msg('n1', 9, 'live'));
    st().applySnapshot(snap('w2', ['n1', 'n2'], { n1: { n: 8, text: 'snap' } }));
    expect(st().preview['a']?.content).toBe('x');
    expect(st().preview['n1']?.content).toBe('live');
    expect(st().preview['n2']).toBeNull();
  });

  it('drop removes the rooms and is a no-op for unknown ones', () => {
    st().setAll([snap('w1', ['a', 'b'], {})]);
    st().drop(['a']);
    expect(st().preview).toEqual({ b: null });
    const before = st();
    st().drop(['zz']);
    expect(st()).toBe(before);
  });
});
