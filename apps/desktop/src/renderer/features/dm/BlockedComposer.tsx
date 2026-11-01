import type { ReactNode } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';
import { setUserBlocked } from '../../services/blocks';
import { selectBlocked, useBlocks } from '../../stores/blocks';
import { useDms } from '../../stores/dms';

/** The DM's peer when I blocked them (ADR-0154), '' otherwise: the composer gives way to BlockedComposer. */
export function useDmBlockedPeer(roomId: string): string {
  const peerId = useDms((s) => s.byRoom[roomId]?.peerId ?? '');
  const blocked = useBlocks(selectBlocked(peerId));
  return peerId && blocked ? peerId : '';
}

/** In place of the composer of a DM with a person I blocked: why I cannot write, and «Разблокировать». */
export function BlockedComposer({ peerId }: { peerId: string }): ReactNode {
  return (
    <div className="mx-4 my-3 flex items-center gap-3 rounded-[var(--radius-card)] bg-hover px-4 py-2.5 text-body text-muted" data-testid="composer-blocked">
      <span className="min-w-0 flex-1">{t('block.composer')}</span>
      <Button size="sm" variant="secondary" onClick={() => void setUserBlocked(peerId, false)}>
        {t('block.unblock')}
      </Button>
    </div>
  );
}
