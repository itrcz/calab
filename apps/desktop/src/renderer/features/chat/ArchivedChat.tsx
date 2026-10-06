import { PERMISSION_BITS, type Room } from '@calaba/protocol';
import { Archive, Timer } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Button, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useMobile } from '../../lib/mobile';
import { openRoom } from '../../services/chat';
import { useArchiveView } from '../../stores/archiveView';
import { useMessages } from '../../stores/messages';
import { NavButton } from '../../components/PhoneHeader';
import { MessageList } from './MessageList';

/** Reading only: no reply, reaction, pin or send action is offered (they would get 410 anyway). */
const READ_ONLY = PERMISSION_BITS.VIEW_ROOM;

/**
 * «Открыть историю» of an archived temporary room (ADR-0044, settings → «Временные комнаты» →
 * «Архив»): the room's messages (GET …/messages is still allowed) under the banner «Комната в
 * архиве» — no composer, no voice, no members. The room is not in the live store; it comes from
 * stores/archiveView and its messages are dropped when the view closes.
 */
export function ArchivedChat({ workspaceId, room }: { workspaceId: string; room: Room }): ReactNode {
  const mobile = useMobile();
  const close = useArchiveView((s) => s.close);
  useEffect(() => {
    void openRoom(room.id);
    return () => useMessages.getState().unload(room.id);
  }, [room.id]);
  return (
    <section data-toast-anchor className="mat-content relative flex min-w-0 flex-1 flex-col" aria-label={room.name} data-testid="archived-chat">
      <header className={cx('mat-toolbar drag sticky top-0 z-[var(--z-sticky)] flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2', mobile && 'gap-1 pl-0.5 pr-1')}>
        {mobile ? <NavButton /> : null}
        <Timer className="size-5 shrink-0 text-faint" aria-hidden />
        <h1 className="min-w-0 flex-1 truncate text-list font-semibold" title={room.name}>
          {room.name}
        </h1>
        <Button variant="secondary" size="sm" className="no-drag" onClick={close}>
          {t('temp.archiveBack')}
        </Button>
      </header>
      <div role="status" className="flex shrink-0 items-center gap-2 border-b border-line bg-[var(--color-fill)] px-4 py-2 text-caption" data-testid="archived-banner">
        <Archive className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="font-semibold text-fg">{t('temp.archived')}</span>
        <span className="min-w-0 truncate text-muted">{t('temp.archivedHint')}</span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageList workspaceId={workspaceId} room={room} perms={READ_ONLY} newMarker="" />
      </div>
    </section>
  );
}
