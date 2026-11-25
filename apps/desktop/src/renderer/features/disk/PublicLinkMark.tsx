import { Globe } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { copyItemLink } from '../../services/disk';
import { useDisk } from '../../stores/disk';

/**
 * «Доступна по ссылке» (CBF-201): the open folder or file has a live public link — the mark and
 * «Скопировать ссылку» (the `/d/<code>` address, not the address bar's `/disk/<id>`, which needs an
 * account). Shown only where the item carries `link` — the server sends it to those who manage the
 * link (ADR-0165), so no extra right is checked here. A leaf with its own primitive selector.
 */
export const PublicLinkMark = memo(function PublicLinkMark({ itemId, className }: { itemId: string; className?: string }): ReactNode {
  const on = useDisk((s) => !!s.items[itemId]?.link);
  if (!on) return null;
  return (
    <div className={className ?? 'flex items-center gap-2 border-b border-line px-3 py-1.5'} data-testid="disk-public-mark">
      <Globe className="size-4 shrink-0 text-accent-text" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-body font-medium">{t('disk.link.mark')}</span>
      <Button variant="secondary" size="sm" className="shrink-0" onClick={() => void copyItemLink(itemId)} data-testid="disk-public-copy">
        {t('disk.link.markCopy')}
      </Button>
    </div>
  );
});
