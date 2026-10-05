/**
 * The phone layout's breakpoint and the focus rule, without imports: components/ui.tsx uses them
 * and is loaded by unit tests in Node (lib/mobile.ts pulls in the platform layer).
 */
export const MOBILE_MAX = 768;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX}px)`;

/**
 * Programmatic focus of a text field (autoFocus, focus on a room switch): not on a phone. iOS
 * scrolls / zooms to the field and raises the keyboard over what the user was looking at, so on
 * phones a field is focused only by the user's own tap (docs/08 «Мобильный веб»). The phone
 * layout is the web build (`web` class on <html>, main.tsx) at ≤ 768 px.
 */
export function autoFocusAllowed(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return true;
  return !(document.documentElement.classList.contains('web') && window.matchMedia(MOBILE_QUERY).matches);
}

/**
 * The primary input cannot hover (a phone / tablet): tooltips never open and hover-only controls
 * are unreachable there, so such UI shows its text as a toast / stays visible (docs/08 «Мобильный веб»).
 */
export function isTouchPrimary(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
}
