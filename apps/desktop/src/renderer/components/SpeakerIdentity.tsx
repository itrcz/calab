import type { WorkspaceRole } from '@calaba/protocol';
import { VolumeX } from 'lucide-react';
import type { ReactNode } from 'react';
import { usePrefs } from '../stores/prefs';
import { Avatar } from './Avatar';
import { ProfileTarget } from './ProfileTarget';
import { StatusEmoji } from './StatusEmoji';
import { cx } from './ui';
import { t } from '../i18n';
import { hasRoleMark, roleTextClass } from '../features/people/MemberBits';
import { BadgeOrRoleMark } from '../features/people/MemberBadge';
import { BirthdayMark } from '../features/people/Birthday';

/**
 * Name colour of a voice participant (docs/08 «Индикация речи», Discord): primary while they
 * speak, muted otherwise (hover brightens the row). Colour only — no weight change, no jump.
 * Owner / admins keep their role colour either way (docs/09 #26): the ring on the avatar says
 * who is talking, the colour on the name says who they are.
 */
export function speakerNameClass(talking: boolean, role?: WorkspaceRole): string {
  if (hasRoleMark(role)) return roleTextClass(role);
  return talking ? 'text-fg' : 'text-muted group-hover/member:text-fg';
}

/**
 * Avatar with the speaking ring + the name, for voice participant rows (the sidebar under a
 * voice room). `talking` = speaking and not muted; the caller reads it per user from the store.
 * `pending` = still connecting for more than 3 s (stores/voicePending useConnectingRing): the
 * «connecting» ring replaces the speaking one and the avatar says «Подключается…».
 */
export function SpeakerIdentity({
  userId,
  name,
  fileId,
  size,
  talking,
  pending = false,
  suffix,
  role,
  workspaceId,
}: {
  userId: string;
  name: string;
  fileId?: string;
  size: number;
  talking: boolean;
  pending?: boolean;
  /** Muted tail after the name (the time-zone label). */
  suffix?: string | null;
  /** Workspace role: owner / admin names in the role colour + RoleMark, unless the member has a badge (docs/09 #26, #129). */
  role?: WorkspaceRole | undefined;
  /** The room's workspace: the member's badge after the name (docs/09 #82). */
  workspaceId?: string | undefined;
}): ReactNode {
  return (
    <>
      {pending ? (
        <span className="flex shrink-0" title={t('voice.pendingMember')} data-pending="true">
          <ProfileTarget userId={userId} name={name} workspaceId={workspaceId} tabbable className="flex shrink-0 rounded-full">
            <Avatar userId={userId} name={name} fileId={fileId} size={size} connecting ringInside />
          </ProfileTarget>
        </span>
      ) : (
        <ProfileTarget userId={userId} name={name} workspaceId={workspaceId} tabbable className="flex shrink-0 rounded-full">
          <Avatar userId={userId} name={name} fileId={fileId} size={size} speaking={talking} ringInside />
        </ProfileTarget>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span data-testid="speaker-name" className={cx('min-w-0 truncate transition-colors duration-100', speakerNameClass(talking && !pending, role))}>
          {name}
        </span>
        {/* The badge replaces the role mark (owner, 29.09, docs/08 «Бейдж»). */}
        <BadgeOrRoleMark workspaceId={workspaceId} userId={userId} role={role} />
        {suffix ? (
          // Time zone as a tiny tag (owner, 28.09): present, but takes almost no room.
          <span className="inline-flex h-[14px] shrink-0 items-center rounded-full bg-hover px-1 text-[9px] font-medium leading-none tabular-nums text-muted">{suffix}</span>
        ) : null}
        <BirthdayMark userId={userId} />
        {/* Custom status in voice too (07.10): the emoji, the text in the tooltip. */}
        <StatusEmoji userId={userId} />
      </span>
      <MutedByMe userId={userId} />
    </>
  );
}

/** «Вы заглушили» (docs/09 #20): I muted them for myself (prefs.mutedUsers) — a muted VolumeX. */
export function MutedByMe({ userId, className }: { userId: string; className?: string }): ReactNode {
  const muted = usePrefs((s) => s.mutedUsers[userId] === true);
  if (!muted) return null;
  return <VolumeX className={cx('size-4 shrink-0 text-muted', className)} aria-label={t('people.mutedByYou')} role="img" data-testid="muted-by-me" />;
}
