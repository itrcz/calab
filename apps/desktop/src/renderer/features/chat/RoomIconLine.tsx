import type { RoomIconCard } from '@calaba/protocol';
import { memo, type ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { t } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { useUi } from '../../stores/ui';
import { useMemberName } from '../../stores/workspaces';

/**
 * «Анна изменила картинку комнаты» (ADR-0092 §2): a centred service line across the feed, like
 * Telegram's «changed the group photo» — the new picture as a 40 px circle before the text (a tap
 * opens it in the lightbox), no picture when it was removed. No bubble, avatar or actions.
 */
export const RoomIconLine = memo(function RoomIconLine({ card, authorId, workspaceId }: { card: RoomIconCard; authorId: string; workspaceId: string }): ReactNode {
  const name = useMemberName(workspaceId, authorId);
  const fileId = card.fileId;
  const text = t(fileId ? 'room.iconChanged' : 'room.iconRemoved', { name });
  return (
    <div className="flex justify-center py-1" data-testid="room-icon-line">
      <div className="flex min-w-0 max-w-full items-center gap-2 rounded-full bg-[var(--color-fill)] py-1 pl-1 pr-3 text-caption text-muted">
        {fileId ? (
          <button
            type="button"
            aria-label={t('room.iconOpen')}
            className="shrink-0 rounded-full"
            onClick={() => useUi.getState().openDialog({ kind: 'image', images: [{ fileId, name: '', width: 0, height: 0 }], index: 0 })}
          >
            <MediaImg path={thumbnailPath(fileId)} alt="" draggable={false} className="size-10 rounded-full bg-[var(--color-fill-hover)] object-cover" />
          </button>
        ) : (
          <span className="w-2" aria-hidden />
        )}
        <span className="min-w-0 truncate">{text}</span>
      </div>
    </div>
  );
});
