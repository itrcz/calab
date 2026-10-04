import type { Achievement } from '@calaba/protocol';
import { Award } from 'lucide-react';
import { memo, type CSSProperties, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { cx } from '../../components/ui';
import { filePath } from '../../lib/api/endpoints';

/**
 * An achievement picture (ADR-0061 §2): a 512×512 WebP with a transparent background, shown on
 * any surface without a backing (the transparency is the point), at 24 / 28 / 40 / 64 / 96 / 160.
 * The picture is a file of the workspace (ADR-0061 amendment 1: `GET /api/files/{fileId}`, the
 * authenticated media path as badge pictures), loaded lazily; an unknown achievement (the catalog
 * is still loading) keeps the place with an empty box, one without a picture (`fileId` empty: a
 * migrated entry whose picture is still being copied) shows a neutral placeholder.
 */
export const AchievementImg = memo(function AchievementImg({
  achievement,
  size,
  className,
  alt = '',
  title,
  eager = false,
}: {
  achievement: Achievement | undefined;
  size: number;
  className?: string;
  alt?: string;
  title?: string;
  eager?: boolean;
}): ReactNode {
  const style: CSSProperties = { width: size, height: size };
  if (!achievement) return <span className={cx('inline-block shrink-0', className)} style={style} aria-hidden />;
  if (!achievement.fileId) {
    return (
      <span
        className={cx('inline-grid shrink-0 place-items-center rounded-full bg-hover text-faint', className)}
        style={style}
        title={title}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        data-testid="achievement-placeholder"
      >
        <Award style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }} strokeWidth={1.5} aria-hidden />
      </span>
    );
  }
  // The box keeps the size while the authenticated URL resolves (MediaImg renders a bare span then).
  return (
    <span className={cx('inline-block shrink-0', className)} style={style}>
      <MediaImg
        path={filePath(achievement.fileId)}
        alt={alt}
        title={title}
        width={size}
        height={size}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        className="achievement-img block size-full object-contain"
      />
    </span>
  );
});
