import type { AutomationCard as Card } from '@calaba/protocol';
import { Cog } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { t } from '../../i18n';
import { openTaskAnywhere } from '../../services/boards';
import { useBoards } from '../../stores/boards';
import { StatusIcon, colorCss } from './visuals';

/**
 * A message of a board automation rule (ADR-0060, SystemMessage.automation): in a text room
 * (`notify_room`) or the task's comments (`comment`). «⚙ Автоматизация: <правило>» instead of the
 * author, the rendered text, and — in a room — the task as the chat's task card (key, title,
 * status from the store when the task is loaded); a click opens the task panel.
 */
export const AutomationCardView = memo(function AutomationCardView({ card, workspaceId, roomId }: { card: Card; workspaceId: string; roomId: string }): ReactNode {
  // In the task's own comments the task card would point at itself.
  const inTask = useBoards((s) => !!card.taskId && s.roomTask[roomId] === card.taskId);
  const task = useBoards((s) => (card.taskId ? s.tasks[card.taskId] : undefined));
  const status = useBoards((s) => (task ? s.boards[task.boardId]?.statuses.find((x) => x.id === task.statusId) : undefined));
  const who = card.ruleName ? t('rules.actorNamed', { name: card.ruleName }) : t('rules.actor');
  return (
    <article className="flex w-full min-w-0 flex-col gap-1.5 rounded-[var(--radius-card)] border border-line bg-[var(--color-card)] px-3 py-2" aria-label={who} data-testid="automation-card">
      <span className="flex min-w-0 items-center gap-1.5 text-caption font-medium text-muted">
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[var(--color-fill-hover)] text-fg" aria-hidden>
          <Cog className="size-3" />
        </span>
        <span className="truncate">{who}</span>
      </span>
      {card.text ? <p className="selectable whitespace-pre-wrap break-words text-body text-fg">{card.text}</p> : null}
      {!inTask && card.taskId ? (
        <button
          type="button"
          onClick={() => openTaskAnywhere({ id: card.taskId, workspaceId, boardId: card.boardId })}
          className="flex min-w-0 max-w-[400px] items-start gap-1.5 rounded-[var(--radius-row)] border-l-[3px] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] py-1.5 pl-2 pr-2 text-left hover:bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]"
          style={{ borderLeftColor: status ? colorCss(status.color) : 'var(--color-accent)' }}
          data-testid="automation-task"
        >
          {status ? <StatusIcon type={status.type} color={status.color} className="mt-[3px]" /> : null}
          <span className="line-clamp-2 min-w-0 text-body font-semibold leading-5 text-fg">
            {task ? <span className="mr-1.5 font-normal tabular-nums text-muted">{task.key}</span> : null}
            {task?.title ?? t('boards.task')}
          </span>
        </button>
      ) : null}
    </article>
  );
});
