import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { IconButton } from './ui';

/**
 * The ✕ in the top-right corner of a list card (the inbox cards, CBF-155 / ADR-0163, and the
 * «Недавние» rows, CBF-179): a sibling of the card's button (a button cannot nest one). The
 * parent is `relative`; the card's button leaves room on its right.
 */
export function DismissButton({ onClick }: { onClick: () => void }): ReactNode {
  return (
    <IconButton label={t('shell.inboxDismiss')} size="sm" data-inbox-dismiss onClick={onClick} className="absolute right-0.5 top-0.5">
      <X className="size-4" strokeWidth={1.75} aria-hidden />
    </IconButton>
  );
}
