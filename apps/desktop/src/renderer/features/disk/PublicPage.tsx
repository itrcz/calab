import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { OfficeConfigResponse, PublicDiskEntry, PublicDiskFile, PublicDiskFolder } from '@calaba/protocol';
import { DiskItemKind } from '@calaba/protocol';
import * as DialogP from '../../components/radix/dialog';
import { ArrowLeft, ChevronRight, Download, Folder, Link2Off } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { Button, IconButton, Spinner, cx } from '../../components/ui';
import { getLocale, t, useLocale } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { textKind } from '../../lib/diskPreview';
import { folderParam, fromEntry, fromLinkedFile, metaOf, publicView, type PublicFile } from '../../lib/diskPublic';
import { fmt } from '../../lib/format';
import { diskPublic, downloadUrl } from '../../services/diskPublic';
import { useUi } from '../../stores/ui';
import { PdfViewer } from '../chat/PdfViewer';
import { ViewerBar, onDark } from '../chat/Lightbox';
import { TextBody } from './DiskViewer';
import { connectHost, originOf, type HostEvent } from './office/bridge';
import { FileTypeIcon } from './visuals';

/**
 * `/d/{code}` — a public Disk link read without signing in (ADR-0094 §3, ADR-0165; docs/08
 * «Диск: публичная ссылка»). A file link: the file's card (preview, size, «Открыть», «Скачать»).
 * A folder link: the folder read-only — crumbs from the linked folder down (never above it),
 * folders first then files with type, size and date; a folder opens in place (`?folder=<id>`,
 * browser back works), a file opens in the app's viewers or as a card with «Скачать»;
 * «Скачать всё» is the open folder as a zip. What the server does not list (trashed,
 * «Только выбранные» inside) is not reachable. No socket, no session; `noindex,nofollow` and
 * `no-referrer` as metas, like the wiki's public page.
 */
type Meta = { kind: 'loading' } | { kind: 'gone' } | { kind: 'ready'; meta: PublicDiskFile };

export function DiskPublicPage({ code }: { code: string }): ReactNode {
  useLocale();
  const [meta, setMeta] = useState<Meta>({ kind: 'loading' });
  const [open, setOpen] = useState<PublicFile | null>(null);

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
    diskPublic.meta(code, ctl.signal).then(
      (m) => {
        setMeta({ kind: 'ready', meta: m });
        document.title = `${m.name} · Calab`;
      },
      () => {
        // 404 = revoked / expired / deleted; anything else (429, network) reads the same to a visitor.
        if (!ctl.signal.aborted) setMeta({ kind: 'gone' });
      },
    );
    return () => ctl.abort();
  }, [code]);

  const close = useCallback(() => setOpen(null), []);
  if (meta.kind === 'gone') return <Gone />;
  return (
    <div className="h-full overflow-y-auto bg-bg text-fg mobile:pt-[var(--safe-top,0px)]" data-testid="disk-public">
      <div className="mx-auto flex min-h-full w-full max-w-[960px] flex-col px-8 mobile:px-4">
        <main className="min-w-0 flex-1 pb-8 pt-10 mobile:pt-6">
          {meta.kind === 'loading' ? (
            <Loading />
          ) : meta.meta.kind === DiskItemKind.FOLDER ? (
            <FolderView code={code} meta={meta.meta} onOpen={setOpen} onGone={() => setMeta({ kind: 'gone' })} />
          ) : (
            <FileView code={code} meta={meta.meta} onOpen={setOpen} />
          )}
        </main>
        <footer className="shrink-0 pb-[calc(var(--safe-bottom,0px)+24px)] pt-2 text-center text-caption text-muted" data-testid="disk-public-footer">
          {t('disk.pub.footer')}
        </footer>
      </div>
      {open ? <PublicViewer code={code} file={open} onClose={close} /> : null}
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
    <div className="grid h-full place-items-center bg-bg px-6 text-fg" data-testid="disk-public-gone">
      <div className="flex max-w-[360px] flex-col items-center gap-3 text-center">
        <Link2Off className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
        <h1 className="text-title font-semibold">{t('disk.pub.gone')}</h1>
        <p className="text-body text-muted">{t('disk.pub.goneText')}</p>
      </div>
    </div>
  );
}

const until = (m: { expiresAt?: PublicDiskFile['expiresAt'] }): string => (m.expiresAt ? t('disk.link.until', { date: fmt.stamp(timestampDate(m.expiresAt)) }) : '');

// ---------------------------------------------------------------- a file link

function FileView({ code, meta, onOpen }: { code: string; meta: PublicDiskFile; onOpen: (f: PublicFile) => void }): ReactNode {
  const phone = useUi((s) => s.phone.on);
  const f = fromLinkedFile(meta);
  const view = publicView(f, phone);
  const exp = until(meta);
  return (
    <section className="mx-auto flex max-w-[560px] flex-col items-center gap-4 text-center" data-testid="disk-public-file">
      <div className="grid size-40 place-items-center overflow-hidden rounded-[var(--radius-card)] border border-line bg-elev">
        {f.hasThumbnail ? (
          <MediaImg path={diskPublic.thumbPath(code, '')} alt="" decoding="async" className="size-full object-cover" />
        ) : (
          <FileTypeIcon file={metaOf(f)} className="size-[88px]" />
        )}
      </div>
      <div className="flex min-w-0 max-w-full flex-col gap-1">
        <h1 className="break-words text-[22px] font-semibold leading-7 [overflow-wrap:anywhere]" data-testid="disk-public-name">
          {meta.name}
        </h1>
        <p className="text-caption text-muted">
          {fmt.size(meta.size)}
          {exp ? ` · ${exp}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {view !== 'card' ? (
          <Button variant="secondary" onClick={() => onOpen(f)} data-testid="disk-public-open">
            {t('disk.open')}
          </Button>
        ) : null}
        <Button variant="primary" onClick={() => downloadUrl(diskPublic.contentUrl(code, ''))} data-testid="disk-public-download">
          <Download className="size-4" aria-hidden />
          {t('disk.download')}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- a folder link

type Listing = { key: string; folder: PublicDiskFolder; items: PublicDiskEntry[]; next: string } | { key: string; failed: true };

function FolderView({ code, meta, onOpen, onGone }: { code: string; meta: PublicDiskFile; onOpen: (f: PublicFile) => void; onGone: () => void }): ReactNode {
  const [folderId, setFolderId] = useState(() => folderParam(location.search));
  const [res, setRes] = useState<Listing | null>(null);
  const [more, setMore] = useState(false);
  const [zipNote, setZipNote] = useState('');
  const key = `${code}|${folderId}`;
  const cur = res && res.key === key ? res : null;

  useEffect(() => {
    const ctl = new AbortController();
    diskPublic.folder(code, folderId, '', ctl.signal).then(
      (f) => setRes({ key, folder: f, items: f.items, next: f.nextCursor }),
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        // The open folder left the link (moved, made «Только выбранные», trashed) — or the link is gone.
        if (e instanceof ApiError && e.status === 404 && folderId) setRes({ key, failed: true });
        else if (e instanceof ApiError && e.status === 404) onGone();
        else setRes({ key, failed: true });
      },
    );
    return () => ctl.abort();
  }, [code, folderId, key, onGone]);

  useEffect(() => {
    const on = (): void => setFolderId(folderParam(location.search));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  const go = useCallback((id: string, rootId: string) => {
    history.pushState(null, '', id && id !== rootId ? `${location.pathname}?folder=${encodeURIComponent(id)}` : location.pathname);
    setFolderId(id === rootId ? '' : id);
    setZipNote('');
  }, []);

  const loadMore = (): void => {
    if (!cur || 'failed' in cur || !cur.next) return;
    setMore(true);
    diskPublic.folder(code, folderId, cur.next).then(
      (f) => {
        setRes((prev) => (prev && prev.key === key && 'items' in prev ? { ...prev, items: [...prev.items, ...f.items], next: f.nextCursor } : prev));
        setMore(false);
      },
      () => setMore(false),
    );
  };

  const downloadAll = (): void => {
    // Asked first (`?check=1`, not counted): over the ceiling or too often is said on the page
    // instead of downloading an error.
    setZipNote('');
    void diskPublic.archiveCheck(code, folderId).then((r) => {
      if (r === 'large') setZipNote(t('disk.pub.tooLarge'));
      else if (r === 'busy') setZipNote(t('disk.pub.busy'));
      else if (r === 'gone') setZipNote(t('disk.pub.failed'));
      else downloadUrl(diskPublic.archiveUrl(code, folderId));
    });
  };

  const path = cur && 'folder' in cur ? cur.folder.path : [];
  const rootId = path[0]?.id ?? meta.id;
  const name = cur && 'folder' in cur ? cur.folder.name : meta.name;
  const exp = until(meta);
  return (
    <section className="flex flex-col gap-4" data-testid="disk-public-folder">
      <header className="flex items-start gap-3 mobile:flex-col mobile:items-stretch">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {folderId && path.length > 1 ? (
            <IconButton label={t('disk.pub.back')} onClick={() => go(path[path.length - 2]?.id ?? '', rootId)} data-testid="disk-public-back">
              <ArrowLeft className="size-5" aria-hidden />
            </IconButton>
          ) : (
            <span className="grid size-10 shrink-0 place-items-center" aria-hidden>
              <Folder className="size-8 fill-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] text-accent" strokeWidth={1.5} />
            </span>
          )}
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-[22px] font-semibold leading-7" data-testid="disk-public-name">
              {name}
            </h1>
            {exp ? <p className="text-caption text-muted">{exp}</p> : null}
          </div>
        </div>
        <Button variant="secondary" className="shrink-0 mobile:self-start" onClick={downloadAll} disabled={!cur || 'failed' in cur} data-testid="disk-public-download-all">
          <Download className="size-4" aria-hidden />
          {t('disk.pub.downloadAll')}
        </Button>
      </header>
      {zipNote ? <p className="text-caption text-muted">{zipNote}</p> : null}
      {path.length > 1 ? <Crumbs path={path} rootId={rootId} onGo={go} /> : null}
      {!cur ? (
        <Loading />
      ) : 'failed' in cur ? (
        <p className="grid h-40 place-items-center text-body text-muted" role="alert" data-testid="disk-public-failed">
          {t('disk.pub.failed')}
        </p>
      ) : cur.items.length === 0 ? (
        <p className="grid h-40 place-items-center text-body text-muted" data-testid="disk-public-empty">
          {t('disk.pub.empty')}
        </p>
      ) : (
        <>
          <div className="flex flex-col border-t border-line" role="list" data-testid="disk-public-list">
            {cur.items.map((e) => (
              <Row key={e.id} code={code} entry={e} rootId={rootId} onFolder={go} onFile={onOpen} />
            ))}
          </div>
          {cur.next ? (
            <Button variant="secondary" className="self-center" busy={more} onClick={loadMore} data-testid="disk-public-more">
              {t('disk.pub.more')}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

function Crumbs({ path, rootId, onGo }: { path: PublicDiskFolder['path']; rootId: string; onGo: (id: string, rootId: string) => void }): ReactNode {
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-body" aria-label={t('disk.path')} data-testid="disk-public-crumbs">
      {path.map((c, i) => {
        const last = i === path.length - 1;
        return (
          <span key={c.id} className="flex min-w-0 items-center gap-1">
            {i > 0 ? <ChevronRight className="size-3.5 shrink-0 text-muted" aria-hidden /> : null}
            {last ? (
              <span className="max-w-[240px] truncate font-medium" aria-current="page">
                {c.name}
              </span>
            ) : (
              <button type="button" className="max-w-[200px] truncate rounded-[var(--radius-row)] px-1 text-muted hover:bg-hover hover:text-fg" onClick={() => onGo(c.id, rootId)}>
                {c.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

const Row = memo(function Row({
  code,
  entry,
  rootId,
  onFolder,
  onFile,
}: {
  code: string;
  entry: PublicDiskEntry;
  rootId: string;
  onFolder: (id: string, rootId: string) => void;
  onFile: (f: PublicFile) => void;
}): ReactNode {
  const folder = entry.kind === DiskItemKind.FOLDER;
  const f = folder ? null : fromEntry(entry);
  const changed = entry.updatedAt ? fmt.stamp(timestampDate(entry.updatedAt)) : '';
  const open = (): void => {
    if (f) onFile(f);
    else onFolder(entry.id, rootId);
  };
  return (
    <div role="listitem" className="group flex min-h-12 items-center gap-3 border-b border-line px-1 hover:bg-hover mobile:min-h-14" data-testid="disk-public-row">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 py-1.5 text-left" onClick={open} data-testid="disk-public-row-open">
        <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[6px]" aria-hidden>
          {folder ? (
            <Folder className="size-7 fill-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] text-accent" strokeWidth={1.5} />
          ) : f?.hasThumbnail ? (
            <MediaImg path={diskPublic.thumbPath(code, entry.id)} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
          ) : (
            <FileTypeIcon file={f ? metaOf(f) : undefined} className="size-8" compact />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body text-fg">{entry.name}</span>
          <span className="hidden truncate text-caption text-muted mobile:block">{folder ? t('disk.pub.folder') : [fmt.size(entry.size), changed].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="w-24 shrink-0 text-right text-caption tabular-nums text-muted mobile:hidden">{folder ? '' : fmt.size(entry.size)}</span>
        <span className="w-36 shrink-0 truncate text-right text-caption text-muted mobile:hidden">{changed}</span>
      </button>
      {f ? (
        <IconButton label={t('disk.pub.downloadName', { name: entry.name })} size="sm" onClick={() => downloadUrl(diskPublic.contentUrl(code, entry.id))} data-testid="disk-public-row-download">
          <Download className="size-4" aria-hidden />
        </IconButton>
      ) : (
        <span className="w-7 shrink-0" aria-hidden />
      )}
    </div>
  );
});

// ---------------------------------------------------------------- the viewer

/**
 * The file in a full-window frame (the Lightbox's): images, video, audio and text in place, PDF in
 * the app's PDF viewer, office documents in the read-only office viewer, anything else a card with
 * «Скачать». Closing unmounts everything it ran (the media element, the editor's frame).
 */
function PublicViewer({ code, file, onClose }: { code: string; file: PublicFile; onClose: () => void }): ReactNode {
  const phone = useUi((s) => s.phone.on);
  const view = publicView(file, phone);
  const download = (): void => downloadUrl(diskPublic.contentUrl(code, file.id));
  if (view === 'pdf') {
    return <PdfViewer file={{ id: file.id, name: file.name, size: file.size }} path={diskPublic.contentPath(code, file.id)} onDownload={download} onClose={onClose} />;
  }
  const tk = textKind(file);
  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag anim-in fixed inset-0 z-[var(--z-modal)] bg-[rgb(0_0_0/82%)]" />
        <DialogP.Content
          aria-modal="true"
          aria-describedby={undefined}
          data-testid="disk-public-viewer"
          data-kind={view}
          className="anim-in fixed inset-0 z-[var(--z-modal)] flex flex-col focus:outline-none"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <ViewerBar title={file.name} meta={fmt.size(file.size)}>
            <IconButton label={t('lightbox.download')} onClick={download} className={onDark} data-testid="disk-public-viewer-download">
              <Download className="size-5" />
            </IconButton>
          </ViewerBar>
          <div
            className="flex min-h-0 flex-1 items-center justify-center px-6 pb-6 mobile:px-2"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose();
            }}
          >
            {view === 'image' ? (
              <MediaImg path={file.hasThumbnail ? diskPublic.thumbPath(code, file.id, 1024) : diskPublic.contentPath(code, file.id)} alt={file.name} className="max-h-full max-w-full object-contain" />
            ) : view === 'video' ? (
              <video src={diskPublic.contentUrl(code, file.id)} controls autoPlay playsInline className="max-h-full max-w-full rounded-[var(--radius-card)] bg-black" data-testid="disk-public-video" />
            ) : view === 'audio' ? (
              <div className="w-full max-w-[560px] rounded-[var(--radius-card)] bg-elev p-4">
                <audio src={diskPublic.contentUrl(code, file.id)} controls autoPlay className="w-full" data-testid="disk-public-audio" />
              </div>
            ) : view === 'text' && tk ? (
              <div className="max-h-full w-full max-w-[900px] overflow-auto rounded-[var(--radius-card)] bg-elev p-4 text-fg">
                <TextBody path={diskPublic.contentPath(code, file.id)} size={file.size} kind={tk} name={file.name} />
              </div>
            ) : view === 'office' ? (
              <OfficeView code={code} file={file} onDownload={download} />
            ) : (
              <NoPreview file={file} onDownload={download} />
            )}
          </div>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

function NoPreview({ file, onDownload, failed }: { file: PublicFile; onDownload: () => void; failed?: boolean }): ReactNode {
  return (
    <div className="flex max-w-[360px] flex-col items-center gap-3 rounded-[var(--radius-card)] bg-elev p-6 text-center text-fg" data-testid="disk-public-nopreview">
      <FileTypeIcon file={metaOf(file)} className="size-16" />
      <p className="text-body text-muted">{failed ? t('disk.pub.officeFailed') : t('disk.pub.noPreview')}</p>
      <Button variant="primary" onClick={onDownload}>
        <Download className="size-4" aria-hidden />
        {t('disk.download')}
      </Button>
    </div>
  );
}

const appTheme = (): 'dark' | 'light' => (document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark');

/** Office documents read-only in the Document Server's viewer (ADR-0143 host page; ADR-0165 link config). */
function OfficeView({ code, file, onDownload }: { code: string; file: PublicFile; onDownload: () => void }): ReactNode {
  const [cfg, setCfg] = useState<OfficeConfigResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const ac = new AbortController();
    diskPublic.office(code, file.id, { theme: appTheme(), phone: useUi.getState().phone.on, lang: getLocale().split('-')[0] ?? 'ru' }, ac.signal).then(
      (c) => setCfg(c),
      () => {
        if (!ac.signal.aborted) setFailed(true);
      },
    );
    return () => ac.abort();
  }, [code, file.id]);
  useEffect(() => {
    const el = frame.current;
    const origin = cfg ? originOf(cfg.docsUrl) : '';
    if (!cfg || !el || !origin) return;
    const on = (e: HostEvent): void => {
      if (e.name === 'ready') setReady(true);
      else if (e.name === 'error') setFailed(true);
    };
    const conn = connectHost(window, el, origin, cfg.configJson, on);
    el.src = cfg.hostUrl;
    // The Document Server never said hello (unreachable): give up like the app does.
    const timer = window.setTimeout(() => setFailed((f) => f || !el.dataset['ready']), 90_000);
    return () => {
      window.clearTimeout(timer);
      conn.close();
    };
  }, [cfg]);
  if (failed) return <NoPreview file={file} onDownload={onDownload} failed />;
  return (
    <div className="relative size-full overflow-hidden rounded-[var(--radius-card)] bg-elev" data-testid="disk-public-office">
      {cfg ? <iframe ref={frame} title={file.name} className={cx('size-full border-0', !ready && 'invisible')} data-ready={ready ? '1' : undefined} /> : null}
      {!ready ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner className="size-6" />
        </span>
      ) : null}
    </div>
  );
}
