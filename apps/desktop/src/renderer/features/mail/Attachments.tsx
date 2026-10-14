import { Download, FileArchive, FileImage, FileSpreadsheet, FileText, File as FileIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MailMessage } from '../../../shared/mail';
import { plural, t } from '../../i18n';
import { fmt } from '../../lib/format';
import type { LightboxImage } from '../../lib/lightbox';
import { mailApi } from '../../stores/mail';
import { useUi } from '../../stores/ui';

/** Image types the strip previews and the lightbox opens (the protocol serves `image/*` inline only, §10). */
const PREVIEW = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

/** A file-type icon by MIME (the reader's tiles and the composer's chips). */
export function fileIcon(mime: string, cls = 'size-5 shrink-0 text-muted'): ReactNode {
  if (mime.startsWith('image/')) return <FileImage className={cls} aria-hidden />;
  if (/zip|rar|7z|tar|gzip/.test(mime)) return <FileArchive className={cls} aria-hidden />;
  if (/sheet|excel|csv/.test(mime)) return <FileSpreadsheet className={cls} aria-hidden />;
  if (/pdf|word|text|document|rtf/.test(mime)) return <FileText className={cls} aria-hidden />;
  return <FileIcon className={cls} aria-hidden />;
}

/**
 * The attachments under the body (§8): images as previews (a click opens the app's lightbox), other
 * files as a tile with icon, name and size. A tile is a plain link to the attachment URL without
 * `download`: the window navigating there is main's cue to save it into Downloads with its name
 * (frameGuard.ts: quarantine / Mark-of-the-Web, then revealed). In the mock (a data: URL) the
 * renderer's guards drop the navigation. Inline images shown in the body are not repeated.
 */
export function AttachmentStrip({ message }: { message: MailMessage }): ReactNode {
  const api = mailApi();
  const list = message.attachments.filter((a) => !a.inline);
  if (!list.length || !api) return null;
  const images = list.filter((a) => PREVIEW.test(a.mime));
  const gallery: LightboxImage[] = images.map((a) => ({ fileId: `mail:${message.id}:${a.id}`, name: a.name, mime: a.mime, width: 0, height: 0, src: api.attachmentUrl(message.id, a.id) }));
  return (
    <section className="flex flex-col gap-2 border-t border-line px-4 py-3" aria-label={plural('mbox.attachmentsCount', list.length)} data-testid="mail-attachments">
      <h3 className="text-caption font-medium text-muted">{plural('mbox.attachmentsCount', list.length)}</h3>
      <ul className="flex flex-wrap gap-2">
        {list.map((a) => {
          const url = api.attachmentUrl(message.id, a.id);
          const imageAt = images.indexOf(a);
          return (
            <li key={a.id}>
              {imageAt >= 0 ? (
                <button
                  type="button"
                  className="group flex w-40 flex-col overflow-hidden rounded-[8px] border border-line bg-[var(--color-bg)] text-left hover:bg-hover"
                  onClick={() => useUi.getState().openDialog({ kind: 'image', images: gallery, index: imageAt })}
                  title={a.name}
                >
                  <img src={url} alt="" draggable={false} className="h-24 w-full bg-hover object-cover" loading="lazy" />
                  <span className="flex min-w-0 flex-col px-2 py-1.5">
                    <span className="truncate text-caption font-medium text-fg">{a.name}</span>
                    <span className="text-micro text-muted">{fmt.size(a.size)}</span>
                  </span>
                </button>
              ) : (
                <a
                  href={url}
                  draggable={false}
                  className="flex h-12 w-56 items-center gap-2 rounded-[8px] border border-line bg-[var(--color-bg)] px-2.5 text-left hover:bg-hover"
                  title={t('mbox.download')}
                  aria-label={`${a.name}, ${fmt.size(a.size)} — ${t('mbox.download')}`}
                  data-testid="mail-attachment-download"
                >
                  {fileIcon(a.mime)}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-caption font-medium text-fg">{a.name}</span>
                    <span className="text-micro text-muted">{fmt.size(a.size)}</span>
                  </span>
                  <Download className="size-3.5 shrink-0 text-muted" aria-hidden />
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
