import { memo, type ReactNode } from 'react';
import { Segmented } from '../../components/ui';
import { t } from '../../i18n';
import { COMPLETIONS, type Completion } from '../../lib/boards/completion';

const LABEL = { open: 'boards.completion.open', done: 'boards.completion.done', all: 'boards.completion.all' } as const;

/** «Незавершённые · Завершённые · Все» (lib/boards/completion.ts): a board view and «Мои задачи». */
export const CompletionSwitch = memo(function CompletionSwitch({ value, onChange }: { value: Completion; onChange: (v: Completion) => void }): ReactNode {
  return (
    <div className="shrink-0" data-testid="completion-switch" data-value={value}>
      <Segmented value={value} options={COMPLETIONS.map((c) => ({ value: c, label: t(LABEL[c]) }))} onChange={onChange} label={t('boards.completion.label')} />
    </div>
  );
});
