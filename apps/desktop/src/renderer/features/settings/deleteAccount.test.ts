import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: { kind: 'web', apiBase: '', apiFetch: vi.fn() } }));

const { ApiError } = await import('../../lib/api/client');
const { deleteAccountError, ownedWorkspaceNames } = await import('./deleteAccount');

describe('deleteAccount', () => {
  it('lists the owned workspaces in the sidebar order', () => {
    const byId = {
      a: { ws: { ownerId: 'me', name: 'Alpha' } },
      b: { ws: { ownerId: 'other', name: 'Beta' } },
      c: { ws: { ownerId: 'me', name: 'Gamma' } },
    };
    expect(ownedWorkspaceNames(['c', 'b', 'a', 'gone'], byId, 'me')).toEqual(['Gamma', 'Alpha']);
    expect(ownedWorkspaceNames(['a'], byId, '')).toEqual([]);
  });

  it('maps server errors to the field or the blocker', () => {
    expect(deleteAccountError(new ApiError('ERROR_CODE_INVALID_CREDENTIALS', 'x', 403)).password).toBeTruthy();
    expect(deleteAccountError(new ApiError('ERROR_CODE_CONFLICT', 'x', 409, undefined, { reason: 'OWNS_WORKSPACES' }))).toEqual({ owner: true });
    expect(deleteAccountError(new ApiError('ERROR_CODE_VALIDATION', 'x', 422, 'currentPassword')).password).toBeTruthy();
    expect(deleteAccountError(new ApiError('ERROR_CODE_RATE_LIMITED', 'x', 429)).form).toBeTruthy();
    expect(deleteAccountError(new Error('offline')).form).toBeTruthy();
  });
});
