import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { timestampDate, timestampMs } from '@bufbuild/protobuf/wkt';
import { WorkspaceRole, wikiPermissions } from '@calaba/protocol';
import { ChevronRight, Download, Ellipsis, FileText, FolderInput, History, Link2, Plus, RotateCcw, Search, Trash2, Users } from 'lucide-react';
import { memo, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { WikiIdleIcon } from '../../assets/nav/icons';
import { Bar, BAR_GROUP } from '../../components/Bar';
import { CreateButton } from '../../components/CreateButton';
import { MediaImg } from '../../components/MediaImg';
import { CreateSlot, HeaderIcon, PhoneHeader, PhoneSearchButton } from '../../components/PhoneHeader';
import { Button, IconButton, Input, Spinner, cx } from '../../components/ui';
import { plural, t, useLocale } from '../../i18n';
import { fmt } from '../../lib/format';
import { pushOnTab } from '../../lib/phoneNav';
import { haptics } from '../../lib/haptics';
import { canStructure, canWrite, childKey, filterPages, TOP, trashKey } from '../../lib/wiki/tree';
import { phoneBack } from '../../services/phoneNav';
import { createPage, deleteForever, emptyTrash, exportMarkdown, loadChildren, loadPage, loadTrash, openWikiPage, restorePage, searchPages, setCover, setIcon, trashPage } from '../../services/wiki';
import { myUserId } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useWiki } from '../../stores/wiki';
import { useWikiUi } from '../../stores/wikiUi';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { EmojiPicker } from '../chat/EmojiPicker';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { WikiDialogs } from './Dialogs';
import { WikiDocLazy } from './lazy';
import { TitleField } from './WikiPage';

/**
 * «Вики» on the phone (ADR-0096 §7, docs/08 «Вики: телефон»): the tab root lists the top-level
 * pages (56 px rows), a page and the trash are pushed screens (`{kind:'wiki'}`, lib/phoneNav.ts)
 * with the standard headers. The page screen carries the cover, icon, title, the document (the
 * desktop's lazy chunk, with the simplified toolbar above the keyboard) and the subpages; its «⋯»
 * is a centred card with the same actions as the desktop's, the dialogs are the desktop's. Only
 * the top screen is mounted, so leaving a page closes its sync socket. Rows are `memo` and read
 * their page by id; no timers.
 */

/** The wiki "section is on screen" flag the gateway events read (services/wiki.ts onScreen) while any wiki screen is mounted. */
function useWikiOnScreen(): void {
  useEffect(() => {
    useWikiUi.getState().setActive(true);
    return () => useWikiUi.getState().setActive(false);
  }, []);
}

const NONE: readonly string[] = [];

function useCanCreate(workspaceId: string): boolean {
  const roles = useMemberRoles(workspaceId, myUserId());
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  return canWrite(wikiPermissions(roles, { guest }));
}

// ---------------------------------------------------------------- the tab root

export function PhoneWiki({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  useWikiOnScreen();
  const canCreate = useCanCreate(workspaceId);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    void loadChildren(workspaceId, TOP);
    return () => useWikiUi.getState().setQuery('');
  }, [workspaceId]);
  const toggleSearch = (): void => {
    if (searching) useWikiUi.getState().setQuery('');
    setSearching((v) => !v);
  };
  return (
    <section className="mat-content relative flex min-h-0 flex-1 flex-col" aria-label={t('wiki.section')} data-testid="phone-wiki">
      <Bar>
        <HeaderIcon>
          <WikiIdleIcon className="size-5" />
        </HeaderIcon>
        <h1 className="min-w-0 flex-1 truncate text-headline font-semibold">{t('wiki.section')}</h1>
        {/* Standard order «⋯ · поиск · +» (docs/08): the magnifier and the «+» slot are at the same x as on every root. */}
        <div className={BAR_GROUP}>
          <RootMenu />
          <PhoneSearchButton onClick={toggleSearch} active={searching} label={t('wiki.search')} />
          {canCreate ? <CreateButton tip={false} label={t('wiki.newPage')} onClick={() => void createPage(workspaceId, '')} data-testid="phone-wiki-create" /> : <CreateSlot />}
        </div>
      </Bar>
      {searching ? <SearchField onClose={() => setSearching(false)} /> : null}
      <RootList workspaceId={workspaceId} canCreate={canCreate} />
    </section>
  );
}

function RootMenu(): ReactNode {
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton tip={false} bar label={t('wiki.moreMenu')} data-testid="phone-wiki-more">
          <Ellipsis className="size-5" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'min-w-56')} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="phone-wiki-more-menu">
          <Dropdown.Item className={menuItem} onSelect={() => useUi.getState().setPhone((n) => pushOnTab(n, 'wiki', { kind: 'wiki', pageId: '', trash: true }))} data-testid="phone-wiki-open-trash">
            <Trash2 className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
            {t('wiki.trash')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function SearchField({ onClose }: { onClose: () => void }): ReactNode {
  const query = useWikiUi((s) => s.query);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="shrink-0 px-4 pb-2">
      <Input
        ref={ref}
        type="search"
        icon={<Search className="size-4" aria-hidden />}
        value={query}
        onChange={(e) => useWikiUi.getState().setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            useWikiUi.getState().setQuery('');
            onClose();
          }
        }}
        placeholder={t('wiki.search')}
        aria-label={t('wiki.search')}
        className="rounded-full"
        data-testid="phone-wiki-search-field"
      />
    </div>
  );
}

function RootList({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }): ReactNode {
  const key = childKey(workspaceId, TOP);
  const query = useWikiUi((s) => s.query);
  const ids = useWiki(useShallow((s) => s.lists[key] ?? NONE));
  const loaded = useWiki((s) => !!s.lists[key]);
  const failed = useWiki((s) => s.load[key] === 'error');
  const open = useCallback((id: string) => openWikiPage(workspaceId, id), [workspaceId]);
  const scroll = 'min-h-0 flex-1 overflow-y-auto overscroll-contain';
  if (query.trim()) return <SearchResults workspaceId={workspaceId} query={query} onOpen={open} />;
  if (!loaded) {
    return (
      <div className={cx(scroll, 'grid place-items-center')}>
        {failed ? (
          <div className="flex flex-col items-center gap-3 px-6 text-center text-body text-muted">
            <p>{t('wiki.phone.loadFailed')}</p>
            <Button variant="secondary" onClick={() => void loadChildren(workspaceId, TOP)}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }
  if (!ids.length) {
    return (
      <div className={cx(scroll, 'grid place-items-center')} data-testid="phone-wiki-empty">
        <div className="flex flex-col items-center gap-3 px-6 text-center text-body text-muted">
          <FileText className="size-10" strokeWidth={1.25} aria-hidden />
          <p className="font-medium text-fg">{t('wiki.emptyTree')}</p>
          {canCreate ? <Button onClick={() => void createPage(workspaceId, '')}>{t('wiki.newPage')}</Button> : null}
        </div>
      </div>
    );
  }
  return (
    <div className={scroll} data-testid="phone-wiki-area">
      <div role="list" aria-label={t('wiki.tree')} className="pb-6">
        {ids.map((id) => (
          <PageRow key={id} id={id} onOpen={open} />
        ))}
      </div>
    </div>
  );
}

/** A page row: icon · title · «изменено …» · «›» when it has subpages — 56 px, one target. */
const PageRow = memo(function PageRow({ id, onOpen }: { id: string; onOpen: (id: string) => void }): ReactNode {
  const title = useWiki((s) => s.pages[id]?.title ?? '');
  const icon = useWiki((s) => s.pages[id]?.icon ?? '');
  const updated = useWiki((s) => {
    const at = s.pages[id]?.updatedAt;
    return at ? timestampMs(at) : 0;
  });
  const kids = useWiki((s) => !!s.pages[id]?.hasChildren);
  const known = useWiki((s) => !!s.pages[id]);
  if (!known) return null;
  return (
    <div role="listitem" className="flex h-14 items-center pl-4 pr-3" data-testid="phone-wiki-row">
      <button type="button" onClick={() => onOpen(id)} className="tap-hit flex h-14 min-w-0 flex-1 items-center gap-3 text-left">
        <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-[var(--color-fill)] text-[22px] leading-none" aria-hidden>
          {icon || <FileText className="size-5 text-muted" strokeWidth={1.75} />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-list leading-5 text-fg">{title || t('wiki.untitled')}</span>
          {updated ? <span className="truncate text-caption leading-4 text-muted">{t('wiki.phone.updated', { when: fmt.relative(new Date(updated)) })}</span> : null}
        </span>
        {kids ? <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden /> : null}
      </button>
    </div>
  );
});

/** The filter: loaded pages whose title matches, then the server's hits (title and text) not shown yet. */
function SearchResults({ workspaceId, query, onOpen }: { workspaceId: string; query: string; onOpen: (id: string) => void }): ReactNode {
  const local = useWiki(useShallow((s) => filterPages(s.pages, workspaceId, query)));
  const [remote, setRemote] = useState<Array<{ id: string; title: string; icon: string }>>([]);
  const [busy, setBusy] = useState(false);
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      searchPages(workspaceId, q, ctl.signal).then(
        (r) => {
          setRemote(r);
          setBusy(false);
        },
        () => setBusy(false),
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [workspaceId, q]);
  const shown = new Set(local);
  const extra = q.length < 2 ? [] : remote.filter((r) => !shown.has(r.id));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6" role="list" aria-label={t('wiki.search')} data-testid="phone-wiki-search-results">
      {local.map((id) => (
        <PageRow key={id} id={id} onOpen={onOpen} />
      ))}
      {extra.map((r) => (
        <div key={r.id} role="listitem" className="flex h-14 items-center pl-4 pr-3" data-testid="phone-wiki-hit">
          <button type="button" onClick={() => onOpen(r.id)} className="tap-hit flex h-14 min-w-0 flex-1 items-center gap-3 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-[var(--color-fill)] text-[22px] leading-none" aria-hidden>
              {r.icon || <FileText className="size-5 text-muted" strokeWidth={1.75} />}
            </span>
            <span className="min-w-0 flex-1 truncate text-list leading-5 text-fg">{r.title || t('wiki.untitled')}</span>
          </button>
        </div>
      ))}
      {busy ? (
        <div className="grid h-12 place-items-center">
          <Spinner className="size-4" />
        </div>
      ) : !local.length && !extra.length ? (
        <p className="px-4 py-6 text-center text-body text-muted">{t('wiki.searchEmpty')}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- the page

export function PhoneWikiPage({ workspaceId, pageId }: { workspaceId: string; pageId: string }): ReactNode {
  useLocale();
  useWikiOnScreen();
  const known = useWiki((s) => !!s.pages[pageId]);
  const seen = useRef(false);
  useEffect(() => {
    useWikiUi.getState().openPage(workspaceId, pageId);
    void loadPage(workspaceId, pageId);
  }, [workspaceId, pageId]);
  // A page that is removed or hidden from me while open (gateway event, 404) closes its screen.
  useEffect(() => {
    if (known) seen.current = true;
    else if (seen.current) phoneBack();
  }, [known]);
  const trashed = useWiki((s) => !!s.pages[pageId]?.trashedAt);
  const write = useWiki((s) => canWrite(s.pages[pageId]?.myBits ?? 0n));
  const structure = useWiki((s) => {
    const p = s.pages[pageId];
    return !!p && canStructure(p, myUserId());
  });
  const editable = write && !trashed;
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <section className="mat-content relative flex min-h-0 flex-1 flex-col" aria-label={t('wiki.section')} data-testid="phone-wiki-page">
      <PageHeader workspaceId={workspaceId} pageId={pageId} structure={structure && !trashed} canAdd={editable} trashed={trashed} />
      {known ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="wiki-scroll">
          <PageBody workspaceId={workspaceId} pageId={pageId} editable={editable} setup={structure && !trashed} trashed={trashed} host={host} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center">
          <Spinner />
        </div>
      )}
      <div ref={setHost} className="shrink-0" />
      <WikiDialogs workspaceId={workspaceId} />
    </section>
  );
}

function PageHeader({ workspaceId, pageId, structure, canAdd, trashed }: { workspaceId: string; pageId: string; structure: boolean; canAdd: boolean; trashed: boolean }): ReactNode {
  const title = useWiki((s) => s.pages[pageId]?.title ?? '');
  const icon = useWiki((s) => s.pages[pageId]?.icon ?? '');
  const updated = useWiki((s) => {
    const at = s.pages[pageId]?.updatedAt;
    return at ? timestampMs(at) : 0;
  });
  const peers = useWikiUi((s) => s.peers);
  const subtitle = peers > 0 ? plural('wiki.phone.editors', peers) : updated ? t('wiki.phone.updated', { when: fmt.relative(new Date(updated)) }) : undefined;
  return (
    <PhoneHeader
      title={
        <>
          {icon ? <span aria-hidden>{icon} </span> : null}
          {title || t('wiki.untitled')}
        </>
      }
      {...(subtitle ? { subtitle } : {})}
    >
      {canAdd ? (
        <IconButton tip={false} bar label={t('wiki.addSubpage')} onClick={() => void createPage(workspaceId, pageId)} data-testid="phone-wiki-add-subpage">
          <Plus className="size-5" aria-hidden />
        </IconButton>
      ) : null}
      <PageMenu pageId={pageId} structure={structure} trashed={trashed} />
    </PhoneHeader>
  );
}

function PageMenu({ pageId, structure, trashed }: { pageId: string; structure: boolean; trashed: boolean }): ReactNode {
  const ui = useWikiUi.getState;
  const item = (Icon: typeof Users, label: string, run: () => void, testId: string, danger = false): ReactNode => (
    <Dropdown.Item className={cx(menuItem, danger && 'text-danger-text')} onSelect={run} data-testid={testId}>
      <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
      {label}
    </Dropdown.Item>
  );
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton tip={false} bar label={t('wiki.moreMenu')} data-testid="phone-wiki-page-more">
          <Ellipsis className="size-5" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'min-w-56')} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="phone-wiki-page-menu">
          {structure ? item(Users, t('wiki.access'), () => ui().openDialog({ kind: 'share', pageId, tab: 'access' }), 'wiki-open-access') : null}
          {structure ? item(Link2, t('wiki.link'), () => ui().openDialog({ kind: 'share', pageId, tab: 'link' }), 'wiki-open-link') : null}
          {item(History, t('wiki.versions'), () => ui().openDialog({ kind: 'versions', pageId }), 'wiki-open-versions')}
          {structure ? item(FolderInput, t('wiki.move'), () => ui().openDialog({ kind: 'move', pageId }), 'wiki-open-move') : null}
          {item(Download, t('wiki.export'), () => exportMarkdown(pageId), 'wiki-export')}
          {structure && !trashed ? (
            <>
              <Dropdown.Separator className={menuSeparator} />
              {item(
                Trash2,
                t('wiki.toTrash'),
                () => {
                  void trashPage(pageId).then(() => {
                    if (useWiki.getState().pages[pageId]?.trashedAt) phoneBack();
                  });
                },
                'wiki-trash-page',
                true,
              )}
            </>
          ) : null}
          {structure && trashed ? (
            <>
              <Dropdown.Separator className={menuSeparator} />
              {item(RotateCcw, t('wiki.restore'), () => void restorePage(pageId), 'wiki-restore-page')}
              {item(Trash2, t('wiki.deleteForever'), () => void deleteForever(pageId), 'wiki-delete-page', true)}
            </>
          ) : null}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function PageBody({ workspaceId, pageId, editable, setup, trashed, host }: { workspaceId: string; pageId: string; editable: boolean; setup: boolean; trashed: boolean; host: HTMLElement | null }): ReactNode {
  const coverId = useWiki((s) => s.pages[pageId]?.cover?.id ?? '');
  const icon = useWiki((s) => s.pages[pageId]?.icon ?? '');
  const coverInput = useRef<HTMLInputElement>(null);
  return (
    <article className="flex min-h-full flex-col pb-[calc(var(--safe-bottom,0px)+24px)]">
      {coverId ? (
        setup ? (
          <button type="button" onClick={() => coverInput.current?.click()} aria-label={t('wiki.cover.change')} className="block h-28 w-full shrink-0 overflow-hidden bg-[var(--color-fill)]" data-testid="wiki-cover">
            <MediaImg path={`/api/files/${coverId}`} alt="" className="size-full object-cover" decoding="async" />
          </button>
        ) : (
          <div className="h-28 w-full shrink-0 overflow-hidden bg-[var(--color-fill)]" data-testid="wiki-cover">
            <MediaImg path={`/api/files/${coverId}`} alt="" className="size-full object-cover" decoding="async" />
          </div>
        )
      ) : null}
      <div className="w-full px-4">
        {trashed ? (
          <div className="mt-4 flex items-center gap-2 rounded-[var(--radius-card)] bg-[color-mix(in_srgb,var(--color-red)_10%,transparent)] px-3 py-2 text-body" role="status" data-testid="wiki-trashed">
            <Trash2 className="size-4 shrink-0 text-danger-text" aria-hidden />
            <span className="min-w-0 flex-1">{t('wiki.inTrash')}</span>
          </div>
        ) : null}
        <div className={cx('flex flex-col', coverId ? (icon ? '-mt-6' : 'mt-4') : 'mt-4')}>
          {icon ? (
            setup ? (
              <EmojiPicker label={t('wiki.icon.change')} onPick={(e) => setIcon(pageId, e)} closeOnPick side="bottom">
                <button type="button" className="mb-1 grid size-14 place-items-center self-start rounded-[var(--radius-card)] text-[44px] leading-none" data-testid="wiki-icon">
                  {icon}
                </button>
              </EmojiPicker>
            ) : (
              <span className="mb-1 grid size-14 place-items-center text-[44px] leading-none" data-testid="wiki-icon">
                {icon}
              </span>
            )
          ) : null}
          {setup && (!icon || !coverId) ? (
            <div className="flex flex-wrap gap-x-4" data-testid="wiki-head-tools">
              {icon ? null : (
                <EmojiPicker label={t('wiki.icon.add')} onPick={(e) => setIcon(pageId, e)} closeOnPick side="bottom">
                  <button type="button" className="flex h-11 items-center text-caption text-muted" data-testid="wiki-icon-add">
                    {t('wiki.icon.add')}
                  </button>
                </EmojiPicker>
              )}
              {coverId ? null : (
                <button type="button" onClick={() => coverInput.current?.click()} className="flex h-11 items-center text-caption text-muted" data-testid="wiki-cover-add">
                  {t('wiki.cover.add')}
                </button>
              )}
            </div>
          ) : null}
          <TitleField pageId={pageId} editable={setup} className="!text-[26px] leading-8" />
        </div>
        <Suspense
          fallback={
            <div className="grid h-24 place-items-center">
              <Spinner />
            </div>
          }
        >
          <WikiDocLazy workspaceId={workspaceId} pageId={pageId} editable={editable} phone toolbarHost={host} />
        </Suspense>
        <PhoneSubpages workspaceId={workspaceId} pageId={pageId} canAdd={editable} />
      </div>
      <input
        ref={coverInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void setCover(pageId, f);
        }}
        data-testid="wiki-cover-input"
      />
    </article>
  );
}

/** The page's children at the bottom: rows as on the root, with «+ Подстраница». */
const PhoneSubpages = memo(function PhoneSubpages({ workspaceId, pageId, canAdd }: { workspaceId: string; pageId: string; canAdd: boolean }): ReactNode {
  const key = childKey(workspaceId, pageId);
  const ids = useWiki(useShallow((s) => s.lists[key] ?? NONE));
  const hasChildren = useWiki((s) => !!s.pages[pageId]?.hasChildren);
  const loaded = useWiki((s) => !!s.lists[key]);
  useEffect(() => {
    if (hasChildren && !loaded) void loadChildren(workspaceId, pageId);
  }, [hasChildren, loaded, workspaceId, pageId]);
  const open = useCallback((id: string) => openWikiPage(workspaceId, id), [workspaceId]);
  if (!ids.length && !canAdd) return null;
  return (
    <section className="-mx-4 mt-8 flex flex-col border-t border-line pt-3" aria-label={t('wiki.subpages')} data-testid="wiki-subpages">
      <h2 className="px-4 text-caption font-semibold text-muted">{t('wiki.subpages')}</h2>
      <div role="list">
        {ids.map((id) => (
          <PageRow key={id} id={id} onOpen={open} />
        ))}
      </div>
      {canAdd ? (
        <button
          type="button"
          onClick={() => {
            haptics.tap();
            void createPage(workspaceId, pageId);
          }}
          className="flex h-12 items-center gap-3 px-4 text-body text-muted"
          data-testid="wiki-add-subpage"
        >
          <Plus className="size-5" aria-hidden />
          {t('wiki.addSubpage')}
        </button>
      ) : null}
    </section>
  );
});

// ---------------------------------------------------------------- the trash

export function PhoneWikiTrash({ workspaceId }: { workspaceId: string }): ReactNode {
  useLocale();
  useWikiOnScreen();
  const key = trashKey(workspaceId);
  const ids = useWiki(useShallow((s) => s.lists[key] ?? NONE));
  const loaded = useWiki((s) => !!s.lists[key]);
  useEffect(() => {
    void loadTrash(workspaceId);
  }, [workspaceId]);
  return (
    <section className="mat-content relative flex min-h-0 flex-1 flex-col" aria-label={t('wiki.trash')} data-testid="phone-wiki-trash">
      <PhoneHeader title={t('wiki.trash')}>
        {ids.length ? (
          <IconButton tip={false} bar label={t('wiki.emptyTrash')} onClick={() => void emptyTrash(workspaceId)} data-testid="phone-wiki-empty-trash">
            <Trash2 className="size-5" aria-hidden />
          </IconButton>
        ) : null}
      </PhoneHeader>
      {!loaded ? (
        <div className="grid min-h-0 flex-1 place-items-center">
          <Spinner />
        </div>
      ) : !ids.length ? (
        <div className="grid min-h-0 flex-1 place-items-center px-6 text-center text-body text-muted" data-testid="phone-wiki-trash-empty">
          {t('wiki.trashEmpty')}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6" role="list">
          {ids.map((id) => (
            <TrashRow key={id} id={id} />
          ))}
        </div>
      )}
    </section>
  );
}

const TrashRow = memo(function TrashRow({ id }: { id: string }): ReactNode {
  const title = useWiki((s) => s.pages[id]?.title ?? '');
  const icon = useWiki((s) => s.pages[id]?.icon ?? '');
  const at = useWiki((s) => s.pages[id]?.trashedAt);
  const structure = useWiki((s) => {
    const p = s.pages[id];
    return !!p && canStructure(p, myUserId());
  });
  const known = useWiki((s) => !!s.pages[id]);
  if (!known) return null;
  return (
    <div role="listitem" className="flex h-14 items-center gap-1 pl-4 pr-1" data-testid="phone-wiki-trash-row">
      <span className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-[var(--color-fill)] text-[22px] leading-none" aria-hidden>
        {icon || <FileText className="size-5 text-muted" strokeWidth={1.75} />}
      </span>
      <span className="ml-2 flex min-w-0 flex-1 flex-col">
        <span className="truncate text-list leading-5 text-fg">{title || t('wiki.untitled')}</span>
        {at ? <span className="truncate text-caption leading-4 text-muted">{t('wiki.trashedAt', { date: fmt.listTime(timestampDate(at)) })}</span> : null}
      </span>
      {structure ? (
        <>
          <IconButton tip={false} label={t('wiki.restore')} onClick={() => void restorePage(id)} data-testid="phone-wiki-restore">
            <RotateCcw className="size-5" aria-hidden />
          </IconButton>
          <IconButton tip={false} label={t('wiki.deleteForever')} onClick={() => void deleteForever(id)} className="text-danger-text" data-testid="phone-wiki-delete">
            <Trash2 className="size-5" aria-hidden />
          </IconButton>
        </>
      ) : null}
    </div>
  );
});
