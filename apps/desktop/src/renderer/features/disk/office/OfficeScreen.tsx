import { DiskItemResponseSchema, OfficeConfigResponseSchema, OfficeMode, type DiskItem, type OfficeConfigResponse } from '@calaba/protocol';
import { ArrowLeft, Download, RotateCw } from 'lucide-react';
import { memo, useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton, Spinner, cx } from '../../../components/ui';
import { getLocale, t } from '../../../i18n';
import { ApiError, call, qs } from '../../../lib/api/client';
import { usePageVisible } from '../../../lib/pageVisible';
import { platform } from '../../../platform';
import { toast } from '../../../stores/toasts';
import { useTaskTabs, type TaskTab } from '../../../stores/taskTabs';
import { useUi } from '../../../stores/ui';
import { FRAME_START, connectHost, convertTarget, frameReducer, officeCapability, originOf, viewOnly, type HostConnection, type HostEvent } from './bridge';
import { openOfficeFile, type OfficeSource } from './fileTabs';
import { downloadFile } from '../../../services/files';
import { diskApi, downloadItem } from '../../../services/disk';

type Load = { kind: 'loading' } | { kind: 'ready'; cfg: OfficeConfigResponse } | { kind: 'error'; why: 'unsupported' | 'unavailable' | 'failed' };

const appTheme = (): 'dark' | 'light' => (document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark');

/** The Document Server does not say hello (unreachable, blocked): the frame gives up after this. */
const HELLO_TIMEOUT_MS = 15_000;
/**
 * It said hello but the document is not shown yet: on the first open the editor's JS and fonts
 * (~12 MB, cached afterwards) take 10–30 s on a slow link, so this budget is wider.
 */
const READY_TIMEOUT_MS = 90_000;
/** Leaving a file with changes pending: how long the editor gets to save before the edits are kept on screen. */
export const SAVE_WAIT_MS = 8_000;
/** A hidden window with nothing unsaved keeps the editor this long, then lets it go (docs/14: a hidden window runs nothing). */
export const HIDDEN_PARK_MS = 5 * 60_000;

export const officeApi = {
  /** GET /api/office/config: the signed editor configuration of a Disk item or, view only, of a plain file (ADR-0143). */
  config: (src: OfficeSource, p: { theme: 'dark' | 'light'; phone: boolean; lang: string }, signal?: AbortSignal) =>
    call('GET', `/api/office/config${qs({ ...('itemId' in src ? { item: src.itemId } : { file: src.fileId }), theme: p.theme, phone: p.phone ? 1 : undefined, lang: p.lang })}`, OfficeConfigResponseSchema, undefined, signal),
  /** «Сохранить как» of a legacy Disk file: a NEW item next to it in the modern format (the source is never written). */
  convertItem: (itemId: string) => call('POST', `/api/disk/items/${itemId}/office/convert`, DiskItemResponseSchema),
  /** «Сохранить как» of a legacy attachment: a new item in folder `parentId` ('' = the root) of workspace `ws`. */
  convertFile: (ws: string, fileId: string, parentId: string) => call('POST', `/api/workspaces/${ws}/office/convert`, DiskItemResponseSchema, { fileId, parentId }),
  /** «Сохранить в Диск» of an attachment: an editable copy in folder `parentId` ('' = the root) of workspace `ws`. */
  importFile: (ws: string, fileId: string, parentId: string) => call('POST', `/api/workspaces/${ws}/disk/import`, DiskItemResponseSchema, { fileId, parentId }),
};

/** A workspace the Disk lives in (not «Личные» / a guest's pseudo-workspace). */
const diskWorkspace = (ws: string): boolean => ws !== '' && !ws.startsWith('@');

/** A fresh config on mount and on every `attempt` (the retry); aborted on leaving. */
function useOfficeConfig(src: OfficeSource, attempt: number): Load {
  const key = 'itemId' in src ? src.itemId : src.fileId;
  const [state, setState] = useState<{ key: string; attempt: number; v: Load } | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    officeApi
      .config(src, { theme: appTheme(), phone: useUi.getState().phone.on, lang: getLocale().split('-')[0] ?? 'ru' }, ac.signal)
      .then((cfg) => {
        if (!ac.signal.aborted) setState({ key, attempt, v: { kind: 'ready', cfg } });
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        const status = e instanceof ApiError ? e.status : 0;
        setState({ key, attempt, v: { kind: 'error', why: status === 415 ? 'unsupported' : status === 404 ? 'unavailable' : 'failed' } });
      });
    return () => ac.abort();
    // `src` is identified by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return state?.key === key && state.attempt === attempt ? state.v : { kind: 'loading' };
}

/**
 * The editor's frame: the host page on the Document Server's origin in an iframe that exists only
 * while the view does. Unmounting sends «close» (the host destroys the editor), tells main to stop
 * allowing the origin, and React removes the iframe — the Document Server's JS, its socket and its
 * timers go with it. While it loads, one timer waits for the host's hello.
 */
function EditorFrame({ cfg, title, loading, onEvent, onConn }: { cfg: OfficeConfigResponse; title: string; loading: boolean; onEvent: (e: HostEvent) => void; onConn: (c: HostConnection | null) => void }): ReactNode {
  const ref = useRef<HTMLIFrameElement>(null);
  const greeted = useRef(false);
  const origin = originOf(cfg.docsUrl);
  useEffect(() => {
    const frame = ref.current;
    greeted.current = false;
    if (!frame || !origin) return;
    let conn: HostConnection | null = null;
    let live = true;
    // Electron: main asks the server it is logged in to for the Document Server origin and lets
    // exactly that origin's host page through its navigation guards (main/officeFrame.ts); a config
    // pointing anywhere else is not framed. The web has its own CSP (frame-src).
    void (platform.office ? platform.office.openFrame() : Promise.resolve(origin)).then((allowed) => {
      if (!live) return;
      if (allowed !== origin) {
        onEvent({ name: 'error', code: 'origin' });
        return;
      }
      conn = connectHost(window, frame, origin, cfg.configJson, onEvent, () => {
        greeted.current = true;
      });
      onConn(conn);
      frame.src = cfg.hostUrl;
    });
    // The theme follows the app while the editor is open (the host applies it if the editor supports that).
    const mo = new MutationObserver(() => conn?.setTheme(appTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      live = false;
      mo.disconnect();
      onConn(null);
      conn?.close();
      void platform.office?.closeFrame();
    };
  }, [cfg, origin, onEvent, onConn]);
  useEffect(() => {
    if (!loading) return;
    const timeout = (): void => onEvent({ name: 'error', code: 'timeout' });
    const hello = window.setTimeout(() => {
      if (!greeted.current) timeout();
    }, HELLO_TIMEOUT_MS);
    const ready = window.setTimeout(timeout, READY_TIMEOUT_MS);
    return () => {
      window.clearTimeout(hello);
      window.clearTimeout(ready);
    };
  }, [loading, onEvent]);
  return <iframe ref={ref} title={title} data-testid="office-frame" referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write" className="size-full border-0 bg-elev" />;
}

/** The view of the file tab whose editor exists (nothing without one). */
export const OfficeScreen = memo(function OfficeScreen(): ReactNode {
  const tab = useTaskTabs((s) => s.tabs.find((x) => x.id === s.fileMounted && x.kind === 'file'));
  return tab ? <OfficeView key={tab.id} tab={tab} /> : null;
});

/**
 * An opened file in the shell's content slot (ADR-0143): the editor with its own header (logo, name,
 * save state, co-editors, its «Открыть расположение файла» = back), no frame of ours around it; the
 * phone gets a full-screen view with a back bar. The mode is the server's (Disk bits; the phone and
 * view-only types always view). When the view is left the editor stays hidden only until it has
 * saved (or the wait ends: then the view comes back, edits kept), and is then torn down.
 */
function OfficeView({ tab }: { tab: TaskTab }): ReactNode {
  const id = tab.id;
  const source: OfficeSource = tab.itemId ? { itemId: tab.itemId } : { fileId: tab.fileId ?? '' };
  const name = tab.title;
  const [attempt, setAttempt] = useState(0);
  const load = useOfficeConfig(source, attempt);
  const [state, dispatch] = useReducer(frameReducer, FRAME_START);
  const phone = useUi((s) => s.phone.on);
  const shown = useTaskTabs((s) => s.fileActive === id);
  const closing = useTaskTabs((s) => s.fileClosing === id);
  const conn = useRef<HostConnection | null>(null);
  const onConn = useCallback((c: HostConnection | null) => {
    conn.current = c;
  }, []);
  const [saving, setSaving] = useState(false);

  const cap = officeCapability(name) ?? 'view';
  const view = load.kind === 'ready' ? viewOnly(cap, load.cfg.mode === OfficeMode.EDIT, phone) : true;
  const itemId = tab.itemId ?? '';
  const fileId = tab.fileId ?? '';
  // A legacy format (doc, xls, ppt) opens read-only: «Сохранить как» makes a modern copy. An
  // attachment opens read-only: «Сохранить в Диск» makes an editable one (into the root of its
  // workspace). The phone only views.
  const convert = !phone && load.kind === 'ready' ? convertTarget(name) : '';
  const attachment = !itemId && !phone && load.kind === 'ready' && diskWorkspace(tab.ws);
  const lossy = !view && load.kind === 'ready' && load.cfg.format?.lossy ? (load.cfg.format.extension || '') : '';

  // The editor's own «back» (goback → requestClose) leaves the view; its save runs on the way out.
  const onEvent = useCallback((e: HostEvent) => {
    if (e.name === 'requestClose') useTaskTabs.getState().leaveFile();
    else dispatch(e);
  }, []);

  // The tab's mark: a dot while changes are pending.
  useEffect(() => {
    useTaskTabs.getState().setFileMark(id, state.status === 'saving' ? 'dirty' : null);
  }, [id, state.status]);
  useEffect(() => () => useTaskTabs.getState().setFileMark(id, null), [id]);

  // Leaving the view (or «save and close»): ask for a save once, wait for the saved state, then the
  // editor goes. If it does not save in time nothing is lost: the view comes back with a warning.
  const asked = useRef(false);
  useEffect(() => {
    if (shown && !closing) {
      asked.current = false;
      return;
    }
    if (state.status !== 'saving') {
      if (closing) useTaskTabs.getState().removeFile(id);
      else useTaskTabs.getState().editorGone(id);
      return;
    }
    if (!asked.current) {
      asked.current = true;
      conn.current?.save();
    }
    const timer = window.setTimeout(() => {
      const st = useTaskTabs.getState();
      st.setFileMark(id, 'warn');
      st.setFileClosing(null);
      st.showFile(id);
      toast.info(t('office.saveFailed', { name }));
    }, SAVE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [shown, closing, state.status, id, name]);

  const retry = useCallback((): void => {
    dispatch({ name: 'reset' });
    setAttempt((n) => n + 1);
  }, []);

  // A hidden window (ADR-0143 §11, docs/14): after HIDDEN_PARK_MS with nothing unsaved the editor
  // goes (its iframe, socket and timers); when the window shows again it opens afresh. One
  // one-shot timer while hidden, none while shown.
  const pageVisible = usePageVisible();
  const [parked, setParked] = useState(false);
  useEffect(() => {
    if (pageVisible || parked || state.status === 'saving') return;
    const id = window.setTimeout(() => setParked(true), HIDDEN_PARK_MS);
    return () => window.clearTimeout(id);
  }, [pageVisible, parked, state.status]);
  useEffect(() => {
    if (!parked) return;
    const wake = (): void => {
      if (document.hidden) return;
      setParked(false);
      retry();
    };
    document.addEventListener('visibilitychange', wake);
    return () => document.removeEventListener('visibilitychange', wake);
  }, [parked, retry]);

  // Both make a NEW Disk item and open it as its own tab (the source stays as it is).
  const copy = (run: () => Promise<{ item?: DiskItem }>, failText: string, done: boolean): void => {
    setSaving(true);
    run().then(
      (r) => {
        setSaving(false);
        if (!r.item) return;
        if (done) toast.success(t('office.import.done', { name: r.item.name }));
        openOfficeFile({ itemId: r.item.id }, r.item.name, r.item.workspaceId);
      },
      (e: unknown) => {
        setSaving(false);
        toast.fail(e, failText);
      },
    );
  };
  // «Скачать»: the original file as saved so far (a Disk item: its current version), through the one download path.
  const download = (): void => {
    if (!itemId) downloadFile({ id: fileId, name });
    else
      void diskApi.get(itemId).then(
        (r) => r.item && downloadItem(r.item),
        (e: unknown) => toast.fail(e, t('err.ctx.download')),
      );
  };
  const saveAs = (): void => copy(() => (itemId ? officeApi.convertItem(itemId) : officeApi.convertFile(tab.ws, fileId, '')), t('office.saveAs.failed'), false);
  const saveToDisk = (): void => copy(() => officeApi.importFile(tab.ws, fileId, ''), t('office.import.failed'), true);

  const failed = load.kind === 'error' || state.status === 'error';
  const message =
    load.kind === 'error'
      ? load.why === 'unsupported'
        ? t('office.unsupported')
        : load.why === 'unavailable'
          ? t('office.unavailable')
          : t('office.failed')
      : state.problem === 'unreachable'
        ? t('office.unreachable')
        : state.problem === 'token'
          ? t('office.token')
          : t('office.error');
  const canRetry = !(load.kind === 'error' && (load.why === 'unsupported' || load.why === 'unavailable'));
  const frameLoading = load.kind === 'loading' || (load.kind === 'ready' && state.status === 'loading');

  return (
    <div
      className={cx(
        'mat-content flex min-w-0 flex-col overflow-hidden',
        phone ? 'fixed inset-0 z-[var(--z-modal)] pb-(--safe-bottom) pt-(--safe-top)' : 'relative flex-1 rounded-tl-[var(--radius-panel)] border-l border-t border-[var(--color-panel-edge)]',
        !shown && 'hidden',
      )}
      data-testid="office-view"
      data-state={failed ? 'error' : load.kind === 'ready' ? state.status : load.kind}
      data-mode={view ? 'view' : 'edit'}
    >
      {phone ? (
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1">
          <IconButton label={t('shell.back')} onClick={() => useTaskTabs.getState().leaveFile()} data-testid="office-back" className="mobile:size-11">
            <ArrowLeft className="size-5" aria-hidden />
          </IconButton>
          <span className="min-w-0 flex-1 truncate text-body font-medium" title={name}>
            {name}
          </span>
          <span className="mr-2 inline-flex h-6 shrink-0 items-center rounded-full bg-hover px-2.5 text-caption font-medium text-muted" data-testid="office-view-badge">
            {t('office.view')}
          </span>
        </div>
      ) : null}
      {/* A legacy format or an attachment: view only, with the way to an editable copy and «Скачать».
          A file edited in place has no bar of ours (docs/08): the editor's «Файл → Скачать как» saves it. */}
      {convert || attachment ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-caption text-muted" data-testid={convert ? 'office-convert-notice' : 'office-attachment-notice'}>
          <span className="min-w-0">{convert ? t('office.convert', { ext: convert }) : t('office.attachment')}</span>
          <span className="flex shrink-0 gap-2">
            {phone ? null : (
              <Button variant="secondary" size="sm" onClick={download} data-testid="office-download">
                <Download className="size-4" aria-hidden /> {t('chat.download')}
              </Button>
            )}
            {attachment ? (
              <Button variant="secondary" size="sm" onClick={saveToDisk} disabled={saving} data-testid="office-import">
                {t('office.import')}
              </Button>
            ) : null}
            {convert && (itemId || attachment) ? (
              <Button variant="secondary" size="sm" onClick={saveAs} disabled={saving} data-testid="office-save-as">
                {t('office.saveAs', { ext: convert })}
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
      {/* odt, ods, odp, rtf, csv, txt are saved back in their own format (the Document Server's lossy-edit). */}
      {lossy ? (
        <div className="shrink-0 border-b border-line px-3 py-1.5 text-caption text-muted" data-testid="office-lossy-notice">
          {t('office.lossy', { ext: lossy })}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {load.kind === 'ready' && !failed && !parked ? <EditorFrame cfg={load.cfg} title={name} loading={state.status === 'loading'} onEvent={onEvent} onConn={onConn} /> : null}
        {failed ? (
          <div role="alert" className="grid size-full place-items-center p-6 text-center" data-testid="office-error">
            <div className="flex max-w-[360px] flex-col items-center gap-3">
              <p className="text-body text-fg">{message}</p>
              {canRetry ? (
                <Button variant="secondary" size="sm" onClick={retry} data-testid="office-retry">
                  <RotateCw className="size-4" aria-hidden /> {t('common.retry')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {frameLoading && !failed ? (
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            <Spinner className="size-6 text-muted" label={t('office.loading')} />
          </span>
        ) : null}
      </div>
      {/* The bottom island (mute, the self panel) stays over the shell in a call: the editor ends
          above it, its status bar never under the island (docs/08 «Нижний островок», like the mail list). */}
      {phone ? null : <div aria-hidden className="shrink-0" style={{ height: 'calc(var(--island-height, -12px) + 12px)' }} data-testid="office-island-spacer" />}
    </div>
  );
}
