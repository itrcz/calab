import { X } from 'lucide-react';
import { memo, useCallback, type ReactNode } from 'react';
import type { MailDraftAttachment } from '../../../shared/mail';
import { IconButton } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { mailApi } from '../../stores/mail';
import { fileIcon } from './Attachments';
import { attachmentsSize } from './compose';

const PREVIEW = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

/**
 * The composer's attachments (owner 12.10): a strip of chips under «Тема», above the text — never
 * inside it. A chip: thumbnail (images) or type icon, name, size, «×». The total with more than one
 * file; past 25 MB an inline error (§6).
 */
export function ComposeAttachments({ list, overLimit, onRemove }: { list: MailDraftAttachment[]; overLimit: boolean; onRemove: (id: string) => void }): ReactNode {
  if (!list.length && !overLimit) return null;
  const total = attachmentsSize(list);
  return (
    <div className="flex flex-col gap-1.5 border-b border-line py-2" data-testid="compose-attachments">
      {list.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('mbox.attach')}>
          {list.map((a) => (
            <Chip key={a.id} a={a} onRemove={onRemove} />
          ))}
        </ul>
      ) : null}
      {list.length > 1 || overLimit ? (
        <p className="flex gap-2 text-caption">
          {list.length > 1 ? <span className="text-muted">{t('mbox.attachTotal', { size: fmt.size(total) })}</span> : null}
          {overLimit ? (
            <span className="text-danger-text" role="alert" data-testid="compose-attach-error">
              {t('mbox.tooBig')}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

const THUMB = 'size-6 shrink-0 rounded-[4px] object-cover';

const Chip = memo(function Chip({ a, onRemove }: { a: MailDraftAttachment; onRemove: (id: string) => void }): ReactNode {
  const image = PREVIEW.test(a.mime);
  const forwarded = image && a.kind === 'message' ? (mailApi()?.attachmentUrl(a.messageId, a.attachmentId) ?? null) : null;
  return (
    <li className="inline-flex h-9 max-w-[260px] items-center gap-2 rounded-[8px] bg-hover pl-1.5 pr-1 text-caption text-fg" data-testid="compose-attachment">
      {image && a.kind === 'file' ? (
        <FileThumb data={a.data} mime={a.mime} />
      ) : forwarded ? (
        <img src={forwarded} alt="" className={THUMB} draggable={false} />
      ) : (
        <span className="grid size-6 shrink-0 place-items-center">{fileIcon(a.mime, 'size-4 shrink-0 text-muted')}</span>
      )}
      <span className="min-w-0 truncate">{a.name}</span>
      <span className="shrink-0 tabular-nums text-muted">{fmt.size(a.size)}</span>
      <IconButton label={t('mbox.removeAttachment', { name: a.name })} size="sm" tip={false} className="size-6" onClick={() => onRemove(a.id)}>
        <X className="size-3.5" />
      </IconButton>
    </li>
  );
});

/** A picked image's thumbnail: an object URL set on the element and revoked with it (no state, no re-render). */
function FileThumb({ data, mime }: { data: Uint8Array; mime: string }): ReactNode {
  const ref = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img || typeof URL.createObjectURL !== 'function') return;
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
      img.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [data, mime],
  );
  return <img ref={ref} alt="" className={THUMB} draggable={false} />;
}
