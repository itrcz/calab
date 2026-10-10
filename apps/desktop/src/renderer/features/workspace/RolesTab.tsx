import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { BILLING_PERMISSIONS, PERMISSION_BITS, WorkspaceRole, type PermissionBits, type PermissionName, type Role, type WorkspaceMember } from '@calaba/protocol';
import { AtSign, Check, ChevronDown, ChevronLeft, ChevronRight, Crown, GripVertical, Plus, ShieldCheck, Trash2, TriangleAlert, UserRound, X } from 'lucide-react';
import { memo, useId, useMemo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Badge, Button, Card, Empty, IconButton, Input, Row, Segmented, Toggle, cx } from '../../components/ui';
import { plural, t, type MessageKey } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { previewRoles, rolePreview, visibleBoards, visibleRooms, type PreviewItemId } from '../../lib/rolePreview';
import {
  ROLE_NAME_MAX,
  ROLE_PALETTE,
  ROLE_PERM_GROUPS,
  ROLE_TEMPLATES,
  BILLING_PERM_BIT,
  BILLING_PERM_ORDER,
  billingEditableBits,
  billingOn,
  botsWithRole,
  canAssignRole,
  canCreateRole,
  canDeleteRole,
  canEditRole,
  canRenameRole,
  editableBits,
  isCustomRole,
  isFullRole,
  GUEST_BITS,
  parseRoleColor,
  permDefault,
  reorderCustom,
  roleActor,
  roleColorCss,
  roleCounts,
  roleNameError,
  rolesOfMember,
  templateBits,
  templateClipped,
  toggleBilling,
  topRole,
  uniqueRoleName,
  warnBotsAdmin,
  type BillingPermName,
  type PermDefault,
  type PermGroupId,
  type RoleActor,
  type RoleNameError,
  type RoleTemplateId,
} from '../../lib/roles';
import { useBoards } from '../../stores/boards';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { roleName } from '../people/MemberBits';
import { MemberPicker } from '../people/MemberPicker';
import { memberItems, type PeoplePickItem } from '../people/memberPickItems';
import { PERM_HINT, PERM_LABEL } from './RoomDialogs';
import { toggleMemberRole } from '../people/actions';
import { nameOf } from '../people/members';

/*
 * Workspace settings → «Роли» (ADR-0026, ADR-0048 §3, docs/08 «Роли»): the list (colour, member
 * count, built-ins marked, custom roles dragged into order), the new-role form (name, colour,
 * «Шаблон», the bits, the preview — nothing is saved until «Создать») and a role card (name, colour,
 * «Упоминаемая», the permission matrix by function, «Что увидит участник…», members with the role,
 * delete). Card changes apply at once (System Settings style); the server re-checks every rule, a
 * refusal (403 / 422) shows inline.
 */

const GROUP_LABEL: Record<PermGroupId, MessageKey> = {
  workspace: 'roles.group.workspace',
  members: 'roles.group.members',
  invites: 'roles.group.invites',
  rooms: 'roles.group.rooms',
  voice: 'roles.group.voice',
  telephony: 'roles.group.telephony',
  moderation: 'roles.group.moderation',
  calendar: 'roles.group.calendar',
  boards: 'roles.group.boards',
  recordings: 'roles.group.recordings',
  integrations: 'roles.group.integrations',
  journals: 'roles.group.journals',
};

/** The «Биллинг» group (ADR-0087): label and «что даёт» of each bit. */
const BILLING_LABEL: Record<BillingPermName, MessageKey> = {
  BILLING_VIEW: 'perm.BILLING_VIEW',
  BILLING_TOPUP: 'perm.BILLING_TOPUP',
  BILLING_MANAGE: 'perm.BILLING_MANAGE',
};
const BILLING_HINT: Record<BillingPermName, MessageKey> = {
  BILLING_VIEW: 'perm.hint.BILLING_VIEW',
  BILLING_TOPUP: 'perm.hint.BILLING_TOPUP',
  BILLING_MANAGE: 'perm.hint.BILLING_MANAGE',
};

const DEFAULT_LABEL: Record<PermDefault, MessageKey> = {
  guests: 'perm.default.guests',
  members: 'perm.default.members',
  admins: 'perm.default.admins',
};

const TEMPLATE_LABEL: Record<RoleTemplateId, MessageKey> = {
  empty: 'roles.tpl.empty',
  moderator: 'roles.tpl.moderator',
  manager: 'roles.tpl.manager',
  observer: 'roles.tpl.observer',
};

const PREVIEW_LABEL: Record<PreviewItemId, MessageKey> = {
  rooms: 'roles.preview.rooms',
  voice: 'roles.preview.voice',
  tempRooms: 'roles.preview.tempRooms',
  calendar: 'roles.preview.calendar',
  events: 'roles.preview.events',
  boards: 'roles.preview.boards',
  createBoards: 'roles.preview.createBoards',
  tabWorkspace: 'roles.preview.tabWorkspace',
  tabMembers: 'roles.preview.tabMembers',
  tabInvites: 'roles.preview.tabInvites',
  tabRoles: 'roles.preview.tabRoles',
  tabStickers: 'roles.preview.tabStickers',
  tabBots: 'roles.preview.tabBots',
  tabIntegrations: 'roles.preview.tabIntegrations',
  tabJournals: 'roles.preview.tabJournals',
  tabRecordings: 'roles.preview.tabRecordings',
};

const NO_ROLES: readonly Role[] = [];

/** «что даёт · кому по умолчанию» of a bit (ADR-0048 §3). */
function permHint(p: PermissionName): string {
  const what = PERM_HINT[p];
  const who = t(DEFAULT_LABEL[permDefault(p)]);
  return what ? `${t(what)} · ${who}` : who;
}

const NAME_ERROR: Record<Exclude<RoleNameError, null>, MessageKey> = {
  empty: 'roles.err.empty',
  long: 'roles.err.long',
  taken: 'roles.err.taken',
};

const err = (e: unknown): string => errorText(e);

/** Me in this workspace as a role actor (lib/roles). */
function useActor(workspaceId: string): RoleActor {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const mine = useMemberRoles(workspaceId, me);
  return useMemo(() => roleActor(mine), [mine]);
}

export function RolesTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const role = useWorkspaces((s) => (open ? s.byId[workspaceId]?.roles.find((r) => r.id === open) : undefined));
  if (creating) {
    return (
      <RoleDraft
        workspaceId={workspaceId}
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setOpen(id);
        }}
      />
    );
  }
  const list = <RoleList workspaceId={workspaceId} onOpen={setOpen} onCreate={() => setCreating(true)} />;
  // A role deleted meanwhile (here or elsewhere) → back to the list.
  if (open && !role) return list;
  return role ? <RoleCard workspaceId={workspaceId} role={role} onBack={() => setOpen(null)} /> : list;
}

/** The glyph before a role name: crown / shield for owner / admin, @ member, guest icon, a colour dot for a custom role. */
function RoleIcon({ role, size = 'md' }: { role: Role; size?: 'md' | 'lg' }): ReactNode {
  const box = size === 'lg' ? 'size-8' : 'size-6';
  if (isCustomRole(role)) {
    return (
      <span className={cx('grid shrink-0 place-items-center', box)} aria-hidden>
        <span className={cx('rounded-full', size === 'lg' ? 'size-4' : 'size-3')} style={{ background: role.color ? roleColorCss(role.color) : 'var(--color-label-tertiary)' }} />
      </span>
    );
  }
  const Icon = role.builtin === WorkspaceRole.OWNER ? Crown : role.builtin === WorkspaceRole.ADMIN ? ShieldCheck : role.builtin === WorkspaceRole.GUEST ? UserRound : AtSign;
  const tone = role.builtin === WorkspaceRole.OWNER ? 'text-role-owner' : role.builtin === WorkspaceRole.ADMIN ? 'text-role-admin' : 'text-muted';
  return (
    <span className={cx('grid shrink-0 place-items-center rounded-full bg-[var(--color-fill)]', box, tone)} aria-hidden>
      <Icon className={size === 'lg' ? 'size-4' : 'size-3.5'} />
    </span>
  );
}

function RoleList({ workspaceId, onOpen, onCreate }: { workspaceId: string; onOpen: (id: string) => void; onCreate: () => void }): ReactNode {
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const actor = useActor(workspaceId);
  const [error, setError] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor));
  const counts = useMemo(() => roleCounts(roles ?? [], Object.values(members ?? {})), [roles, members]);
  if (!roles) return null;

  const onEnd = (e: DragEndEvent): void => {
    const over = e.over?.id;
    if (over === undefined) return;
    const order = reorderCustom(roles, String(e.active.id), String(over));
    if (!order) return;
    // Optimistic: the custom roles take positions n+1 … 2 at once; the answer (or ROLE_UPDATE) confirms.
    const before = roles;
    const pos = new Map(order.map((id, i) => [id, order.length + 1 - i]));
    useWorkspaces.getState().setRoles(workspaceId, roles.map((r) => (pos.has(r.id) ? { ...r, position: pos.get(r.id) ?? r.position } : r)));
    setError(null);
    api.roles.order(workspaceId, order).then(
      (res) => useWorkspaces.getState().setRoles(workspaceId, res.roles),
      (x: unknown) => {
        useWorkspaces.getState().setRoles(workspaceId, before);
        setError(err(x));
      },
    );
  };

  return (
    <>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-caption text-muted">{t('roles.hint')}</p>
        {canCreateRole(actor) ? (
          <Button onClick={onCreate} data-testid="role-create">
            <Plus className="size-4" aria-hidden /> {t('roles.create')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="-mt-2 text-caption text-danger-text" data-testid="roles-error">
          {error}
        </p>
      ) : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
        <Card title={plural('roles.count', roles.length)}>
          {roles.map((r) => (
            <RoleRow key={r.id} role={r} count={counts.get(r.id) ?? 0} draggable={isCustomRole(r) && canEditRole(actor, r)} onOpen={() => onOpen(r.id)} />
          ))}
        </Card>
      </DndContext>
    </>
  );
}

function RoleRow({ role, count, draggable, onOpen }: { role: Role; count: number; draggable: boolean; onOpen: () => void }): ReactNode {
  const name = roleName(role);
  const drag = useDraggable({ id: role.id, disabled: !draggable });
  const drop = useDroppable({ id: role.id, disabled: !isCustomRole(role) });
  const ref = (n: HTMLDivElement | null): void => {
    drag.setNodeRef(n);
    drop.setNodeRef(n);
  };
  const style = drag.transform ? { transform: `translate3d(0, ${Math.round(drag.transform.y)}px, 0)` } : undefined;
  return (
    <div
      ref={ref}
      style={style}
      className={cx(
        'relative flex min-h-11 items-center gap-2 bg-[var(--color-card)] pl-1 pr-2',
        drag.isDragging && 'z-10 opacity-90 shadow-[var(--shadow-popover)]',
        drop.isOver && !drag.isDragging && 'shadow-[inset_0_2px_0_var(--color-accent)]',
      )}
      data-testid="role-row"
    >
      {draggable ? (
        <button
          type="button"
          aria-label={t('roles.drag', { name })}
          className="grid size-7 shrink-0 cursor-grab place-items-center rounded-[6px] text-faint hover:bg-hover hover:text-fg active:cursor-grabbing"
          {...drag.listeners}
          {...drag.attributes}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      ) : (
        <span className="w-7 shrink-0" aria-hidden />
      )}
      <button type="button" onClick={onOpen} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[6px] pr-1 text-left" aria-label={name}>
        <RoleIcon role={role} />
        <span className="min-w-0 truncate text-body font-medium">
          {name}
        </span>
        {!isCustomRole(role) ? <Badge>{t('roles.builtin')}</Badge> : null}
        {role.mentionable ? <AtSign className="size-3.5 shrink-0 text-faint" aria-label={t('roles.mentionable')} /> : null}
        <span className="ml-auto shrink-0 text-caption text-muted">{plural('roles.nMembers', count)}</span>
        <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the role card

function RoleCard({ workspaceId, role, onBack }: { workspaceId: string; role: Role; onBack: () => void }): ReactNode {
  const actor = useActor(workspaceId);
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles ?? []);
  const [error, setError] = useState<string | null>(null);
  const name = roleName(role);
  const editable = canEditRole(actor, role);
  const bits = editableBits(actor, role);
  const billingBits = billingEditableBits(actor, role);
  const full = isFullRole(role);

  const patch = async (init: Parameters<typeof api.roles.update>[2]): Promise<void> => {
    setError(null);
    try {
      const r = await api.roles.update(workspaceId, role.id, init);
      if (r.role) useWorkspaces.getState().upsertRole(r.role);
    } catch (e) {
      setError(err(e));
    }
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('roles.delete'), t('roles.deleteConfirm', { name }), t('roles.delete')))) return;
    setError(null);
    try {
      await api.roles.remove(workspaceId, role.id);
      useWorkspaces.getState().removeRole(workspaceId, role.id);
      onBack();
    } catch (e) {
      setError(err(e));
    }
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onBack} data-testid="role-back">
          <ChevronLeft className="size-4" aria-hidden /> {t('roles.tab')}
        </Button>
        <RoleIcon role={role} size="lg" />
        <h3 className="min-w-0 truncate text-headline font-semibold" data-testid="role-title">
          {name}
        </h3>
        {!isCustomRole(role) ? <Badge>{t('roles.builtin')}</Badge> : null}
      </div>
      {!editable ? <p className="-mt-2 text-caption text-muted">{t('roles.readOnly')}</p> : null}
      {error ? (
        <p role="alert" className="-mt-2 text-caption text-danger-text" data-testid="role-error">
          {error}
        </p>
      ) : null}

      <Card title={t('roles.card.basics')}>
        <Row label={t('roles.name')} {...(!isCustomRole(role) ? { hint: t('roles.nameFixed') } : {})}>
          <RoleNameInput role={role} roles={roles} disabled={!canRenameRole(actor, role)} onCommit={(v) => patch({ name: v })} />
        </Row>
        <div className="flex flex-col gap-2 px-3 py-2.5" data-settings-row>
          <span className="text-body" data-settings-label>
            {t('roles.color')}
          </span>
          <ColorPicker value={role.color} disabled={!editable} onChange={(c) => void patch({ color: c })} />
        </div>
        <Row label={t('roles.mentionable')} hint={t('roles.mentionableHint')}>
          <Toggle label={t('roles.mentionable')} checked={role.mentionable} disabled={!editable} onChange={(v) => void patch({ mentionable: v })} />
        </Row>
      </Card>

      {full ? (
        <Card title={t('roles.perms')}>
          <p className="px-3 py-2.5 text-body text-muted" data-testid="role-full-access">
            {t('roles.fullAccess')}
          </p>
        </Card>
      ) : (
        <>
          <BotsAdminWarning workspaceId={workspaceId} roleId={role.id} bits={role.permissions} />
          <PermissionMatrix
            idPrefix={role.id}
            bits={role.permissions}
            editable={bits}
            billingEditable={billingBits}
            guest={role.builtin === WorkspaceRole.GUEST}
            lockedHint={editable}
            onChange={(p) => void patch({ permissions: p })}
          />
          <RolePreview workspaceId={workspaceId} roleId={role.id} position={role.position} builtin={role.builtin} bits={role.permissions} />
        </>
      )}

      <RoleMembers workspaceId={workspaceId} role={role} actor={actor} onError={setError} />

      {canDeleteRole(actor, role) ? (
        <div className="flex justify-end">
          <Button variant="destructive" onClick={() => void remove()} data-testid="role-delete">
            <Trash2 className="size-4" aria-hidden /> {t('roles.delete')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * ADR-0051: a bot acts through the API with its roles' bits — administrative bits on a role that
 * bots hold make their tokens admin keys. A yellow note above the matrix (docs/08: yellow =
 * warning); the bot count is a primitive selector, so member traffic re-renders it only when the
 * count moves.
 */
const BotsAdminWarning = memo(function BotsAdminWarning({ workspaceId, roleId, bits }: { workspaceId: string; roleId: string; bits: PermissionBits }): ReactNode {
  const bots = useWorkspaces((s) => {
    const e = s.byId[workspaceId];
    return e ? botsWithRole(e.roles, Object.values(e.members), roleId) : 0;
  });
  if (!warnBotsAdmin(bits, bots)) return null;
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-row)] bg-mention px-2.5 py-2 text-caption text-fg" role="note" data-testid="role-bots-admin">
      <TriangleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
      {plural('roles.botsAdmin', bots)}
    </div>
  );
});

/** Name field: commits on Enter / blur; the name rules (lib/roles roleNameError) inline, Esc restores. */
function RoleNameInput({ role, roles, disabled, onCommit }: { role: Role; roles: readonly Role[]; disabled: boolean; onCommit: (v: string) => Promise<void> }): ReactNode {
  const shown = roleName(role);
  const [v, setV] = useState(shown);
  const [prev, setPrev] = useState(shown);
  const errId = useId();
  if (prev !== shown) {
    setPrev(shown);
    setV(shown);
  }
  const problem = disabled ? null : roleNameError(v, roles, role.id);
  const commit = (): void => {
    if (disabled || problem || v.trim() === shown) return;
    void onCommit(v.trim());
  };
  return (
    <div className="flex w-60 flex-col items-end gap-1">
      <Input
        aria-label={t('roles.name')}
        value={v}
        disabled={disabled}
        maxLength={ROLE_NAME_MAX * 2}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? errId : undefined}
        data-testid="role-name"
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape' && v !== shown) {
            e.stopPropagation();
            setV(shown);
          }
        }}
      />
      {problem ? (
        <span id={errId} className="text-caption text-danger-text">
          {t(NAME_ERROR[problem], { n: ROLE_NAME_MAX })}
        </span>
      ) : null}
    </div>
  );
}

/** 12 swatches + «Свой цвет» (the system colour picker; a hex field would be one more control). */
function ColorPicker({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (c: number) => void }): ReactNode {
  const custom = value !== 0 && !ROLE_PALETTE.includes(value);
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('roles.color')} data-testid="role-colors">
      {ROLE_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={roleColorCss(c)}
          disabled={disabled}
          onClick={() => onChange(c)}
          className={cx(
            'size-7 rounded-full outline-offset-2 transition-transform duration-[var(--motion-fast)] enabled:hover:scale-110 disabled:opacity-50',
            value === c && 'ring-2 ring-fg ring-offset-2 ring-offset-[var(--color-card)]',
          )}
          style={{ background: roleColorCss(c) }}
        />
      ))}
      <label
        className={cx(
          'relative grid size-7 cursor-pointer place-items-center overflow-hidden rounded-full border border-dashed border-[var(--color-label-tertiary)] text-muted',
          custom && 'border-solid ring-2 ring-fg ring-offset-2 ring-offset-[var(--color-card)]',
          disabled && 'cursor-default opacity-50',
        )}
        style={custom ? { background: roleColorCss(value) } : undefined}
        title={t('roles.colorCustom')}
      >
        {custom ? null : <Plus className="size-3.5" aria-hidden />}
        <input
          type="color"
          aria-label={t('roles.colorCustom')}
          className="absolute inset-0 cursor-pointer opacity-0"
          disabled={disabled}
          value={roleColorCss(value || 0x8e8e93)}
          onChange={(e) => {
            const c = parseRoleColor(e.target.value);
            if (c !== null && c !== value) onChange(c);
          }}
        />
      </label>
    </div>
  );
}

/**
 * The bits by function (lib/roles ROLE_PERM_GROUPS): a checkbox per permission with «что даёт ·
 * кому по умолчанию»; the guest role lists only the guest bits. A bit I may not grant is disabled
 * (with the reason as its tooltip when the role itself is mine to edit).
 */
function PermissionMatrix({
  idPrefix,
  bits,
  editable,
  billingEditable,
  guest,
  lockedHint,
  onChange,
}: {
  idPrefix: string;
  bits: PermissionBits;
  editable: PermissionBits;
  /** Billing bits I may toggle (ADR-0087: the owner only; lib/roles billingEditableBits). */
  billingEditable: PermissionBits;
  guest: boolean;
  /** The role is editable by me: a disabled bit explains itself. */
  lockedHint: boolean;
  onChange: (p: PermissionBits) => void;
}): ReactNode {
  return (
    <>
      {guest ? <p className="-mb-2 px-1 text-caption text-muted">{t('roles.guestNote')}</p> : null}
      {ROLE_PERM_GROUPS.map((g) => {
        const perms = g.perms.filter((p) => !guest || (PERMISSION_BITS[p] & GUEST_BITS) !== 0n);
        if (perms.length === 0) return null;
        return (
          <Card key={g.id} title={t(GROUP_LABEL[g.id])}>
            {perms.map((p) => {
              const bit = PERMISSION_BITS[p];
              const on = (bits & bit) !== 0n;
              const can = (editable & bit) !== 0n;
              const id = `perm-${idPrefix}-${p}`;
              return (
                <Row key={p} label={t(PERM_LABEL[p])} hint={permHint(p)} htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={on}
                    disabled={!can}
                    title={!can && lockedHint ? t('roles.bitLocked') : undefined}
                    data-testid={`role-perm-${p}`}
                    onChange={(e) => onChange(e.target.checked ? bits | bit : bits & ~bit)}
                    className="size-[18px] cursor-pointer rounded-[4px] accent-[var(--color-accent-strong)] disabled:cursor-default disabled:opacity-50"
                  />
                </Row>
              );
            })}
          </Card>
        );
      })}
      {guest ? null : (
        <Card title={t('roles.group.billing')} footer={t('roles.billing.footer')}>
          <div data-testid="role-billing-group">
            {BILLING_PERM_ORDER.map((p) => {
              const on = billingOn(bits, p);
              const can = (billingEditable & BILLING_PERM_BIT[p]) !== 0n;
              const id = `perm-${idPrefix}-${p}`;
              return (
                <Row key={p} label={t(BILLING_LABEL[p])} hint={`${t(BILLING_HINT[p])} · ${t('perm.default.nobody')}`} htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={on}
                    disabled={!can}
                    title={!can && lockedHint ? t('roles.billing.ownerOnly') : undefined}
                    data-testid={`role-perm-${p}`}
                    onChange={(e) => onChange(toggleBilling(bits, p, e.target.checked))}
                    className="size-[18px] cursor-pointer rounded-[4px] accent-[var(--color-accent-strong)] disabled:cursor-default disabled:opacity-50"
                  />
                </Row>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}

/**
 * «Что увидит участник с этой ролью» (ADR-0048 §3): a collapsible card under the bits, a check /
 * cross list computed with computePermissions (lib/rolePreview) — live as bits change. Primitive
 * props; the room / board counts are primitive selectors, so store traffic re-renders it only when
 * a count moves.
 */
const RolePreview = memo(function RolePreview({
  workspaceId,
  roleId,
  position,
  builtin,
  bits,
}: {
  workspaceId: string;
  roleId: string;
  position: number;
  builtin: WorkspaceRole;
  bits: PermissionBits;
}): ReactNode {
  const all = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const roles = useMemo(() => (all ? previewRoles(all, { id: roleId, position, builtin }, bits) : null), [all, roleId, position, builtin, bits]);
  const guest = builtin === WorkspaceRole.GUEST;
  const rooms = useRooms((s) => (roles && open ? visibleRooms(s.byId, workspaceId, roles) : '0/0'));
  const boards = useBoards((s) => (roles && open ? visibleBoards(s.boards, workspaceId, roles, guest) : '0/0'));
  const items = useMemo(() => (roles ? rolePreview(roles, guest, { rooms, boards }) : []), [roles, guest, rooms, boards]);
  if (!roles) return null;
  const count = (id: PreviewItemId): string | null => {
    const c = id === 'rooms' ? rooms : id === 'boards' ? boards : null;
    if (!c || c.endsWith('/0')) return null;
    const [n = '0', total = '0'] = c.split('/');
    return t('roles.preview.of', { n, total });
  };
  const row = (it: (typeof items)[number]): ReactNode => (
    <li key={it.id} className="flex min-h-8 items-center gap-2 px-3 py-1" data-testid={`role-preview-${it.id}`} data-on={it.on ? '1' : '0'}>
      {it.on ? (
        <Check className="size-4 shrink-0 text-ok" aria-label={t('roles.preview.yes')} />
      ) : (
        <X className="size-4 shrink-0 text-faint" aria-label={t('roles.preview.no')} />
      )}
      <span className={cx('min-w-0 flex-1 truncate text-body', !it.on && 'text-muted')}>{t(PREVIEW_LABEL[it.id])}</span>
      {count(it.id) ? <span className="shrink-0 text-caption tabular-nums text-muted">{count(it.id)}</span> : null}
    </li>
  );
  return (
    <section className="flex flex-col gap-1.5" data-testid="role-preview">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 self-start rounded-[6px] px-1 text-caption font-semibold text-muted hover:text-fg"
      >
        <ChevronDown className={cx('size-3.5 transition-transform duration-[var(--motion-fast)]', !open && '-rotate-90')} aria-hidden />
        {t('roles.preview.title')}
      </button>
      {open ? (
        <div id={bodyId} className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)] py-1">
          <p className="px-3 pb-1 pt-1.5 text-caption text-faint">{t('roles.preview.hint')}</p>
          <ul>{items.filter((i) => !i.settings).map(row)}</ul>
          <p className="px-3 pb-0.5 pt-2 text-caption font-medium text-muted">{t('roles.preview.settings')}</p>
          <ul>{items.filter((i) => i.settings).map(row)}</ul>
        </div>
      ) : null}
    </section>
  );
});

/**
 * «Создать роль» (ADR-0048 §3): a draft — name, colour, «Шаблон» (Пусто · Модератор · Менеджер
 * отдела · Наблюдатель pre-check bits), the bits and the preview; nothing reaches the server until
 * «Создать» (then the role card opens). The new role goes to the bottom of the custom ones
 * (position 2): the bits I may grant are those of a role there.
 */
function RoleDraft({ workspaceId, onCancel, onCreated }: { workspaceId: string; onCancel: () => void; onCreated: (id: string) => void }): ReactNode {
  const actor = useActor(workspaceId);
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles ?? NO_ROLES);
  const [name, setName] = useState(() => uniqueRoleName(t('roles.newName'), roles));
  const [color, setColor] = useState(ROLE_PALETTE[0] ?? 0);
  const [tpl, setTpl] = useState<RoleTemplateId>('empty');
  const [bits, setBits] = useState<PermissionBits>(0n);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errId = useId();
  const editable = useMemo(() => editableBits(actor, { position: 2, builtin: WorkspaceRole.UNSPECIFIED }), [actor]);
  const billingEditable = billingEditableBits(actor, { position: 2, builtin: WorkspaceRole.UNSPECIFIED });
  const problem = roleNameError(name, roles);
  const clipped = templateClipped(tpl, editable) !== 0n;

  const apply = (id: RoleTemplateId): void => {
    setTpl(id);
    setBits(templateBits(id, editable));
  };
  const submit = async (): Promise<void> => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.roles.create(workspaceId, { name: name.trim(), color, permissions: bits, mentionable: false });
      if (r.role) {
        useWorkspaces.getState().upsertRole(r.role);
        onCreated(r.role.id);
      }
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} data-testid="role-back">
          <ChevronLeft className="size-4" aria-hidden /> {t('roles.tab')}
        </Button>
        <h3 className="min-w-0 truncate text-headline font-semibold" data-testid="role-title">
          {t('roles.create')}
        </h3>
      </div>
      {error ? (
        <p role="alert" className="-mt-2 text-caption text-danger-text" data-testid="role-error">
          {error}
        </p>
      ) : null}
      <Card title={t('roles.card.basics')}>
        <Row label={t('roles.name')}>
          <div className="flex w-60 flex-col items-end gap-1">
            <Input
              aria-label={t('roles.name')}
              value={name}
              autoFocus
              maxLength={ROLE_NAME_MAX * 2}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? errId : undefined}
              data-testid="role-name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
            {problem ? (
              <span id={errId} className="text-caption text-danger-text">
                {t(NAME_ERROR[problem], { n: ROLE_NAME_MAX })}
              </span>
            ) : null}
          </div>
        </Row>
        <div className="flex flex-col gap-2 px-3 py-2.5" data-settings-row>
          <span className="text-body" data-settings-label>
            {t('roles.color')}
          </span>
          <ColorPicker value={color} disabled={false} onChange={setColor} />
        </div>
      </Card>
      <Card title={t('roles.tpl.label')} footer={t('roles.tpl.hint')}>
        <div className="flex flex-col gap-2 px-3 py-2.5" data-testid="role-template">
          <Segmented label={t('roles.tpl.label')} value={tpl} onChange={apply} options={ROLE_TEMPLATES.map((x) => ({ value: x.id, label: t(TEMPLATE_LABEL[x.id]) }))} />
          {tpl === 'observer' ? <p className="text-caption text-muted">{t('roles.tpl.observerNote')}</p> : null}
          {clipped ? <p className="text-caption text-muted" data-testid="role-template-clipped">{t('roles.tpl.clipped')}</p> : null}
        </div>
      </Card>
      <PermissionMatrix idPrefix="new" bits={bits} editable={editable} billingEditable={billingEditable} guest={false} lockedHint onChange={setBits} />
      <RolePreview workspaceId={workspaceId} roleId="" position={2} builtin={WorkspaceRole.UNSPECIFIED} bits={bits} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button busy={busy} disabled={!!problem} onClick={() => void submit()} data-testid="role-create-submit">
          {t('common.create')}
        </Button>
      </div>
    </>
  );
}

/**
 * «Участники с ролью»: who holds it, × to take it, «Добавить участника» through the member picker
 * (docs/08 «Выбор участника»). Member / guest follow the member itself: just a note.
 */
function RoleMembers({ workspaceId, role, actor, onError }: { workspaceId: string; role: Role; actor: RoleActor; onError: (e: string | null) => void }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const [adding, setAdding] = useState(false);
  const all = entry?.roles;
  const list = useMemo(() => {
    if (!entry || !all) return [];
    return Object.values(entry.members)
      .filter((m) => m.user && rolesOfMember(all, m).some((r) => r.id === role.id))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }, [entry, all, role.id]);
  if (!entry || !all) return null;
  if (role.builtin === WorkspaceRole.MEMBER || role.builtin === WorkspaceRole.GUEST) {
    return (
      <Card title={t('roles.members')}>
        <p className="px-3 py-2.5 text-body text-muted">{t(role.builtin === WorkspaceRole.GUEST ? 'roles.everyGuest' : 'roles.everyMember')}</p>
      </Card>
    );
  }
  const assignable = (m: WorkspaceMember): boolean => {
    const theirs = rolesOfMember(all, m);
    return (
      canAssignRole(actor, role, topRole(theirs)?.position ?? -1, m.user?.id === me) &&
      !(role.builtin === WorkspaceRole.ADMIN && m.role === WorkspaceRole.GUEST) &&
      // ADR-0087: bots never hold billing bits.
      !(m.user?.isBot && (role.permissions & BILLING_PERMISSIONS) !== 0n)
    );
  };
  const held = new Set(list.map((m) => m.user?.id ?? ''));
  const items = memberItems(Object.values(entry.members), {
    exclude: held,
    roles: all,
    decorate: (m) => (assignable(m) ? undefined : { disabled: true }),
  });
  const choosable = items.some((i) => !i.disabled);
  const set = (userId: string, on: boolean): void => {
    onError(null);
    void toggleMemberRole(workspaceId, userId, role, on);
  };
  const pick = (item: PeoplePickItem): void => {
    setAdding(false);
    if (item.kind === 'member') set(item.userId, true);
  };
  return (
    <Card title={`${t('roles.members')} · ${list.length}`}>
      {list.length === 0 ? <Empty>{t('roles.noMembers')}</Empty> : null}
      {list.map((m) => {
        const u = m.user;
        if (!u) return null;
        const n = nameOf(m) || u.displayName;
        return (
          <div key={u.id} className="flex min-h-11 items-center gap-2.5 px-3 py-1.5" data-testid="role-member">
            <Avatar userId={u.id} name={n} fileId={u.avatarFileId || undefined} size={24} presence />
            <span className="min-w-0 flex-1 truncate text-body">{n}</span>
            {assignable(m) ? (
              <IconButton label={t('roles.removeMember', { name: n })} className="text-muted hover:text-danger" onClick={() => set(u.id, false)}>
                <X className="size-4" />
              </IconButton>
            ) : null}
          </div>
        );
      })}
      {choosable ? (
        <div className="px-3 py-2">
          <MemberPicker
            open={adding}
            onOpenChange={setAdding}
            groups={[{ id: 'members', label: '', items }]}
            onSelect={pick}
            placeholder={t('picker.searchPeople')}
            label={t('roles.addMember')}
            testId="role-member-picker"
          >
            <Button variant="secondary" size="sm" data-testid="role-add-member">
              <Plus className="size-3.5" aria-hidden /> {t('roles.addMember')}
            </Button>
          </MemberPicker>
        </div>
      ) : null}
    </Card>
  );
}

