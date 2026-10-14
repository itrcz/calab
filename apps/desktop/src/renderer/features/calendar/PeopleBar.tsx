import { WorkspaceRole } from '@calaba/protocol';
import { Plus, X } from 'lucide-react';
import { memo, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { ProfileTarget } from '../../components/ProfileTarget';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { MAX_PEOPLE, personColor } from '../../lib/calendar/people';
import { myUserId } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { memberItems } from '../people/memberPickItems';
import { MemberPicker } from '../people/MemberPicker';
import { dragKind, dragPayload } from './dragState';

/**
 * The people chips of the day view's «Люди» filter and of «Подобрать время» (ADR-0041 §3): avatar
 * chips ringed with each person's column colour, «+ Люди» (member picker with search, ≤ 20), «×»
 * clears; a member dragged from the members list onto the bar is added (owner: d&d everywhere).
 */
export function PeopleBar({
  workspaceId,
  people,
  onAdd,
  onRemove,
  onClear,
  wrap = false,
  max = MAX_PEOPLE,
  testId,
}: {
  workspaceId: string;
  people: readonly string[];
  onAdd: (ids: readonly string[]) => void;
  onRemove: (id: string) => void;
  onClear?: (() => void) | undefined;
  /** Chips wrap to more lines (a sheet, the find-a-time panel) instead of scrolling sideways. */
  wrap?: boolean;
  /** At most this many people (the calendar's filter: 20; a temporary room's access: 50). */
  max?: number;
  testId: string;
}): ReactNode {
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const [picking, setPicking] = useState(false);
  const [over, setOver] = useState(false);
  const groups = useMemo(() => {
    const list = Object.values(members ?? {}).filter((m) => m.user && !m.user.isBot && m.role !== WorkspaceRole.GUEST);
    return [{ id: 'members', label: '', items: memberItems(list, { exclude: new Set(people), ...(roles ? { roles } : {}) }) }];
  }, [members, roles, people]);

  const add = (id: string): void => {
    if (people.includes(id)) return;
    if (people.length >= max) {
      toast.info(t('fb.maxPeople', { n: max }));
      return;
    }
    onAdd([id]);
  };

  return (
    <div
      className={cx('flex min-w-0 flex-1 items-center gap-2 rounded-full', over && 'outline outline-2 outline-offset-2 outline-accent')}
      onDragOver={(e: DragEvent) => {
        if (dragKind(e.dataTransfer) !== 'user') return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        setOver(false);
        const p = dragPayload(e.dataTransfer);
        if (!p?.userId) return;
        e.preventDefault();
        const m = members?.[p.userId];
        if (m && !m.user?.isBot && m.role !== WorkspaceRole.GUEST) add(p.userId);
      }}
      data-testid={testId}
    >
      {/* The row may scroll sideways: 4 px of room inside it keep a keyboard focus ring whole. */}
      <ul aria-label={t('fb.people')} className={cx('-m-1 flex min-w-0 items-center gap-2 p-1', wrap ? 'flex-wrap' : 'scrollbar-none overflow-x-auto')}>
        {people.map((id, i) => (
          <PersonChip key={id} workspaceId={workspaceId} userId={id} color={personColor(i)} onRemove={onRemove} />
        ))}
        <li className="shrink-0">
          <MemberPicker open={picking} onOpenChange={setPicking} restoreFocus="keyboard" groups={groups} onSelect={(it) => it.kind === 'member' && add(it.userId)} placeholder={t('picker.searchPeople')} label={t('fb.addPeople')} testId={`${testId}-picker`}>
            {/* A ghost chip: the same 28 px pill as the people, dashed. */}
            <button
              type="button"
              data-testid={`${testId}-add`}
              className="flex h-7 items-center gap-1 rounded-full border border-dashed border-[var(--color-label-tertiary)] pl-2 pr-2.5 text-caption font-medium text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg"
            >
              <Plus className="size-3.5" aria-hidden />
              {people.length ? t('fb.addShort') : t('fb.addPeople')}
            </button>
          </MemberPicker>
        </li>
      </ul>
      {people.length === 0 ? <span className="hidden min-w-0 truncate text-caption text-faint min-[1100px]:inline">{t('fb.dropHint')}</span> : null}
      {people.length && onClear ? (
        <IconButton label={t('fb.clear')} size="sm" onClick={onClear} data-testid={`${testId}-clear`} className="ml-auto">
          <X className="size-4" />
        </IconButton>
      ) : null}
    </div>
  );
}

/** One person: avatar 20 in their colour's ring, the name (me: «Вы»), «×». */
const PersonChip = memo(function PersonChip({ workspaceId, userId, color, onRemove }: { workspaceId: string; userId: string; color: string; onRemove: (id: string) => void }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const avatar = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.user?.avatarFileId ?? '');
  const label = userId === myUserId() ? t('fb.me') : name;
  return (
    <li className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-[var(--color-fill)] pl-1 pr-0.5 text-caption" data-testid="person-chip" data-user={userId}>
      {/* Avatar 20 with its column colour as a 2 px ring. */}
      <ProfileTarget userId={userId} name={name} workspaceId={workspaceId} tabbable className="flex items-center rounded-full text-left">
        <span className="grid size-5 place-items-center rounded-full" style={{ boxShadow: `0 0 0 2px ${color}` }}>
          <Avatar userId={userId} name={name} {...(avatar ? { fileId: avatar } : {})} size={20} />
        </span>
        <span className="max-w-32 truncate pl-1 text-fg" title={name}>
          {label}
        </span>
      </ProfileTarget>
      <button type="button" onClick={() => onRemove(userId)} aria-label={t('fb.remove', { name })} className="grid size-6 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
});
