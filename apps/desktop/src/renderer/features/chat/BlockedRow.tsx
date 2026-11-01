import { EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { useBlocks } from '../../stores/blocks';

/**
 * A message of a person I blocked (ADR-0154): collapsed to one line with «Показать» (this session
 * only). The row's own subscription returns a primitive, so a block re-renders only that author's
 * rows (docs/14 «Ререндеры»).
 */
export function BlockedGate({ authorId, msgKey, children }: { authorId: string; msgKey: string; children: ReactNode }): ReactNode {
  const hidden = useBlocks((s) => !!s.ids?.[authorId] && !s.revealed[msgKey]);
  if (!hidden) return children;
  return (
    <div className="flex items-center gap-2 px-4 py-1 pl-[60px] text-caption text-faint mobile:pl-4" data-testid="message-hidden" data-message-id={msgKey}>
      <EyeOff className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{t('block.hiddenMessage')}</span>
      <button type="button" className="tap-hit shrink-0 rounded px-1 text-accent-text hover:underline" onClick={() => useBlocks.getState().reveal(msgKey)}>
        {t('block.show')}
      </button>
    </div>
  );
}
