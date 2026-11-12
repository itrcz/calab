import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { toast } from '../stores/toasts';
import { Button, Input } from './ui';

/**
 * A read-only value to copy (an address, a command): the field (selected on focus) and «Скопировать».
 * Phone: the field takes the whole line (a long command stays readable), the button goes under it.
 * Its own module: ui.tsx stays free of the stores (unit tests import it without a window).
 */
export function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }): ReactNode {
  return (
    <div className="flex min-w-0 items-center gap-2 mobile:flex-col mobile:items-stretch">
      <Input readOnly value={value} aria-label={label} spellCheck={false} className="min-w-0 flex-1 text-ellipsis font-mono text-caption" onFocus={(e) => e.currentTarget.select()} data-testid={testId} />
      <Button
        variant="secondary"
        className="shrink-0 mobile:self-end"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => toast.success(t('chat.copied')),
            (e: unknown) => toast.fail(e),
          )
        }
        data-testid={testId ? `${testId}-copy` : undefined}
      >
        <Copy className="size-3.5" aria-hidden />
        {t('disk.link.copyShort')}
      </Button>
    </div>
  );
}
