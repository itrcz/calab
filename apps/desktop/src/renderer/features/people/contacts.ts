import { WorkspaceRole } from '@calaba/protocol';
import { useShallow } from 'zustand/react/shallow';
import { useSession } from '../../stores/session';
import { useWorkspaces, type WorkspaceEntry } from '../../stores/workspaces';

/**
 * Contacts of a person (ADR-0077): email (+ verified mark) and phone. The server fills them only
 * for colleagues — someone I share a workspace with where neither of us is a guest — and never for
 * guests or bots. The client shows them by the same rule over the workspaces it holds, so contacts
 * learnt earlier stop showing once that is no longer true (left the workspace, a role change).
 */

/** Same rule as the server (pbconv.ContactsVisible), over every workspace I am in. */
export function contactsVisible(byId: Readonly<Record<string, WorkspaceEntry>>, me: string, userId: string): boolean {
  if (!userId) return false;
  if (userId === me) return true;
  for (const e of Object.values(byId)) {
    if (e.role === WorkspaceRole.GUEST || e.role === WorkspaceRole.UNSPECIFIED) continue;
    const m = e.members[userId];
    if (!m?.user || m.role === WorkspaceRole.GUEST || m.user.isBot || m.user.isGuest) continue;
    return true;
  }
  return false;
}

export interface Contacts {
  email: string;
  emailVerified: boolean;
  phone: string;
}

const NONE = { visible: false, email: '', emailVerified: false, phone: '' };

/**
 * The person's contacts when I may see them, else null. A shallow selector of primitives: a
 * presence or voice change re-renders nothing.
 */
export function useContacts(userId: string): Contacts | null {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const c = useWorkspaces(
    useShallow((s) => {
      const u = s.users[userId];
      if (!u || (!u.email && !u.phone) || !contactsVisible(s.byId, me, userId)) return NONE;
      return { visible: true, email: u.email, emailVerified: u.emailVerified, phone: u.phone };
    }),
  );
  return c.visible ? { email: c.email, emailVerified: c.emailVerified, phone: c.phone } : null;
}

/** The person's nickname (public, ADR-0077), '' for none. */
export function useUsername(userId: string): string {
  return useWorkspaces((s) => s.users[userId]?.username ?? '');
}

/** `+7 (999) 123-45-67` → `tel:+79991234567`. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}
