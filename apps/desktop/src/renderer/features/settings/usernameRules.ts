/**
 * Nickname and phone rules of the profile (ADR-0077), as the server checks them (users/contacts.go):
 * the field says what is wrong before a request is made. The server stays the judge.
 */

export type UsernameState = 'idle' | 'checking' | 'free' | 'taken' | 'invalid' | 'reserved';

const USERNAME_RE = /^[a-z][a-z0-9_]{2,31}$/;
const RESERVED = new Set(['here', 'everyone', 'channel', 'all', 'admin', 'support', 'calab', 'system', 'bot']);
const PHONE_RE = /^\+?[0-9() -]+$/;

/** Trimmed, lower case, without one leading «@». */
export function normalizeUsername(s: string): string {
  return s.trim().replace(/^@/, '').toLowerCase();
}

/** What is wrong with a normalized nickname, or null ('' clears it: fine). */
export function usernameProblem(name: string): 'invalid' | 'reserved' | null {
  if (name === '') return null;
  if (!USERNAME_RE.test(name)) return 'invalid';
  return RESERVED.has(name) ? 'reserved' : null;
}

/** True when the phone would be refused ('' clears it: fine). */
export function phoneProblem(s: string): boolean {
  const p = s.trim().replace(/\s+/g, ' ');
  if (p === '') return false;
  const digits = p.replace(/\D/g, '').length;
  return p.length > 32 || !PHONE_RE.test(p) || digits < 3;
}
