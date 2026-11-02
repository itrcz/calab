import { create } from '@bufbuild/protobuf';
import {
  DispatchEventSchema,
  IdentityAccessReason,
  ReadySchema,
  WorkspaceCreateSchema,
  WorkspaceDeleteSchema,
  WorkspaceIdentityAccessSchema,
  WorkspaceRole,
  WorkspaceSchema,
  WorkspaceSnapshotSchema,
  type DispatchEvent,
} from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => false, addEventListener: vi.fn(), visibilityState: 'visible' });
vi.stubGlobal('window', globalThis);

vi.mock('./billing', () => ({ onBillingUpdate: vi.fn(), onWorkspaceBilling: vi.fn(), resyncBilling: vi.fn() }));
vi.mock('./voice', () => ({ voice: { leave: vi.fn(), leaveParked: vi.fn(), currentRoomId: null, onMoved: vi.fn(), reconcileSelfState: vi.fn(), stopStream: vi.fn(), checkSeat: vi.fn(), onGatewayBack: vi.fn(), refreshRights: vi.fn() } }));
vi.mock('./chat', () => ({ clearChatRooms: vi.fn(), resyncLoadedRooms: vi.fn(() => Promise.resolve()), resyncPins: vi.fn(() => Promise.resolve()), retryFailedLoads: vi.fn(() => Promise.resolve()) }));
vi.mock('./mentions', () => ({ loadMentions: () => Promise.resolve() }));
vi.mock('./notify', () => ({ onIncomingMessage: vi.fn(), mentionsMe: () => false }));
vi.mock('./profile', () => ({ applyUserSettings: vi.fn() }));
const { resyncGateway } = vi.hoisted(() => ({ resyncGateway: vi.fn() }));
vi.mock('./gateway', () => ({ pruneGatewaySubscriptions: vi.fn(), resyncGateway }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined }, clearProtectedMedia: vi.fn() } }));

const { applyDispatch, PENDING_WORKSPACE_MAX_MS } = await import('./dispatch');
const { useWorkspaces } = await import('../stores/workspaces');
const { useRooms } = await import('../stores/rooms');
const { useIdentity } = await import('../stores/identity');
const { resetIdentityGate } = await import('../lib/api/identityGate');
const { useSession } = await import('../stores/session');
const { useUi } = await import('../stores/ui');

const A = 'ws-a';
const B = 'ws-b';
const ev = (event: DispatchEvent['event']): DispatchEvent => create(DispatchEventSchema, { event });
const snap = (id: string) => create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id, name: id }), role: WorkspaceRole.MEMBER });
const ready = (ids: string[], pending: string[] = []): void =>
  applyDispatch(ev({ case: 'ready', value: create(ReadySchema, { sessionId: 'gs', workspaces: ids.map(snap), pendingWorkspaceIds: pending }) }));
const active = (): string | null => useUi.getState().activeWorkspaceId;

beforeEach(() => {
  vi.useFakeTimers();
  useWorkspaces.getState().reset();
  useRooms.getState().reset();
  useIdentity.getState().reset();
  resetIdentityGate();
  useSession.getState().set({ sessionId: 'gs' });
  ready([A, B]);
  useUi.getState().setWorkspace(A);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a workspace READY lists as pending (board #145)', () => {
  it('stays selected as pending until its WORKSPACE_CREATE', () => {
    ready([B], [A]);
    expect(active()).toBe(A);
    expect(useWorkspaces.getState().pending[A]).toBe(A); // under its last known name
    expect(useWorkspaces.getState().byId[A]).toBeUndefined();
    applyDispatch(ev({ case: 'workspaceCreate', value: create(WorkspaceCreateSchema, { snapshot: snap(A) }) }));
    expect(useWorkspaces.getState().pending[A]).toBeUndefined();
    expect(useWorkspaces.getState().byId[A]).toBeDefined();
    expect(active()).toBe(A);
  });

  it('a lock settles it on the lock screen, an ALLOWED update does not', () => {
    ready([B], [A]);
    const access = (reason: IdentityAccessReason) =>
      applyDispatch(
        ev({
          case: 'workspaceIdentityAccessUpdate',
          value: { $typeName: 'calaba.v1.WorkspaceIdentityAccessUpdate', sessionId: 'gs', access: create(WorkspaceIdentityAccessSchema, { workspaceId: A, reason }) },
        }),
      );
    access(IdentityAccessReason.ALLOWED); // the sweep's re-add: its WORKSPACE_CREATE follows
    expect(useWorkspaces.getState().pending[A]).toBe(A); // under its last known name
    access(IdentityAccessReason.SSO_REQUIRED);
    expect(useWorkspaces.getState().pending[A]).toBeUndefined();
    expect(active()).toBe(A); // WorkspaceLock, not Welcome
  });

  it('WORKSPACE_DELETE removes it as today', () => {
    ready([B], [A]);
    applyDispatch(ev({ case: 'workspaceDelete', value: create(WorkspaceDeleteSchema, { workspaceId: A }) }));
    expect(useWorkspaces.getState().pending[A]).toBeUndefined();
    expect(active()).toBe(B);
  });

  it('asks for a fresh READY after the bound, never giving the workspace up', () => {
    resyncGateway.mockClear();
    ready([], [A]); // the only workspace: giving it up would show Welcome
    vi.advanceTimersByTime(PENDING_WORKSPACE_MAX_MS - 1);
    expect(resyncGateway).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resyncGateway).toHaveBeenCalledTimes(1);
    expect(useWorkspaces.getState().pending[A]).toBe(A);
    expect(active()).toBe(A);
    // Settled meanwhile: no resync.
    resyncGateway.mockClear();
    ready([B], [A]);
    applyDispatch(ev({ case: 'workspaceCreate', value: create(WorkspaceCreateSchema, { snapshot: snap(A) }) }));
    vi.advanceTimersByTime(PENDING_WORKSPACE_MAX_MS);
    expect(resyncGateway).not.toHaveBeenCalled();
  });

  it('a workspace READY leaves out without listing it pending is gone, as before', () => {
    ready([B]);
    expect(active()).toBe(B);
    useUi.getState().setWorkspace(B);
    ready([]);
    expect(active()).toBeNull(); // truly no workspace: Welcome
  });
});
