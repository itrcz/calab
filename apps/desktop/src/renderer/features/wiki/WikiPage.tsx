import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ChevronRight, CloudOff, Download, Ellipsis, Eye, FileText, FolderInput, History, ImagePlus, Plus, RotateCcw, Share2, Smile, Trash2, Users, X } from 'lucide-react';
import { memo, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bar, BAR_GROUP } from '../../components/Bar';
import { MediaImg } from '../../components/MediaImg';
import { Button, IconButton, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { ancestorsOf, canStructure, canWrite, childKey } from '../../lib/wiki/tree';
import {
  createPage,
  deleteForever,
  exportMarkdown,
  loadChildren,
  openWikiPage,
  removeCover,
  renamePage,
  restorePage,
  setCover,
  setIcon,
  setTitleLocal,
  takeTitleFocus,
  trashPage,
} from '../../services/wiki';
import { myUserId, useSession } from '../../stores/session';
import { useWiki } from '../../stores/wiki';
import { useWikiUi } from '../../stores/wikiUi';
import { EmojiPicker } from '../chat/EmojiPicker';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { WikiDocLazy } from './lazy';

/**
 * The right side of «Вики» (ADR-0096 §9, docs/08 «Вики»): the header (crumbs · sync pill ·
 * «Поделиться» · «⋯») and the open page — cover, icon, title (PATCH with a 500 ms debounce; the
 * first H1 of the document stays independent), the meta line and the editor (lazy chunk), the
 * subpages at the bottom. Text column ≤ 760 px, centred. Only the open page mounts a document.
 */
export function WikiMain({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }): ReactNode {
  const pageId = useWikiUi((s) => s.pageOf[workspaceId] ?? '');
  const known = useWiki((s) => !!s.pages[pageId]);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <WikiBar workspaceId={workspaceId} pageId={known ? pageId : ''} />
      <div className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto" data-testid="wiki-scroll">
        {pageId && known ? (
          <PageView key={pageId} workspaceId={workspaceId} pageId={pageId} />
        ) : pageId ? (
          <div className="grid h-full place-items-center">
            <Spinner />
          </div>
        ) : (
          <NoPage workspaceId={workspaceId} canCreate={canCreate} />
        )}
      </div>
    </div>
  );
}

function NoPage({ workspaceId, canCreate }: { workspaceId: string; canCreate: boolean }): ReactNode {
  useLocale();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-body text-muted" data-testid="wiki-empty">
      <FileText className="size-10" strokeWidth={1.25} aria-hidden />
      <p>{t('wiki.pickPage')}</p>
      {canCreate ? <Button onClick={() => void createPage(workspaceId, '')}>{t('wiki.newPage')}</Button> : null}
    </div>
  );
}

// ---------------------------------------------------------------- header

function WikiBar({ workspaceId, pageId }: { workspaceId: string; pageId: string }): ReactNode {
  useLocale();
  const structure = useWiki((s) => {
    const p = s.pages[pageId];
    return !!p && canStructure(p, myUserId());
  });
  const trashed = useWiki((s) => !!s.pages[pageId]?.trashedAt);
  const sync = useWikiUi((s) => s.sync);
  // The global «Нет соединения» pill floats over the middle of this bar: keep the crumbs left of it and don't repeat the message.
  const reconnecting = useSession((s) => s.ready && s.reconnectBanner);
  return (
    <Bar plain className="gap-2 pl-3 pr-3" data-testid="wiki-bar">
      {pageId ? <Crumbs workspaceId={workspaceId} pageId={pageId} clear={reconnecting} /> : <h1 className="px-1.5 text-headline font-semibold">{t('wiki.section')}</h1>}
      <span className="flex-1" />
      {pageId && !(reconnecting && sync === 'offline') && (sync === 'offline' || sync === 'readonly') ? (
        <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-[var(--color-fill)] px-2.5 text-caption text-muted" role="status" data-testid="wiki-sync-pill">
          {sync === 'offline' ? <CloudOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
          {sync === 'offline' ? t('wiki.sync.offline') : t('wiki.sync.readonly')}
        </span>
      ) : null}
      {pageId ? (
        <span className={BAR_GROUP}>
          {structure && !trashed ? (
            <Button variant="secondary" size="sm" onClick={() => useWikiUi.getState().openDialog({ kind: 'share', pageId, tab: 'access' })} data-testid="wiki-share">
              <Share2 className="size-3.5" aria-hidden />
              {t('wiki.share')}
            </Button>
          ) : null}
          <MoreMenu pageId={pageId} structure={structure} trashed={trashed} />
        </span>
      ) : null}
    </Bar>
  );
}

const Crumbs = memo(function Crumbs({ workspaceId, pageId, clear }: { workspaceId: string; pageId: string; clear: boolean }): ReactNode {
  const path = useWiki(useShallow((s) => ancestorsOf(s.pages, pageId)));
  const shown: Array<string | null> = path.length > 3 ? [path[0] ?? null, null, ...path.slice(-2)] : path;
  return (
    <nav aria-label={t('wiki.path')} className={cx('flex min-w-0 items-center gap-0.5', clear && 'max-w-[calc(50%-150px)]')} data-testid="wiki-crumbs">
      {shown.map((id, i) => (
        <span key={id ?? `gap${i}`} className="flex min-w-0 items-center gap-0.5">
          {id === null ? <span className="px-1 text-muted">…</span> : <CrumbButton workspaceId={workspaceId} id={id} />}
          <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />
        </span>
      ))}
      <CrumbTitle id={pageId} />
    </nav>
  );
});

function CrumbButton({ workspaceId, id }: { workspaceId: string; id: string }): ReactNode {
  const title = useWiki((s) => s.pages[id]?.title ?? '');
  const icon = useWiki((s) => s.pages[id]?.icon ?? '');
  return (
    <button
      type="button"
      onClick={() => openWikiPage(workspaceId, id)}
      className="flex h-8 min-w-0 max-w-48 items-center gap-1 truncate rounded-[var(--radius-bar)] px-1.5 text-body text-muted hover:bg-hover hover:text-fg"
      data-testid="wiki-crumb"
    >
      {icon ? <span aria-hidden>{icon}</span> : null}
      <span className="truncate">{title || t('wiki.untitled')}</span>
    </button>
  );
}

function CrumbTitle({ id }: { id: string }): ReactNode {
  const title = useWiki((s) => s.pages[id]?.title ?? '');
  const icon = useWiki((s) => s.pages[id]?.icon ?? '');
  return (
    <h1 className="flex min-w-0 items-center gap-1.5 truncate px-1.5 text-body font-semibold" aria-current="page">
      {icon ? <span aria-hidden>{icon}</span> : null}
      <span className="truncate">{title || t('wiki.untitled')}</span>
    </h1>
  );
}

function MoreMenu({ pageId, structure, trashed }: { pageId: string; structure: boolean; trashed: boolean }): ReactNode {
  const ui = useWikiUi.getState;
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton label={t('wiki.moreMenu')} data-testid="wiki-more">
          <Ellipsis className="size-4" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'min-w-56')} sideOffset={4} align="end" collisionPadding={16} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="wiki-more-menu">
          <Dropdown.Item className={menuItem} onSelect={() => ui().openDialog({ kind: 'versions', pageId })} data-testid="wiki-open-versions">
            <History className="size-4" strokeWidth={1.75} aria-hidden />
            {t('wiki.versions')}
          </Dropdown.Item>
          <Dropdown.Item className={menuItem} onSelect={() => exportMarkdown(pageId)} data-testid="wiki-export">
            <Download className="size-4" strokeWidth={1.75} aria-hidden />
            {t('wiki.export')}
          </Dropdown.Item>
          {structure && !trashed ? (
            <>
              <Dropdown.Item className={menuItem} onSelect={() => ui().openDialog({ kind: 'move', pageId })} data-testid="wiki-open-move">
                <FolderInput className="size-4" strokeWidth={1.75} aria-hidden />
                {t('wiki.move')}
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} onSelect={() => ui().openDialog({ kind: 'share', pageId, tab: 'access' })} data-testid="wiki-open-access">
                <Users className="size-4" strokeWidth={1.75} aria-hidden />
                {t('wiki.access')}
              </Dropdown.Item>
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void trashPage(pageId)} data-testid="wiki-trash-page">
                <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
                {t('wiki.toTrash')}
              </Dropdown.Item>
            </>
          ) : null}
          {structure && trashed ? (
            <>
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Item className={menuItem} onSelect={() => void restorePage(pageId)} data-testid="wiki-restore-page">
                <RotateCcw className="size-4" strokeWidth={1.75} aria-hidden />
                {t('wiki.restore')}
              </Dropdown.Item>
              <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void deleteForever(pageId)} data-testid="wiki-delete-page">
                <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
                {t('wiki.deleteForever')}
              </Dropdown.Item>
            </>
          ) : null}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

// ---------------------------------------------------------------- the page

function PageView({ workspaceId, pageId }: { workspaceId: string; pageId: string }): ReactNode {
  useLocale();
  const coverId = useWiki((s) => s.pages[pageId]?.cover?.id ?? '');
  const icon = useWiki((s) => s.pages[pageId]?.icon ?? '');
  const trashed = useWiki((s) => !!s.pages[pageId]?.trashedAt);
  const structure = useWiki((s) => {
    const p = s.pages[pageId];
    return !!p && canStructure(p, myUserId());
  });
  const write = useWiki((s) => canWrite(s.pages[pageId]?.myBits ?? 0n));
  const editable = write && !trashed;
  const setup = structure && !trashed;
  const coverInput = useRef<HTMLInputElement>(null);
  return (
    <article className="flex min-h-full flex-col pb-24" data-testid="wiki-page">
      {coverId ? (
        <div className="group relative h-44 w-full shrink-0 overflow-hidden bg-[var(--color-fill)]" data-testid="wiki-cover">
          <MediaImg path={`/api/files/${coverId}`} alt="" className="size-full object-cover" decoding="async" />
          {setup ? (
            <span className="absolute bottom-2 right-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              <Button variant="secondary" size="sm" onClick={() => coverInput.current?.click()}>
                {t('wiki.cover.change')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => removeCover(pageId)} data-testid="wiki-cover-remove">
                {t('wiki.cover.remove')}
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="mx-auto w-full max-w-[760px] px-12">
        {trashed ? <TrashedBanner pageId={pageId} structure={structure} /> : null}
        <div className={cx('group/head flex flex-col', coverId ? (icon ? '-mt-9' : 'mt-6') : 'mt-10')}>
          {icon ? <IconButtonBig pageId={pageId} icon={icon} setup={setup} /> : null}
          {setup ? (
            <div className="flex h-8 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/head:opacity-100" data-testid="wiki-head-tools">
              {icon ? null : (
                <EmojiPicker label={t('wiki.icon.add')} onPick={(e) => setIcon(pageId, e)} closeOnPick side="bottom">
                  <button type="button" className="flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-caption text-muted hover:bg-hover hover:text-fg" data-testid="wiki-icon-add">
                    <Smile className="size-3.5" aria-hidden />
                    {t('wiki.icon.add')}
                  </button>
                </EmojiPicker>
              )}
              {icon ? (
                <button
                  type="button"
                  onClick={() => setIcon(pageId, '')}
                  className="flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-caption text-muted hover:bg-hover hover:text-fg"
                >
                  <X className="size-3.5" aria-hidden />
                  {t('wiki.icon.remove')}
                </button>
              ) : null}
              {coverId ? null : (
                <button
                  type="button"
                  onClick={() => coverInput.current?.click()}
                  className="flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-caption text-muted hover:bg-hover hover:text-fg"
                  data-testid="wiki-cover-add"
                >
                  <ImagePlus className="size-3.5" aria-hidden />
                  {t('wiki.cover.add')}
                </button>
              )}
            </div>
          ) : (
            <div className="h-2" />
          )}
          <TitleField pageId={pageId} editable={setup} />
        </div>
        <Suspense
          fallback={
            <div className="grid h-24 place-items-center">
              <Spinner />
            </div>
          }
        >
          <WikiDocLazy workspaceId={workspaceId} pageId={pageId} editable={editable} />
        </Suspense>
        <Subpages workspaceId={workspaceId} pageId={pageId} canAdd={editable} />
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

function IconButtonBig({ pageId, icon, setup }: { pageId: string; icon: string; setup: boolean }): ReactNode {
  const glyph = <span className="text-[56px] leading-none">{icon}</span>;
  if (!setup) {
    return (
      <span className="relative mb-1 grid size-[72px] place-items-center" data-testid="wiki-icon">
        {glyph}
      </span>
    );
  }
  return (
    <EmojiPicker label={t('wiki.icon.change')} onPick={(e) => setIcon(pageId, e)} closeOnPick side="bottom">
      <button type="button" className="relative mb-1 grid size-[72px] place-items-center rounded-[var(--radius-card)] hover:bg-hover" data-testid="wiki-icon">
        {glyph}
      </button>
    </EmojiPicker>
  );
}

function TrashedBanner({ pageId, structure }: { pageId: string; structure: boolean }): ReactNode {
  return (
    <div className="mt-6 flex items-center gap-3 rounded-[var(--radius-card)] bg-[color-mix(in_srgb,var(--color-red)_10%,transparent)] px-3 py-2 text-body" role="status" data-testid="wiki-trashed">
      <Trash2 className="size-4 shrink-0 text-danger-text" aria-hidden />
      <span className="min-w-0 flex-1">{t('wiki.inTrash')}</span>
      {structure ? (
        <>
          <Button variant="secondary" size="sm" onClick={() => void restorePage(pageId)}>
            {t('wiki.restore')}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void deleteForever(pageId)}>
            {t('wiki.deleteForever')}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The title (H1 size): typed text is applied to the store at once (the tree and crumbs follow) and
 * PATCHed 500 ms after the last key, and on blur. A remote rename shows while the field is not focused.
 */
export function TitleField({ pageId, editable, className }: { pageId: string; editable: boolean; className?: string }): ReactNode {
  const stored = useWiki((s) => s.pages[pageId]?.title ?? '');
  const [value, setValue] = useState(stored);
  const saved = useRef(stored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  /** The text typed and not PATCHed yet (null: nothing to save). Never read from the DOM: on unmount the ref is already detached. */
  const typed = useRef<string | null>(null);
  useEffect(() => {
    if (!focused.current && stored !== value) {
      setValue(stored);
      saved.current = stored;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a remote change
  }, [stored]);
  const flush = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = typed.current;
    typed.current = null;
    if (next === null || next.trim() === saved.current.trim()) return;
    const prev = saved.current;
    saved.current = next;
    void renamePage(pageId, next, prev);
  };
  useEffect(() => {
    if (takeTitleFocus(pageId)) ref.current?.focus();
    return () => flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount / unmount
  }, []);
  // Grows with the text (a long title wraps).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      readOnly={!editable}
      maxLength={200}
      placeholder={t('wiki.untitled')}
      aria-label={t('wiki.title')}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        flush();
      }}
      onChange={(e) => {
        const v = e.target.value.replace(/\n/g, ' ');
        setValue(v);
        typed.current = v;
        setTitleLocal(pageId, v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, 500);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          flush();
          document.querySelector<HTMLElement>('.wiki-prose')?.focus();
        }
      }}
      className={cx('w-full resize-none overflow-hidden bg-transparent font-bold tracking-[-0.01em] text-fg outline-none placeholder:text-faint', className ?? 'text-[32px] leading-[40px]')}
      data-testid="wiki-title"
    />
  );
}

/** The page's children at the bottom (rows), with «+ Подстраница». */
const Subpages = memo(function Subpages({ workspaceId, pageId, canAdd }: { workspaceId: string; pageId: string; canAdd: boolean }): ReactNode {
  const key = childKey(workspaceId, pageId);
  const ids = useWiki(useShallow((s) => s.lists[key] ?? NONE));
  const hasChildren = useWiki((s) => !!s.pages[pageId]?.hasChildren);
  const loaded = useWiki((s) => !!s.lists[key]);
  useEffect(() => {
    if (hasChildren && !loaded) void loadChildren(workspaceId, pageId);
  }, [hasChildren, loaded, workspaceId, pageId]);
  if (!ids.length && !canAdd) return null;
  return (
    <section className="mt-6 flex flex-col gap-1 border-t border-line pt-4" aria-label={t('wiki.subpages')} data-testid="wiki-subpages">
      <h2 className="text-caption font-semibold text-muted">{t('wiki.subpages')}</h2>
      {ids.map((id) => (
        <SubpageRow key={id} workspaceId={workspaceId} id={id} />
      ))}
      {canAdd ? (
        <button
          type="button"
          onClick={() => void createPage(workspaceId, pageId)}
          className="-ml-2 flex h-9 items-center gap-2 rounded-[var(--radius-row)] px-2 text-body text-muted hover:bg-hover hover:text-fg"
          data-testid="wiki-add-subpage"
        >
          <Plus className="size-4" aria-hidden />
          {t('wiki.addSubpage')}
        </button>
      ) : null}
    </section>
  );
});

const NONE: readonly string[] = [];

const SubpageRow = memo(function SubpageRow({ workspaceId, id }: { workspaceId: string; id: string }): ReactNode {
  const title = useWiki((s) => s.pages[id]?.title ?? '');
  const icon = useWiki((s) => s.pages[id]?.icon ?? '');
  const preview = useWiki((s) => s.pages[id]?.preview ?? '');
  return (
    <button
      type="button"
      onClick={() => openWikiPage(workspaceId, id)}
      className="-ml-2 flex min-h-9 items-center gap-2 rounded-[var(--radius-row)] px-2 py-1 text-left hover:bg-hover"
      data-testid="wiki-subpage"
    >
      <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
        {icon || <FileText className="size-4 text-muted" strokeWidth={1.75} />}
      </span>
      <span className="min-w-0 shrink-0 truncate text-body font-medium underline decoration-[var(--color-separator)] underline-offset-4">{title || t('wiki.untitled')}</span>
      {preview ? <span className="min-w-0 flex-1 truncate text-caption text-muted">{preview}</span> : null}
    </button>
  );
});
