import type { Achievement } from '@calaba/protocol';
import { memo, type CSSProperties, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { cx } from '../../components/ui';

/**
 * An achievement picture (ADR-0061 §2): a 512×512 WebP with a transparent background, shown on
 * any surface without a backing (the transparency is the point), at 24 / 28 / 40 / 64 / 96 / 160.
 * Loaded through the authenticated media path (MediaImg), lazily; an unknown achievement (the
 * catalog is still loading) keeps the place with an empty box.
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
  if (!achievement?.imageUrl) return <span className={cx('inline-block shrink-0', className)} style={style} aria-hidden />;
  // The box keeps the size while the authenticated URL resolves (MediaImg renders a bare span then).
  return (
    <span className={cx('inline-block shrink-0', className)} style={style}>
      <MediaImg
        path={achievement.imageUrl}
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
