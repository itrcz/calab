import * as ContextMenu from '@radix-ui/react-context-menu';
import { WorkspaceRole } from '@calaba/protocol';
import { ArrowRightLeft, AtSign, Award, Ban, MessageCircle, Phone, Check, ChevronRight, IdCard, LogOut, NotebookPen, Pencil, Shield, UserCheck, UserMinus, UserRound, UserX, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Slider, cx } from '../../components/ui';
import { t } from '../../i18n';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
import { banMember, copyUserId, disconnectFromVoice, moveMember, openProfile, promoteGuest, removeMember, serverMute, serverUnmute, stopMemberCamera, toggleMemberRole } from './actions';
import { roleColorCss } from '../../lib/roles';
import { USER_VOLUME_MAX, userVolumeCapped } from '../../lib/voiceLogic';
import { requestMention } from '../chat/mentionRequest';
import { memberActions, type MenuActions } from './members';
import { roleName } from './MemberBits';
import { NicknameDialog } from './NicknameDialog';
import { useCanCall, useCanDm } from '../dm/canDm';
import { startDm } from '../../services/dms';
import { startCall } from '../../services/call';
import { RoomSubmenuPicker } from '../workspace/RoomPicker';
import { LocalTime } from './LocalTime';
import { useAchievementUi } from '../../stores/achievementUi';

/** What I may do with a member right now (reactive; the server re-checks every action). */
export function useMemberActions(workspaceId: string, userId: string): MenuActions | null {
  const meId = useSession((s) => s.me?.user?.id ?? '');
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const roomsById = useRooms((s) => s.byId);
  const myVoiceRoomId = useVoice((s) => s.roomId);
  return useMemo(() => {
    const target = entry?.members[userId];
    if (!entry || !target?.user) return null;
    return memberActions({
      meId,
      myRole: entry.role,
      myRoleIds: entry.members[meId]?.roleIds ?? [],
      roles: entry.roles,
      target,
      targetVoice: entry.voice[userId],
      myVoiceRoomId,
      rooms: roomsOfWorkspace(roomsById, workspaceId),
      allowSelfNickname: entry.ws.allowSelfNickname,
    });
  }, [entry, userId, meId, myVoiceRoomId, roomsById, workspaceId]);
}

/**
 * The one member menu (docs/09 #12, #20, #32, #33, #35): the voice participants in the room
 * list, the members column, the author's avatar and name in the chat, «…» in the profile. Wrap
 * the element —
 *
 *   <MemberContextMenu workspaceId={ws} userId={id}><div>…row…</div></MemberContextMenu>
 *
 * The child must accept a ref and props (Radix `asChild`). Outside a workspace (DM) or for an
 * unknown member the child is rendered as is. «Профиль» opens the profile dialog; `inProfile`
 * leaves it out (the menu of the profile's own «…»).
 */
export function MemberContextMenu({
  workspaceId,
  userId,
  inProfile = false,
  children,
}: {
  workspaceId: string;
  userId: string;
  inProfile?: boolean;
  children: ReactElement;
}): ReactNode {
  // Only whether the member is known here (useMemberActions is null otherwise): the actions read
  // the whole workspace entry, which changes on every voice state — computed when the menu opens
  // (the portal mounts its content only while open), not in every wrapped row / avatar.
  const known = useWorkspaces((s) => !!s.byId[workspaceId]?.members[userId]?.user);
  const [renaming, setRenaming] = useState(false);
  const dialog = renaming ? <NicknameDialog workspaceId={workspaceId} userId={userId} onClose={() => setRenaming(false)} /> : null;
  if (!known) return children;
  return (
    <>
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <OpenMemberMenu workspaceId={workspaceId} userId={userId} onRename={() => setRenaming(true)} inProfile={inProfile} />
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {dialog}
    </>
  );
}

function OpenMemberMenu({ workspaceId, userId, onRename, inProfile }: { workspaceId: string; userId: string; onRename: () => void; inProfile: boolean }): ReactNode {
  const actions = useMemberActions(workspaceId, userId);
  const canDm = useCanDm(workspaceId, userId);
  const canCall = useCanCall(userId, workspaceId);
  if (!actions) return null;
  return <MemberMenuContent workspaceId={workspaceId} userId={userId} actions={actions} canDm={canDm} canCall={canCall} onRename={onRename} inProfile={inProfile} />;
}

/** 40 px rows (Discord member menu), 15 px text. */
const row = cx(menuItem, 'h-10 text-[15px]');
const danger = 'text-danger-text data-[highlighted]:text-accent-fg';
/**
 * «Позвонить» / «Написать» (ADR-0034, the owner's request): two equal buttons across the top of
 * the menu — icon over the label on the neutral fill, the accent when highlighted.
 */
const topAction = cx(
  'flex h-14 min-w-0 flex-1 cursor-default flex-col items-center justify-center gap-1 rounded-[var(--radius-row)] bg-[var(--color-fill)] px-2 text-body font-medium text-fg outline-none',
  'data-[highlighted]:bg-accent-strong data-[highlighted]:text-accent-fg',
);

/** Right-aligned 20 px rounded checkbox (Discord); the item's checked state fills it. */
function MenuCheck({
  label,
  checked,
  onChange,
  disabled,
  tone,
  title,
  testId,
  dot,
}: {
  label: string;
  /** A role colour dot before the label (the «Роли ›» submenu). */
  dot?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  tone?: 'danger';
  title?: string;
  testId?: string;
}): ReactNode {
  return (
    <ContextMenu.CheckboxItem
      className={cx(row, 'group/check justify-between', tone === 'danger' && danger)}
      checked={checked}
      disabled={disabled}
      title={title}
      data-testid={testId}
      onCheckedChange={onChange}
      // A checkbox toggles in place (Discord): the menu stays open.
      onSelect={(e) => e.preventDefault()}
    >
      {dot ? <span className="size-2.5 shrink-0 rounded-full" style={{ background: dot }} aria-hidden /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-[5px] border-[1.5px] border-[var(--color-label-tertiary)] group-data-[state=checked]/check:border-accent-strong group-data-[state=checked]/check:bg-accent-strong group-data-[highlighted]/check:border-current"
      >
        <ContextMenu.ItemIndicator>
          <Check className="size-3.5 text-white" strokeWidth={3} />
        </ContextMenu.ItemIndicator>
      </span>
    </ContextMenu.CheckboxItem>
  );
}

function MemberMenuContent({
  workspaceId,
  userId,
  actions: a,
  canDm,
  canCall,
  onRename,
  inProfile,
}: {
  workspaceId: string;
  userId: string;
  actions: MenuActions;
  canDm: boolean;
  canCall: boolean;
  onRename: () => void;
  inProfile: boolean;
}): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const self = useSession((s) => s.me?.user?.id) === userId;
  const roomId = useWorkspaces((s) => s.byId[workspaceId]?.voice[userId]?.roomId ?? '');
  const localMuted = usePrefs((s) => !!s.mutedUsers[userId]);
  const localDeaf = usePrefs((s) => !!s.deafUsers[userId]);
  const videoHidden = usePrefs((s) => !!s.hiddenVideo[userId]);
  const setPrefs = usePrefs((s) => s.setPrefs);
  const hiddenVideo = usePrefs((s) => s.hiddenVideo);
  const forMe = a.volume || a.localMute || a.hideVideo;
  const manageItems = a.rename || a.roles !== null || a.grantAchievement || a.moveTargets.length > 0;
  const moderation = a.serverMute || a.serverUnmute || a.stopCamera || a.disconnect;
  const admin = a.promote || a.removeGuest || a.kick || a.ban;
  const setHidden = (on: boolean): void => {
    const next = { ...hiddenVideo };
    if (on) next[userId] = true;
    else delete next[userId];
    setPrefs({ hiddenVideo: next });
  };
  return (
    // Discord layout (docs/09 #20): sections split by hairlines — profile | for me (local) |
    // manage | moderation (red) | admin | ID.
    <ContextMenu.Content className={cx(menuBox, 'w-[300px]')} collisionPadding={8}>
      <div className={cx(menuLabel, 'truncate')} title={name}>
        {name}
      </div>
      <LocalTime userId={userId} variant="menu" />
      {canDm ? (
        <div className="flex gap-1 px-1 pb-1 pt-0.5" data-testid="member-menu-top">
          {canCall ? (
            <ContextMenu.Item className={topAction} onSelect={() => void startCall(userId)}>
              <Phone className="size-[18px]" aria-hidden />
              <span className="max-w-full truncate">{t('call.call')}</span>
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Item className={topAction} onSelect={() => void startDm(userId)}>
            <MessageCircle className="size-[18px]" aria-hidden />
            <span className="max-w-full truncate">{t('dm.write')}</span>
          </ContextMenu.Item>
        </div>
      ) : null}
      {!inProfile ? (
        <ContextMenu.Item className={row} onSelect={() => openProfile(workspaceId, userId)}>
          <UserRound className="size-4" aria-hidden /> {t('people.menu.profile')}
        </ContextMenu.Item>
      ) : null}
      <ContextMenu.Item className={row} onSelect={() => requestMention(userId, name)}>
        <AtSign className="size-4" aria-hidden /> {t('people.menu.mention')}
      </ContextMenu.Item>
      <ContextMenu.Item className={row} onSelect={() => openProfile(workspaceId, userId, true)}>
        <NotebookPen className="size-4" aria-hidden />
        <span className="flex min-w-0 flex-col leading-[18px]">
          <span className="truncate">{t('people.menu.addNote')}</span>
          <span className="truncate text-micro leading-[13px] opacity-75">{t('people.menu.addNoteHint')}</span>
        </span>
      </ContextMenu.Item>

      {/* For me only (local, prefs): volume, «Заглушить», «Не слышать», «Не показывать видео». */}
      {forMe ? <ContextMenu.Separator className={menuSeparator} /> : null}
      {a.volume ? <VolumeRow userId={userId} menu /> : null}
      {a.localMute ? <MenuCheck label={t('people.menu.localMute')} checked={localMuted} onChange={(v) => voice.setUserMuted(userId, v)} testId="menu-local-mute" /> : null}
      {a.volume ? <MenuCheck label={t('people.menu.deafen')} title={t('people.menu.deafenHint')} checked={localDeaf} onChange={(v) => voice.setUserDeaf(userId, v)} /> : null}
      {/* Local: stop receiving their camera (unsubscribe), an avatar tile instead (docs/09 #42). */}
      {a.hideVideo ? <MenuCheck label={t('video.hide')} checked={videoHidden} onChange={setHidden} /> : null}

      {manageItems ? <ContextMenu.Separator className={menuSeparator} /> : null}
      {a.rename ? (
        <ContextMenu.Item className={row} onSelect={onRename}>
          <Pencil className="size-4" aria-hidden /> {self ? t('people.menu.renameSelf') : t('people.menu.rename')}
        </ContextMenu.Item>
      ) : null}
      {a.roles ? (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={cx(row, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
            <Shield className="size-4" aria-hidden />
            <span className="flex-1">{t('people.menu.roles')}</span>
            <ChevronRight className="size-4" aria-hidden />
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className={cx(menuBox, 'max-h-80 w-60 overflow-y-auto')} sideOffset={4} collisionPadding={8} data-testid="member-roles-menu">
              {a.roles.map((x) => (
                <MenuCheck
                  key={x.role.id}
                  label={roleName(x.role)}
                  dot={x.role.builtin === WorkspaceRole.ADMIN ? 'var(--color-role-admin)' : x.role.color ? roleColorCss(x.role.color) : 'var(--color-label-tertiary)'}
                  checked={x.on}
                  disabled={!x.enabled}
                  onChange={(v) => void toggleMemberRole(workspaceId, userId, x.role, v)}
                />
              ))}
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      ) : null}
      {a.grantAchievement ? (
        <ContextMenu.Item className={row} onSelect={() => useAchievementUi.getState().openGrant({ workspaceId, userId })} data-testid="member-grant-achievement">
          <Award className="size-4" aria-hidden /> {t('ach.menu')}
        </ContextMenu.Item>
      ) : null}
      {a.moveTargets.length > 0 ? (
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger className={cx(row, 'data-[state=open]:not-data-[highlighted]:bg-hover')}>
            <ArrowRightLeft className="size-4" aria-hidden />
            <span className="flex-1">{t('people.menu.move')}</span>
            <ChevronRight className="size-4" aria-hidden />
          </ContextMenu.SubTrigger>
          <ContextMenu.Portal>
            <ContextMenu.SubContent className={cx(menuBox, 'max-h-80 w-56 overflow-y-auto')} sideOffset={4} collisionPadding={8}>
              <RoomSubmenuPicker rooms={a.moveTargets} itemClass={row} onSelect={(r) => moveMember(workspaceId, roomId, userId, r.id)} />
            </ContextMenu.SubContent>
          </ContextMenu.Portal>
        </ContextMenu.Sub>
      ) : null}

      {/* Moderation (by rights, red like Discord's «Server Mute»). */}
      {moderation ? <ContextMenu.Separator className={menuSeparator} /> : null}
      {a.serverMute || a.serverUnmute ? (
        <MenuCheck
          label={t('people.menu.serverMuteToggle')}
          tone="danger"
          checked={a.alreadyMuted}
          disabled={a.alreadyMuted ? !a.serverUnmute : !a.serverMute}
          onChange={(v) => (v ? serverMute(roomId, userId) : serverUnmute(roomId, userId))}
          testId="menu-server-mute"
        />
      ) : null}
      {a.stopCamera ? (
        <ContextMenu.Item className={cx(row, danger)} onSelect={() => stopMemberCamera(workspaceId, roomId, userId)}>
          <VideoOff className="size-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('video.stopMember')}</span>
        </ContextMenu.Item>
      ) : null}
      {a.disconnect ? (
        <ContextMenu.Item className={cx(row, danger)} onSelect={() => disconnectFromVoice(roomId, userId)}>
          <LogOut className="size-4" aria-hidden /> {t('people.menu.disconnect')}
        </ContextMenu.Item>
      ) : null}

      {admin ? <ContextMenu.Separator className={menuSeparator} /> : null}
      {a.promote ? (
        <ContextMenu.Item className={row} onSelect={() => promoteGuest(workspaceId, userId)}>
          <UserCheck className="size-4" aria-hidden /> {t('people.menu.promote')}
        </ContextMenu.Item>
      ) : null}
      {a.removeGuest ? (
        <ContextMenu.Item className={cx(row, danger)} onSelect={() => void removeMember(workspaceId, userId, true)}>
          <UserMinus className="size-4" aria-hidden /> {t('people.menu.kick')}
        </ContextMenu.Item>
      ) : null}
      {a.kick ? (
        <ContextMenu.Item className={cx(row, danger)} onSelect={() => void removeMember(workspaceId, userId, false)}>
          <UserX className="size-4" aria-hidden /> {t('people.menu.kick')}
        </ContextMenu.Item>
      ) : null}
      {a.ban ? (
        <ContextMenu.Item className={cx(row, danger)} onSelect={() => void banMember(workspaceId, userId)} data-testid="member-ban">
          <Ban className="size-4" aria-hidden /> {t('ban.menu')}
        </ContextMenu.Item>
      ) : null}

      <ContextMenu.Separator className={menuSeparator} />
      <ContextMenu.Item className={row} onSelect={() => copyUserId(userId)}>
        <IdCard className="size-4" aria-hidden /> {t('people.menu.copyId')}
      </ContextMenu.Item>
    </ContextMenu.Content>
  );
}

/**
 * Per-user playback volume («Громкость», 0–200 %, docs/09 #20). element.volume caps at 1 — no
 * WebAudio boost (docs/02 echo rules): above 100 % only offsets a lower headphones ▾ volume, and
 * the row says so when it cannot. Shared by the member menu and the profile card.
 */
export function VolumeRow({ userId, className, menu = false }: { userId: string; className?: string; menu?: boolean }): ReactNode {
  const volume = usePrefs((s) => s.userVolumes[userId] ?? 1);
  const muted = usePrefs((s) => !!s.mutedUsers[userId]);
  const capped = usePrefs((s) => userVolumeCapped(s.userVolumes[userId] ?? 1, s.outputVolume));
  const value = muted ? t('people.menu.localMuted') : `${Math.round(volume * 100)}%`;
  const body = (
    <>
      <div className="mb-1 flex items-center justify-between text-caption text-muted">
        <span className="flex items-center gap-1.5">
          {muted ? <VolumeX className="size-3.5" aria-hidden /> : <Volume2 className="size-3.5" aria-hidden />} {t('people.menu.volume')}
        </span>
        <span className="tabular-nums">{value}</span>
      </div>
      <Slider label={t('people.menu.volume')} value={volume} min={0} max={USER_VOLUME_MAX} step={0.01} pointerOnly={menu} onChange={(v) => voice.setUserVolume(userId, v)} />
      {capped && !muted ? (
        <p className="mt-1 text-caption leading-4 text-muted" data-testid="volume-capped">
          {t('people.menu.volumeCapped')}
        </p>
      ) : null}
    </>
  );
  if (!menu) return <div className={cx('px-2 pb-2 pt-1', className)}>{body}</div>;
  // In a menu only menu items are allowed (axe aria-required-children), so the row is one: ↑/↓
  // reach it like any item, ←/→ change the volume by 5 %, the mouse drags the slider; selecting
  // it keeps the menu open.
  return (
    <ContextMenu.Item
      className={cx('rounded-[5px] px-2 pb-2 pt-1 outline-none data-[highlighted]:bg-hover', className)}
      aria-label={`${t('people.menu.volume')}: ${value}`}
      onSelect={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = Math.min(USER_VOLUME_MAX, Math.max(0, Math.round((volume + (e.key === 'ArrowRight' ? 0.05 : -0.05)) * 100) / 100));
        voice.setUserVolume(userId, next);
      }}
    >
      {body}
    </ContextMenu.Item>
  );
}
