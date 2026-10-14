import { PermissionTargetType, WorkspaceRole, type OverrideEntry } from '@calaba/protocol';
import { Plus, X } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { Button, IconButton, Select, Spinner, Switch } from '../../components/ui';
import { t } from '../../i18n';
import { isFullRole } from '../../lib/roles';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { MemberAvatar } from '../boards/menus';
import { RoleMark, roleName } from './MemberBits';
import { MemberPicker } from './MemberPicker';
import { memberItems, type PeoplePickItem, type RolePickItem } from './memberPickItems';

/**
 * «Доступ» of a tree item — one editor for the Disk (ADR-0094 §2) and the Wiki (ADR-0096 §6):
 * «Только выбранные» (restricted), the owner, roles and people with «Просмотр / Правка / Нет
 * доступа», «Добавить роль или человека» (guests only by name). The caller holds the draft
 * (useTreeAccess) and saves it with one PUT; the bits are the section's VIEW / WRITE pair.
 */
export type Level = 'view' | 'edit' | 'deny';
export interface Draft {
  targetType: PermissionTargetType;
  targetId: string;
  level: Level;
}
export interface TreeBits {
  VIEW: bigint;
  WRITE: bigint;
}

/** An override as one of the levels: «Правка» = VIEW | WRITE, «Просмотр» = VIEW (WRITE denied), «Нет доступа» = both denied. */
export function levelOf(e: Pick<OverrideEntry, 'allow' | 'deny'>, b: TreeBits): Level {
  if ((e.allow & b.WRITE) !== 0n) return 'edit';
  if ((e.allow & b.VIEW) !== 0n) return 'view';
  if ((e.deny & b.VIEW) !== 0n) return 'deny';
  return 'view';
}
export function entryOf(
  d: Draft,
  b: TreeBits,
): {
  targetType: PermissionTargetType;
  targetId: string;
  allow: bigint;
  deny: bigint;
} {
  const vw = b.VIEW | b.WRITE;
  const bits = d.level === 'edit' ? { allow: vw, deny: 0n } : d.level === 'view' ? { allow: b.VIEW, deny: b.WRITE } : { allow: 0n, deny: vw };
  return { targetType: d.targetType, targetId: d.targetId, ...bits };
}
const keyOf = (d: Pick<Draft, 'targetType' | 'targetId'>): string => `${d.targetType}:${d.targetId}`;

export interface TreeAccess {
  /** Null while loading. */
  drafts: Draft[] | null;
  setDrafts: Dispatch<SetStateAction<Draft[] | null>>;
  restricted: boolean;
  setRestricted: (v: boolean) => void;
}

/** Loads the item's overrides once (`load` must be stable); a failure calls `onFail`. */
export function useTreeAccess(
  load: () => Promise<{
    entries: readonly OverrideEntry[];
    restricted: boolean;
  }>,
  bits: TreeBits,
  onFail: (e: unknown) => void,
): TreeAccess {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [restricted, setRestricted] = useState(false);
  useEffect(() => {
    let live = true;
    load().then(
      (r) => {
        if (!live) return;
        setRestricted(r.restricted);
        setDrafts(
          r.entries.map((e) => ({
            targetType: e.targetType,
            targetId: e.targetId,
            level: levelOf(e, bits),
          })),
        );
      },
      (e: unknown) => live && onFail(e),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per item
  }, [load]);
  return { drafts, setDrafts, restricted, setRestricted };
}

export function TreeAccessEditor({
  workspaceId,
  ownerId,
  access,
  hint,
  inherited,
  footer,
  testId,
}: {
  workspaceId: string;
  ownerId: string;
  access: TreeAccess;
  /** Under «Только выбранные». */
  hint: string;
  /** No overrides and not restricted. */
  inherited: string;
  footer: string;
  /** Prefix of the test ids (`disk-access`, `wiki-access`). */
  testId: string;
}): ReactNode {
  const { drafts, setDrafts, restricted, setRestricted } = access;
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const [adding, setAdding] = useState(false);
  const groups = useMemo((): Array<PickerGroup<PeoplePickItem>> => {
    const listed = new Set((drafts ?? []).map(keyOf));
    const rs: RolePickItem[] = (roles ?? [])
      .filter((r) => !isFullRole(r) && r.builtin !== WorkspaceRole.GUEST)
      .map((r) => ({
        kind: 'role',
        id: `role:${r.id}`,
        roleId: r.id,
        role: r.builtin,
        color: r.color,
        label: roleName(r),
        note: listed.has(`${PermissionTargetType.ROLE}:${r.id}`) ? t('picker.listed') : '',
        search: [roleName(r), r.name],
      }));
    const people = memberItems(Object.values(members ?? {}), {
      ...(roles ? { roles } : {}),
      exclude: new Set(ownerId ? [ownerId] : []),
      decorate: (m) => (listed.has(`${PermissionTargetType.USER}:${m.user?.id ?? ''}`) ? { note: t('picker.listed') } : undefined),
    });
    return [
      { id: 'roles', label: t('picker.roles'), items: rs },
      { id: 'members', label: t('picker.members'), items: people },
    ];
  }, [drafts, roles, members, ownerId]);
  const setLevel = useMemo(
    () =>
      (k: string, level: Level): void =>
        setDrafts((ds) => (ds ?? []).map((d) => (keyOf(d) === k ? { ...d, level } : d))),
    [setDrafts],
  );
  const remove = useMemo(
    () =>
      (k: string): void =>
        setDrafts((ds) => (ds ?? []).filter((d) => keyOf(d) !== k)),
    [setDrafts],
  );
  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <Switch checked={restricted} onChange={setRestricted} label={t('disk.restricted')} hint={hint} disabled={!drafts} />
      <section className="flex flex-col gap-1">
        <h3 className="text-caption font-semibold text-muted">{t('disk.accessWho')}</h3>
        <div className="flex flex-col overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]">
          {ownerId ? <OwnerRow workspaceId={workspaceId} userId={ownerId} /> : null}
          {drafts === null ? (
            <div className="grid h-12 place-items-center">
              <Spinner />
            </div>
          ) : (
            drafts.map((d) => <TargetRow key={keyOf(d)} workspaceId={workspaceId} draft={d} onLevel={setLevel} onRemove={remove} testId={testId} />)
          )}
          {drafts && !drafts.length && !restricted ? <p className="px-3 py-2 text-caption text-muted">{inherited}</p> : null}
        </div>
        <MemberPicker
          open={adding}
          onOpenChange={setAdding}
          groups={groups}
          onSelect={(it) => {
            setAdding(false);
            const d: Draft =
              it.kind === 'role'
                ? {
                    targetType: PermissionTargetType.ROLE,
                    targetId: it.roleId,
                    level: 'view',
                  }
                : {
                    targetType: PermissionTargetType.USER,
                    targetId: it.userId,
                    level: 'view',
                  };
            setDrafts((ds) => (ds?.some((x) => keyOf(x) === keyOf(d)) ? ds : [...(ds ?? []), d]));
          }}
          placeholder={t('picker.searchPeople')}
          label={t('disk.accessAdd')}
          testId={`${testId}-picker`}
        >
          <Button variant="secondary" size="sm" className="mt-1 self-start" disabled={!drafts} data-testid={`${testId}-add`}>
            <Plus className="size-3.5" aria-hidden /> {t('disk.accessAdd')}
          </Button>
        </MemberPicker>
      </section>
      <p className="text-caption text-faint">{footer}</p>
    </div>
  );
}

function OwnerRow({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  return (
    <div className="flex h-11 items-center gap-2.5 border-b border-[var(--color-card-line)] px-3">
      <MemberAvatar workspaceId={workspaceId} userId={userId} size={24} />
      <span className="min-w-0 flex-1 truncate text-body">{name}</span>
      <span className="text-caption text-muted">{t('disk.owner')}</span>
    </div>
  );
}

const TargetRow = memo(function TargetRow({
  workspaceId,
  draft,
  onLevel,
  onRemove,
  testId,
}: {
  workspaceId: string;
  draft: Draft;
  onLevel: (k: string, l: Level) => void;
  onRemove: (k: string) => void;
  testId: string;
}): ReactNode {
  const role = useWorkspaces((s) => (draft.targetType === PermissionTargetType.ROLE ? s.byId[workspaceId]?.roles.find((r) => r.id === draft.targetId) : undefined));
  const user = draft.targetType === PermissionTargetType.USER;
  const guest = useWorkspaces((s) => user && s.byId[workspaceId]?.members[draft.targetId]?.role === WorkspaceRole.GUEST);
  const name = user ? memberName(workspaceId, draft.targetId) : role ? `@${roleName(role)}` : draft.targetId;
  const k = keyOf(draft);
  return (
    <div className="flex h-11 items-center gap-2.5 border-b border-[var(--color-card-line)] px-3 last:border-b-0" data-testid={`${testId}-row`}>
      {user ? (
        <MemberAvatar workspaceId={workspaceId} userId={draft.targetId} size={24} />
      ) : (
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-fill-hover)] text-caption font-semibold text-muted" aria-hidden>
          @
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-body">
        <span className="truncate">{name}</span>
        {role ? <RoleMark role={role.builtin} tone="muted" /> : null}
        {guest ? <span className="shrink-0 text-caption text-muted">{t('disk.guest')}</span> : null}
      </span>
      <span className="w-36 shrink-0">
        <Select value={draft.level} onChange={(e) => onLevel(k, e.target.value as Level)} aria-label={t('disk.level', { name })} data-testid={`${testId}-level`}>
          <option value="view">{t('disk.level.view')}</option>
          <option value="edit">{t('disk.level.edit')}</option>
          <option value="deny">{t('disk.level.deny')}</option>
        </Select>
      </span>
      <IconButton size="sm" label={t('perm.removeTarget', { name })} onClick={() => onRemove(k)} data-testid={`${testId}-remove`}>
        <X className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  );
});
