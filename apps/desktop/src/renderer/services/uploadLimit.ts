import { ApiError } from '../lib/api/client';
import { uploadsAboveFileLimit } from '../lib/permissions';
import { myUserId, useSession } from '../stores/session';
import { rolesOf, useWorkspaces } from '../stores/workspaces';

const MB = 1 << 20;

/**
 * The size limit of one file I upload here, in bytes (CBF-191, ADR-0155): the workspace's own
 * (Workspace.max_file_mb) or the server's (READY.max_file_mb) — DMs and notes (`workspaceId` '')
 * always the server's. undefined = no client check: the server's limit is unknown (an older
 * server), or I am an administrator of the workspace, who uploads up to the server's hard cap
 * (ADR-0164). The server decides anyway (413 FILE_TOO_LARGE); this only spares a doomed upload.
 */
export function fileLimitBytes(workspaceId: string): number | undefined {
  const server = useSession.getState().maxFileMb;
  if (!workspaceId) return server > 0 ? server * MB : undefined;
  const entry = useWorkspaces.getState().byId[workspaceId];
  if (!entry || uploadsAboveFileLimit(rolesOf(entry, myUserId()))) return undefined;
  const mb = entry.ws.maxFileMb || server;
  return mb > 0 ? mb * MB : undefined;
}

/**
 * The refusal the server would give a file of `size` bytes (413 FILE_TOO_LARGE with `limit`), or
 * null when it fits / the limit is unknown. lib/api/errors describes both the same way.
 */
export function tooLargeError(workspaceId: string, size: number): ApiError | null {
  const limit = fileLimitBytes(workspaceId);
  if (limit === undefined || size <= limit) return null;
  return new ApiError('ERROR_CODE_FILE_TOO_LARGE', 'file exceeds the limit', 413, undefined, { limit });
}
