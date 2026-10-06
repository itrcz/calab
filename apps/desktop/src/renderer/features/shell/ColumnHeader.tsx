import { ChevronDown, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useHotkeyLabel } from '../../services/hotkeys';
import { useUi } from '../../stores/ui';

/**
 * The desktop sidebar column's header (docs/08 «Колонка», owner 07.10, Codex reference): one 48 px
 * row without a divider — the large title (the workspace switcher, or «Личные») on the left, quiet
 * icons and the section's accent «+» on the right. The same row on every section (Чаты, Личные,
 * Календарь, Доски); the phone keeps its own headers.
 */
export function ColumnHeader({ title, children }: { title: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <div className="flex h-12 shrink-0 items-center gap-0.5 pl-2 pr-2" data-testid="section-header">
      <div className="flex min-w-0 flex-1 items-center">{title}</div>
      <ColumnSearch />
      {children}
    </div>
  );
}

/** A plain large title (a section with no workspace switcher, e.g. «Личные»). */
export function ColumnTitle({ children }: { children: ReactNode }): ReactNode {
  return <h2 className="min-w-0 truncate px-2 text-[17px] font-semibold leading-[22px] tracking-[-0.01em] text-fg">{children}</h2>;
}

/** The quiet search icon: the same quick switcher as ⌘K and the title bar's pill. */
function ColumnSearch(): ReactNode {
  const keys = useHotkeyLabel('search');
  return (
    <IconButton label={t('shell.search')} shortcut={keys} onClick={() => useUi.getState().openDialog({ kind: 'quick-switcher' })} data-testid="column-search">
      <Search className="size-[18px]" strokeWidth={1.75} aria-hidden />
    </IconButton>
  );
}

/**
 * Group header of a sidebar list (owner, 07.10): normal-case muted text — «Разработка»,
 * «Голосовые» — no uppercase, no letter-spacing. The phone keeps its uppercase caption.
 */
export const GROUP_LABEL =
  'text-[13px] font-medium leading-[18px] text-muted mobile:text-micro mobile:font-semibold mobile:uppercase mobile:tracking-[0.04em] mobile:leading-[14px]';

/** Sidebar row plates (owner, 07.10): selected — a soft grey plate; hover — a fainter one. */
export const ROW_SELECTED = 'bg-active';
export const ROW_HOVER = 'hover:bg-row-hover mobile:hover:bg-hover';

/**
 * The group's chevron after its name (owner, 07.10, Codex reference): shown on hover / focus of the
 * header; always while the group is collapsed, so a folded group still reads as one.
 */
export function GroupChevron({ collapsed, className }: { collapsed: boolean; className?: string }): ReactNode {
  return (
    <ChevronDown
      className={cx(
        'size-3.5 shrink-0 transition-[transform,opacity] duration-[var(--motion-fast)]',
        collapsed ? '-rotate-90 opacity-100' : 'opacity-0 group-hover/cat:opacity-100 group-focus-within/cat:opacity-100',
        className,
      )}
      strokeWidth={2}
      aria-hidden
    />
  );
}
