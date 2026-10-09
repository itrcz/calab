import { create } from '@bufbuild/protobuf';
import {
  BillingState,
  BillingUpdateSchema,
  DispatchEventSchema,
  IdentityAccessReason,
  ReadySchema,
  RoomSchema,
  RoomType,
  WorkspaceBillingStatusSchema,
  WorkspaceIdentityAccessSchema,
  WorkspaceRole,
  WorkspaceSchema,
  WorkspaceSnapshotSchema,
  WorkspaceUpdateSchema,
  type DispatchEvent,
} from '@calaba/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('document', { hasFocus: () => false, addEventListener: vi.fn(), visibilityState: 'visible' });
vi.stubGlobal('window', globalThis);

const billing = vi.hoisted(() => ({ onBillingUpdate: vi.fn(), onWorkspaceBilling: vi.fn(), resyncBilling: vi.fn() }));
vi.mock('./billing', () => billing);
vi.mock('./voice', () => ({ voice: { leave: vi.fn(), currentRoomId: null, onMoved: vi.fn(), reconcileSelfState: vi.fn(), stopStream: vi.fn(), checkSeat: vi.fn(), refreshRights: vi.fn() } }));
vi.mock('./chat', () => ({ clearChatRooms: vi.fn(), resyncLoadedRooms: vi.fn(() => Promise.resolve()), resyncPins: vi.fn(() => Promise.resolve()), retryFailedLoads: vi.fn(() => Promise.resolve()) }));
vi.mock('./mentions', () => ({ loadMentions: () => Promise.resolve() }));
vi.mock('./notify', () => ({ onIncomingMessage: vi.fn(), mentionsMe: () => false }));
vi.mock('./profile', () => ({ applyUserSettings: vi.fn() }));
vi.mock('./gateway', () => ({ pruneGatewaySubscriptions: vi.fn() }));
vi.mock('../stores/toasts', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../platform', () => ({ platform: { kind: 'web', app: { log: () => undefined }, clearProtectedMedia: vi.fn() } }));

const { applyDispatch } = await import('./dispatch');
const { useWorkspaces } = await import('../stores/workspaces');
const { useRooms } = await import('../stores/rooms');
const { useIdentity } = await import('../stores/identity');
const { resetIdentityGate } = await import('../lib/api/identityGate');
const { useSession } = await import('../stores/session');

const WS = 'ws-paid';
const ev = (event: DispatchEvent['event']): DispatchEvent => create(DispatchEventSchema, { event });
const suspended = () => create(WorkspaceBillingStatusSchema, { state: BillingState.SUSPENDED });

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaces.getState().reset();
  useRooms.getState().reset();
  useIdentity.getState().reset();
  resetIdentityGate();
  useSession.getState().set({ sessionId: 'gs' });
});

describe('a workspace closed for unpaid billing (ADR-0080 §8)', () => {
  it('READY with the stub keeps it listed with the paywall state; only BILLING_UPDATE of it passes', () => {
    applyDispatch(
      ev({
        case: 'ready',
        value: create(ReadySchema, {
          sessionId: 'gs',
          workspaces: [create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: WS, name: 'Paid', billing: suspended() }), role: WorkspaceRole.OWNER })],
          identityAccess: [create(WorkspaceIdentityAccessSchema, { workspaceId: WS, reason: IdentityAccessReason.BILLING_SUSPENDED })],
        }),
      }),
    );
    const entry = useWorkspaces.getState().byId[WS];
    expect(entry?.ws.name).toBe('Paid');
    expect(entry?.ws.billing?.state).toBe(BillingState.SUSPENDED);
    expect(entry?.role).toBe(WorkspaceRole.OWNER);

    applyDispatch(ev({ case: 'billingUpdate', value: create(BillingUpdateSchema, { workspaceId: WS, revision: 3n }) }));
    expect(billing.onBillingUpdate).toHaveBeenCalledWith(WS, 3n);
    // Any other lock keeps dropping it.
    useIdentity.getState().setAccess(create(WorkspaceIdentityAccessSchema, { workspaceId: WS, reason: IdentityAccessReason.SSO_REQUIRED }));
    applyDispatch(ev({ case: 'billingUpdate', value: create(BillingUpdateSchema, { workspaceId: WS, revision: 4n }) }));
    expect(billing.onBillingUpdate).toHaveBeenCalledTimes(1);
  });

  it('a live suspension turns the open workspace into the stub; paying brings it back in full', () => {
    applyDispatch(
      ev({
        case: 'ready',
        value: create(ReadySchema, {
          sessionId: 'gs',
          workspaces: [
            create(WorkspaceSnapshotSchema, {
              workspace: create(WorkspaceSchema, { id: WS, name: 'Paid' }),
              role: WorkspaceRole.MEMBER,
              rooms: [create(RoomSchema, { id: 'r1', workspaceId: WS, type: RoomType.TEXT, name: 'general' })],
            }),
          ],
        }),
      }),
    );
    // WORKSPACE_UPDATE while the lease still holds: the state switches to the paywall at once.
    applyDispatch(ev({ case: 'workspaceUpdate', value: create(WorkspaceUpdateSchema, { workspace: create(WorkspaceSchema, { id: WS, name: 'Paid', billing: suspended() }) }) }));
    expect(useWorkspaces.getState().byId[WS]?.ws.billing?.state).toBe(BillingState.SUSPENDED);
    // The sweep's access status: content goes, the stub stays.
    applyDispatch(
      ev({
        case: 'workspaceIdentityAccessUpdate',
        value: { $typeName: 'calaba.v1.WorkspaceIdentityAccessUpdate', sessionId: 'gs', access: create(WorkspaceIdentityAccessSchema, { workspaceId: WS, reason: IdentityAccessReason.BILLING_SUSPENDED }) },
      }),
    );
    expect(useRooms.getState().byId['r1']).toBeUndefined();
    expect(useWorkspaces.getState().byId[WS]?.role).toBe(WorkspaceRole.MEMBER);
    expect(useWorkspaces.getState().byId[WS]?.ws.billing?.state).toBe(BillingState.SUSPENDED);
    // Paid: ALLOWED, then the full snapshot.
    applyDispatch(
      ev({
        case: 'workspaceIdentityAccessUpdate',
        value: { $typeName: 'calaba.v1.WorkspaceIdentityAccessUpdate', sessionId: 'gs', access: create(WorkspaceIdentityAccessSchema, { workspaceId: WS, reason: IdentityAccessReason.ALLOWED }) },
      }),
    );
    applyDispatch(
      ev({
        case: 'workspaceCreate',
        value: {
          $typeName: 'calaba.v1.WorkspaceCreate',
          snapshot: create(WorkspaceSnapshotSchema, {
            workspace: create(WorkspaceSchema, { id: WS, name: 'Paid', billing: create(WorkspaceBillingStatusSchema, { state: BillingState.ACTIVE }) }),
            role: WorkspaceRole.MEMBER,
            rooms: [create(RoomSchema, { id: 'r1', workspaceId: WS, type: RoomType.TEXT, name: 'general' })],
          }),
        },
      }),
    );
    expect(useWorkspaces.getState().byId[WS]?.ws.billing?.state).toBe(BillingState.ACTIVE);
    expect(useRooms.getState().byId['r1']).toBeDefined();
  });
});
