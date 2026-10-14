import { RoomType } from '@calaba/protocol';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Card, Input, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { useMobile } from '../../lib/mobile';
import { api } from '../../lib/api/endpoints';
import { mayInviteGuestsIn } from '../../lib/permissions';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useMemberRoles } from '../../stores/workspaces';
import { roomLabel } from '../chat/roomLabel';
import { linkOf } from './RoomLinkTab';
import { roomLinkError } from './roomLink';
import { guestInviteMode, guestLink, guestLinkDefaults } from './roomGuestInvite';

/**
 * «Пригласить гостя без регистрации» (docs/09 #55, ADR-0016): the first block of the invite modal
 * opened from a room. The room's usable guest link with «Копировать», or one «Создать ссылку»
 * (7 days, speak + write, no use limit); «Настроить срок и права…» opens the room settings'
 * «Ссылка для гостей». Only with INVITE_GUESTS in the room (ADR-0043; the server checks it).
 */
/** Whether the card shows for this room: not a DM, and INVITE_GUESTS there (the server's check for guest links). */
export function useGuestInviteShown(roomId: string): boolean {
  const room = useRooms((s) => s.byId[roomId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const roles = useMemberRoles(room?.workspaceId, me);
  return mayInviteGuestsIn(roles, me, room);
}

export function RoomGuestInviteCard({ roomId }: { roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const canCreate = useGuestInviteShown(roomId);
  const phone = useMobile();
  const qc = useQueryClient();
  const key = ['roomInvites', roomId];
  const q = useQuery({ queryKey: key, queryFn: () => api.roomInvites.list(roomId), enabled: canCreate && !!room });
  const voice = room?.type === RoomType.VOICE;
  const create = useMutation({
    mutationFn: () => api.roomInvites.create(roomId, guestLinkDefaults(voice)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(roomLinkError(e)),
  });
  // Usability is judged at the list's fetch time (render stays pure; the list refetches on open).
  const now = q.dataUpdatedAt;
  const mode = guestInviteMode({ room, canCreate, invites: q.data?.invites, nowMs: now });
  if (mode === 'hidden' || !room) return null;
  const invite = q.data ? guestLink(q.data.invites, now) : null;
  const link = invite ? linkOf(invite) : '';
  const copy = (): void => {
    if (!link) return;
    void navigator.clipboard.writeText(link).then(
      () => toast.success(t('people.link.copied')),
      () => toast.error(t('roomInvite.failed')),
    );
  };
  const configure = (): void => useUi.getState().openDialog({ kind: 'room-settings', roomId, tab: 'guests' });
  return (
    <Card
      title={t('guestInvite.title')}
      footer={
        <>
          {t('guestInvite.hint', { room: roomLabel(room) })}{' '}
          <button type="button" className="rounded-[var(--radius-control)] text-accent-text hover:underline" onClick={configure}>
            {t('guestInvite.configure')}
          </button>
        </>
      }
    >
      <div className="flex min-h-12 items-center gap-2 px-3 py-2 mobile:flex-col mobile:items-stretch mobile:gap-3 mobile:py-3" data-testid="guest-invite">
        {q.isError ? (
          <span className="text-body text-muted">{roomLinkError(q.error)}</span>
        ) : mode === 'loading' ? (
          <Spinner className="mx-auto size-4" />
        ) : mode === 'link' ? (
          <>
            {phone ? (
              // Phone: the whole address, wrapped on any character (a one-line field cut it off).
              <textarea
                readOnly
                rows={Math.min(4, Math.max(2, Math.ceil(link.length / 28)))}
                value={link}
                aria-label={t('guestInvite.link')}
                className="selectable w-full resize-none break-all rounded-[14px] border border-line bg-elev px-3 py-2 font-mono text-[16px] leading-snug text-fg"
                onFocus={(e) => e.currentTarget.select()}
              />
            ) : (
              <Input readOnly value={link} aria-label={t('guestInvite.link')} className="min-w-0 flex-1 font-mono" onFocus={(e) => e.currentTarget.select()} />
            )}
            <Button variant="secondary" disabled={!link} onClick={copy} className="mobile:w-full">
              <Copy className="size-4" aria-hidden /> {t('people.link.copy')}
            </Button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 text-body text-muted">{t('guestInvite.none')}</span>
            <Button busy={create.isPending} onClick={() => create.mutate()}>
              {t('people.link.create')}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
