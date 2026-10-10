import type { Session } from 'electron';

/**
 * Sessions of workspace web apps (ADR-0050 §4, `persist:app-<id>`). Every webContents in one of
 * them — an app's view, a sign-in popup it opened — gets the app guards (main/webApps.ts), not
 * the ones of our own pages (windows.ts guardWebContents), which must stay as strict as they are.
 * Kept in its own module so windows.ts and webApps.ts do not import each other.
 */
const appSessions = new WeakSet<Session>();

export function markAppSession(ses: Session): void {
  appSessions.add(ses);
}

export function isAppSession(ses: Session | undefined): boolean {
  return !!ses && appSessions.has(ses);
}

/**
 * The in-memory session of the checkout window's page (ADR-0084, main/checkoutWindow.ts): it gets
 * the checkout guards (https navigation for card 3DS), not windows.ts guardWebContents.
 */
const checkoutSessions = new WeakSet<Session>();

export function markCheckoutSession(ses: Session): void {
  checkoutSessions.add(ses);
}

export function isCheckoutSession(ses: Session | undefined): boolean {
  return !!ses && checkoutSessions.has(ses);
}
