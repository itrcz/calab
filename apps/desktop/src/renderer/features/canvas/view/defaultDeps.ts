/** The app's wiring of the Canvas screen: platform auth, the real WebSocket, the signed-in person. */
import { serverClockOffset } from '../../../lib/canvas/serverClock';
import { uploadCanvasImage } from '../../../services/canvas';
import { platform } from '../../../platform';
import { useSession } from '../../../stores/session';
import { memberName, useWorkspaces } from '../../../stores/workspaces';
import type { CanvasViewDeps } from './session';

export function appDeps(workspaceId: string): CanvasViewDeps {
  return {
    serverUrl: () => useSession.getState().serverUrl || window.location.origin,
    getToken: () => platform.auth.accessToken(),
    refreshToken: () => platform.auth.forceRefresh(),
    mediaUrl: (path) => platform.mediaUrl(path),
    uploadImage: uploadCanvasImage,
    openLink: (url) => void platform.app.openExternal(url),
    createSocket: (url) => new WebSocket(url),
    serverClockOffset: () => serverClockOffset(useSession.getState().serverUrl || window.location.origin),
    user: () => {
      const id = useSession.getState().me?.user?.id ?? '';
      const known = id && useWorkspaces.getState().byId[workspaceId]?.members[id];
      return { id, name: known ? memberName(workspaceId, id) : (useSession.getState().me?.user?.displayName ?? '') };
    },
  };
}
