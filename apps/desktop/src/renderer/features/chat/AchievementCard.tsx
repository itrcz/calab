import type { AchievementCard as Card } from '@calaba/protocol';
import type { Timestamp } from '@bufbuild/protobuf/wkt';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { memo, useCallback, type ReactNode } from 'react';
import { t } from '../../i18n';
import { useAchievement } from '../../lib/achievementCatalog';
import { fmt } from '../../lib/format';
import { useMobile } from '../../lib/mobile';
import { useAchievementUi } from '../../stores/achievementUi';
import { useMemberName } from '../../stores/workspaces';
import { AchievementImg } from '../people/AchievementImg';
import { openProfile } from '../people/actions';

/**
 * «Имя получает ачивку» (ADR-0061 §4–5, docs/08 «Ачивки»): the system card the server posts into
 * the general chat when an achievement is granted with «Рассказать в общем чате». The author is
 * the recipient. A full-width card on `.achievement-surface` (accent → warm gold, white text):
 * the picture 96 px (phone 64) with no backing, then the overline «ДОСТИЖЕНИЕ», the title, «**Имя**
 * получает ачивку» (the name opens the profile), the note «за что» in quotes, «Вручил(а) Имя ·
 * 3 окт.». The picture and the title open the viewer. No animation here.
 */
export const AchievementCardView = memo(function AchievementCardView({
  authorId,
  card,
  workspaceId,
  roomId,
  messageId,
  createdAt,
}: {
  authorId: string;
  card: Card;
  workspaceId: string;
  roomId: string;
  messageId: string;
  createdAt: Timestamp | undefined;
}): ReactNode {
  const a = useAchievement(workspaceId, card.achievementId);
  const mobile = useMobile();
  const name = useMemberName(workspaceId, authorId);
  const by = useMemberName(workspaceId, card.grantedBy);
  const at = createdAt ? timestampMs(createdAt) : 0;
  const title = a?.title ?? t('ach.unknown');
  const open = useCallback(() => {
    useAchievementUi.getState().openView({
      achievementId: card.achievementId,
      workspaceId,
      userId: authorId,
      fromChat: true,
      grants: [{ id: card.grantId, note: card.note, grantedBy: card.grantedBy, grantedAt: at, messageId, roomId }],
    });
  }, [card, workspaceId, authorId, at, messageId, roomId]);
  const [before, after] = t('ach.receives').split('{name}');
  return (
    <article
      aria-label={t('ach.cardAria', { name, title })}
      data-testid="achievement-card"
      className="achievement-surface relative flex w-full items-center gap-4 overflow-hidden rounded-[var(--radius-card)] px-5 py-4 shadow-[var(--shadow-card)] mobile:gap-3 mobile:px-3 mobile:py-3"
    >
      <button type="button" className="shrink-0 rounded-[var(--radius-control)]" onClick={open} aria-label={t('ach.view.open', { title })}>
        <AchievementImg achievement={a} size={mobile ? 64 : 96} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-caption font-semibold uppercase tracking-wide opacity-70">{t('ach.overline')}</p>
        <button type="button" className="min-w-0 self-start truncate rounded-[var(--radius-control)] text-left text-body font-semibold hover:underline" onClick={open}>
          {title}
        </button>
        <p className="min-w-0 text-body">
          {before}
          <button
            type="button"
            className="rounded-[var(--radius-control)] font-semibold hover:underline"
            onClick={() => (workspaceId ? openProfile(workspaceId, authorId) : undefined)}
          >
            {name}
          </button>
          {after}
        </p>
        {card.note ? <p className="selectable mt-1 break-words text-body">«{card.note}»</p> : null}
        <p className="mt-1 text-caption opacity-80">{at ? t('ach.grantedBy', { name: by, date: fmt.dayMonth(new Date(at)) }) : t('ach.grantedByOnly', { name: by })}</p>
      </div>
    </article>
  );
});
