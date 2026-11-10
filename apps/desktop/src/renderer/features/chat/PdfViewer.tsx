import * as DialogP from '../../components/radix/dialog';
import { Download, Send } from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { IconButton, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { filePath } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { platform } from '../../platform';
import { downloadFile } from '../../services/files';
import { ViewerBar, onDark } from './Lightbox';

type PdfState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error' };

/**
 * The file as a blob: URL typed application/pdf (ADR-0103): the API serves it as an attachment with
 * `CSP: sandbox` (a frame on its URL would download it), so the bytes are fetched with the token
 * and shown from memory. Closing aborts the fetch and frees the blob. One file per mount (the
 * dialog is keyed by the file id).
 */
function usePdfBlob(path: string): PdfState {
  const [state, setState] = useState<PdfState>({ kind: 'loading' });
  useEffect(() => {
    const ac = new AbortController();
    let url: string | null = null;
    platform
      .apiFetch(path, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (ac.signal.aborted) return;
        // Typed by us, never sniffed: only Chromium's PDF viewer renders it, never as a page.
        url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        setState({ kind: 'ready', url });
      })
      .catch(() => {
        if (!ac.signal.aborted) setState({ kind: 'error' });
      });
    return () => {
      ac.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return state;
}

/**
 * Full-window PDF viewer (ADR-0103), the Lightbox's frame: name and size, «Скачать», «Закрыть»;
 * the document in Chromium's built-in viewer (pages, zoom, search, print). A click outside the
 * document or Esc closes; unmounting drops the frame and the blob, nothing keeps running.
 */
export function PdfViewer({
  file,
  onClose,
  onSendToChat,
  path,
  onDownload,
  noDownload = false,
}: {
  file: { id: string; name: string; size: bigint };
  onClose: () => void;
  /** Opened from the Disk (CBF-20): «Отправить в чат». */
  onSendToChat?: () => void;
  /** Another source of the bytes (a public Disk link, ADR-0165); default GET /api/files/{id}. */
  path?: string;
  /** «Скачать» of that source; default the file download. */
  onDownload?: () => void;
  /** No «Скачать» at all (a «Без скачивания» public link, ADR-0167). */
  noDownload?: boolean;
}): ReactNode {
  const state = usePdfBlob(path ?? filePath(file.id));
  const closeOnBackdrop = (e: MouseEvent): void => {
    if (e.target === e.currentTarget) onClose();
  };
  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag anim-in fixed inset-0 z-[var(--z-modal)] bg-[rgb(0_0_0/82%)]" />
        <DialogP.Content
          aria-modal="true"
          data-testid="pdf-viewer"
          data-state={state.kind}
          className="anim-in fixed inset-0 z-[var(--z-modal)] flex flex-col focus:outline-none"
          // Focus the viewer itself (not the first button: its tooltip would swallow the first Esc).
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <ViewerBar title={file.name} meta={fmt.size(file.size)}>
            {onSendToChat ? (
              <IconButton label={t('disk.sendToChat')} onClick={onSendToChat} className={onDark} data-testid="pdf-send">
                <Send className="size-5" />
              </IconButton>
            ) : null}
            {noDownload ? null : (
              <IconButton label={t('lightbox.download')} onClick={onDownload ?? (() => downloadFile(file))} className={onDark} data-testid="pdf-download">
                <Download className="size-5" />
              </IconButton>
            )}
          </ViewerBar>
          <div className="grid min-h-0 flex-1 place-items-center px-6 pb-6 mobile:px-2" onClick={closeOnBackdrop}>
            {state.kind === 'ready' ? (
              <iframe
                src={state.url}
                title={file.name}
                data-testid="pdf-frame"
                className="size-full rounded-[var(--radius-card)] border-0 bg-elev shadow-[var(--shadow-popover)]"
              />
            ) : state.kind === 'loading' ? (
              <span className="grid size-12 place-items-center rounded-full bg-[rgb(0_0_0/50%)]">
                <Spinner className="size-6 text-[color:var(--color-on-accent)]" label={t('pdfViewer.loading')} />
              </span>
            ) : (
              <span role="alert" className="rounded-full bg-[rgb(0_0_0/60%)] px-3 py-1.5 text-caption text-[color:var(--color-on-accent)]">
                {t('pdfViewer.failed')}
              </span>
            )}
          </div>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}
