import type { PublicWikiPage } from '@calaba/protocol';
import { ChevronDown, FileText, Link2Off } from 'lucide-react';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { outlineRows, type OutlineRow } from '../../lib/wiki/publicOutline';
import { wikiPublic } from '../../services/wikiPublic';

/** Yjs + Tiptap in their own chunk (lazy.ts rule): the public page loads it after the meta. */
const PublicDoc = lazy(() => import('./PublicDoc'));

type Loaded = { key: string; page: PublicWikiPage; body: Uint8Array } | { key: string; gone: true };

/**
 * `/w/{code}` — a wiki page read without signing in (ADR-0096 §6, docs/08 «Вики: публичная
 * страница»): cover, icon, title and the document in the same editor, read-only. With
 * `include_children` the visible subpages are an outline on the left (on the phone a «Содержание»
 * disclosure above the text); the open subpage is `?page=<id>`. No sync socket, no awareness, no
 * session: the document is one request. `noindex` + no-referrer like the public forms.
 */
export function WikiPublicPage({ code }: { code: string }): ReactNode {
  useLocale();
  const [pageId, setPageId] = useState<string | undefined>(() => new URLSearchParams(location.search).get('page') ?? undefined);
  const [outline, setOutline] = useState<PublicWikiPage | null>(null);
  const [res, setRes] = useState<Loaded | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const key = `${code}|${pageId ?? ''}`;
  // The answer of the current page; one of another page (a click just happened) counts as loading.
  const cur = res && res.key === key ? res : null;
  const gone = !!cur && 'gone' in cur;
  const page = cur && 'page' in cur ? cur.page : null;
  const body = cur && 'page' in cur ? cur.body : null;
  const state = cur ? 'ready' : 'loading';

  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex,nofollow';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => {
      robots.remove();
      referrer.remove();
    };
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    void Promise.all([wikiPublic.page(code, pageId, ctl.signal), wikiPublic.state(code, pageId, ctl.signal)]).then(
      ([meta, bytes]) => {
        // The outline is the whole branch and the same for every page of it: read from the first answer.
        setOutline((prev) => prev ?? meta);
        setRes({ key, page: meta, body: bytes });
        document.title = `${meta.title || t('wiki.untitled')} · Calab`;
      },
      () => {
        // 404 = revoked / expired / trashed; anything else (429, network) reads the same to a visitor.
        if (!ctl.signal.aborted) setRes({ key, gone: true });
      },
    );
    return () => ctl.abort();
  }, [code, pageId, key]);

  // Browser back / forward between subpages.
  useEffect(() => {
    const on = (): void => setPageId(new URLSearchParams(location.search).get('page') ?? undefined);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const fail = useCallback(() => setRes({ key, gone: true }), [key]);
  const open = useCallback((id: string, rootId: string) => {
    const url = id === rootId ? location.pathname : `${location.pathname}?page=${encodeURIComponent(id)}`;
    history.pushState(null, '', url);
    setPageId(id === rootId ? undefined : id);
    scroller.current?.scrollTo(0, 0);
  }, []);

  const rows = useMemo(() => (outline && outline.children.length ? outlineRows({ id: outline.rootId, title: outline.title, icon: outline.icon }, outline.children) : []), [outline]);
  const current = page?.id ?? '';

  if (gone) return <Gone />;
  return (
    <div ref={scroller} className="h-full overflow-y-auto bg-bg text-fg mobile:pt-[var(--safe-top,0px)]" data-testid="wiki-public">
      <div className="mx-auto flex min-h-full w-full max-w-[1100px] flex-col">
        <div className="flex min-h-0 flex-1 mobile:flex-col">
          {rows.length > 1 && outline ? (
            <>
              <aside className="sticky top-0 h-screen w-[260px] shrink-0 overflow-y-auto border-r border-line px-2 py-6 mobile:hidden" aria-label={t('wiki.public.outline')} data-testid="wiki-public-outline">
                <Outline rows={rows} current={current} rootId={outline.rootId} onOpen={open} />
              </aside>
              <MobileOutline rows={rows} current={current} rootId={outline.rootId} onOpen={open} />
            </>
          ) : null}
          <main className="min-w-0 flex-1" data-testid="wiki-public-main">
            {page && state === 'ready' ? (
              <article className="flex flex-col pb-10">
                {page.coverFileId ? (
                  <div className="h-44 w-full shrink-0 overflow-hidden bg-[var(--color-fill)] mobile:h-32" data-testid="wiki-public-cover">
                    <MediaImg path={wikiPublic.filePath(code, page.coverFileId)} alt="" className="size-full object-cover" decoding="async" />
                  </div>
                ) : null}
                <div className="mx-auto w-full max-w-[760px] px-12 mobile:px-4">
                  <div className={cx('flex flex-col', page.coverFileId ? (page.icon ? '-mt-9' : 'mt-6') : 'mt-10 mobile:mt-6')}>
                    {page.icon ? <span className="mb-1 grid size-[72px] place-items-center text-[56px] leading-none mobile:size-14 mobile:text-[44px]" data-testid="wiki-public-icon">{page.icon}</span> : null}
                    <h1 className="text-[32px] font-bold leading-[40px] tracking-[-0.01em] mobile:text-[26px] mobile:leading-8" data-testid="wiki-public-title">
                      {page.title || t('wiki.untitled')}
                    </h1>
                  </div>
                  <Suspense fallback={<Loading />}>
                    {body ? <PublicDoc key={`${current}|${body.length}`} code={code} body={body} onError={fail} /> : null}
                  </Suspense>
                </div>
              </article>
            ) : (
              <Loading />
            )}
          </main>
        </div>
        <footer className="shrink-0 px-4 pb-[calc(var(--safe-bottom,0px)+24px)] pt-2 text-center text-caption text-muted" data-testid="wiki-public-footer">
          {t('wiki.public.footer')}
        </footer>
      </div>
    </div>
  );
}

function Loading(): ReactNode {
  return (
    <div className="grid h-40 place-items-center">
      <Spinner />
    </div>
  );
}

function Gone(): ReactNode {
  return (
    <div className="grid h-full place-items-center bg-bg px-6 text-fg" data-testid="wiki-public-gone">
      <div className="flex max-w-[360px] flex-col items-center gap-3 text-center">
        <Link2Off className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
        <h1 className="text-title font-semibold">{t('wiki.public.gone')}</h1>
        <p className="text-body text-muted">{t('wiki.public.goneText')}</p>
      </div>
    </div>
  );
}

interface OutlineProps {
  rows: readonly OutlineRow[];
  current: string;
  rootId: string;
  onOpen: (id: string, rootId: string) => void;
}

const Outline = memo(function Outline({ rows, current, rootId, onOpen }: OutlineProps): ReactNode {
  return (
    <nav className="flex flex-col gap-0.5" aria-label={t('wiki.public.outline')}>
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onOpen(r.id, rootId)}
          aria-current={r.id === current ? 'page' : undefined}
          style={{ paddingLeft: 8 + r.depth * 14 }}
          className={cx('flex min-h-8 items-center gap-2 rounded-[var(--radius-row)] pr-2 text-left text-body mobile:min-h-11', r.id === current ? 'bg-active font-medium' : 'text-muted hover:bg-hover hover:text-fg')}
          data-testid="wiki-public-outline-row"
        >
          <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
            {r.icon || <FileText className="size-4 text-muted" strokeWidth={1.75} />}
          </span>
          <span className="min-w-0 flex-1 truncate">{r.title || t('wiki.untitled')}</span>
        </button>
      ))}
    </nav>
  );
});

/** Phone: «Содержание» collapsed above the text (the outline column is hidden below 769 px). */
function MobileOutline(p: OutlineProps): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="hidden border-b border-line px-2 mobile:block" data-testid="wiki-public-toc">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-11 w-full items-center gap-2 px-2 text-body font-medium"
        data-testid="wiki-public-toc-toggle"
      >
        <span className="flex-1 text-left">{t('wiki.public.outline')}</span>
        <ChevronDown className={cx('size-4 text-muted transition-transform motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? (
        <div className="pb-2">
          <Outline
            {...p}
            onOpen={(id, root) => {
              setOpen(false);
              p.onOpen(id, root);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
