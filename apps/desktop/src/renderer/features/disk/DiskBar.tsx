import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useDroppable } from '@dnd-kit/core';
import { ArrowUpDown, Check, ChevronRight, Ellipsis, FolderPlus, Gauge, History, Search, Settings2, Trash2, Upload } from 'lucide-react';
import { memo, useRef, type ReactNode } from 'react';
import { Bar, BAR_GROUP } from '../../components/Bar';
import { CreateButton } from '../../components/CreateButton';
import { Button, IconButton, Input, Segmented, cx } from '../../components/ui';
import { t } from '../../i18n';
import { crumbs, DISK_SORTS, ROOT, type Crumb, type DiskSort, type DiskView } from '../../lib/disk';
import { createFolder, emptyTrash, uploadFiles } from '../../services/disk';
import { useDisk } from '../../stores/disk';
import { useDiskUi } from '../../stores/diskUi';
import { usePrefs } from '../../stores/prefs';
import { useUi } from '../../stores/ui';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';

/**
 * The disk's header (docs/08 «Шапки», ADR-0094 §8): crumbs of the open folder (each a drop target
 * for dragged items) · the search of the open folder · «Плитки | Список» · the sort · «+» (Папка,
 * Загрузить файлы) · «⋯» (Корзина, История диска, Место, Настройки корзины). In the trash: the
 * crumbs «Диск › Корзина» and «Очистить корзину». Reads primitives only.
 */
const SORT_LABEL: Record<DiskSort, 'disk.sort.name' | 'disk.sort.updated' | 'disk.sort.size'> = {
  name: 'disk.sort.name',
  updated: 'disk.sort.updated',
  size: 'disk.sort.size',
};

export function DiskBar({ workspaceId, folderId, trash, write, manage }: { workspaceId: string; folderId: string; trash: boolean; write: boolean; manage: boolean }): ReactNode {
  return (
    <Bar plain className="gap-2 pl-3 pr-3" data-testid="disk-bar">
      <Crumbs workspaceId={workspaceId} folderId={folderId} trash={trash} />
      <span className="flex-1" />
      <SearchBox />
      {trash ? null : <ViewSwitch />}
      {trash ? null : <SortMenu />}
      <span className={BAR_GROUP}>
        {trash ? (
          write ? (
            <Button variant="destructive" onClick={() => void emptyTrash(workspaceId)} data-testid="disk-empty-trash">
              {t('disk.emptyTrash')}
            </Button>
          ) : null
        ) : write ? (
          <CreateMenu workspaceId={workspaceId} folderId={folderId} />
        ) : null}
        <MoreMenu workspaceId={workspaceId} trash={trash} manage={manage} />
      </span>
    </Bar>
  );
}

// ---------------------------------------------------------------- crumbs

const Crumbs = memo(function Crumbs({ workspaceId, folderId, trash }: { workspaceId: string; folderId: string; trash: boolean }): ReactNode {
  const path = useDisk((s) => (folderId ? s.paths[folderId] : undefined));
  const all = trash ? [{ id: ROOT, name: t('disk.section') }] : crumbs(t('disk.section'), path ?? []);
  // Deep paths fold the middle: the root, «…», the last two.
  const shown: Array<Crumb | null> = all.length > 4 ? [all[0] ?? null, null, ...all.slice(-2)] : all;
  return (
    <nav aria-label={t('disk.path')} className="flex min-w-0 items-center gap-0.5" data-testid="disk-crumbs">
      {shown.map((c, i) => {
        const last = !trash && i === shown.length - 1;
        return (
          <span key={c ? c.id || 'root' : 'gap'} className="flex min-w-0 items-center gap-0.5">
            {i > 0 ? <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden /> : null}
            {c === null ? <span className="px-1 text-muted">…</span> : <CrumbButton workspaceId={workspaceId} crumb={c} current={last} />}
          </span>
        );
      })}
      {trash ? (
        <span className="flex min-w-0 items-center gap-0.5">
          <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
          <h1 className="truncate px-1.5 text-headline font-semibold">{t('disk.trash')}</h1>
        </span>
      ) : null}
    </nav>
  );
});

function CrumbButton({ workspaceId, crumb, current }: { workspaceId: string; crumb: Crumb; current: boolean }): ReactNode {
  const { setNodeRef, isOver } = useDroppable({ id: `crumb:${crumb.id || 'root'}`, disabled: current, data: { folderId: crumb.id } });
  if (current) {
    return (
      <h1 className="min-w-0 truncate px-1.5 text-headline font-semibold" title={crumb.name} aria-current="page">
        {crumb.name}
      </h1>
    );
  }
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={() => useDiskUi.getState().openFolder(workspaceId, crumb.id)}
      className={cx('h-8 min-w-0 truncate rounded-[var(--radius-bar)] px-1.5 text-headline font-semibold text-muted hover:bg-hover hover:text-fg', isOver && 'bg-hover text-fg ring-2 ring-accent')}
      title={crumb.name}
      data-testid="disk-crumb"
    >
      {crumb.name}
    </button>
  );
}

// ---------------------------------------------------------------- controls

function SearchBox(): ReactNode {
  const query = useDiskUi((s) => s.query);
  return (
    <span className="w-44 shrink">
      <Input
        type="search"
        icon={<Search className="size-3.5" aria-hidden />}
        value={query}
        onChange={(e) => useDiskUi.getState().setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.stopPropagation();
            useDiskUi.getState().setQuery('');
          }
        }}
        placeholder={t('disk.search')}
        aria-label={t('disk.search')}
        className="h-8 rounded-full"
        data-testid="disk-search"
      />
    </span>
  );
}

function ViewSwitch(): ReactNode {
  const view = usePrefs((s) => s.diskView);
  return (
    <Segmented<DiskView>
      value={view}
      label={t('disk.view')}
      options={[
        { value: 'tiles', label: t('disk.view.tiles') },
        { value: 'list', label: t('disk.view.list') },
      ]}
      onChange={(diskView) => usePrefs.getState().setPrefs({ diskView })}
      testId="disk-view"
    />
  );
}

function SortMenu(): ReactNode {
  const sort = usePrefs((s) => s.diskSort);
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton label={t('disk.sortBy', { by: t(SORT_LABEL[sort]) })} data-testid="disk-sort">
          <ArrowUpDown className="size-4" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={menuBox} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()}>
          <Dropdown.Label className={menuLabel}>{t('disk.sort')}</Dropdown.Label>
          <Dropdown.RadioGroup value={sort} onValueChange={(v) => usePrefs.getState().setPrefs({ diskSort: v as DiskSort })}>
            {DISK_SORTS.map((s) => (
              <Dropdown.RadioItem key={s} value={s} className={menuItem}>
                <span className="min-w-0 flex-1">{t(SORT_LABEL[s])}</span>
                {s === sort ? <Check className="size-4 shrink-0" aria-hidden /> : null}
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function CreateMenu({ workspaceId, folderId }: { workspaceId: string; folderId: string }): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <CreateButton label={t('disk.create')} data-testid="disk-create" />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={menuBox} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="disk-create-menu">
            <Dropdown.Item className={menuItem} onSelect={() => void createFolder(workspaceId, folderId)} data-testid="disk-new-folder">
              <FolderPlus className="size-4" strokeWidth={1.75} aria-hidden />
              {t('disk.newFolder')}
            </Dropdown.Item>
            <Dropdown.Item className={menuItem} onSelect={() => input.current?.click()} data-testid="disk-upload">
              <Upload className="size-4" strokeWidth={1.75} aria-hidden />
              {t('disk.upload')}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) uploadFiles(workspaceId, folderId, files);
        }}
        data-testid="disk-file-input"
      />
    </>
  );
}

function MoreMenu({ workspaceId, trash, manage }: { workspaceId: string; trash: boolean; manage: boolean }): ReactNode {
  const ui = useDiskUi.getState;
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton label={t('disk.moreMenu')} data-testid="disk-more">
          <Ellipsis className="size-4" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'min-w-56')} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="disk-more-menu">
          <Dropdown.Item className={menuItem} onSelect={() => ui().openTrash(workspaceId, !trash)} data-testid="disk-open-trash">
            <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
            {trash ? t('disk.backToDisk') : t('disk.trash')}
          </Dropdown.Item>
          {manage ? (
            <Dropdown.Item className={menuItem} onSelect={() => ui().openDialog({ kind: 'disk-history', wsId: workspaceId })} data-testid="disk-open-history">
              <History className="size-4" strokeWidth={1.75} aria-hidden />
              {t('disk.diskHistory')}
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item className={menuItem} onSelect={() => ui().openDialog({ kind: 'usage', wsId: workspaceId })} data-testid="disk-open-usage">
            <Gauge className="size-4" strokeWidth={1.75} aria-hidden />
            {t('disk.usage.title')}
          </Dropdown.Item>
          {manage ? (
            <>
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Item className={menuItem} onSelect={() => useUi.getState().openDialog({ kind: 'workspace-settings', workspaceId, tab: 'disk' })} data-testid="disk-open-settings">
                <Settings2 className="size-4" strokeWidth={1.75} aria-hidden />
                {t('disk.trashSettings')}
              </Dropdown.Item>
            </>
          ) : null}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
