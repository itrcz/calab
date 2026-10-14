import type { WorkspacePlan } from '@calaba/protocol';
import { t } from '../i18n';
import { log } from '../lib/log';
import { contactHref, planErrorNotice, planKind } from '../lib/plan';
import { platform } from '../platform';
import { iosNativeShell } from '../platform/nativeShell';
import { useSession } from '../stores/session';
import { useToasts, type ToastAction } from '../stores/toasts';
import { useWorkspaces } from '../stores/workspaces';

/**
 * Plan limits in the UI (ADR-0024, docs/08 «Тариф»): the contact link and the toasts shown when a
 * limit is hit. The rules themselves are pure (lib/plan.ts); the server enforces them.
 */

/** The plan of a workspace as members see it (Workspace.plan); undefined from an older server. */
export function workspacePlan(workspaceId: string | null | undefined): WorkspacePlan | undefined {
  return workspaceId ? useWorkspaces.getState().byId[workspaceId]?.ws.plan : undefined;
}

/**
 * Purchases, prices and sales offers: everywhere but the iOS shell (App Store rules, owner
 * 2026-10-10; platform/nativeShell). The Android shell, browsers and the desktop keep them.
 */
export function planOffersAllowed(): boolean {
  return !iosNativeShell();
}

/** «Связаться для покупки» target (READY.plan_contact), or null when the server gave none usable. */
export function planContact(): string | null {
  return planOffersAllowed() ? contactHref(useSession.getState().planContact) : null;
}

/** Opens the contact (the mail client for mailto:, the browser for https:). */
export function openPlanContact(): void {
  const href = planContact();
  if (!href) return;
  void platform.app.openExternal(href).catch((e: unknown) => log.warn('plan contact: open failed', e));
}

/** The toast's «Связаться» button (none without a usable contact). */
export function contactAction(): ToastAction | undefined {
  return planContact() ? { label: t('plan.contactShort'), run: openPlanContact } : undefined;
}

/** A plan-limit toast: info, with «Связаться» when buying would help and a contact is known. */
export function planToast(text: string, contact = true): void {
  const action = contact ? contactAction() : undefined;
  useToasts.getState().push('info', text, action);
}

/**
 * Shows the plan toast for an API error caused by a plan limit (409 ROOM_FULL PLAN_LIMIT, 413
 * FILE_QUOTA_EXCEEDED) and returns true; false for every other error (the caller reports it).
 */
export function reportPlanError(err: unknown, workspaceId: string | null | undefined): boolean {
  const notice = planErrorNotice(err, planKind(workspacePlan(workspaceId)));
  if (!notice) return false;
  planToast(notice.text, notice.contact);
  return true;
}
