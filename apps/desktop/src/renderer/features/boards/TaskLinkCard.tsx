import type { UnfurlResponse } from '@calaba/protocol';
import { SquareKanban } from 'lucide-react';
import { memo, useMemo, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { linkCard } from '../../lib/boards/card';
import { openBoardLink, openTaskAnywhere } from '../../services/boards';
import { useBoards } from '../../stores/boards';
import { MemberAvatar, useToday } from './menus';
import { StatusIcon, colorCss, formatDue, isOverdue } from './visuals';

/**
 * A `/t/<KEY-N>` or `/b/<id>` link in a message (ADR-0042 §5 «Ссылки»): a card instead of the
 * web preview — key, title, status, assignees, due date — from the server's unfurl (by the
 * viewer's rights), live from the boards store when the task / board is loaded there. A click
 * opens the task panel / the board in the app.
 */
export const TaskLinkCard = memo(function TaskLinkCard({ res, href }: { res: UnfurlResponse; href: string }): ReactNode {
  const taskId = res.task?.id ?? '';
  const boardId = res.task?.boardId ?? res.board?.id ?? '';
  const liveTask = useBoards((s) => (taskId ? s.tasks[taskId] : undefined));
  const liveBoard = useBoards((s) => (boardId ? s.boards[boardId] : undefined));
  const card = useMemo(() => linkCard(res, { task: liveTask, board: liveBoard }), [res, liveTask, liveBoard]);
  const today = useToday();
  if (!card) return null;
  const open = (e: MouseEvent): void => {
    e.preventDefault();
    if (card.kind === 'task') openTaskAnywhere({ id: card.id, workspaceId: card.workspaceId, boardId: card.boardId });
    else openBoardLink('board', card.id);
  };
  const box =
    'mt-1.5 flex w-full min-w-0 max-w-[400px] flex-col gap-1 rounded-[var(--radius-row)] border-l-[3px] bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] py-1.5 pl-2 pr-2 text-left hover:bg-[color-mix(in_srgb,var(--bubble-accent)_16%,transparent)]';
  if (card.kind === 'board') {
    return (
      <a href={href} onClick={open} className={box} style={{ borderLeftColor: 'var(--bubble-accent)' }} data-testid="board-link-card">
        <span className="flex min-w-0 items-center gap-1.5 text-body font-semibold text-fg">
          <span aria-hidden>{card.emoji || <SquareKanban className="size-4" />}</span>
          <span className="truncate">{card.name}</span>
        </span>
        <span className="text-caption text-[color:var(--bubble-meta)]">{t('boards.card.board', { key: card.key, n: card.openTasks })}</span>
      </a>
    );
  }
  const overdue = isOverdue(card.dueOn, today, card.done);
  return (
    <a href={href} onClick={open} className={box} style={{ borderLeftColor: colorCss(card.statusColor) }} data-testid="task-link-card">
      <span className="flex min-w-0 items-start gap-1.5">
        <StatusIcon type={card.statusType} color={card.statusColor} icon={card.statusIcon} className="mt-[3px]" />
        <span className="line-clamp-2 min-w-0 text-body font-semibold leading-5 text-fg">
          <span className="mr-1.5 font-normal tabular-nums text-[color:var(--bubble-meta)]">{card.key}</span>
          {card.title}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2 text-caption text-[color:var(--bubble-meta)]">
        <span className="min-w-0 truncate">{[card.boardName, card.statusName].filter(Boolean).join(' · ')}</span>
        {card.dueOn ? <span className={cx('shrink-0 tabular-nums', overdue && 'text-danger-text')}>{formatDue(card.dueOn, today)}</span> : null}
        {card.assignees.length ? (
          <span className="ml-auto flex shrink-0 -space-x-1.5" aria-label={t('boards.nAssignees', { n: card.assignees.length + card.more })}>
            {card.assignees.map((u) => (
              <span key={u} className="rounded-full ring-2 ring-[var(--bubble-bg,var(--color-bg))]">
                <MemberAvatar workspaceId={card.workspaceId} userId={u} size={18} />
              </span>
            ))}
            {card.more ? <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-hover px-1 text-micro text-muted">+{card.more}</span> : null}
          </span>
        ) : null}
      </span>
    </a>
  );
});
