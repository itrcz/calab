import { create } from '@bufbuild/protobuf';
import { MessageSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { useMessages } from './messages';

// Issue #49: a reply quote of a deleted message shows «deleted» (also live), not «show original».
describe('gone ids', () => {
  beforeEach(() => useMessages.getState().reset());

  it('remove() marks the id as deleted even when the room is not loaded', () => {
    useMessages.getState().remove('r', 'm1');
    expect(useMessages.getState().gone.m1).toBe(true);
  });

  it('deleting a loaded message marks it and drops it from the window', () => {
    useMessages.getState().setWindow('r', [create(MessageSchema, { id: 'm1', roomId: 'r', authorId: 'u' })], false, false);
    useMessages.getState().remove('r', 'm1');
    expect(useMessages.getState().gone.m1).toBe(true);
    expect(useMessages.getState().rooms.r?.items.length).toBe(0);
  });

  it('markGone is idempotent (no new state object)', () => {
    useMessages.getState().markGone('x');
    const g = useMessages.getState().gone;
    useMessages.getState().markGone('x');
    expect(useMessages.getState().gone).toBe(g);
  });
});
