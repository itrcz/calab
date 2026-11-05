import type { WorkspaceApp } from '@calaba/protocol';
import { t } from '../i18n';
import { api } from '../lib/api/endpoints';
import { isMobileNow } from '../lib/mobile';
import { log } from '../lib/log';
import { moveApp } from '../lib/webApps';
import { platform } from '../platform';
import { useBoardsUi } from '../stores/boardsUi';
import { toast } from '../stores/toasts';
import { useUi } from '../stores/ui';
import { useSignInAsk } from '../stores/webAppSignIn';
import { useWebApps } from '../stores/webApps';

/**
 * Web apps of a workspace (ADR-0050): open / manage, and the events. The site itself is shown by
 * features/webapps/AppScreen (a main-process view on the desktop, an iframe on the web; a phone
 * opens a new tab).
 */

/** Opens the app in place of the room column and the chat (a phone: a new browser tab). */
export function openWebApp(appId: string): void {
  const a = useWebApps.getState().byId[appId];
  if (!a) return;
  if (isMobileNow()) {
    // ADR-0050 §6: on a phone the site goes straight to a new tab.
    window.open(a.url, '_blank', 'noopener,noreferrer');
    return;
  }
  const ui = useUi.getState();
  if (ui.activeWorkspaceId !== a.workspaceId) ui.setWorkspace(a.workspaceId);
  if (useBoardsUi.getState().active) useBoardsUi.getState().setActive(false);
  useWebApps.getState().setOpen(appId);
}

export function closeWebApp(): void {
  useWebApps.getState().setOpen(null);
}

/** The app's address in a new browser tab (web) / the system browser (desktop). */
export function openAppInBrowser(url: string): void {
  if (platform.kind === 'electron') void platform.app.openExternal(url).catch((e: unknown) => toast.fail(e));
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export async function createWebApp(workspaceId: string, init: { name: string; url: string; iconFileId: string }): Promise<WorkspaceApp | undefined> {
  const r = await api.apps.create(workspaceId, init);
  if (r.app) useWebApps.getState().upsert(r.app);
  return r.app;
}

export async function updateWebApp(appId: string, init: { name?: string; url?: string; iconFileId?: string }): Promise<void> {
  const r = await api.apps.update(appId, init);
  if (r.app) useWebApps.getState().upsert(r.app);
}

export async function deleteWebApp(appId: string): Promise<void> {
  const a = useWebApps.getState().byId[appId];
  await api.apps.remove(appId);
  if (a) dropApp(a.workspaceId, appId);
}

/** Drag & drop in the rail: the new order at once, the server's order after (a refusal restores it). */
export async function moveWebApp(workspaceId: string, appId: string, index: number): Promise<void> {
  const st = useWebApps.getState();
  const before = st.order[workspaceId] ?? [];
  const m = moveApp(before, appId, index);
  st.reorder(workspaceId, m.order);
  try {
    const r = await api.apps.move(appId, m.after, m.before);
    useWebApps.getState().setWorkspace(workspaceId, r.apps);
  } catch (e) {
    useWebApps.getState().reorder(workspaceId, before);
    toast.fail(e, t('err.ctx.save'));
  }
}

/** WORKSPACE_APP_DELETE or my own delete: the icon goes, the desktop view and its site data too. */
function dropApp(workspaceId: string, appId: string): void {
  useWebApps.getState().remove(workspaceId, appId);
  void platform.webApps?.forget(appId).catch((e: unknown) => log.warn('webapp forget failed', e));
}

export function applyAppUpsert(a: WorkspaceApp): void {
  useWebApps.getState().upsert(a);
}

export function applyAppDelete(workspaceId: string, appId: string): void {
  dropApp(workspaceId, appId);
}

/**
 * My role in a workspace changed (ADR-0050 §1: guests see no apps): a guest made a member loads
 * the list (the snapshot of a guest had none), a member made a guest loses it.
 */
export function onMyRoleChanged(workspaceId: string, wasGuest: boolean, isGuest: boolean): void {
  if (wasGuest === isGuest) return;
  if (isGuest) {
    useWebApps.getState().setWorkspace(workspaceId, []);
    return;
  }
  api.apps.list(workspaceId).then(
    (r) => useWebApps.getState().setWorkspace(workspaceId, r.apps),
    (e: unknown) => log.warn('webapps list failed', e),
  );
}

let installed = false;

/** Once: the desktop views' navigation state, main's sign-in consents, and the boards mode closing an app. */
export function installWebApps(): void {
  if (installed) return;
  installed = true;
  platform.webApps?.onState((s) => useWebApps.getState().setNav(s));
  platform.webApps?.onSignInAsk((ask) => useSignInAsk.setState({ ask }));
  // Boards opened from anywhere (a link, a notification) replace the app, like a room does.
  useBoardsUi.subscribe((s, prev) => {
    if (s.active && !prev.active) closeWebApp();
  });
}
