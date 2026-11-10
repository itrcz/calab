import { WorkspaceRole, type Role } from '@calaba/protocol';
import { Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CLOSE_HIT, cx } from '../../components/ui';
import { t } from '../../i18n';
import { roleColorCss } from '../../lib/roles';
import { roleName } from './MemberBits';
import { MemberPicker } from './MemberPicker';
import type { PeoplePickItem, RolePickItem } from './memberPickItems';

/** Role dot colour: owner / admin tokens, the rest neutral (custom roles: their own colour). */
function roleDot(role: WorkspaceRole): string {
  if (role === WorkspaceRole.OWNER) return 'bg-[var(--color-role-owner)]';
  if (role === WorkspaceRole.ADMIN) return 'bg-[var(--color-role-admin)]';
  return 'bg-[var(--color-label-tertiary)]';
}

/** A role as a picker row (the «+» of RoleChipList). */
export function rolePickItem(r: Role, note = ''): RolePickItem {
  const label = roleName(r);
  return { kind: 'role', id: r.id, roleId: r.id, role: r.builtin, color: r.color, label, note, search: [label] };
}

/**
 * Roles as chips with a colour dot, × on the removable ones and «+» opening the role picker
 * (ADR-0026): the profile's «Роли» and the roles of an invitation (CBF-174) — one control.
 */
export function RoleChipList({
  roles,
  removable,
  onRemove,
  items,
  onPick,
  pickerTestId = 'role-picker',
  className,
}: {
  /** The chips, in order (highest first). */
  roles: readonly Role[];
  removable: (r: Role) => boolean;
  onRemove: (r: Role) => void;
  /** What «+» offers; no «+» when empty. */
  items: readonly RolePickItem[];
  onPick: (item: RolePickItem) => void;
  pickerTestId?: string;
  className?: string;
}): ReactNode {
  const [adding, setAdding] = useState(false);
  const pick = (item: PeoplePickItem): void => {
    setAdding(false);
    if (item.kind === 'role') onPick(item);
  };
  return (
    <div className={cx('flex flex-wrap items-center gap-1.5', className)}>
      {roles.map((r) => {
        const label = roleName(r);
        return (
          <span key={r.id} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line pl-2.5 pr-2.5 text-caption" data-testid="role-chip">
            <span className={cx('size-2.5 shrink-0 rounded-full', roleDot(r.builtin))} style={r.builtin === WorkspaceRole.UNSPECIFIED && r.color ? { background: roleColorCss(r.color) } : undefined} aria-hidden />
            <span className="min-w-0 truncate">{label}</span>
            {removable(r) ? (
              <button
                type="button"
                aria-label={t('people.profile.removeRole', { role: label })}
                className={cx(CLOSE_HIT, '-mr-1 grid size-5 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg')}
                onClick={() => onRemove(r)}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </span>
        );
      })}
      {items.length > 0 ? (
        <MemberPicker
          open={adding}
          onOpenChange={setAdding}
          groups={[{ id: 'roles', label: '', items: [...items] }]}
          onSelect={pick}
          placeholder={t('roles.search')}
          label={t('people.profile.addRole')}
          testId={pickerTestId}
          width={260}
          align="start"
        >
          <button type="button" aria-label={t('people.profile.addRole')} className="grid size-7 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <Plus className="size-4" aria-hidden />
          </button>
        </MemberPicker>
      ) : null}
    </div>
  );
}
