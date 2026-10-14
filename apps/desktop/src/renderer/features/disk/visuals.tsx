import type { DiskItem } from '@calaba/protocol';
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Link2,
  Lock,
  Presentation,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { fileKind, isFolder, type FileKind } from '../../lib/disk';

/** Type glyphs (lucide, as elsewhere) and their tint: the kind reads at a glance in a grid of files. */
const KIND: Record<FileKind, { icon: LucideIcon; tone: string }> = {
  image: { icon: FileImage, tone: 'text-[var(--color-green-text)]' },
  video: { icon: FileVideo, tone: 'text-[var(--color-red-text)]' },
  audio: { icon: FileAudio, tone: 'text-accent-text' },
  pdf: { icon: FileText, tone: 'text-[var(--color-red-text)]' },
  archive: { icon: FileArchive, tone: 'text-[var(--color-warn-text)]' },
  sheet: { icon: FileSpreadsheet, tone: 'text-[var(--color-green-text)]' },
  slides: { icon: Presentation, tone: 'text-[var(--color-warn-text)]' },
  doc: { icon: FileText, tone: 'text-accent-text' },
  code: { icon: FileCode, tone: 'text-muted' },
  text: { icon: FileText, tone: 'text-muted' },
  other: { icon: File, tone: 'text-muted' },
};

/** The item's glyph: a filled accent folder, or the file kind's icon. */
export function ItemGlyph({ item, className }: { item: DiskItem; className: string }): ReactNode {
  if (isFolder(item)) return <Folder className={cx(className, 'fill-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] text-accent')} strokeWidth={1.5} aria-hidden />;
  const k = KIND[fileKind(item.file)];
  const Icon = k.icon;
  return <Icon className={cx(className, k.tone)} strokeWidth={1.5} aria-hidden />;
}

/** A tile's picture: the image thumbnail (lazy) or the glyph on the tile's plate. */
export const ItemPicture = memo(function ItemPicture({ item }: { item: DiskItem }): ReactNode {
  const thumb = !isFolder(item) && item.file?.thumbnailUrl ? item.file.id : '';
  if (thumb) return <MediaImg path={thumbnailPath(thumb)} alt="" loading="lazy" decoding="async" draggable={false} className="block size-full object-cover" />;
  return (
    <span className="grid size-full place-items-center">
      <ItemGlyph item={item} className="size-12" />
    </span>
  );
});

/** Badges of an item: restricted («Только выбранные»), shared (own overrides), a public link. */
export function ItemBadges({ item, className }: { item: DiskItem; className?: string }): ReactNode {
  if (!item.restricted && !item.shared && !item.link) return null;
  return (
    <span className={cx('flex shrink-0 items-center gap-1 text-muted', className)} data-testid="disk-badges">
      {item.restricted ? (
        <span title={t('disk.badge.restricted')} aria-label={t('disk.badge.restricted')} role="img">
          <Lock className="size-3.5" aria-hidden />
        </span>
      ) : item.shared ? (
        <span title={t('disk.badge.shared')} aria-label={t('disk.badge.shared')} role="img">
          <Users className="size-3.5" aria-hidden />
        </span>
      ) : null}
      {item.link ? (
        <span title={t('disk.badge.link')} aria-label={t('disk.badge.link')} role="img">
          <Link2 className="size-3.5" aria-hidden />
        </span>
      ) : null}
    </span>
  );
}
