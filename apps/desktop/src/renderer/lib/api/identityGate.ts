/** Renderer defence against cached/late responses after a workspace access revocation. */
const locked = new Set<string>();
/** Locked for unpaid billing (ADR-0080 §8): the owner's billing routes stay usable. */
const billingOnly = new Set<string>();
const rooms = new Map<string, string>();
const versions = new Map<string, number>();
export function identityPathWorkspace(path: string): string | undefined {
  const ws = /^\/api\/workspaces\/([^/?]+)/.exec(path)?.[1];
  if (ws) return ws;
  const room = /^\/api\/rooms\/([^/?]+)/.exec(path)?.[1];
  return room ? rooms.get(room) : resourceIdentityWorkspace(path);
}
export function markIdentityBoundary(workspaceId: string, roomIds: readonly string[], blocked: boolean, billing = false): void {
  for (const id of roomIds) rooms.set(id, workspaceId);
  versions.set(workspaceId, (versions.get(workspaceId) ?? 0) + 1);
  if (blocked) locked.add(workspaceId);
  else locked.delete(workspaceId);
  if (blocked && billing) billingOnly.add(workspaceId);
  else billingOnly.delete(workspaceId);
}
export function identityRoomLocked(roomId: string): boolean {
  const ws = rooms.get(roomId);
  return !!ws && locked.has(ws);
}
export function identityRequestVersion(path: string): number {
  return versions.get(identityPathWorkspace(path) ?? '') ?? 0;
}
export function identityRequestBlocked(path: string, version?: number): boolean {
  const ws = identityPathWorkspace(path);
  // The control-plane remains usable for linking, status and recovery, never protected content.
  if (/^\/api\/workspaces\/[^/]+\/identity(?:\/|$)/.test(path)) return false;
  // A workspace closed for unpaid billing: its owner pays through the billing routes and reads
  // the workspace itself (the server's recovery scope); everything else stays closed.
  if (ws && billingOnly.has(ws) && /^\/api\/workspaces\/[^/?]+(?:\/billing(?:[/?]|$)|\?|$)/.test(path)) return false;
  return !!ws && (locked.has(ws) || (version !== undefined && version !== identityRequestVersion(path)));
}
export function resetIdentityGate(): void {
  locked.clear();
  billingOnly.clear();
  rooms.clear();
  versions.clear();
  resources.clear();
}

const resources = new Map<string, string>();
export function rememberIdentityResources(workspaceId: string, resourcePaths: readonly string[]): void {
  for (const path of resourcePaths) resources.set(path, workspaceId);
}
export function resourceIdentityWorkspace(path: string): string | undefined {
  const key = /^\/api\/[^/]+\/[^/?]+/.exec(path)?.[0];
  return key ? resources.get(key) : undefined;
}
