import { ChevronDown, MessageCirclePlus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { CreateButton } from '../../components/CreateButton';
import { Button, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useMobile } from '../../lib/mobile';
import { HOME, splitDms, useDms, type DmEntry } from '../../stores/dms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { NotesSection } from '../notes/NotesSection';
import { ColumnHeader, ColumnTitle, GROUP_LABEL, GroupChevron } from '../shell/ColumnHeader';
import { DmRow } from './DmRow';
import { DmSearch } from './DmSearch';

/**
 * «Личные» column (ADR-0020, Discord Home): the message search on top (CBF-159), then the DMs by
 * last activity — avatar with presence, name, the last message and its time, the unread count —
 * and at the bottom the collapsed «Архив — N» (docs/09 #51). Same material, width and island
 * padding as the room column (docs/08, Layout).
 */
export function DmSidebar(): ReactNode {
  const byRoom = useDms((s) => s.byRoom);
  const preview = useDms((s) => s.preview);
  const current = useUi((s) => (s.activeWorkspaceId === HOME ? (s.lastRoom[HOME] ?? '') : ''));
  const { main: list, archived } = useMemo(() => splitDms(byRoom, preview, current), [byRoom, preview, current]);
  const open = useUi((s) => s.openDialog);
  const guest = useSession((s) => s.me?.user?.isGuest ?? false);
  const mobile = useMobile();
  const [searching, setSearching] = useState(false);

  return (
    <aside className={cx('island-fade flex w-[var(--sidebar-width)] shrink-0 flex-col', mobile ? 'mat-content' : 'mat-sidebar mat-sidebar-window')} aria-label={t('dm.list')}>
      {/* Desktop (ADR-0074 §3; owner 07.10): the column header pattern — «Личные» large and «+». */}
      {mobile ? null : (
        <ColumnHeader title={<ColumnTitle>{t('mobile.tabDms')}</ColumnTitle>}>
          <CreateButton label={t('dm.new')} data-testid="section-create-dm" onClick={() => open({ kind: 'new-dm' })} />
        </ColumnHeader>
      )}
      {/* CBF-159: the search field above the list (phone: the tab root has its title and «+»); a query replaces the list. */}
      <DmSearch onActive={setSearching} />
      <div className={cx('min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pt-1 mobile:px-0 mobile:pt-2', searching && 'hidden')} style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}>
        {/* «Заметки» (ADR-0039): my shelves above the DMs; guest accounts have none. */}
        {guest ? null : <NotesSection />}
        <div className="group/cat flex h-9 items-center pr-1 pt-2 mobile:h-11 mobile:pr-0 mobile:pt-0">
          <h2 className={cx('min-w-0 flex-1 truncate pl-2 mobile:pl-3', GROUP_LABEL)}>{t('dm.list')}</h2>
        </div>
        {list.length === 0 && archived.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 py-8 text-center text-body text-muted" data-testid="dm-empty">
            <p>{t('dm.empty')}</p>
            <p className="text-caption">{t('dm.emptyHint')}</p>
            <Button size="sm" onClick={() => open({ kind: 'new-dm' })}>
              <MessageCirclePlus className="size-3.5" aria-hidden /> {t('dm.new')}
            </Button>
          </div>
        ) : (
          <ul className="mt-0.5 flex flex-col gap-px mobile:mt-0 mobile:gap-0" data-testid="dm-list">
            {list.map((e) => (
              <DmRow key={e.roomId} entry={e} />
            ))}
          </ul>
        )}
        {archived.length > 0 ? <ArchiveSection list={archived} /> : null}
      </div>
    </aside>
  );
}

/** «Архив — N» (docs/09 #51): collapsed by default; a DM returns by its menu or a new message. */
function ArchiveSection({ list }: { list: DmEntry[] }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const mobile = useMobile();
  const label = t('dm.archiveSection', { n: list.length });
  return (
    <section className="mt-2" aria-label={label} data-testid="dm-archive">
      <div className="group/cat flex h-9 items-center pr-1 pt-2 mobile:h-11 mobile:pt-0">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className={cx(
            'flex h-7 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-row)] pl-2 text-left transition-colors duration-[var(--motion-fast)] hover:text-fg mobile:h-11 mobile:pl-3',
            GROUP_LABEL,
          )}
        >
          {mobile ? (
            <ChevronDown className={cx('size-3 shrink-0 transition-transform duration-[var(--motion-fast)]', !expanded && '-rotate-90')} strokeWidth={2.25} aria-hidden />
          ) : null}
          <span className="truncate">{label}</span>
          {mobile ? null : <GroupChevron collapsed={!expanded} />}
        </button>
      </div>
      {expanded ? (
        <ul className="mt-0.5 flex flex-col gap-px mobile:mt-0 mobile:gap-0" data-testid="dm-archive-list">
          {list.map((e) => (
            <DmRow key={e.roomId} entry={e} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

