import { PresenceStatus, WorkspaceRole } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { MessageCircle, MonitorUp, Pencil, Phone, UserRound, Volume2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, Toggle } from '../../components/ui';
import { fmt } from '../../lib/format';
import { t, type MessageKey } from '../../i18n';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { isGuest, useMemberName, useRoleLook, useWorkspaces } from '../../stores/workspaces';
import { BotBadge, GuestBadge, roleTextClass, roleTextStyle } from './MemberBits';
import { BotActions, BotDetails, BotHandle } from './BotProfile';
import { BadgeOrRoleMark } from './MemberBadge';
import { VolumeRow, useMemberActions } from './MemberContextMenu';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { useVoice } from '../../stores/voice';
import { useCanCall, useCanDm } from '../dm/canDm';
import { useOnCall } from '../call/CallBits';
import { startCall } from '../../services/call';
import { startDm } from '../../services/dms';
import { openProfile } from './actions';
import { LocalTime } from './LocalTime';
import { BirthdayInfo } from './Birthday';
import { ProfileCardAchievements } from './ProfileAchievements';

const ROLE_KEY: Record<WorkspaceRole, MessageKey> = {
  [WorkspaceRole.UNSPECIFIED]: 'role.member',
  [WorkspaceRole.OWNER]: 'role.owner',
  [WorkspaceRole.ADMIN]: 'role.admin',
  [WorkspaceRole.MEMBER]: 'role.member',
  [WorkspaceRole.GUEST]: 'role.guest',
};

const PRESENCE_KEY: Partial<Record<PresenceStatus, MessageKey>> = {
  [PresenceStatus.ONLINE]: 'presence.online',
  [PresenceStatus.IDLE]: 'presence.idle',
  [PresenceStatus.DND]: 'presence.dnd',
};

/**
 * Member profile (docs/09 #12): avatar, name (nickname) + profile name, presence, custom
 * status, role, voice, «В пространстве с», and «Сменить ник» when allowed.
 */
export function ProfileCard({
  workspaceId,
  userId,
  onRename,
  onClose,
}: {
  workspaceId: string;
  userId: string;
  onRename: () => void;
  /** Closes the card (after «Написать» opened the DM). */
  onClose?: () => void;
}): ReactNode {
  const m = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]);
  const status = useWorkspaces((s) => s.presences[userId]?.status);
  const v = useWorkspaces((s) => s.byId[workspaceId]?.voice[userId]);
  const roomName = useRooms((s) => (v?.roomId ? s.byId[v.roomId]?.name : undefined));
  const self = useSession((s) => s.me?.user?.id) === userId;
  const name = useMemberName(workspaceId, userId);
  const look = useRoleLook(workspaceId, userId);
  const actions = useMemberActions(workspaceId, userId);
  const localMuted = usePrefs((s) => !!s.mutedUsers[userId]);
  const canDm = useCanDm(workspaceId, userId);
  const canCall = useCanCall(userId, workspaceId);
  const onCall = useOnCall(userId);
  // Speaking ring while they talk in my call (docs/08 «Индикация речи»).
  const speaking = useVoice((st) => st.speaking[userId] ?? false);
  const u = m?.user;
  if (!m || !u) return null;
  const presence = status !== undefined ? PRESENCE_KEY[status] : undefined;
  const statusLine = [u.statusEmoji, u.statusText].filter(Boolean).join(' ');
  return (
    <div className="flex w-72 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={56} presence speaking={speaking && !v?.muted} ring="var(--color-popover-solid)" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className={`truncate text-headline font-semibold ${roleTextClass(m.role, 'role', look)}`} style={roleTextStyle(m.role, 'role', look)} title={name}>
              {name}
            </h3>
            {/* The badge inline after the name, as in lists (docs/08 «Бейдж»); its name is the tooltip. */}
            <BadgeOrRoleMark workspaceId={workspaceId} userId={userId} role={m.role} custom={look} />
            {isGuest(m) ? <GuestBadge /> : null}
            {u.isBot ? <BotBadge /> : null}
          </div>
          {m.nickname && m.nickname !== u.displayName ? (
            <div className="truncate text-body text-muted" title={u.displayName}>
              {u.displayName}
            </div>
          ) : null}
          {/* A bot (ADR-0031): its @username instead of presence (bots are never «в сети» as people). */}
          {u.isBot ? (
            <BotHandle botUserId={userId} />
          ) : onCall ? (
            // ADR-0034: «На звонке» (with whom is not disclosed) instead of the presence line.
            <div className="flex items-center gap-1 text-caption text-muted">
              <Phone className="size-3.5 shrink-0 text-ok" aria-hidden />
              {t('call.onCall')}
            </div>
          ) : (
            <div className="text-caption text-muted">{t(presence ?? 'members.offline')}</div>
          )}
        </div>
      </div>
      {statusLine ? <p className="selectable break-words text-body">{statusLine}</p> : null}
      {u.isBot ? <BotDetails botUserId={userId} compact /> : null}
      {canDm ? (
        // ADR-0020 / ADR-0034: the most direct next steps from a profile — «Написать», «Позвонить».
        // 16 px from the header block (12 gap + 4), like the card's padding (docs/08 «Карточка участника»).
        <div className="mt-1 flex gap-2">
          <Button
            className="min-w-0 flex-1"
            onClick={() => {
              onClose?.();
              void startDm(userId);
            }}
          >
            <MessageCircle className="size-3.5" aria-hidden />
            {t('dm.write')}
          </Button>
          {canCall ? (
            <Button
              variant="secondary"
              className="min-w-0 flex-1"
              onClick={() => {
                onClose?.();
                void startCall(userId);
              }}
            >
              <Phone className="size-3.5" aria-hidden />
              {t('call.call')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 border-t border-line pt-3 text-caption">
        <dt className="text-muted">{t('people.profile.role')}</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          {t(ROLE_KEY[m.role])}
        </dd>
        <ProfileCardAchievements workspaceId={workspaceId} userId={userId} />
        {u.isBot ? null : <LocalTime userId={userId} variant="row" />}
        {u.isBot ? null : <BirthdayInfo userId={userId} variant="row" />}
        {v?.roomId ? (
          <>
            <dt className="text-muted">{t('people.profile.voice')}</dt>
            <dd className="flex min-w-0 items-center gap-1.5">
              {v.streaming ? <MonitorUp className="size-3.5 shrink-0 text-danger" aria-hidden /> : <Volume2 className="size-3.5 shrink-0 text-ok" aria-hidden />}
              <span className="truncate" title={roomName}>
                {v.streaming ? `${t('people.streaming')} · ` : ''}
                {roomName ?? t('people.inVoice')}
              </span>
            </dd>
          </>
        ) : null}
        {m.joinedAt ? (
          <>
            <dt className="text-muted">{t('people.profile.joined')}</dt>
            <dd>{fmt.date(timestampDate(m.joinedAt))}</dd>
          </>
        ) : null}
      </dl>
      {actions?.volume ? (
        // Discord's most-used member actions: volume and «mute for me» (docs/09 #12).
        <div className="-mx-2 flex flex-col border-t border-line pt-2">
          <VolumeRow userId={userId} />
          <label className="flex h-8 items-center justify-between gap-3 px-2 text-body">
            <span>{t('people.menu.localMute')}</span>
            <Toggle checked={localMuted} onChange={(v) => voice.setUserMuted(userId, v)} label={t('people.menu.localMute')} />
          </label>
        </div>
      ) : null}
      {u.isBot && !self ? <BotActions botUserId={userId} /> : null}
      {actions?.rename ? (
        <Button variant="secondary" className="w-full" onClick={onRename}>
          <Pencil className="size-3.5" aria-hidden />
          {self ? t('people.menu.renameSelf') : t('people.menu.rename')}
        </Button>
      ) : null}
      {/* The full profile (docs/09 #20): member since, roles, the private note. */}
      <Button
        variant="ghost"
        className="w-full"
        onClick={() => {
          onClose?.();
          openProfile(workspaceId, userId);
        }}
      >
        <UserRound className="size-3.5" aria-hidden />
        {t('people.profile.full')}
      </Button>
    </div>
  );
}
