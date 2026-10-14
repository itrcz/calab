import { FormerMemberReason, UserRefSchema, ListWorkspaceUsersResponseSchema } from '@calaba/protocol';
import { create } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const users = vi.fn<(ws: string, ids: string[]) => Promise<unknown>>();
vi.mock('../lib/api/endpoints', () => ({ api: { workspaces: { users: (ws: string, ids: string[]) => users(ws, ids) } } }));

import { formerKey, useWorkspaces } from '../stores/workspaces';
import { RESOLVE_BATCH, resetResolver, resolveUsers } from './users';

const ref = (id: string, former = true) =>
  create(UserRefSchema, { userId: id, displayName: `U ${id}`, former, reason: FormerMemberReason.REMOVED });

describe('resolveUsers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetResolver();
    useWorkspaces.getState().reset();
    users.mockReset();
    users.mockImplementation((_ws, ids) =>
      Promise.resolve(create(ListWorkspaceUsersResponseSchema, { users: ids.filter((i) => i !== 'ghost').map((i) => ref(i)) })),
    );
  });
  afterEach(() => vi.useRealTimers());

  it('batches ids asked within 100 ms into one request and dedupes them', async () => {
    resolveUsers('w', ['a', 'b']);
    resolveUsers('w', ['b', 'c']);
    await vi.advanceTimersByTimeAsync(99);
    expect(users).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(users).toHaveBeenCalledTimes(1);
    expect(users.mock.calls[0]?.[1]).toEqual(['a', 'b', 'c']);
    expect(useWorkspaces.getState().users['a']?.displayName).toBe('U a');
    expect(useWorkspaces.getState().former[formerKey('w', 'a')]?.reason).toBe(FormerMemberReason.REMOVED);
  });

  it('splits more than 100 ids and never re-asks answered or unanswered ids', async () => {
    resolveUsers(
      'w',
      Array.from({ length: RESOLVE_BATCH + 5 }, (_, i) => `u${i}`),
    );
    resolveUsers('w', ['ghost']);
    await vi.advanceTimersByTimeAsync(200);
    expect(users.mock.calls.map((c) => (c[1]).length)).toEqual([RESOLVE_BATCH, 6]);
    resolveUsers('w', ['ghost', 'u1']);
    await vi.advanceTimersByTimeAsync(200);
    expect(users).toHaveBeenCalledTimes(2);
  });
});

describe('former flag in the store', () => {
  it('a resolved past member is marked; a current one clears the mark', () => {
    useWorkspaces.getState().reset();
    useWorkspaces.getState().applyUserRefs('w', [ref('x')]);
    expect(useWorkspaces.getState().former[formerKey('w', 'x')]).toBeDefined();
    useWorkspaces.getState().applyUserRefs('w', [ref('x', false)]);
    expect(useWorkspaces.getState().former[formerKey('w', 'x')]).toBeUndefined();
  });
});
