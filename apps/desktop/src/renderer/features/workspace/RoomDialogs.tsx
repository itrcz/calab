import { create } from '@bufbuild/protobuf';
import {
  audioTierKbps,
  PERMISSION_BITS,
  PermissionTargetType,
  RoomMediaOverrideSchema,
  RoomPermissionOverrideSchema,
  RoomType,
  WorkspaceRole,
  type PermissionName,
  type Role,
} from '@calaba/protocol';
import { useMutation } from '@tanstack/react-query';
import { AudioLines, Check, ChevronRight, Hash, Link2, Minus, Plus, Settings2, ShieldCheck, Timer, Volume2, X } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { confirmAction } from '../../components/Confirm';
import { Button, Card, Field, IconButton, Input, Modal, Row, Select, Switch, Tip, Toggle, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { audioTierLabel } from '../../lib/audioTierLabel';
import { api } from '../../lib/api/endpoints';
import { isAdminRole, mayAllowRecording, mayInviteGuestsIn, mayManageRoom, ROOM_EDITABLE, compactDrafts, toDrafts, triOf, withTri, type OverrideDraft, type Tri } from '../../lib/permissions';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { isGuest, memberName, rolesOf, useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { useSession } from '../../stores/session';
import { customLook, isCustomRole, isFullRole, roleColorCss } from '../../lib/roles';
import { Avatar } from '../../components/Avatar';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { GuestBadge, RoleMark, roleName, roleTextClass, roleTextStyle } from '../people/MemberBits';
import { MemberPicker } from '../people/MemberPicker';
import { memberItems, splitGuests, type PeoplePickItem, type RolePickItem } from '../people/memberPickItems';
import { PRESETS, presetDetail, presetText } from '../voice/StreamPicker';
import { CommitInput } from '../settings/CommitInput';
import { SettingsWindow, type SettingsSection } from '../../components/SettingsWindow';
import { UserLimitCard } from '../shell/UserLimitCard';
import { RoomLinkTab } from '../people/RoomLinkTab';
import { RoomAccessCard } from './RoomAccessCard';
import { AudioTierHint, AudioTierOptions } from './AudioTierOptions';
import { capAudioKbps } from '../../lib/plan';
import { reportPlanError } from '../../services/plan';

const err = (e: unknown): string => errorText(e);

export function RoomCreateDialog({
  workspaceId,
  voice,
  categoryId = '',
  onClose,
}: {
  workspaceId: string;
  voice: boolean;
  /** Category «+» in the room list (docs/09 #4): create the room inside it. */
  categoryId?: string;
  onClose: () => void;
}): ReactNode {
  const [type, setType] = useState(voice ? RoomType.VOICE : RoomType.TEXT);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const openRoom = useUi((s) => s.openRoom);
  const m = useMutation({
    mutationFn: () => api.rooms.create(workspaceId, { type, name: name.trim(), topic: topic.trim(), isPrivate, categoryId }),
    onSuccess: (r) => {
      if (r.room) {
        useRooms.getState().upsert(r.room);
        openRoom(workspaceId, r.room.id);
      }
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={t('room.createTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button busy={m.isPending} disabled={!name.trim()} onClick={() => m.mutate()}>{t('common.create')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RoomTypePicker value={type} onChange={setType} />
        <Field label={t('room.name')} error={m.error ? err(m.error) : null}>
          <Input
            autoFocus
            value={name}
            maxLength={100}
            icon={type === RoomType.VOICE ? <Volume2 className="size-4" /> : <Hash className="size-4" />}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && !m.isPending) m.mutate();
            }}
          />
        </Field>
        <Field label={t('room.topic')}>
          <Input value={topic} maxLength={1024} onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <Switch checked={isPrivate} onChange={setPrivate} label={t('room.private')} hint={t('room.privateHint')} />
      </div>
    </Modal>
  );
}

/** Room type as two radio cards (Discord «Create channel»): icon, name, one line of what it is. */
function RoomTypePicker({ value, onChange }: { value: RoomType; onChange: (v: RoomType) => void }): ReactNode {
  const opts = [
    { v: RoomType.TEXT, icon: Hash, label: t('room.typeText'), hint: t('room.typeTextHint') },
    { v: RoomType.VOICE, icon: Volume2, label: t('room.typeVoice'), hint: t('room.typeVoiceHint') },
  ];
  return (
    <div role="radiogroup" aria-label={t('room.type')} className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-muted" aria-hidden>
        {t('room.type')}
      </span>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={cx(
            'flex items-center gap-3 rounded-[var(--radius-card)] border px-3 py-2 text-left hover:bg-hover',
            value === o.v ? 'border-accent bg-[var(--color-bubble-highlight)]' : 'border-line bg-[var(--color-card)]',
          )}
        >
          <o.icon className="size-5 shrink-0 text-muted" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-medium">{o.label}</span>
            <span className="text-caption text-muted">{o.hint}</span>
          </span>
          <span
            className={cx('grid size-4 shrink-0 place-items-center rounded-full border', value === o.v ? 'border-accent bg-accent' : 'border-[var(--color-fill-hover)]')}
            aria-hidden
          >
            {value === o.v ? <span className="size-1.5 rounded-full bg-white" /> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

export function RoomSettingsDialog({ roomId, tab, onClose }: { roomId: string; tab: string | undefined; onClose: () => void }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const roles = useMemberRoles(room?.workspaceId, me);
  if (!room) return null;
  const voice = room.type === RoomType.VOICE;
  // By right, as the server checks (ADR-0043): the room's settings — MANAGE_ROOM; its guest
  // links — INVITE_GUESTS (a room's inviter may hold only that).
  // A temporary room's creator manages it too (ADR-0044, the server's rooms.MayManage).
  const manage = mayManageRoom(roles, me, room);
  const guests = mayInviteGuestsIn(roles, me, room);
  const sections: SettingsSection[] = [
    ...(manage
      ? [
          { id: 'general', label: t('ws.tabGeneral'), icon: Settings2, content: <GeneralTab roomId={roomId} onDeleted={onClose} /> },
          ...(voice ? [{ id: 'media', label: t('ws.tabMedia'), icon: AudioLines, content: <MediaTab roomId={roomId} /> }] : []),
          { id: 'perms', label: t('room.tabPerms'), icon: ShieldCheck, content: <PermissionsTab roomId={roomId} /> },
        ]
      : []),
    ...(guests ? [{ id: 'guests', label: t('people.link.tab'), icon: Link2, content: <RoomLinkTab roomId={roomId} manage={manage} /> }] : []),
  ];
  if (sections.length === 0) return null;
  const Glyph = room.expiresAt ? Timer : voice ? Volume2 : Hash;
  return (
    <SettingsWindow
      title={room.name}
      titleIcon={<Glyph className="size-4 shrink-0 text-muted" aria-hidden />}
      sections={sections}
      initial={tab ?? sections[0]?.id ?? 'general'}
      onClose={onClose}
    />
  );
}

async function patchRoom(roomId: string, init: Parameters<typeof api.rooms.update>[1]): Promise<void> {
  const r = await api.rooms.update(roomId, init);
  if (r.room) useRooms.getState().upsert(r.room);
}

function GeneralTab({ roomId, onDeleted }: { roomId: string; onDeleted: () => void }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const del = useMutation({
    mutationFn: () => api.rooms.remove(roomId),
    onSuccess: () => {
      useRooms.getState().remove(roomId);
      onDeleted();
    },
  });
  if (!room) return null;
  return (
    <>
      <Card title={t('card.basics')}>
        <Row label={t('room.name')}>
          <CommitInput label={t('room.name')} value={room.name} maxLength={100} onCommit={(v) => (v ? patchRoom(roomId, { name: v }) : undefined)} />
        </Row>
        <Row label={t('room.topic')}>
          <CommitInput label={t('room.topic')} value={room.topic} maxLength={1024} onCommit={(v) => patchRoom(roomId, { topic: v })} />
        </Row>
      </Card>
      {/* ADR-0048: the access level — a private room, or a temporary one (its privacy can change);
          this tab is only for whoever manages the room. */}
      {room.isPrivate || room.expiresAt ? <RoomAccessCard room={room} manage /> : null}
      <Card title={t('card.danger')} footer={del.error ? err(del.error) : undefined}>
        <Row label={t('room.delete')}>
          <Button
            variant="destructive"
            busy={del.isPending}
            onClick={() => void confirmAction(t('room.delete'), t('room.deleteConfirm', { name: room.name }), t('room.delete')).then((ok) => ok && del.mutate())}
          >
            {t('room.deleteBtn')}
          </Button>
        </Row>
      </Card>
    </>
  );
}

function MediaTab({ roomId }: { roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const ov = room?.mediaOverride;
  const wsDefaults = useWorkspaces((s) => (room ? s.byId[room.workspaceId]?.ws.mediaDefaults : undefined));
  const audioCap = useWorkspaces((s) => (room ? (s.byId[room.workspaceId]?.ws.plan?.limits?.audioTierMaxKbps ?? 0) : 0));
  // media_override replaces the whole override: always send every field.
  const apply = (patch: { bitrate?: number | ''; preset?: number | ''; streams?: number | ''; cameras?: number | '' }): void => {
    const bitrate = patch.bitrate !== undefined ? patch.bitrate : (ov?.audioBitrateKbps ?? '');
    const preset = patch.preset !== undefined ? patch.preset : (ov?.maxStreamPreset ?? '');
    const streams = patch.streams !== undefined ? patch.streams : (ov?.maxStreams ?? '');
    const cameras = patch.cameras !== undefined ? patch.cameras : (ov?.cameraLimit ?? '');
    void patchRoom(roomId, {
      mediaOverride: create(RoomMediaOverrideSchema, {
        ...(bitrate !== '' ? { audioBitrateKbps: bitrate } : {}),
        ...(preset !== '' ? { maxStreamPreset: preset } : {}),
        ...(streams !== '' ? { maxStreams: streams } : {}),
        ...(cameras !== '' ? { cameraLimit: cameras } : {}),
      }),
    }).catch((e: unknown) => {
      if (!reportPlanError(e, room?.workspaceId)) toast.error(err(e));
    });
  };
  const num = (v: string): number | '' => (v === '' ? '' : Number(v));
  // «Как в пространстве (32 кбит/с)»: the inherited value right in the option.
  const def = (v: string): string => t('media.default', { v });
  return (
    <>
    <UserLimitCard roomId={roomId} />
    <Card title={t('card.voiceStream')} footer={t('room.mediaText')}>
      <Row label={t('media.bitrate')} hint={<AudioTierHint cap={audioCap} />}>
        <Select aria-label={t('media.bitrate')} className="w-60" value={ov?.audioBitrateKbps ? audioTierKbps(ov.audioBitrateKbps) : ''} onChange={(e) => apply({ bitrate: num(e.target.value) })}>
          <option value="">{def(audioTierLabel(capAudioKbps(wsDefaults?.audioBitrateKbps ?? 32, audioCap)))}</option>
          <AudioTierOptions cap={audioCap} />
        </Select>
      </Row>
      {/* Short options (240 px); the parameters and the inherited value go to the hint and titles. */}
      <Row
        label={t('media.maxPreset')}
        hint={
          ov?.maxStreamPreset
            ? presetDetail(ov.maxStreamPreset)
            : t('media.inheritHint', { v: presetDetail(wsDefaults?.maxStreamPreset || 3) })
        }
      >
        <Select aria-label={t('media.maxPreset')} className="w-60" value={ov?.maxStreamPreset ?? ''} onChange={(e) => apply({ preset: num(e.target.value) })}>
          <option value="" title={presetDetail(wsDefaults?.maxStreamPreset || 3)}>
            {t('media.inherit')}
          </option>
          {PRESETS.map((p) => (
            <option key={p} value={p} title={presetDetail(p)}>
              {presetText(p)}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.maxStreams')} hint={t('media.maxStreamsHint')}>
        <Select aria-label={t('media.maxStreams')} className="w-60" value={ov?.maxStreams ?? ''} onChange={(e) => apply({ streams: num(e.target.value) })}>
          <option value="">{def(String(wsDefaults?.maxStreams ?? 3))}</option>
          {Array.from({ length: 11 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t('media.cameraLimit')} hint={t('media.cameraLimitHint')}>
        <Select aria-label={t('media.cameraLimit')} className="w-60" value={ov?.cameraLimit ?? ''} onChange={(e) => apply({ cameras: num(e.target.value) })}>
          <option value="">{def(String(wsDefaults?.cameraLimit ?? 6))}</option>
          {Array.from({ length: 26 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </Select>
      </Row>
    </Card>
    <RecordingCard roomId={roomId} />
    </>
  );
}

/**
 * «Запись встреч» (ADR-0025): whether members may record meetings in this voice room. The server
 * wants MANAGE_RECORDINGS of the workspace besides MANAGE_ROOM (ADR-0048): a room manager without
 * it sees the switch disabled.
 */
function RecordingCard({ roomId }: { roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const admin = mayAllowRecording(useMemberRoles(room?.workspaceId, me), me, room);
  const [busy, setBusy] = useState(false);
  if (!room) return null;
  const set = (v: boolean): void => {
    setBusy(true);
    void patchRoom(roomId, { allowRecording: v })
      .catch((e: unknown) => toast.error(err(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Card title={t('room.recCard')}>
      <Row label={t('room.allowRec')} hint={admin ? t('room.allowRecHint') : t('room.allowRecAdmin')}>
        <Toggle label={t('room.allowRec')} checked={room.allowRecording} disabled={!admin || busy} onChange={set} />
      </Row>
    </Card>
  );
}

export const PERM_LABEL: Record<PermissionName, MessageKey> = {
  VIEW_ROOM: 'perm.VIEW_ROOM',
  SEND_MESSAGES: 'perm.SEND_MESSAGES',
  ATTACH_FILES: 'perm.ATTACH_FILES',
  MANAGE_MESSAGES: 'perm.MANAGE_MESSAGES',
  CONNECT: 'perm.CONNECT',
  SPEAK: 'perm.SPEAK',
  STREAM: 'perm.STREAM',
  MUTE_MEMBERS: 'perm.MUTE_MEMBERS',
  MANAGE_ROOM: 'perm.MANAGE_ROOM',
  MANAGE_WORKSPACE: 'perm.MANAGE_WORKSPACE',
  ADMINISTRATOR: 'perm.ADMINISTRATOR',
  MOVE_MEMBERS: 'perm.MOVE_MEMBERS',
  MANAGE_NICKNAMES: 'perm.MANAGE_NICKNAMES',
  MENTION_EVERYONE: 'perm.MENTION_EVERYONE',
  VIDEO: 'perm.VIDEO',
  MANAGE_ROLES: 'perm.MANAGE_ROLES',
  MANAGE_STICKERS: 'perm.MANAGE_STICKERS',
  VIEW_BOARD: 'perm.VIEW_BOARD',
  CREATE_TASKS: 'perm.CREATE_TASKS',
  EDIT_TASKS: 'perm.EDIT_TASKS',
  MANAGE_BOARD: 'perm.MANAGE_BOARD',
  INVITE_MEMBERS: 'perm.INVITE_MEMBERS',
  INVITE_GUESTS: 'perm.INVITE_GUESTS',
  CREATE_TEMP_ROOMS: 'perm.CREATE_TEMP_ROOMS',
  PLACE_CALLS: 'perm.PLACE_CALLS',
  CREATE_BOARDS: 'perm.CREATE_BOARDS',
  MANAGE_MEMBERS: 'perm.MANAGE_MEMBERS',
  MANAGE_BOTS: 'perm.MANAGE_BOTS',
  MANAGE_INTEGRATIONS: 'perm.MANAGE_INTEGRATIONS',
  VIEW_JOURNALS: 'perm.VIEW_JOURNALS',
  MANAGE_EVENTS: 'perm.MANAGE_EVENTS',
  MANAGE_RECORDINGS: 'perm.MANAGE_RECORDINGS',
};

/**
 * What a permission gives, one line (ADR-0043, ADR-0048 §3: the role editor adds «кому по
 * умолчанию» from lib/roles permDefault). ADMINISTRATOR is never listed.
 */
export const PERM_HINT: Partial<Record<PermissionName, MessageKey>> = {
  VIEW_ROOM: 'perm.hint.VIEW_ROOM',
  SEND_MESSAGES: 'perm.hint.SEND_MESSAGES',
  ATTACH_FILES: 'perm.hint.ATTACH_FILES',
  MANAGE_MESSAGES: 'perm.hint.MANAGE_MESSAGES',
  CONNECT: 'perm.hint.CONNECT',
  SPEAK: 'perm.hint.SPEAK',
  STREAM: 'perm.hint.STREAM',
  VIDEO: 'perm.hint.VIDEO',
  MUTE_MEMBERS: 'perm.hint.MUTE_MEMBERS',
  MOVE_MEMBERS: 'perm.hint.MOVE_MEMBERS',
  MANAGE_NICKNAMES: 'perm.hint.MANAGE_NICKNAMES',
  MENTION_EVERYONE: 'perm.hint.MENTION_EVERYONE',
  MANAGE_ROOM: 'perm.hint.MANAGE_ROOM',
  MANAGE_WORKSPACE: 'perm.hint.MANAGE_WORKSPACE',
  MANAGE_ROLES: 'perm.hint.MANAGE_ROLES',
  MANAGE_STICKERS: 'perm.hint.MANAGE_STICKERS',
  VIEW_BOARD: 'perm.hint.VIEW_BOARD',
  CREATE_TASKS: 'perm.hint.CREATE_TASKS',
  EDIT_TASKS: 'perm.hint.EDIT_TASKS',
  MANAGE_BOARD: 'perm.hint.MANAGE_BOARD',
  INVITE_MEMBERS: 'perm.hint.INVITE_MEMBERS',
  INVITE_GUESTS: 'perm.hint.INVITE_GUESTS',
  CREATE_TEMP_ROOMS: 'perm.hint.CREATE_TEMP_ROOMS',
  PLACE_CALLS: 'perm.hint.PLACE_CALLS',
  CREATE_BOARDS: 'perm.hint.CREATE_BOARDS',
  MANAGE_MEMBERS: 'perm.hint.MANAGE_MEMBERS',
  MANAGE_BOTS: 'perm.hint.MANAGE_BOTS',
  MANAGE_INTEGRATIONS: 'perm.hint.MANAGE_INTEGRATIONS',
  VIEW_JOURNALS: 'perm.hint.VIEW_JOURNALS',
  MANAGE_EVENTS: 'perm.hint.MANAGE_EVENTS',
  MANAGE_RECORDINGS: 'perm.hint.MANAGE_RECORDINGS',
};

function targetKey(o: Pick<OverrideDraft, 'targetType' | 'targetId'>): string {
  return `${o.targetType}:${o.targetId}`;
}

/**
 * Deny / inherit / allow as a segmented control (UX review #2): the selected segment is
 * filled — deny red 18 % + red glyph, inherit neutral raised, allow green 18 % + green glyph;
 * unselected segments show the glyph only.
 */
export function TriToggle({ value, onChange, label }: { value: Tri; onChange: (v: Tri) => void; label: string }): ReactNode {
  const SEL: Record<Tri, string> = {
    deny: 'bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)] text-danger-text',
    inherit: 'bg-[var(--color-segment-on)] text-fg shadow-[var(--shadow-segment)]',
    allow: 'bg-[color-mix(in_srgb,var(--color-green)_18%,transparent)] text-ok',
  };
  const btn = (v: Tri, Icon: typeof X, name: string): ReactNode => (
    <Tip label={name}>
      <button
        type="button"
        role="radio"
        aria-label={`${label}: ${name}`}
        aria-checked={value === v}
        onClick={() => onChange(v)}
        className={cx('grid h-6 w-8 place-items-center rounded-full', value === v ? SEL[v] : 'text-muted hover:bg-[var(--color-fill)] hover:text-fg')}
      >
        <Icon className="size-4" strokeWidth={value === v ? 2.25 : 1.75} aria-hidden />
      </button>
    </Tip>
  );
  return (
    <div className="inline-flex rounded-[var(--radius-control)] bg-hover p-0.5" role="radiogroup" aria-label={label}>
      {btn('deny', X, t('perm.deny'))}
      {btn('inherit', Minus, t('perm.inherit'))}
      {btn('allow', Check, t('perm.allow'))}
    </div>
  );
}

/** Voice-only permissions: a text room doesn't list them (UX review). */
const VOICE_ONLY: ReadonlySet<PermissionName> = new Set(['CONNECT', 'SPEAK', 'STREAM', 'VIDEO', 'MUTE_MEMBERS', 'MOVE_MEMBERS', 'PLACE_CALLS']);

function PermissionsTab({ roomId }: { roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const entry = useWorkspaces((s) => (room ? s.byId[room.workspaceId] : undefined));
  const members = entry?.members;
  // Targets are the workspace roles by id (ADR-0026); owner / admin are fixed rows (full access).
  const wsRoles = useMemo(() => entry?.roles ?? [], [entry?.roles]);
  // A restricted room (ADR-0029): admins count as members here — only the owner stays fixed.
  const restricted = room?.restricted ?? false;
  const isFixed = useCallback((r: Pick<Role, 'builtin'>): boolean => (restricted ? r.builtin === WorkspaceRole.OWNER : isFullRole(r)), [restricted]);
  const fixedRoles = wsRoles.filter(isFixed);
  const memberRoleId = wsRoles.find((r) => r.builtin === WorkspaceRole.MEMBER)?.id ?? 'member';
  const [drafts, setDrafts] = useState<OverrideDraft[]>(() => toDrafts(room?.permissionOverrides ?? []));
  const [selected, setSelected] = useState(`${PermissionTargetType.ROLE}:${memberRoleId}`);
  const [adding, setAdding] = useState(false);

  const targets = useMemo(() => {
    const roles = wsRoles
      .filter((r) => !isFixed(r))
      .map((r) => ({ key: `${PermissionTargetType.ROLE}:${r.id}`, type: PermissionTargetType.ROLE, id: r.id, label: roleName(r), role: r }));
    const users = drafts
      .filter((d) => d.targetType === PermissionTargetType.USER)
      .map((d) => ({ key: targetKey(d), type: d.targetType, id: d.targetId, label: memberName(room?.workspaceId ?? null, d.targetId), role: undefined }));
    return [...roles, ...users];
  }, [drafts, isFixed, room?.workspaceId, wsRoles]);

  const current = targets.find((x) => x.key === selected) ?? targets[0];
  // Guests with a personal override are listed apart, folded (ADR-0040); opens for a selected guest.
  const isGuestTarget = useCallback((x: { type: PermissionTargetType; id: string }): boolean => x.type === PermissionTargetType.USER && isGuest(members?.[x.id]), [members]);
  const mainTargets = targets.filter((x) => !isGuestTarget(x));
  const guestTargets = targets.filter(isGuestTarget);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const showGuests = guestsOpen || (!!current && isGuestTarget(current));
  const draft = drafts.find((d) => current && targetKey(d) === current.key);

  const save = useMutation({
    mutationFn: (next: OverrideDraft[]) =>
      api.rooms.setPermissions(roomId, {
        overrides: compactDrafts(next).map((d) => create(RoomPermissionOverrideSchema, d)),
      }),
    onSuccess: (r) => {
      if (r.room) useRooms.getState().upsert(r.room);
    },
    onError: (e) => {
      toast.error(err(e));
      setDrafts(toDrafts(useRooms.getState().byId[roomId]?.permissionOverrides ?? []));
    },
  });

  // Applied immediately (System Settings style): each change PUTs the full override set.
  const setTri = (bit: bigint, v: Tri): void => {
    if (!current) return;
    const exists = drafts.some((d) => targetKey(d) === current.key);
    const base = exists ? drafts : [...drafts, { targetType: current.type, targetId: current.id, allow: 0n, deny: 0n }];
    const next = base.map((d) => (targetKey(d) === current.key ? withTri(d, bit, v) : d));
    setDrafts(next);
    save.mutate(next);
  };

  // «×» of a person's row: their whole override goes (the same as every right back to neutral, but
  // at once, and the row leaves the list). Roles are always listed (they are the workspace's), never removed.
  const removeUser = (k: string): void => {
    const d = drafts.find((x) => targetKey(x) === k);
    const next = drafts.filter((x) => targetKey(x) !== k);
    setDrafts(next);
    if (current?.key === k) setSelected(`${PermissionTargetType.ROLE}:${memberRoleId}`);
    if (d && (d.allow !== 0n || d.deny !== 0n)) save.mutate(next); // a row only added here was never saved
  };

  const addUser = (userId: string): void => {
    const d: OverrideDraft = { targetType: PermissionTargetType.USER, targetId: userId, allow: 0n, deny: 0n };
    if (!drafts.some((x) => targetKey(x) === targetKey(d))) setDrafts([...drafts, d]);
    setSelected(targetKey(d));
  };
  const editable = ROOM_EDITABLE.filter((name) => room?.type === RoomType.VOICE || !VOICE_ONLY.has(name));

  // docs/09 #33: every member of the workspace is in the picker (it used to drop the owner, the
  // admins and anyone already listed — «не все видны»). Owner and admins always have every right
  // (ADMINISTRATOR ignores room overrides, docs/04): shown, marked, not choosable.
  const pickGroups = useMemo((): Array<PickerGroup<PeoplePickItem>> => {
    const listed = new Set(drafts.filter((d) => d.targetType === PermissionTargetType.USER).map((d) => d.targetId));
    const full = t('picker.fullAccess');
    const roles: RolePickItem[] = wsRoles.map((r) => ({
      kind: 'role',
      id: `role:${r.id}`,
      roleId: r.id,
      role: r.builtin,
      color: r.color,
      label: roleName(r),
      note: isFixed(r) ? full : '',
      search: [roleName(r), r.name],
      ...(isFixed(r) ? { disabled: true } : {}),
    }));
    const people = memberItems(Object.values(members ?? {}), {
      roles: wsRoles,
      decorate: (m) => ((restricted ? m.role === WorkspaceRole.OWNER : isAdminRole(m.role)) ? { note: full, disabled: true } : listed.has(m.user?.id ?? '') ? { note: t('picker.listed') } : undefined),
    });
    // Guest accounts (ADR-0040) sit apart in a collapsed group; a search still finds them.
    const { members: permanent, guests } = splitGuests(people);
    return [
      { id: 'roles', label: t('picker.roles'), items: roles },
      { id: 'members', label: t('picker.members'), items: permanent },
      ...(guests.length > 0 ? [{ id: 'guests', label: t('picker.guests', { n: guests.length }), items: guests, collapsible: true }] : []),
    ];
  }, [drafts, isFixed, members, restricted, wsRoles]);
  const pick = (item: PeoplePickItem): void => {
    if (item.kind === 'role') setSelected(`${PermissionTargetType.ROLE}:${item.roleId}`);
    else addUser(item.userId);
    setAdding(false);
  };

  const renderTarget = (x: (typeof targets)[number]): ReactNode => {
    const on = current?.key === x.key;
    const m = x.type === PermissionTargetType.USER ? members?.[x.id] : undefined;
    const look = m ? customLook(rolesOf(entry, x.id)) : undefined;
    const user = x.type === PermissionTargetType.USER;
    return (
      <div
        key={x.key}
        className={cx('flex h-8 shrink-0 items-center rounded-[var(--radius-row)]', on ? 'bg-accent-strong text-accent-fg' : 'text-fg hover:bg-hover')}
        data-testid="perm-target"
      >
        <button
          type="button"
          aria-pressed={on}
          title={x.label}
          onClick={() => setSelected(x.key)}
          className={cx('flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-body', user && 'pr-0')}
        >
          {x.type === PermissionTargetType.USER ? (
            <Avatar userId={x.id} name={x.label} {...(m?.user?.avatarFileId ? { fileId: m.user.avatarFileId } : {})} size={20} />
          ) : x.role && isCustomRole(x.role) ? (
            <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
              <span className="size-2.5 rounded-full" style={{ background: x.role.color ? roleColorCss(x.role.color) : 'var(--color-label-tertiary)' }} />
            </span>
          ) : null}
          <span
            className={cx('min-w-0 truncate', x.type === PermissionTargetType.USER && roleTextClass(m?.role, on ? 'inherit' : 'role', look))}
            style={x.type === PermissionTargetType.USER ? roleTextStyle(m?.role, on ? 'inherit' : 'role', look) : undefined}
          >
            {x.type === PermissionTargetType.ROLE ? '@' : ''}
            {x.label}
          </span>
          {m ? <RoleMark role={m.role} custom={look} tone={on ? 'inherit' : 'role'} /> : null}
          {m && isGuest(m) ? <GuestBadge /> : null}
        </button>
        {user ? (
          <IconButton
            size="sm"
            label={t('perm.removeTarget', { name: x.label })}
            className={cx('mr-0.5', on && 'text-accent-fg hover:text-accent-fg')}
            disabled={save.isPending}
            onClick={() => removeUser(x.key)}
            data-testid="perm-target-remove"
          >
            <X className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex gap-4">
      <div className="flex w-56 shrink-0 flex-col gap-0.5" data-testid="perm-targets">
        {fixedRoles.map((r) => (
          // Fixed rows (docs/04: ADMINISTRATOR ignores room overrides) — shown, never edited.
          <div key={r.id} className="flex shrink-0 flex-col justify-center px-2 py-1" data-testid="perm-fixed-role" title={t('picker.alwaysFull')}>
            <span className="flex min-w-0 items-center gap-1.5 text-body">
              <span className={cx('min-w-0 truncate', roleTextClass(r.builtin))}>@{roleName(r)}</span>
              <RoleMark role={r.builtin} />
            </span>
            <span className="truncate text-micro text-faint first-letter:uppercase">{t('picker.fullAccess')}</span>
          </div>
        ))}
        {mainTargets.map(renderTarget)}
        {guestTargets.length > 0 ? (
          <>
            <button
              type="button"
              aria-expanded={showGuests}
              data-testid="perm-guests-toggle"
              onClick={() => setGuestsOpen(!showGuests)}
              className="mt-1 flex h-7 shrink-0 items-center gap-1 px-2 text-left text-micro font-semibold text-muted hover:text-fg"
            >
              <ChevronRight className={cx('size-3 shrink-0', showGuests && 'rotate-90')} aria-hidden />
              {t('picker.guests', { n: guestTargets.length })}
            </button>
            {showGuests ? guestTargets.map(renderTarget) : null}
          </>
        ) : null}
        <MemberPicker
          open={adding}
          onOpenChange={setAdding}
          groups={pickGroups}
          onSelect={pick}
          placeholder={t('picker.searchPeople')}
          label={t('perm.addUser')}
          testId="member-picker"
        >
          <Button variant="secondary" size="sm" className="mt-2 justify-start" data-testid="perm-add">
            <Plus className="size-3.5" aria-hidden />
            <span className="truncate">{t('perm.addUser')}</span>
          </Button>
        </MemberPicker>
      </div>
      <div className="min-w-0 flex-1">
        <table className="w-full overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] text-body">
          <caption className="sr-only">{t('room.tabPerms')}</caption>
          <tbody>
            {editable.map((name) => {
              const bit = PERMISSION_BITS[name];
              return (
                <tr key={name} className="border-b border-[var(--color-card-line)] last:border-b-0" data-settings-row>
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <span data-settings-label title={PERM_HINT[name] ? t(PERM_HINT[name]) : undefined}>
                      {t(PERM_LABEL[name])}
                    </span>
                  </th>
                  <td className="w-32 px-3 py-2 text-right">
                    <TriToggle label={t(PERM_LABEL[name])} value={triOf(draft, bit)} onChange={(v) => setTri(bit, v)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

      </div>
    </div>
  );
}
