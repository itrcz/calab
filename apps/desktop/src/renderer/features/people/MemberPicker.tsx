import { WorkspaceRole } from '@calaba/protocol';
import { AtSign, Crown, ShieldCheck, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { PickerPopover, type PickerPanelProps } from '../../components/picker/Picker';
import { cx } from '../../components/ui';
import { roleColorCss } from '../../lib/roles';
import { GuestBadge, RoleMark, roleTextClass, roleTextStyle } from './MemberBits';
import type { MemberPickItem, PeoplePickItem, RolePickItem } from './memberPickItems';

/**
 * A member row of the picker (docs/08 «Выбор участника»): 24 px avatar with presence, the name
 * in the role colour, nickname / email muted, the role mark, «Гость» pill, an optional note.
 * On the active (accent) row every colour follows the row's text.
 */
export function MemberPickRow({ item, active, trailing }: { item: MemberPickItem; active: boolean; trailing?: ReactNode }): ReactNode {
  const tone = active ? 'inherit' : 'role';
  return (
    <>
      <Avatar
        userId={item.userId}
        name={item.name}
        {...(item.avatarFileId ? { fileId: item.avatarFileId } : {})}
        size={24}
        presence
        ring={active ? 'var(--color-accent-strong)' : 'var(--color-popover-solid)'}
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={cx('min-w-0 shrink truncate font-medium', roleTextClass(item.role, tone, item.custom))} style={roleTextStyle(item.role, tone, item.custom)} title={item.name}>
          {item.name}
        </span>
        <RoleMark role={item.role} custom={item.custom} tone={tone} />
        {item.guest ? <GuestBadge /> : null}
        {item.secondary ? (
          <span className={cx('min-w-0 shrink-[2] truncate text-caption', active ? 'opacity-75' : 'text-muted')} title={item.secondary}>
            {item.secondary}
          </span>
        ) : null}
      </span>
      {item.note ? <span className={cx('shrink-0 text-caption', active ? 'opacity-75' : 'text-muted')}>{item.note}</span> : null}
      {trailing}
    </>
  );
}

/** Icon of a role target: crown / shield for the owner and admins, a colour dot for a custom role, @ for the others. */
function RoleGlyph({ role, color }: { role: WorkspaceRole; color: number }): ReactNode {
  if (role === WorkspaceRole.UNSPECIFIED) {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-fill)]" aria-hidden>
        <span className="size-2.5 rounded-full" style={{ background: color ? roleColorCss(color) : 'var(--color-label-tertiary)' }} />
      </span>
    );
  }
  const Icon = role === WorkspaceRole.OWNER ? Crown : role === WorkspaceRole.ADMIN ? ShieldCheck : role === WorkspaceRole.GUEST ? UserRound : AtSign;
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-fill)]" aria-hidden>
      <Icon className="size-3.5" />
    </span>
  );
}

export function RolePickRow({ item, active }: { item: RolePickItem; active: boolean }): ReactNode {
  return (
    <>
      <RoleGlyph role={item.role} color={item.color} />
      <span className={cx('min-w-0 flex-1 truncate font-medium', roleTextClass(item.role, active ? 'inherit' : 'role'))}>@{item.label}</span>
      {item.note ? <span className={cx('shrink-0 text-caption', active ? 'opacity-75' : 'text-muted')}>{item.note}</span> : null}
    </>
  );
}

export function PeoplePickRow({ item, active }: { item: PeoplePickItem; active: boolean }): ReactNode {
  return item.kind === 'role' ? <RolePickRow item={item} active={active} /> : <MemberPickRow item={item} active={active} />;
}

/**
 * «Добавить роль или участника», «Пригласить»…: the member picker as a popover (a centred card on
 * the phone layout) over its trigger. Groups «Роли» / «Участники» come from the caller.
 */
export function MemberPicker({
  children,
  ...rest
}: Omit<PickerPanelProps<PeoplePickItem>, 'renderItem'> & {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width?: number;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  restoreFocus?: 'always' | 'keyboard';
}): ReactNode {
  return (
    <PickerPopover<PeoplePickItem> {...rest} renderItem={(item, active) => <PeoplePickRow item={item} active={active} />}>
      {children}
    </PickerPopover>
  );
}
