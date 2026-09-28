import {
  AUDIO_BITRATE_OPTIONS_KBPS,
  WorkspaceRole,
  WorkspaceVisibility,
  type Invite,
} from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Ban, Bot as BotIcon, CircleDot, Copy, Gem, Search, Settings2, Shield, Sticker, Trash2, TriangleAlert, Upload, UserPlus, Users } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { MediaImg } from '../../components/MediaImg';
import { SettingsWindow, type SettingsSection } from '../../components/SettingsWindow';
import { Button, Card, Empty, IconButton, Input, Row, Segmented, Select, Spinner, Toggle } from '../../components/ui';
import { getLocale, t, type MessageKey } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api, thumbnailPath, uploadFile, uploadPath } from '../../lib/api/endpoints';
import { fmt, type TimeFormatPref } from '../../lib/format';
import { workspaceInitials } from '../../lib/initials';
import { can, mayManageWorkspace, workspacePerms } from '../../lib/permissions';
import { inviteUrl } from '../../services/links';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { rolesOf, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { CommitInput } from '../settings/CommitInput';
import { MAX_USES } from '../people/RoomLinkTab';
import { ROLE_LABEL } from '../shell/MembersPanel';
import { canRemoveMember, canRenameMember } from '../people/members';
import { NickInline } from '../people/NickInline';
import { PRESETS, presetDetail, presetText } from '../voice/StreamPicker';
import { PlanTab } from './PlanTab';
import { GptunnelTab } from './GptunnelTab';
import { reportPlanError } from '../../services/plan';
import { fromTimeFormatPref, toTimeFormatPref } from '../../services/timeFormat';
import { RoomGuestInviteCard } from '../people/RoomGuestInviteCard';
import { EmailInviteCard, EmailInvitesList } from './EmailInvite';
import { BansTab } from './BansTab';
import { RolesTab } from './RolesTab';
import { StickersTab } from './StickersTab';
import { BotsTab } from './BotsTab';

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
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const myRoles = useMemberRoles(workspaceId, me);
  if (!entry) return null;
  // Settings, media defaults, invites, bans, GPTunneL: MANAGE_WORKSPACE (the server's check) —
  // admins, or a custom role with it. Deleting the workspace: the owner only.
  const admin = mayManageWorkspace(myRoles);
  const owner = entry.role === WorkspaceRole.OWNER;
  // «Роли» (ADR-0026): whoever may manage roles — admins, or a custom role with MANAGE_ROLES.
  const manageRoles = can(workspacePerms(myRoles), 'MANAGE_ROLES');
  // «Стикеры» (ADR-0030): MANAGE_STICKERS — admins, or a custom role with it.
  const manageStickers = can(workspacePerms(myRoles), 'MANAGE_STICKERS');
  const sections: SettingsSection[] = [
    ...(admin
      ? [
          { id: 'general', label: t('ws.tabGeneral'), icon: Settings2, content: <GeneralTab workspaceId={workspaceId} /> },
          { id: 'media', label: t('ws.tabMedia'), icon: AudioLines, content: <MediaTab workspaceId={workspaceId} /> },
        ]
      : []),
    { id: 'members', label: t('ws.members'), icon: Users, content: <MembersTab workspaceId={workspaceId} /> },
    ...(manageRoles ? [{ id: 'roles', label: t('roles.tab'), icon: Shield, content: <RolesTab workspaceId={workspaceId} /> }] : []),
    ...(manageStickers ? [{ id: 'stickers', label: t('stk.tab'), icon: Sticker, content: <StickersTab workspaceId={workspaceId} /> }] : []),
    // «Боты» (ADR-0031): MANAGE_WORKSPACE, like the server's bot management.
    ...(admin ? [{ id: 'bots', label: t('bots.tab'), icon: BotIcon, content: <BotsTab workspaceId={workspaceId} /> }] : []),
    // «Тариф» (ADR-0024): every member sees it; an older server sends no plan — no tab.
    ...(entry.ws.plan ? [{ id: 'plan', label: t('plan.tab'), icon: Gem, content: <PlanTab workspaceId={workspaceId} /> }] : []),
    // «GPTunneL» (ADR-0025): the meeting recording connection; guests don't see it (the API is 403).
    ...(entry.role !== WorkspaceRole.GUEST
      ? [{ id: 'gptunnel', label: t('gpt.tab'), icon: CircleDot, content: <GptunnelTab workspaceId={workspaceId} canManage={admin} /> }]
      : []),
    ...(admin ? [{ id: 'invites', label: t('ws.tabInvites'), icon: UserPlus, content: <InvitesTab workspaceId={workspaceId} roomId={roomId} /> }] : []),
    // «Забаненные» (docs/09 #32): the same right as kicking (MANAGE_WORKSPACE).
    ...(admin ? [{ id: 'bans', label: t('bans.tab'), icon: Ban, content: <BansTab workspaceId={workspaceId} /> }] : []),
    ...(owner
      ? [{ id: 'danger', label: t('ws.tabDanger'), icon: TriangleAlert, destructive: true, content: <DangerTab workspaceId={workspaceId} onDone={onClose} /> }]
      : []),
  ];
  return (
    <SettingsWindow
      title={entry.ws.name}
      titleIcon={<WorkspaceGlyph name={entry.ws.name} iconFileId={entry.ws.iconFileId} size={20} />}
      sections={sections}
      initial={tab ?? (admin ? 'general' : 'members')}
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

function GeneralTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const ws = useWorkspaces((s) => s.byId[workspaceId]?.ws);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const setIcon = async (f: File): Promise<void> => {
    setUploading(true);
    try {
      const meta = await uploadFile(uploadPath(workspaceId, ''), f, f.name, () => undefined).promise;
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
          accept="image/*"
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
          <CommitInput label={t('ws.slug')} value={ws.slug} maxLength={32} onCommit={(v) => patchWorkspace(workspaceId, { slug: v.toLowerCase() })} />
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
    </>
  );
}

function MediaTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const md = useWorkspaces((s) => s.byId[workspaceId]?.ws.mediaDefaults);
  const apply = (init: Parameters<typeof api.workspaces.update>[1]): void =>
    void patchWorkspace(workspaceId, init).catch((e: unknown) => toast.error(err(e)));
  return (
    <Card title={t('card.defaults')} footer={t('ws.mediaText')}>
      <Row label={t('media.bitrate')} hint={t('media.bitrateHint')}>
        <Select aria-label={t('media.bitrate')} className="w-60" value={md?.audioBitrateKbps ?? 32} onChange={(e) => apply({ defaultAudioBitrateKbps: Number(e.target.value) })}>
          {AUDIO_BITRATE_OPTIONS_KBPS.map((b) => (
            <option key={b} value={b}>
              {t('unit.kbps', { n: b })}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.maxPreset')} hint={presetDetail(md?.maxStreamPreset || 3)}>
        <Select
          aria-label={t('media.maxPreset')}
          className="w-60"
          value={md?.maxStreamPreset || 3}
          onChange={(e) => apply({ defaultMaxStreamPreset: Number(e.target.value) })}
        >
          {PRESETS.map((p) => (
            <option key={p} value={p} title={presetDetail(p)}>
              {presetText(p)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.maxStreams')} hint={t('media.maxStreamsHint')}>
        <Select aria-label={t('media.maxStreams')} className="w-20" value={md?.maxStreams ?? 3} onChange={(e) => apply({ defaultMaxStreams: Number(e.target.value) })}>
          {Array.from({ length: 11 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.cameraLimit')} hint={t('media.cameraLimitHint')}>
        <Select aria-label={t('media.cameraLimit')} className="w-20" value={md?.cameraLimit ?? 6} onChange={(e) => apply({ defaultCameraLimit: Number(e.target.value) })}>
          {Array.from({ length: 26 }, (_, i) => (
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
 * same right and API as «Изменить ник» in the member menu), the role select and «Исключить».
 */
function MembersTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<RoleFilter>('all');
  if (!entry) return null;
  const myRoles = rolesOf(entry, me);
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
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-48 flex-1 items-center">
          <Input aria-label={t('common.search')} placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} icon={<Search className="size-3.5" />} />
        </label>
        <Segmented label={t('ws.filter.label')} value={filter} onChange={setFilter} options={ROLE_FILTERS.map((f) => ({ value: f.value, label: t(f.key) }))} />
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
            return (
              <div key={u.id} className="flex min-h-12 items-center gap-3 px-3 py-2" data-testid="ws-member-row">
                <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={32} presence />
                <div className="min-w-0 flex-1">
                  <NickInline workspaceId={workspaceId} member={m} canEdit={canNick} />
                  <div className="truncate text-caption text-faint">{t('ws.joinedSince', { date: m.joinedAt ? fmt.shortDate(timestampDate(m.joinedAt)) : '—' })}</div>
                </div>
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
  const create = useMutation({
    mutationFn: () => api.workspaces.createInvite(workspaceId, { maxUses, expiresInSeconds: expires }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['invites', workspaceId] });
      if (r.invite) void navigator.clipboard.writeText(inviteLink(r.invite)).then(() => toast.success(t('invite.copied')));
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.workspaces.deleteInvite(workspaceId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites', workspaceId] }),
  });
  return (
    <>
      {/* docs/09 #55: from a room, a guest without an account first (the card hides itself without MANAGE_ROOM). */}
      {roomId ? <RoomGuestInviteCard roomId={roomId} /> : null}
      {/* ADR-0023: by an exact address first; the links below stay for everyone else. */}
      <EmailInviteCard workspaceId={workspaceId} />
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
        <Button busy={create.isPending} onClick={() => create.mutate()}>
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
              <IconButton label={t('invite.revoke')} className="text-muted hover:text-danger" onClick={() => revoke.mutate(i.id)}>
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
