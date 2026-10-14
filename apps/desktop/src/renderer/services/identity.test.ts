import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import {
  WorkspaceIdentityAccessSchema,
  IdentityAccessReason,
  RoomSchema,
  WorkspaceSchema,
  WorkspaceSnapshotSchema,
  WorkspaceMemberSchema,
  UserSchema,
  MessageSchema,
  CalendarEventSchema,
  BillingState,
  WorkspaceRole,
} from '@calaba/protocol';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
const mocks = vi.hoisted(() => ({ prune: vi.fn(), clearMedia: vi.fn(), forget: vi.fn(), leave: vi.fn(), chatClear: vi.fn() }));
vi.mock('../platform', () => ({ platform: { kind: 'web', clearProtectedMedia: mocks.clearMedia, webApps: { forget: mocks.forget } } }));
vi.mock('./gateway', () => ({ pruneGatewaySubscriptions: mocks.prune }));
vi.mock('./chat', () => ({ clearChatRooms: mocks.chatClear }));
vi.mock('./voice', () => ({ voice: { leave: mocks.leave } }));
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});
vi.stubGlobal('window', { localStorage: globalThis.localStorage, innerWidth: 960, clearTimeout, matchMedia: () => ({ matches: false }) });
const { drafts, draftMentions } = await import('../features/chat/drafts');
const { applyIdentityAccess } = await import('./identity');
const { useIdentity } = await import('../stores/identity');
const { useWorkspaces } = await import('../stores/workspaces');
const { useRooms } = await import('../stores/rooms');
const { useMessages } = await import('../stores/messages');
const { useRoomPreviews } = await import('../stores/roomPreviews');
const { useCalendar } = await import('../stores/calendar');
const { useVoice } = await import('../stores/voice');
const { useUi } = await import('../stores/ui');
const { queryClient } = await import('../lib/queryClient');
const { identityRequestBlocked, identityRequestVersion, resetIdentityGate } = await import('../lib/api/identityGate');
function seedWorkspace(id: string): void {
  useWorkspaces.getState().applySnapshot(
    create(WorkspaceSnapshotSchema, {
      workspace: create(WorkspaceSchema, { id, name: id }),
      members: [create(WorkspaceMemberSchema, { workspaceId: id, user: create(UserSchema, { id: `user-${id}` }) })],
    }),
  );
  useRooms.getState().upsert(create(RoomSchema, { id: `room-${id}`, workspaceId: id }));
  useMessages
    .getState()
    .setWindow(`room-${id}`, [create(MessageSchema, { id: `msg-${id}`, roomId: `room-${id}`, content: `protected-${id}` })], false, false);
  useRoomPreviews.getState().setPreview(`room-${id}`, create(MessageSchema, { id: `msg-${id}`, roomId: `room-${id}`, content: `protected-${id}` }));
}
beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaces.getState().reset();
  useRooms.getState().reset();
  useMessages.getState().reset();
  useRoomPreviews.getState().reset();
  useCalendar.getState().reset();
  useIdentity.getState().reset();
  queryClient.clear();
  resetIdentityGate();
  useVoice.setState({ workspaceId: null, roomId: null });
  seedWorkspace('a');
  seedWorkspace('b');
  useUi.getState().setWorkspace('a');
});
describe('workspace identity cache boundary', () => {
  it('clears protected workspace data while retaining other workspace and DM windows', () => {
    useRooms.getState().upsert(create(RoomSchema, { id: 'dm', workspaceId: '' }));
    useMessages.getState().setWindow('dm', [create(MessageSchema, { id: 'dm-msg', roomId: 'dm', content: 'personal' })], false, false);
    useCalendar.setState({
      series: { a: create(CalendarEventSchema, { workspaceId: 'a' }), b: create(CalendarEventSchema, { workspaceId: 'b' }) },
    });
    drafts.set('room-a', 'protected draft');
    drafts.set('room-b', 'other draft');
    draftMentions.set('room-a', new Map([['owner', 'user-a']]));
    queryClient.setQueryData(['messages', 'room-a'], 'protected');
    queryClient.setQueryData(['messages', 'room-b'], 'other');
    applyIdentityAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: 'a', reason: IdentityAccessReason.SSO_REQUIRED }));
    expect(drafts.has('room-a')).toBe(false);
    expect(draftMentions.has('room-a')).toBe(false);
    expect(drafts.get('room-b')).toBe('other draft');
    expect(useMessages.getState().rooms['room-a']).toBeUndefined();
    expect(useRoomPreviews.getState().preview['room-a']).toBeUndefined();
    expect(useRoomPreviews.getState().preview['room-b']?.content).toBe('protected-b');
    expect(useRooms.getState().byId['room-a']).toBeUndefined();
    expect(useWorkspaces.getState().byId['a']).toBeUndefined();
    expect(useWorkspaces.getState().users['user-a']).toBeUndefined();
    expect(useMessages.getState().rooms['room-b']?.items[0]?.msg.content).toBe('protected-b');
    expect(useMessages.getState().rooms['dm']?.items[0]?.msg.content).toBe('personal');
    expect(useCalendar.getState().series['a']).toBeUndefined();
    expect(useCalendar.getState().series['b']).toBeDefined();
    expect(queryClient.getQueryData(['messages', 'room-a'])).toBeUndefined();
    expect(queryClient.getQueryData(['messages', 'room-b'])).toBe('other');
    expect(mocks.clearMedia).toHaveBeenCalledOnce();
    expect(mocks.prune).toHaveBeenCalledWith(new Set(['room-a']));
    expect(useUi.getState().activeWorkspaceId).toBe('a');
    expect(useIdentity.getState().access['a']?.reason).toBe(IdentityAccessReason.SSO_REQUIRED);
  });
  it('does not end a voice session in an independently authorized workspace', async () => {
    useVoice.setState({ workspaceId: 'b', roomId: 'room-b' });
    applyIdentityAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: 'a', reason: IdentityAccessReason.DIRECTORY_DENIED }));
    await Promise.resolve();
    expect(mocks.leave).not.toHaveBeenCalled();
  });
  it('disconnects protected media when the revoked workspace owns the voice session', async () => {
    useVoice.setState({ workspaceId: 'a', roomId: 'room-a' });
    applyIdentityAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: 'a', reason: IdentityAccessReason.SSO_REQUIRED }));
    await vi.waitFor(() => expect(mocks.leave).toHaveBeenCalledWith(false));
  });
  it('rejects late responses across lock and reauthorization, preserving control-plane access', () => {
    const path = '/api/rooms/room-a/messages';
    applyIdentityAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: 'a', reason: IdentityAccessReason.ALLOWED }));
    const version = identityRequestVersion(path);
    applyIdentityAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: 'a', reason: IdentityAccessReason.SSO_REQUIRED }));
    expect(identityRequestBlocked(path, version)).toBe(true);
    expect(identityRequestBlocked('/api/workspaces/a/identity/link')).toBe(false);
    expect(identityRequestBlocked('/api/rooms/room-b/messages')).toBe(false);
    applyIdentityAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: 'a', reason: IdentityAccessReason.ALLOWED }));
    expect(identityRequestBlocked(path, version)).toBe(true);
    expect(identityRequestBlocked(path)).toBe(false);
  });
  it('a billing suspension drops the content but keeps the workspace as a paywall stub', () => {
    useWorkspaces.getState().setMyRole('a', WorkspaceRole.OWNER);
    useUi.getState().openDialog({ kind: 'workspace-settings', workspaceId: 'a', tab: 'plan' });
    applyIdentityAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: 'a', reason: IdentityAccessReason.BILLING_SUSPENDED }));
    expect(useMessages.getState().rooms['room-a']).toBeUndefined();
    expect(useRooms.getState().byId['room-a']).toBeUndefined();
    expect(useRoomPreviews.getState().preview['room-a']).toBeUndefined();
    const stub = useWorkspaces.getState().byId['a'];
    expect(stub?.ws.name).toBe('a');
    expect(stub?.ws.billing?.state).toBe(BillingState.SUSPENDED);
    expect(stub?.role).toBe(WorkspaceRole.OWNER);
    expect(Object.keys(stub?.members ?? {})).toEqual([]);
    expect(useWorkspaces.getState().users['user-a']).toBeUndefined();
    expect(useWorkspaces.getState().order).toContain('a');
    // The cabinet stays open; the owner's billing routes pass the gate, content does not.
    expect(useUi.getState().dialog?.kind).toBe('workspace-settings');
    expect(identityRequestBlocked('/api/workspaces/a/billing')).toBe(false);
    expect(identityRequestBlocked('/api/workspaces/a/billing/topups')).toBe(false);
    expect(identityRequestBlocked('/api/workspaces/a')).toBe(false);
    expect(identityRequestBlocked('/api/workspaces/a/members')).toBe(true);
    expect(identityRequestBlocked('/api/workspaces/a/billingx')).toBe(true);
    expect(identityRequestBlocked('/api/rooms/room-a/messages')).toBe(true);
    // Paid: access is back, the full snapshot replaces the stub (WORKSPACE_CREATE).
    applyIdentityAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: 'a', reason: IdentityAccessReason.ALLOWED }));
    expect(identityRequestBlocked('/api/workspaces/a/members')).toBe(false);
    // Another lock reason removes the workspace as before (and closes the billing exception).
    applyIdentityAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: 'a', reason: IdentityAccessReason.SUSPENDED }));
    expect(useWorkspaces.getState().byId['a']).toBeUndefined();
    expect(identityRequestBlocked('/api/workspaces/a/billing')).toBe(true);
  });
  it('treats an expired ALLOWED summary as locked', () => {
    applyIdentityAccess(
      create(WorkspaceIdentityAccessSchema, {
        workspaceId: 'a',
        reason: IdentityAccessReason.ALLOWED,
        validUntil: timestampFromMs(Date.now() - 1),
      }),
    );
    expect(useMessages.getState().rooms['room-a']).toBeUndefined();
  });
});
