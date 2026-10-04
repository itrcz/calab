import type { CSSProperties, ReactNode } from 'react';
import { stickerSrc } from '@/lib/stickers';
import { cx } from './ui';

/**
 * One topic sticker per screenshot. On wide screens it slides out from behind the frame towards the text column
 * and settles, fully visible, in the free space above or below the text (`v`); stacked (narrow) layouts show none.
 * The slide is a one-shot CSS transition driven by `.is-visible` from StoryMotion
 * (transform/opacity only, no scroll code). Fixed values: no hydration drift.
 */
// `below`: under the shot's bottom edge, for short shots where the text column has no room below the text.
type Placement = { asset: string; v: 'top' | 'bottom' | 'below'; angle: number };
export type StickerSet = 'voice' | 'chat' | 'calendar' | 'kanban';

// Chat has none: its screenshot already shows a sticker.
const STICKER: Partial<Record<StickerSet, Placement>> = {
  voice: { asset: 'headphones', v: 'top', angle: -10 },
  calendar: { asset: 'calendar', v: 'top', angle: 8 },
  kanban: { asset: 'tasks', v: 'below', angle: -9 },
};

/** `side`: where the text column is relative to the screenshot. */
export function ShotStage({ set, side, className, children }: { set: StickerSet; side: 'left' | 'right'; className?: string; children: ReactNode }) {
  const s = STICKER[set];
  if (!s) return <div className={className}>{children}</div>;
  return (
    <div className={cx('shot-stage', className)} data-side={side} data-v={s.v} data-reveal>
      <span className="shot-stickers" aria-hidden="true">
        <img src={stickerSrc(s.asset)} alt="" width={128} height={128} loading="lazy" decoding="async" draggable={false} style={{ '--a': `${s.angle}deg` } as CSSProperties} />
      </span>
      <div className="shot-stage-body">{children}</div>
    </div>
  );
}
