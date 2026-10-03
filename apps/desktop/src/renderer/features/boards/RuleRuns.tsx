import { timestampDate } from '@bufbuild/protobuf/wkt';
import type { Board, RuleRun } from '@calaba/protocol';
import { CircleCheck, CircleX } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { loadRuns } from '../../services/automations';
import { openTaskAnywhere } from '../../services/boards';
import { useAutomations } from '../../stores/automations';
import { useBoards } from '../../stores/boards';
import { useBoardsUi } from '../../stores/boardsUi';

/**
 * «Журнал» of a rule (ADR-0060 §6): its last runs, newest first — time, the task (key → the
 * task panel), the result (actions applied) and the error in red. Loaded when opened; ≤ 100.
 */
export function RuleRuns({ ruleId, board, onClose }: { ruleId: string; board: Board; onClose: () => void }): ReactNode {
  const name = useAutomations((s) => s.rules[ruleId]?.name ?? '');
  const [runs, setRuns] = useState<RuleRun[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    loadRuns(ruleId, ac.signal).then(setRuns, () => !ac.signal.aborted && setFailed(true));
    return () => ac.abort();
  }, [ruleId]);
  return (
    <Modal open onClose={onClose} medium title={t('rules.runsTitle', { name })}>
      {failed ? (
        <p className="text-body text-danger-text">{t('rules.runsFailed')}</p>
      ) : !runs ? (
        <div className="grid h-24 place-items-center">
          <Spinner />
        </div>
      ) : runs.length === 0 ? (
        <p className="text-body text-muted">{t('rules.runsEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-card-line)] overflow-hidden rounded-[var(--radius-card)] bg-[var(--color-card)]" data-testid="rule-runs-list">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} board={board} onOpen={onClose} />
          ))}
        </ul>
      )}
    </Modal>
  );
}

function RunRow({ run, board, onOpen }: { run: RuleRun; board: Board; onOpen: () => void }): ReactNode {
  const key = useBoards((s) => (run.taskId ? (s.tasks[run.taskId]?.key ?? '') : ''));
  const at = run.createdAt ? timestampDate(run.createdAt) : null;
  const open = (): void => {
    if (!run.taskId) return;
    onOpen();
    useBoardsUi.getState().openSettings(null);
    openTaskAnywhere({ id: run.taskId, workspaceId: board.workspaceId, boardId: board.id });
  };
  return (
    <li className="flex items-start gap-2 px-3 py-2" data-testid="rule-run" data-ok={run.ok}>
      {run.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-[var(--color-green-text)]" aria-label={t('rules.runOk', { n: run.actionsApplied })} /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger-text" aria-label={t('rules.runFail')} />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-body">
          {run.taskId ? (
            <button type="button" onClick={open} className="shrink-0 rounded-[var(--radius-icon)] px-1 font-medium tabular-nums text-accent-text hover:bg-hover">
              {key || t('boards.task')}
            </button>
          ) : (
            <span className="shrink-0 text-muted">{t('rules.runTaskGone')}</span>
          )}
          <span className="min-w-0 truncate text-muted">{run.ok ? t('rules.runOk', { n: run.actionsApplied }) : t('rules.runFail')}</span>
        </span>
        {run.error ? <span className="break-words text-caption text-danger-text">{run.error}</span> : null}
      </div>
      {at ? (
        <span className="shrink-0 text-caption tabular-nums text-faint" title={fmt.full(at)}>
          {fmt.stamp(at)}
        </span>
      ) : null}
    </li>
  );
}
