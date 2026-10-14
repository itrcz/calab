import { memo, useCallback, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, CloseButton } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { splitKey } from './admissionsModel';
import { decide, dismissKnockToast, knockAuthor, knockTitle } from './services/admissions';
import { useAdmissions, useKnock } from './stores/admissions';

/** At most this many knock toasts at once (the rest wait in the members panel group). */
const MAX = 3;

/**
 * «<Имя> просит войти в <комната>» (ADR-0040 §3, docs/08 «Подтверждение входа гостей»): a card per
 * live knock with «Пустить» / «Отклонить», top right under the room header, over the feed (the chat toasts keep the
 * bottom); on phones a banner under the top bar. It stays until decided (here, in the group or by
 * another decider) or closed — a decision is asked for, it must not slip away on a timer.
 */
export function KnockToasts(): ReactNode {
  const keys = useAdmissions((s) => s.toasts);
  if (keys.length === 0) return null;
  const shown = keys.slice(-MAX);
  return (
    <section
      aria-label={t('adm.knockRegion')}
      className="pointer-events-none fixed right-4 top-[calc(var(--titlebar-height)+56px)] z-[var(--z-toast)] flex w-[340px] flex-col gap-2 [:root.web_&]:top-[calc(var(--titlebar-height-web)+56px)] mobile:left-4 mobile:right-4 mobile:top-[calc(var(--safe-top)+56px)] mobile:w-auto mobile:[:root.web_&]:top-[calc(var(--safe-top)+56px)]"
      data-testid="knock-toasts"
      data-app-occluder
    >
      {shown.map((key) => (
        <KnockToast key={key} knockKey={key} />
      ))}
    </section>
  );
}

const KnockToast = memo(function KnockToast({ knockKey }: { knockKey: string }): ReactNode {
  useLocale();
  const { roomId, userId } = splitKey(knockKey);
  const a = useKnock(roomId, userId);
  const roomName = useRooms((s) => s.byId[roomId]?.name ?? '');
  const workspaceId = useRooms((s) => s.byId[roomId]?.workspaceId ?? '');
  const close = useCallback(() => dismissKnockToast(roomId, userId), [roomId, userId]);
  const byLink = useWorkspaces(() => (a ? knockAuthor(a) : ''));
  if (!a) return null;
  const name = a.user?.displayName ?? '';
  const open = (): void => {
    if (workspaceId) useUi.getState().openRoom(workspaceId, roomId);
  };
  return (
    <div
      role="alertdialog"
      aria-label={knockTitle(name, roomName)}
      data-testid="knock-toast"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
      className="mat-popover anim-in pointer-events-auto flex items-start gap-3 rounded-[var(--radius-panel)] py-3 pl-3 pr-2 text-body text-fg"
    >
      <Avatar userId={userId} name={name} fileId={a.user?.avatarFileId || undefined} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <button type="button" className="min-w-0 rounded-[var(--radius-control)] text-left leading-[18px] hover:underline" onClick={open}>
          <span className="font-semibold [overflow-wrap:anywhere]">{knockTitle(name, roomName)}</span>
        </button>
        {byLink ? <div className="-mt-1 text-caption text-muted [overflow-wrap:anywhere]">{byLink}</div> : null}
        <div className="flex gap-2">
          <Button size="sm" aria-label={t('adm.admitName', { name })} onClick={() => void decide(roomId, userId, { admit: true })}>
            {t('adm.admit')}
          </Button>
          <Button size="sm" variant="secondary" aria-label={t('adm.declineName', { name })} onClick={() => void decide(roomId, userId, { admit: false })}>
            {t('adm.decline')}
          </Button>
        </div>
      </div>
      <CloseButton shortcut="" className="size-6" onClick={close} />
    </div>
  );
});
