import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { toast } from '../../stores/toasts';

/**
 * «Скопировать отчёт» when the mail engine does not start (`ENGINE_FAILED`, ADR-0088 §2): the exit
 * codes and the engine's last stderr lines from main, for a bug report. Never holds secrets.
 */
export function CopyReport({ report }: { report: string }): ReactNode {
  return (
    <button
      type="button"
      className="shrink-0 font-medium text-accent-text hover:underline"
      onClick={() => void navigator.clipboard.writeText(report || 'mail engine: no output').then(() => toast.success(t('mbox.err.reportCopied')))}
      data-testid="mail-copy-report"
    >
      {t('mbox.err.copyReport')}
    </button>
  );
}
