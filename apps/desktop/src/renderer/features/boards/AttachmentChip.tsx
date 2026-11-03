import type { FileMeta } from '@calaba/protocol';
import { Download, Paperclip, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import * as ContextMenu from '../../components/radix/context-menu';
import { downloadFile, openAttachment } from '../../services/files';
import { menuBox, menuItem } from '../shell/menu';

/**
 * One attachment of a task's description: the name opens it (ADR-0103: a picture → the Lightbox,
 * a PDF → the PDF viewer, the rest is downloaded) — a button, never a link to `/api/files/{id}`
 * (services/files.ts downloadFile: such a link did nothing in the desktop app). `onRemove`: «×».
 */
export function AttachmentChip({ file, list, onRemove }: { file: FileMeta; list: readonly FileMeta[]; onRemove?: (f: FileMeta) => void }): ReactNode {
  const chip = (
    <span className="group/chip inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-full border border-line pl-2 pr-1 text-caption" data-testid="task-attachment">
      <Paperclip className="size-3.5 shrink-0 text-muted" aria-hidden />
      <button type="button" onClick={() => openAttachment(file, list)} title={`${file.name} · ${fmt.size(file.size)}`} className="min-w-0 truncate rounded-[var(--radius-row)] text-left hover:underline" data-testid="task-attachment-open">
        {file.name}
      </button>
      {/* «Скачать» saves the file without opening it (desktop: on hover / focus and in the menu; phone: always, no hover there).
          Phone: the 20 px glyph keeps a 44 px target (docs/08) — `before:` 12 px out on every side, 6 px margins so it stays clear of the name and «×». */}
      <button
        type="button"
        aria-label={t('chat.download') + ' ' + file.name}
        title={t('chat.download')}
        onClick={() => downloadFile(file)}
        className="relative grid size-5 shrink-0 place-items-center rounded-full text-muted opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/chip:opacity-100 mobile:mx-1.5 mobile:opacity-100 mobile:before:absolute mobile:before:-inset-3 mobile:before:content-['']"
        data-testid="task-attachment-download"
      >
        <Download className="size-3" aria-hidden />
      </button>
      {onRemove ? (
        <button type="button" aria-label={t('boards.removeAttachment', { name: file.name })} onClick={() => onRemove(file)} className="grid size-5 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{chip}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuBox} onCloseAutoFocus={(e) => e.preventDefault()} data-testid="task-attachment-menu">
          <ContextMenu.Item className={menuItem} onSelect={() => openAttachment(file, list)}>
            {t('disk.open')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => downloadFile(file)} data-testid="task-attachment-menu-download">
            <Download className="size-4" aria-hidden /> {t('chat.download')}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
