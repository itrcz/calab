import { create } from '@bufbuild/protobuf';
import { UserSchema, WorkspaceMemberSchema, WorkspaceRole, WorkspaceSchema, WorkspaceSnapshotSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined } } }));

const { legacyRoles } = await import('../lib/roles');
const { useSession } = await import('../stores/session');
const { useWorkspaces } = await import('../stores/workspaces');
const { fileLimitBytes, tooLargeError } = await import('./uploadLimit');

const W = 'w1';
const MB = 1 << 20;

function join(role: WorkspaceRole, roleIds: string[], maxFileMb = 0): void {
  const me = create(WorkspaceMemberSchema, { workspaceId: W, role, roleIds, user: create(UserSchema, { id: 'me' }) });
  useWorkspaces.getState().applySnapshot(
    create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: W, name: 'W', maxFileMb }), role, members: [me], roles: legacyRoles(W) }),
  );
}

beforeEach(() => {
  useWorkspaces.getState().reset();
  useSession.getState().set({ maxFileMb: 1024, me: { user: create(UserSchema, { id: 'me' }) } as never });
});

describe('fileLimitBytes (CBF-191)', () => {
  it('DMs and notes: the server limit; unknown from an older server', () => {
    expect(fileLimitBytes('')).toBe(1024 * MB);
    useSession.getState().set({ maxFileMb: 0 });
    expect(fileLimitBytes('')).toBeUndefined();
  });

  it('a member: the workspace override, else the server limit', () => {
    join(WorkspaceRole.MEMBER, ['member']);
    expect(fileLimitBytes(W)).toBe(1024 * MB);
    join(WorkspaceRole.MEMBER, ['member'], 50);
    expect(fileLimitBytes(W)).toBe(50 * MB);
    expect(tooLargeError(W, 50 * MB)).toBeNull();
    expect(tooLargeError(W, 50 * MB + 1)).toMatchObject({ code: 'ERROR_CODE_FILE_TOO_LARGE', status: 413, extra: { limit: 50 * MB } });
  });

  it('the owner and admins upload up to the server cap (ADR-0164): no client check', () => {
    join(WorkspaceRole.OWNER, ['owner'], 50);
    expect(fileLimitBytes(W)).toBeUndefined();
    join(WorkspaceRole.ADMIN, ['admin'], 50);
    expect(tooLargeError(W, 4000 * MB)).toBeNull();
  });
});
