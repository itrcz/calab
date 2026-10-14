import type { User } from '@calaba/protocol';
import { memo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { ProfileTarget } from '../../components/ProfileTarget';
import { cx } from '../../components/ui';
import { useWorkspaces } from '../../stores/workspaces';

/**
 * Mail addresses that are people of Calab (owner 12.10): `User.email` (ADR-0077, visible to
 * colleagues) of everyone the client knows — workspace members and DM peers alike live in
 * `useWorkspaces.users`. The address → user id index is built once per `users` object (it changes
 * only when a profile does), never per row; components select a user id (a string) by address.
 */

let index: { users: Record<string, User>; byEmail: Map<string, string> } | null = null;

/** The user id with this email (case-insensitive), or null. Memoised on the `users` object. */
export function userIdByEmail(users: Record<string, User>, email: string): string | null {
  if (index?.users !== users) {
    const byEmail = new Map<string, string>();
    for (const id in users) {
      const e = users[id]?.email.trim().toLowerCase();
      if (e && !byEmail.has(e)) byEmail.set(e, id);
    }
    index = { users, byEmail };
  }
  return index.byEmail.get(email.trim().toLowerCase()) ?? null;
}

/** The matching user's id for an address (a primitive selector: one row re-renders only when its match changes). */
export function useMailUser(address: string): string | null {
  return useWorkspaces((s) => (address ? userIdByEmail(s.users, address) : null));
}

/** The matched user's display name and avatar file (primitives). */
function useUserLook(userId: string): { name: string; fileId: string } {
  const name = useWorkspaces((s) => s.users[userId]?.displayName ?? '');
  const fileId = useWorkspaces((s) => s.users[userId]?.avatarFileId ?? '');
  return { name, fileId };
}

/** A person's avatar (no presence) as a profile button. */
export const UserAvatar = memo(function UserAvatar({ userId, size, className, link = true }: { userId: string; size: number; className?: string; link?: boolean }): ReactNode {
  const { name, fileId } = useUserLook(userId);
  // Inside another button (a collapsed message) it is a picture only.
  if (!link) return <Avatar userId={userId} name={name} size={size} {...(fileId ? { fileId } : {})} {...(className ? { className } : {})} />;
  return (
    <ProfileTarget userId={userId} name={name} className={cx('shrink-0 rounded-full', className)}>
      <Avatar userId={userId} name={name} size={size} {...(fileId ? { fileId } : {})} />
    </ProfileTarget>
  );
});

/** A person's display name as a profile button (the address stays in the secondary line / «Подробнее»). */
export const UserName = memo(function UserName({ userId, className, link = true }: { userId: string; className?: string; link?: boolean }): ReactNode {
  const { name } = useUserLook(userId);
  if (!link) return <span className={className}>{name}</span>;
  return (
    <ProfileTarget userId={userId} name={name} className={cx('min-w-0 truncate text-left hover:underline', className)}>
      {name}
    </ProfileTarget>
  );
});

/** The display name of a matched user (plain text, for labels). */
export function useUserName(userId: string | null): string {
  return useWorkspaces((s) => (userId ? (s.users[userId]?.displayName ?? '') : ''));
}
