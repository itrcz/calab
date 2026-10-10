import { IdentitySettings } from '../identity/IdentitySettings';
import { OAuthClients } from '../identity/OAuth';
import { identityApi } from '../identity/api';
import { localAuthority } from '../identity/model';
import { IdentityAbout, IdentityNotConfigured } from '../identity/IdentityGate';
import { PlanLock } from '../../components/PlanLock';
import { audioTierKbps, type ConcreteScreenSharePreset, IdentityFeature, WorkspaceRole, WorkspaceVisibility, type Invite } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Ban, Bot as BotIcon, Cake, CircleDot, Copy, Gem, KeyRound, AppWindow, Library, Lock, Phone, Search, Settings2, Shield, Trash2, TriangleAlert, Upload, UserPlus, Users } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { slugError } from './slugError';
import { MediaImg } from '../../components/MediaImg';
import { SettingsWindow, type SettingsSection } from '../../components/SettingsWindow';
import { Button, Card, Empty, IconButton, Input, Row, Segmented, Select, Spinner, Toggle } from '../../components/ui';
import { getLocale, t, type MessageKey } from '../../i18n';
import { errorText, identityNotConfigured } from '../../lib/api/errors';
import { api, thumbnailPath, uploadFile, uploadPath } from '../../lib/api/endpoints';
import { fmt, type TimeFormatPref } from '../../lib/format';
import { ICON_SIDE, IMAGE_ACCEPT, avatarFile } from '../../lib/image';
import { workspaceInitials } from '../../lib/initials';
import { can, mayArrangeRooms, settingsAccess, workspacePerms } from '../../lib/permissions';
import { TempRoomsCards } from './TempRoomsCards';
import { inviteUrl } from '../../services/links';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { rolesOf, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { CommitInput } from '../settings/CommitInput';
import { MAX_USES } from '../people/RoomLinkTab';
import { ROLE_LABEL } from '../shell/MembersPanel';
import { canEditMemberBirthday, canRemoveMember, canRenameMember } from '../people/members';
import { MemberBirthdayDialog } from '../people/MemberBirthdayDialog';
import { MemberBirthdaysTable } from './MemberBirthdaysTable';
import { NickInline } from '../people/NickInline';
import { PRESETS, presetDetail, presetText } from '../voice/StreamPicker';
import { PlanFullNote, PlanTab, useMembersCap } from './PlanTab';
import { AudioTierHint, AudioTierOptions } from './AudioTierOptions';
import { GptunnelTab } from './GptunnelTab';
import { TelephonyTab } from './TelephonyTab';
import { capMax, clampToCap, planHasIdentity, workspacePlanName } from '../../lib/plan';
import { reportPlanError, workspacePlan } from '../../services/plan';
import { fromTimeFormatPref, toTimeFormatPref } from '../../services/timeFormat';
import { RoomGuestInviteCard } from '../people/RoomGuestInviteCard';
import { EmailInviteCard, EmailInvitesList } from './EmailInvite';
import { BansTab } from './BansTab';
import { RolesTab } from './RolesTab';
import { LibraryTab, SEGMENT_LABEL } from './LibraryTab';
import { LIBRARY_TAB, librarySegments, resolveSettingsTab } from './library';
import { BotsTab } from './BotsTab';
import { UpcomingBirthdays } from './UpcomingBirthdays';

const err = (e: unknown): string => errorText(e);

/** «Формат времени» (docs/09 #73): the segmented control's order. */
const TIME_FORMATS: readonly TimeFormatPref[] = ['auto', 'h24', 'h12'];

async function patchWorkspace(id: string, init: Parameters<typeof api.workspaces.update>[1]): Promise<void> {
  const r = await api.workspaces.update(id, init);
  if (r.workspace) useWorkspaces.getState().updateWorkspace(r.workspace);
}

export function WorkspaceSettingsDialog({
  workspaceId,
  tab,
  roomId,
  onClose,
}: {
  workspaceId: string;
  tab: string | undefined;
  /** Opened by «Пригласить» in a room (docs/09 #55): the invites tab starts with its guest link. */
  roomId?: string | undefined;
  onClose: () => void;
}): ReactNode {
  const local = useSession((s) => localAuthority(s.authority));
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const myRoles = useMemberRoles(workspaceId, me);
  // SSO / OAuth clients are Business only in the cloud (ADR-0054 §5). The server decides: an
  // on-prem Enterprise workspace (IDENTITY_EDITION=enterprise + allowlist) is entitled on any
  // plan, so the status is always requested and an effective grant unlocks the tab whatever the
  // plan says. Below Business without a grant the tab is PlanLock'ed; a server without identity
  // configuration answers 409 IDENTITY_NOT_CONFIGURED — «не настроено на сервере», not an error.
  const identityPlan = useWorkspaces((s) => planHasIdentity(s.byId[workspaceId]?.ws.plan));
  const identityStatus = useQuery({ queryKey: ['identity', workspaceId], queryFn: () => identityApi.status(workspaceId), enabled: !!entry, retry: false, refetchOnWindowFocus: false });
  const identityOff = identityNotConfigured(identityStatus.error);
  const grants = identityStatus.data?.access?.entitlements?.grants;
  const entitled = (feature: IdentityFeature): boolean => !!grants?.some((g) => g.feature === feature && g.enabled && (!g.validUntil || timestampDate(g.validUntil).getTime() > Date.now()));
  const featureLocked = (feature: IdentityFeature): boolean => !!grants && !entitled(feature);
  const planLocked = (feature: IdentityFeature): boolean => !identityPlan && !entitled(feature);
  if (!entry) return null;
  // Tabs by right, as the server checks (ADR-0048, lib/permissions settingsAccess): «Общие»,
  // «Звук» — MANAGE_WORKSPACE; «Роли» — MANAGE_ROLES; «Библиотека» — by segment (library.ts);
  // «Забаненные» — MANAGE_MEMBERS; «Боты» — MANAGE_BOTS; GPTunneL pairing — MANAGE_INTEGRATIONS;
  // «Приглашения» — INVITE_MEMBERS (ADR-0043). Deleting the workspace: the owner only.
  const access = settingsAccess(myRoles);
  const admin = access.workspace;
  const owner = entry.role === WorkspaceRole.OWNER;
  const manageRoles = access.roles;
  const inviter = access.invites;
  const library = librarySegments(access);
  const requested = resolveSettingsTab(tab);
  const identityPanel = (feature: IdentityFeature, about: ReactNode, content: ReactNode): ReactNode =>
    identityStatus.isPending ? (
      <div className="grid place-items-center py-6">
        <Spinner />
      </div>
    ) : planLocked(feature) ? (
      <PlanLock plan="business" testId={feature === IdentityFeature.OAUTH_PROVIDER ? 'oauth-plan-lock' : 'sso-plan-lock'}>
        {about}
      </PlanLock>
    ) : identityOff ? (
      <IdentityNotConfigured />
    ) : (
      <div className="flex flex-col gap-4">
        {featureLocked(feature) ? <p className="flex items-start gap-2 text-body text-muted"><Lock className="mt-0.5 size-4 shrink-0" aria-hidden />{t('identity.plan')}</p> : null}
        {content}
      </div>
    );
  const sections: SettingsSection[] = [
    ...(admin
      ? [
          {
            id: 'general',
            label: t('ws.tabGeneral'),
            icon: Settings2,
            content: <GeneralTab workspaceId={workspaceId} manageRoles={manageRoles} manageRooms={mayArrangeRooms(myRoles)} />,
          },
          { id: 'media', label: t('ws.tabMedia'), icon: AudioLines, content: <MediaTab workspaceId={workspaceId} /> },
        ]
      : []),
    { id: 'members', label: t('ws.members'), icon: Users, content: <MembersTab workspaceId={workspaceId} /> },
    ...(manageRoles ? [{ id: 'roles', label: t('roles.tab'), icon: Shield, content: <RolesTab workspaceId={workspaceId} /> }] : []),
    // «Библиотека» (docs/08): achievements, badges, stickers, sounds and camera backgrounds behind
    // one segmented switch, each segment by the right of its former tab (features/workspace/library).
    ...(library.length
      ? [
          {
            id: LIBRARY_TAB,
            label: t('ws.tabLibrary'),
            icon: Library,
            keywords: library.map((x) => t(SEGMENT_LABEL[x])).join(' '),
            content: <LibraryTab workspaceId={workspaceId} segments={library} requested={requested.segment} />,
          },
        ]
      : []),
    // «Боты» (ADR-0031): MANAGE_BOTS (ADR-0048), like the server's bot management.
    ...(access.bots ? [{ id: 'bots', label: t('bots.tab'), icon: BotIcon, content: <BotsTab workspaceId={workspaceId} /> }] : []),
    // «Тариф» (ADR-0024): every member sees it; an older server sends no plan — no tab.
    ...(entry.ws.plan ? [{ id: 'plan', label: t('plan.tab'), icon: Gem, content: <PlanTab workspaceId={workspaceId} /> }] : []),
    // «GPTunneL» (ADR-0025): the meeting recording connection; guests don't see it (the API is 403).
    ...(entry.role !== WorkspaceRole.GUEST
      ? [{ id: 'gptunnel', label: t('gpt.tab'), icon: CircleDot, content: <GptunnelTab workspaceId={workspaceId} canManage={access.integrations} /> }]
      : []),
    // «Телефония» (ADR-0046): the SIP account, the connection test and the call journal — MANAGE_WORKSPACE.
    ...(admin ? [{ id: 'telephony', label: t('sip.tab'), icon: Phone, content: <TelephonyTab workspaceId={workspaceId} /> }] : []),
    {
      id: 'identity',
      label: t('identity.settingsTitle'),
      icon: KeyRound,
      locked: planLocked(IdentityFeature.CORPORATE_SSO) || featureLocked(IdentityFeature.CORPORATE_SSO),
      content: identityPanel(
        IdentityFeature.CORPORATE_SSO,
        <IdentityAbout title="identity.title" text="identity.ssoAbout" />,
        <IdentitySettings workspaceId={workspaceId} owner={owner && local} />,
      ),
    },
    ...(local && (owner || entry.role === WorkspaceRole.ADMIN)
      ? [
          {
            id: 'oauth',
            label: t('identity.oauth'),
            icon: AppWindow,
            locked: planLocked(IdentityFeature.OAUTH_PROVIDER) || featureLocked(IdentityFeature.OAUTH_PROVIDER),
            content: identityPanel(
              IdentityFeature.OAUTH_PROVIDER,
              <IdentityAbout title="identity.oauth" text="identity.oauthEmptyHelp" />,
              <OAuthClients workspaceId={workspaceId} />,
            ),
          },
        ]
      : []),
    ...(inviter ? [{ id: 'invites', label: t('ws.tabInvites'), icon: UserPlus, content: <InvitesTab workspaceId={workspaceId} roomId={roomId} /> }] : []),
    // «Забаненные» (docs/09 #32): the same right as kicking (MANAGE_MEMBERS, ADR-0048).
    ...(access.members ? [{ id: 'bans', label: t('bans.tab'), icon: Ban, content: <BansTab workspaceId={workspaceId} /> }] : []),
    ...(owner
      ? [{ id: 'danger', label: t('ws.tabDanger'), icon: TriangleAlert, destructive: true, content: <DangerTab workspaceId={workspaceId} onDone={onClose} /> }]
      : []),
  ];
  return (
    <SettingsWindow
      title={entry.ws.name}
      titleIcon={<WorkspaceGlyph name={entry.ws.name} iconFileId={entry.ws.iconFileId} size={20} />}
      sections={sections}
      initial={requested.tab}
      fallback={admin ? 'general' : 'members'}
      onClose={onClose}
    />
  );
}

/** Workspace icon or its initials (lib/initials.ts — the same letters as the rail). */
function WorkspaceGlyph({ name, iconFileId, size }: { name: string; iconFileId: string; size: number }): ReactNode {
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-[30%] bg-accent-strong font-semibold text-accent-fg"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      {iconFileId ? <MediaImg path={thumbnailPath(iconFileId)} alt="" className="size-full object-cover" /> : workspaceInitials(name)}
    </span>
  );
}

function GeneralTab({
  workspaceId,
  manageRoles,
  manageRooms,
}: {
  workspaceId: string;
  manageRoles: boolean;
  manageRooms: boolean;
}): ReactNode {
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const setIcon = async (f: File): Promise<void> => {
    setUploading(true);
    try {
      // A 256×256 WebP (JPEG fallback), never the picked original (docs/02 «Изображения»).
      const icon = await avatarFile(f, ICON_SIDE);
      const meta = await uploadFile(uploadPath(workspaceId, ''), icon, icon.name, () => undefined).promise;
      await patchWorkspace(workspaceId, { iconFileId: meta.id });
    } catch (e) {
      if (!reportPlanError(e, workspaceId)) toast.error(err(e));
    } finally {
      setUploading(false);
    }
  };
  if (!ws) return null;
  return (
    <>
      <div className="flex items-center gap-4">
        <WorkspaceGlyph name={ws.name} iconFileId={ws.iconFileId} size={64} />
        <Button variant="secondary" busy={uploading} onClick={() => input.current?.click()}>
          <Upload className="size-4" aria-hidden /> {t('ws.icon')}
        </Button>
        <input
          ref={input}
          type="file"
          accept={IMAGE_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void setIcon(f);
            e.target.value = '';
          }}
        />
      </div>
      <Card title={t('card.basics')}>
        <Row label={t('ws.name')}>
          <CommitInput label={t('ws.name')} value={ws.name} maxLength={100} onCommit={(v) => (v ? patchWorkspace(workspaceId, { name: v }) : undefined)} />
        </Row>
        <Row label={t('ws.slug')} hint={t('ws.slugHint')}>
          <CommitInput label={t('ws.slug')} value={ws.slug} maxLength={32} validate={(v) => slugError(v.toLowerCase())} onCommit={(v) => patchWorkspace(workspaceId, { slug: v.toLowerCase() })} />
        </Row>
        <Row label={t('ws.visibility')} hint={ws.visibility === WorkspaceVisibility.OPEN ? t('ws.openHint') : t('ws.privateHint')}>
          <Select
            aria-label={t('ws.visibility')}
            className="w-60"
            value={ws.visibility}
            onChange={(e) =>
              void patchWorkspace(workspaceId, { visibility: Number(e.target.value) }).catch((x: unknown) => toast.error(err(x)))
            }
          >
            <option value={WorkspaceVisibility.PRIVATE}>{t('ws.private')}</option>
            <option value={WorkspaceVisibility.OPEN}>{t('ws.open')}</option>
          </Select>
        </Row>
        <Row label={t('people.nick.allowSelf')} hint={t('people.nick.allowSelfHint')}>
          <Toggle
            label={t('people.nick.allowSelf')}
            checked={ws.allowSelfNickname}
            onChange={(v) => void patchWorkspace(workspaceId, { allowSelfNickname: v }).catch((x: unknown) => toast.error(err(x)))}
          />
        </Row>
        <Row label={t('ws.timeFormat')} hint={t('ws.timeFormatHint')}>
          <Segmented<TimeFormatPref>
            label={t('ws.timeFormat')}
            value={toTimeFormatPref(ws.timeFormat)}
            onChange={(v) => void patchWorkspace(workspaceId, { timeFormat: fromTimeFormatPref(v) }).catch((x: unknown) => toast.error(err(x)))}
            options={TIME_FORMATS.map((f) => ({ value: f, label: t(`ws.timeFormat.${f}`) }))}
          />
        </Row>
      </Card>
      {/* Temporary rooms (ADR-0044): the members' right (MANAGE_ROLES) and the archive (MANAGE_ROOM). */}
      <TempRoomsCards workspaceId={workspaceId} manageRoles={manageRoles} manageRooms={manageRooms} />
    </>
  );
}

function ClampHint({ base, show, limit }: { base: string; show: boolean; limit: string }): ReactNode {
  return show ? (
    <>
      {base}
      <br />
      {t('media.planClamp', { limit })}
    </>
  ) : (
    base
  );
}

function MediaTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const md = useWorkspaces((s) => s.byId[workspaceId]?.ws.mediaDefaults);
  const audioCap = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.audioTierMaxKbps ?? 0);
  // The plan caps what the defaults can reach (#42): effective value = min(default, plan limit); 0 = no plan limit.
  const presetCap = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.streamMaxPreset ?? 0);
  const streamsCap = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.streamsPerRoom ?? 0);
  const camerasCap = useWorkspaces((s) => s.byId[workspaceId]?.ws.plan?.limits?.camerasPerRoom ?? 0);
  const presetValue = clampToCap(md?.maxStreamPreset || 3, presetCap);
  const streamsMax = capMax(10, streamsCap);
  const camerasMax = capMax(25, camerasCap);
  const apply = (init: Parameters<typeof api.workspaces.update>[1]): void =>
    void patchWorkspace(workspaceId, init).catch((e: unknown) => {
      if (!reportPlanError(e, workspaceId)) toast.error(err(e));
    });
  return (
    <Card title={t('card.defaults')} footer={t('ws.mediaText')}>
      <Row label={t('media.bitrate')} hint={<AudioTierHint cap={audioCap} />}>
        <Select aria-label={t('media.bitrate')} className="w-60" value={audioTierKbps(md?.audioBitrateKbps ?? 32)} onChange={(e) => apply({ defaultAudioBitrateKbps: Number(e.target.value) })}>
          <AudioTierOptions cap={audioCap} />
        </Select>
      </Row>
      <Row label={t('media.maxPreset')} hint={<ClampHint base={presetDetail(presetValue)} show={presetCap > 0} limit={presetCap > 0 ? presetText(presetCap as ConcreteScreenSharePreset) : ''} />}>
        <Select
          aria-label={t('media.maxPreset')}
          className="w-60"
          value={presetValue}
          onChange={(e) => apply({ defaultMaxStreamPreset: Number(e.target.value) })}
        >
          {PRESETS.map((p) => (
            <option key={p} value={p} title={presetDetail(p)} disabled={presetCap > 0 && p > presetCap}>
              {presetText(p)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.maxStreams')} hint={<ClampHint base={t('media.maxStreamsHint')} show={streamsCap > 0} limit={String(streamsCap)} />}>
        <Select aria-label={t('media.maxStreams')} className="w-20" value={clampToCap(md?.maxStreams ?? 3, streamsCap)} onChange={(e) => apply({ defaultMaxStreams: Number(e.target.value) })}>
          {Array.from({ length: streamsMax + 1 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.cameraLimit')} hint={<ClampHint base={t('media.cameraLimitHint')} show={camerasCap > 0} limit={String(camerasCap)} />}>
        <Select aria-label={t('media.cameraLimit')} className="w-20" value={clampToCap(md?.cameraLimit ?? 6, camerasCap)} onChange={(e) => apply({ defaultCameraLimit: Number(e.target.value) })}>
          {Array.from({ length: camerasMax + 1 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </Select>
      </Row>
    </Card>
  );
}

type RoleFilter = 'all' | 'owner' | 'admin' | 'member' | 'guest';

const ROLE_FILTERS: Array<{ value: RoleFilter; key: MessageKey }> = [
  { value: 'all', key: 'ws.filter.all' },
  { value: 'owner', key: 'ws.filter.owner' },
  { value: 'admin', key: 'ws.filter.admins' },
  { value: 'member', key: 'ws.filter.members' },
  { value: 'guest', key: 'ws.filter.guests' },
];

const FILTER_ROLE: Record<Exclude<RoleFilter, 'all'>, WorkspaceRole> = {
  owner: WorkspaceRole.OWNER,
  admin: WorkspaceRole.ADMIN,
  member: WorkspaceRole.MEMBER,
  guest: WorkspaceRole.GUEST,
};

/**
 * «Участники» (docs/09 #26): search (nickname or profile name) + role filter on top; each row —
 * the name in its role colour + RoleMark, editable in place for who may rename (NickInline; the
 * same right and API as «Изменить ник» in the member menu), 🎂 «Изменить день рождения»
 * (docs/09 #77), the role select and «Исключить». With MANAGE_NICKNAMES, «Дни рождения» opens
 * the table of every member's date (MemberBirthdaysTable).
 */
function MembersTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<RoleFilter>('all');
  const [view, setView] = useState<'list' | 'birthdays'>('list');
  const [birthdayOf, setBirthdayOf] = useState<string | null>(null);
  if (!entry) return null;
  const myRoles = rolesOf(entry, me);
  const manageBirthdays = can(workspacePerms(myRoles), 'MANAGE_NICKNAMES');
  if (view === 'birthdays' && manageBirthdays) return <MemberBirthdaysTable workspaceId={workspaceId} onBack={() => setView('list')} />;
  const owner = entry.role === WorkspaceRole.OWNER;
  const nameOf = (m: (typeof entry.members)[string]): string => m.nickname || m.user?.displayName || '';
  const needle = q.trim().toLowerCase();
  const members = Object.values(entry.members)
    .filter((m) => filter === 'all' || m.role === FILTER_ROLE[filter])
    .filter((m) => !needle || nameOf(m).toLowerCase().includes(needle) || (m.user?.displayName ?? '').toLowerCase().includes(needle))
    .sort((a, b) => a.role - b.role || nameOf(a).localeCompare(nameOf(b), getLocale()));

  const setRole = async (userId: string, role: WorkspaceRole): Promise<void> => {
    try {
      // Guest → member is only POST …/promote (the PATCH answers 422).
      const guest = entry.members[userId]?.role === WorkspaceRole.GUEST;
      const r = guest && role === WorkspaceRole.MEMBER ? await api.workspaces.promoteGuest(workspaceId, userId) : await api.workspaces.updateMember(workspaceId, userId, { role });
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
    } catch (e) {
      toast.error(err(e));
    }
  };
  const kick = async (userId: string, name: string): Promise<void> => {
    if (!(await confirmAction(t('ws.kick'), t('ws.kickConfirm', { name }), t('ws.kick')))) return;
    try {
      await api.workspaces.removeMember(workspaceId, userId);
      useWorkspaces.getState().removeMember(workspaceId, userId);
    } catch (e) {
      toast.error(err(e));
    }
  };

  return (
    <>
      <UpcomingBirthdays workspaceId={workspaceId} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-48 flex-1 items-center">
          <Input aria-label={t('common.search')} placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} icon={<Search className="size-3.5" />} />
        </label>
        <Segmented label={t('ws.filter.label')} value={filter} onChange={setFilter} options={ROLE_FILTERS.map((f) => ({ value: f.value, label: t(f.key) }))} />
        {manageBirthdays ? (
          <Button variant="secondary" onClick={() => setView('birthdays')} data-testid="open-birthdays-table">
            <Cake className="size-4" aria-hidden /> {t('birthday.tableTitle')}
          </Button>
        ) : null}
      </div>
      {members.length === 0 ? (
        <Empty>{t('ws.filter.none')}</Empty>
      ) : (
        <Card title={t('card.members', { n: members.length })}>
          {members.map((m) => {
            const u = m.user;
            if (!u) return null;
            const name = nameOf(m);
            // Only the owner grants/revokes ADMIN; OWNER is never granted here.
            // MANAGE_WORKSPACE, not the owner, admins only by the owner, below my top role (the server's outranks).
            const editable = canRemoveMember(myRoles, rolesOf(entry, u.id), m, u.id === me);
            const canNick = canRenameMember(rolesOf(entry, me), u.id === me, entry.ws.allowSelfNickname);
            const canBirthday = canEditMemberBirthday(myRoles, rolesOf(entry, u.id), m, u.id === me);
            return (
              <div key={u.id} className="flex min-h-12 items-center gap-3 px-3 py-2" data-testid="ws-member-row">
                <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={32} presence />
                <div className="min-w-0 flex-1">
                  <NickInline workspaceId={workspaceId} member={m} canEdit={canNick} />
                  <div className="truncate text-caption text-faint">{t('ws.joinedSince', { date: m.joinedAt ? fmt.shortDate(timestampDate(m.joinedAt)) : '—' })}</div>
                </div>
                {canBirthday ? (
                  <IconButton label={t('birthday.editFor', { name })} className="text-muted hover:text-fg" onClick={() => setBirthdayOf(u.id)}>
                    <Cake className="size-4" />
                  </IconButton>
                ) : manageBirthdays ? (
                  <span className="w-8 shrink-0" aria-hidden />
                ) : null}
                {/* Role column: a fixed 176 px, so plain labels and pop-ups share one left edge. */}
                {editable ? (
                  <Select aria-label={t('ws.role', { name })} className="w-44" value={m.role} onChange={(e) => void setRole(u.id, Number(e.target.value))}>
                    {owner ? <option value={WorkspaceRole.ADMIN}>{t('role.admin')}</option> : null}
                    <option value={WorkspaceRole.MEMBER}>{t('role.member')}</option>
                    <option value={WorkspaceRole.GUEST}>{t('role.guest')}</option>
                  </Select>
                ) : (
                  <span className="w-44 shrink-0 pl-2 text-body text-muted">{t(ROLE_LABEL[m.role])}</span>
                )}
                {editable ? (
                  <IconButton label={`${t('ws.kick')}: ${name}`} className="text-muted hover:text-danger" onClick={() => void kick(u.id, name)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                ) : (
                  <span className="w-8 shrink-0" aria-hidden />
                )}
              </div>
            );
          })}
        </Card>
      )}
      {birthdayOf ? <MemberBirthdayDialog workspaceId={workspaceId} userId={birthdayOf} onClose={() => setBirthdayOf(null)} /> : null}
    </>
  );
}

const EXPIRY = [
  { s: 0, key: 'invite.never' },
  { s: 3600, key: 'invite.hour' },
  { s: 86400, key: 'invite.day' },
  { s: 7 * 86400, key: 'invite.week' },
] as const;

/** Always https (docs/09 #53); without a known server — the bare code (the join dialog accepts it). */
function inviteLink(i: Invite): string {
  return inviteUrl(useSession.getState().serverUrl, i.code) ?? i.code;
}

function InvitesTab({ workspaceId, roomId }: { workspaceId: string; roomId: string | undefined }): ReactNode {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invites', workspaceId], queryFn: () => api.workspaces.invites(workspaceId) });
  const [maxUses, setMaxUses] = useState(0);
  const [expires, setExpires] = useState(7 * 86400);
  // The plan's members limit (owner 28.09: free = 50): no new links or invitations at the cap.
  const cap = useMembersCap(workspaceId);
  const create = useMutation({
    mutationFn: () => api.workspaces.createInvite(workspaceId, { maxUses, expiresInSeconds: expires }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['invites', workspaceId] });
      if (r.invite) void navigator.clipboard.writeText(inviteLink(r.invite)).then(() => toast.success(t('invite.copied')));
    },
    onError: (e) => {
      if (!reportPlanError(e, workspaceId)) toast.error(errorText(e));
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.workspaces.deleteInvite(workspaceId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites', workspaceId] }),
    onError: (e) => toast.fail(e),
  });
  return (
    <>
      {/* docs/09 #55: from a room, a guest without an account first (the card hides itself without MANAGE_ROOM). */}
      {roomId ? <RoomGuestInviteCard roomId={roomId} /> : null}
      {cap.full ? (
        <PlanFullNote
          text={t('plan.membersFull', { plan: workspacePlanName(workspacePlan(workspaceId)), n: cap.limit })}
          testId="invite-plan-full"
        />
      ) : null}
      {/* ADR-0023: by an exact address first; the links below stay for everyone else. */}
      <EmailInviteCard workspaceId={workspaceId} full={cap.full} />
      <EmailInvitesList workspaceId={workspaceId} />
      <Card title={t('invite.new')} footer={`${t('invite.createHint')} ${t('invite.hint')}`}>
        <Row label={t('invite.maxUses')}>
          {/* The same control as the room guest links: one concept, one control. */}
          <Select aria-label={t('invite.maxUses')} className="w-60" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            {MAX_USES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t('people.link.unlimited') : n}
              </option>
            ))}
          </Select>
        </Row>
        <Row label={t('invite.expires')}>
          <Select aria-label={t('invite.expires')} className="w-60" value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.s} value={x.s}>
                {t(x.key)}
              </option>
            ))}
          </Select>
        </Row>
      </Card>
      <div className="-mt-3 flex justify-end">
        <Button busy={create.isPending} disabled={cap.full} onClick={() => create.mutate()}>
          {t('invite.create')}
        </Button>
      </div>
      {q.isLoading ? <Spinner /> : null}
      {q.data && q.data.invites.length === 0 ? <Empty>{t('invite.none')}</Empty> : null}
      {q.data && q.data.invites.length > 0 ? (
        <Card title={t('invite.active')}>
          {q.data.invites.map((i) => (
            <div key={i.id} className="flex min-h-10 items-center gap-3 px-3 py-2">
              <code className="selectable min-w-0 flex-1 truncate font-mono text-caption" title={inviteLink(i)}>
                {inviteLink(i)}
              </code>
              <span className="shrink-0 text-caption text-faint">
                {i.uses}/{i.maxUses || '∞'} · {i.expiresAt ? fmt.stamp(timestampDate(i.expiresAt)) : t('invite.never')}
              </span>
              <IconButton label={t('invite.copy')} onClick={() => void navigator.clipboard.writeText(inviteLink(i)).then(() => toast.success(t('invite.copied')))}>
                <Copy className="size-4" />
              </IconButton>
              <IconButton label={t('invite.revoke')} className="text-muted hover:text-danger" onClick={() => void confirmAction(t('invite.revokeTitle'), t('invite.revokeText'), t('invite.revoke')).then((ok) => ok && revoke.mutate(i.id))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
        </Card>
      ) : null}
    </>
  );
}

function DangerTab({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }): ReactNode {
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const del = useMutation({
    mutationFn: () => api.workspaces.remove(workspaceId),
    onSuccess: () => {
      useWorkspaces.getState().remove(workspaceId);
      onDone();
    },
  });
  return (
    <Card title={t('card.danger')} footer={del.error ? err(del.error) : t('ws.deleteText')}>
      <Row label={t('ws.delete')}>
        <Button
          variant="destructive"
          busy={del.isPending}
          onClick={() => void confirmAction(t('ws.delete'), t('ws.deleteConfirm', { name: ws?.name ?? '' }), t('ws.delete')).then((ok) => ok && del.mutate())}
        >
          {t('ws.deleteBtn')}
        </Button>
      </Row>
    </Card>
  );
}
