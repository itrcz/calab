import { WorkspaceRole, type Role } from '@calaba/protocol';
import { Crown, ShieldCheck } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Badge, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { roleColorCss } from '../../lib/roles';
import { useFormerInfo, useWorkspaces } from '../../stores/workspaces';

/** «Гость» next to a name (ADR-0016): the shared badge (11/600, sentence case, radius 4). */
export function GuestBadge({ className }: { className?: string }): ReactNode {
  return <Badge {...(className ? { className } : {})}>{t('people.guest')}</Badge>;
}

/**
 * «бывший» next to the name of someone who left the workspace (ADR-0097 §4): an outlined muted
 * 11 px chip, lower case; the tooltip says since when. Renders nothing for a current member, so
 * rows can drop it in unconditionally; it subscribes by id (a stable object), nothing else re-renders it.
 */
export function FormerChip({ workspaceId, userId, className }: { workspaceId: string | null | undefined; userId: string; className?: string }): ReactNode {
  const info = useFormerInfo(workspaceId, userId);
  if (!info) return null;
  return <FormerChipView leftAt={info.leftAt} className={className} />;
}

export function FormerChipView({ leftAt, className }: { leftAt: number; className?: string | undefined }): ReactNode {
  return (
    <span
      data-former-chip
      title={leftAt ? t('former.since', { date: new Date(leftAt).toLocaleDateString() }) : t('former.chip')}
      className={cx('inline-flex h-4 shrink-0 items-center rounded-[4px] border border-line px-1 text-[11px] font-medium leading-none text-muted', className)}
    >
      {t('former.chip')}
    </span>
  );
}

/**
 * «БОТ» next to a bot's name (ADR-0031, docs/08 «Боты»): a neutral pill, 10/600 upper case —
 * smaller and quieter than «Гость», it labels an account type, not a role. `inherit` keeps the
 * surrounding text colour (a selected row on the accent fill).
 */
export function BotBadge({ className, tone = 'neutral' }: { className?: string; tone?: 'neutral' | 'inherit' }): ReactNode {
  return (
    <span
      data-bot-badge
      className={cx(
        'inline-flex h-[15px] shrink-0 items-center rounded-full px-1.5 text-[10px] font-semibold uppercase leading-none tracking-[0.04em]',
        tone === 'inherit' ? 'bg-[rgb(255_255_255/22%)] text-current' : 'bg-hover text-fg',
        className,
      )}
    >
      {t('bots.badge')}
    </span>
  );
}

/**
 * How a role mark / name is coloured: `role` = the role token (default), `muted` = secondary
 * (offline rows), `inherit` = the surrounding text colour (a selected row on the accent fill).
 */
export type RoleTone = 'role' | 'muted' | 'inherit';

/**
 * Name colour per role (docs/09 #26; tokens --color-role-*, ≥ 4.5:1 on the sidebar incl. hover
 * and on the light cards): owner gold, admin accent, everyone else the plain label colour.
 */
export function roleTextClass(role: WorkspaceRole | undefined, tone: RoleTone = 'role', custom?: RoleLook): string {
  if (tone === 'muted') return 'text-muted';
  if (tone === 'inherit') return '';
  if (role === WorkspaceRole.OWNER) return 'text-role-owner';
  if (role === WorkspaceRole.ADMIN) return 'text-role-admin';
  // A custom role's colour comes inline (roleTextStyle).
  if (custom?.color) return '';
  return 'text-fg';
}

const BUILTIN_NAME: Record<WorkspaceRole, MessageKey> = {
  [WorkspaceRole.UNSPECIFIED]: 'role.member',
  [WorkspaceRole.OWNER]: 'role.owner',
  [WorkspaceRole.ADMIN]: 'role.admin',
  [WorkspaceRole.MEMBER]: 'role.member',
  [WorkspaceRole.GUEST]: 'role.guest',
};

/** Shown name of a role: the localized one for the built-ins (their `name` is a key), else its own. */
export function roleName(r: Pick<Role, 'name' | 'builtin'>): string {
  return r.builtin === WorkspaceRole.UNSPECIFIED ? r.name : t(BUILTIN_NAME[r.builtin]);
}

/** A custom role as far as the look goes (ADR-0026): its name (tooltip) and 0xRRGGBB colour. */
export type RoleLook = Pick<Role, 'name' | 'color'>;

/**
 * Inline name colour of a custom role (lib/roles customLook: the member's most senior coloured
 * role, never for owner / admins — the caller passes `custom` only then); `undefined` otherwise.
 */
export function roleTextStyle(role: WorkspaceRole | undefined, tone: RoleTone = 'role', custom?: RoleLook): CSSProperties | undefined {
  if (tone !== 'role' || hasRoleMark(role) || !custom?.color) return undefined;
  return { color: roleColorCss(custom.color) };
}

/** Owner and admins carry a mark; members and guests don't (the guest badge is separate). */
export const hasRoleMark = (role: WorkspaceRole | undefined): boolean => role === WorkspaceRole.OWNER || role === WorkspaceRole.ADMIN;

/**
 * What follows a member's name (owner, 29.09, docs/08 «Бейдж заменяет цветную метку роли»): the
 * badge replaces the role mark (never both); no badge — the role mark (crown / shield / custom
 * dot) or nothing. The name keeps its role colour either way.
 */
export function nameMarkKind(hasBadge: boolean, role: WorkspaceRole | undefined, custom?: RoleLook): 'badge' | 'role' | null {
  if (hasBadge) return 'badge';
  return hasRoleMark(role) || custom ? 'role' : null;
}

/**
 * The one role mark next to a name (docs/09 #26, docs/08 «Роли в списках»): a crown for the
 * owner, a 14 px shield for admins, in the role colour; the tooltip (and accessible name) is the
 * role — «Владелец» / «Администратор» — or `label` when the context needs more (the DM header
 * names the workspace). A custom role (ADR-0026, `custom`) — an 8 px dot in its colour, the
 * role name in the tooltip. The speaking ring lives on the avatar, the role on the name: no clash.
 */
export function RoleMark({
  role,
  custom,
  tone = 'role',
  label,
  className,
}: {
  role: WorkspaceRole | undefined;
  custom?: RoleLook | undefined;
  tone?: RoleTone;
  label?: string;
  className?: string;
}): ReactNode {
  if (!hasRoleMark(role)) {
    if (!custom) return null;
    const name = label ?? custom.name;
    return (
      <span role="img" aria-label={name} title={name} data-role-mark="custom" className={cx('inline-grid size-3.5 shrink-0 place-items-center', className)}>
        <span
          className={cx('size-2 rounded-full', tone === 'muted' && 'opacity-60', tone === 'inherit' && 'ring-1 ring-current')}
          style={{ background: custom.color ? roleColorCss(custom.color) : 'var(--color-label-tertiary)' }}
        />
      </span>
    );
  }
  const owner = role === WorkspaceRole.OWNER;
  const Icon = owner ? Crown : ShieldCheck;
  const title = label ?? t(owner ? 'role.owner' : 'role.admin');
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-role-mark={owner ? 'owner' : 'admin'}
      className={cx('inline-flex shrink-0', roleTextClass(role, tone), className)}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

/**
 * The DM peer's most senior role among the workspaces we share (a DM has no workspace of its
 * own, ADR-0020): owner before admin; `null` when they are neither anywhere. Selectors return
 * primitives only (zustand re-renders on a new object every time).
 */
export function useSharedRole(userId: string): { role: WorkspaceRole; workspace: string } | null {
  const wsId = useWorkspaces((s) => {
    let best = '';
    let rank = 2;
    for (const [id, e] of Object.entries(s.byId)) {
      const r = e.members[userId]?.role;
      const k = r === WorkspaceRole.OWNER ? 0 : r === WorkspaceRole.ADMIN ? 1 : 2;
      if (k < rank) {
        rank = k;
        best = id;
      }
    }
    return best;
  });
  const role = useWorkspaces((s) => (wsId ? s.byId[wsId]?.members[userId]?.role : undefined));
  const workspace = useWorkspaces((s) => (wsId ? (s.byId[wsId]?.ws.name ?? '') : ''));
  return role !== undefined && hasRoleMark(role) ? { role, workspace } : null;
}
