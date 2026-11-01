import { WorkspaceRole, type Workspace } from '@calaba/protocol';

/*
 * Workspace suspension and bans in the UI (docs/09 #32). Pure rules; the server enforces them
 * (403 WORKSPACE_SUSPENDED / BANNED) — the client only explains and hides.
 */

/** Longest reason the server takes (suspension and ban). */
export const REASON_MAX = 500;

/** The workspace is suspended by a superadmin: read-only. */
export const isSuspended = (ws: Workspace | undefined): boolean => !!ws?.suspension;

export interface SuspendedView {
  /** The reason, for the owner / admins (the server sends it only to them). */
  reason: string;
  /** Owner / admins: the text addressed to them and the «Связаться» button. */
  manager: boolean;
}

/** What the suspended bar shows to a member with `role`; null = not suspended. */
export function suspendedView(ws: Workspace | undefined, role: WorkspaceRole | undefined): SuspendedView | null {
  if (!ws?.suspension) return null;
  const manager = role === WorkspaceRole.OWNER || role === WorkspaceRole.ADMIN;
  return { reason: manager ? ws.suspension.reason.trim() : '', manager };
}

export type SuspensionChange =
  | { error: 'reason' }
  | {
      suspended: boolean;
      reason: string;
      confirm: 'suspend' | 'resume' | null;
    };

/**
 * The superadmin's suspension form → the PUT body. Suspending needs a reason; changing only the
 * reason of a suspended workspace needs no confirmation; resuming ignores the reason.
 */
export function suspensionChange(current: boolean, next: boolean, reason: string): SuspensionChange {
  const r = reason.trim().slice(0, REASON_MAX);
  if (!next) return { suspended: false, reason: '', confirm: current ? 'resume' : null };
  if (!r) return { error: 'reason' };
  return { suspended: true, reason: r, confirm: current ? null : 'suspend' };
}

/** react-query key of a workspace's bans; WORKSPACE_BAN_ADD / _REMOVE invalidate it (services/dispatch). */
export const bansKey = (workspaceId: string) => ['bans', workspaceId] as const;

/** react-query key of a workspace's reports (ADR-0154); WORKSPACE_REPORT_* invalidate it. */
export const reportsKey = (workspaceId: string) => ['reports', workspaceId] as const;
