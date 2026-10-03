import * as DialogP from '@radix-ui/react-dialog';
import { MessageSquare, X } from 'lucide-react';
import { memo, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useMediaUrl } from '../../components/MediaImg';
import { CLOSE_HIT, Button, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useAchievement } from '../../lib/achievementCatalog';
import type { GrantLine } from '../../lib/achievements';
import { fmt } from '../../lib/format';
import { attachTilt } from '../../lib/tilt';
import { useAchievementUi, type ViewRequest } from '../../stores/achievementUi';
import { useUi } from '../../stores/ui';
import { useMemberName } from '../../stores/workspaces';
import { useChatView } from '../chat/chatView';
import { AchievementImg } from './AchievementImg';

/** «Открыть в чате»: the room of the card, scrolled to it; every layer above the chat closes. */
export function openGrantInChat(workspaceId: string, g: Pick<GrantLine, 'roomId' | 'messageId'>): void {
  if (!g.roomId || !g.messageId) return;
  useAchievementUi.setState({ view: null, grant: null });
  const ui = useUi.getState();
  ui.openDialog(null);
  ui.openRoom(workspaceId, g.roomId);
  useChatView.getState().requestJump(g.roomId, g.messageId);
}

/**
 * The achievement viewer (ADR-0061 §5, docs/08 «Ачивки»): a 360 px sheet (a bottom drawer on the
 * phone) — the picture 160 px on `.achievement-surface`, the title, the catalog description, «За
 * что» prominent, «Вручил(а) Имя · 3 октября 2026», the grants of a repeated achievement, and
 * «Открыть в чате» when the grant has a card. The only place with effects (the owner's
 * exception): a one-shot shine over the picture (CSS, once) and the ≤ 6° cursor tilt (lib/tilt:
 * pointermove + rAF only, back to 0 in 300 ms). With the sheet open and the cursor still there
 * is no work at all.
 */
export function AchievementView({ req, onClose }: { req: ViewRequest; onClose: () => void }): ReactNode {
  const a = useAchievement(req.achievementId);
  const grants = req.grants ?? [];
  const first = grants[0];
  const title = a?.title ?? t('ach.unknown');
  const ws = req.workspaceId ?? '';
  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="no-drag fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          aria-modal="true"
          data-testid="achievement-view"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          className={cx(
            'mat-sheet anim-in fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[calc(100vh-64px)] w-[calc(100vw-32px)] max-w-[360px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-panel)] text-body focus:outline-none',
            'mobile:anim-sheet mobile:inset-x-0 mobile:bottom-0 mobile:top-auto mobile:max-h-[calc(var(--app-height)-var(--safe-top)-16px)] mobile:w-full mobile:max-w-none mobile:translate-x-0 mobile:translate-y-0 mobile:rounded-b-none mobile:rounded-t-[16px] mobile:pb-[var(--safe-bottom)]',
          )}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Stage imageUrl={a?.imageUrl}>
              <AchievementImg achievement={a} size={160} eager />
            </Stage>
            <div className="flex flex-col gap-1 px-5 pb-5 pt-4">
              <DialogP.Title className="text-title font-semibold leading-tight">{title}</DialogP.Title>
              {a?.archivedAt ? <span className="text-caption text-faint">{t('ach.view.archived')}</span> : null}
              <DialogP.Description className={a?.description ? 'selectable break-words text-body text-muted' : 'sr-only'}>{a?.description || title}</DialogP.Description>
              {first ? <GrantMain workspaceId={ws} grant={first} /> : null}
              {grants.length > 1 ? <GrantList workspaceId={ws} grants={grants} /> : null}
              {first?.messageId && first.roomId && !req.fromChat && ws ? (
                <Button variant="secondary" className="mt-4 self-start" onClick={() => openGrantInChat(ws, first)} data-testid="achievement-open-chat">
                  <MessageSquare className="size-3.5" aria-hidden />
                  {t('ach.view.openChat')}
                </Button>
              ) : null}
            </div>
          </div>
          <DialogP.Close
            aria-label={t('common.close')}
            className={cx(CLOSE_HIT, 'absolute right-3 top-3 grid size-7 place-items-center rounded-full bg-scrim text-white transition-[filter] duration-[var(--motion-fast)] hover:brightness-125')}
          >
            <X className="size-4" strokeWidth={1.75} aria-hidden />
          </DialogP.Close>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/**
 * The surface with the picture: the tilt area is the whole stage (a calm target), the tilted
 * element is the picture with its shine. The shine is masked by the picture itself (the same
 * authenticated URL), so only its opaque part glints; a mask that fails to load hides the shine.
 */
const Stage = memo(function Stage({ imageUrl, children }: { imageUrl: string | undefined; children: ReactNode }): ReactNode {
  const area = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const url = useMediaUrl(imageUrl);
  useEffect(() => {
    if (!area.current || !target.current) return;
    return attachTilt(area.current, target.current);
  }, []);
  const mask = url ? ({ '--ach-mask': `url("${url}")` } as CSSProperties) : undefined;
  return (
    <div ref={area} className="achievement-surface flex h-[224px] items-center justify-center mobile:h-[200px]" data-testid="achievement-stage">
      <div ref={target} className="achievement-tilt relative">
        {children}
        {mask ? <span className="achievement-shine" style={mask} aria-hidden /> : null}
      </div>
    </div>
  );
});

function GrantMain({ workspaceId, grant }: { workspaceId: string; grant: GrantLine }): ReactNode {
  const by = useMemberName(workspaceId || null, grant.grantedBy);
  return (
    <section className="mt-4 flex flex-col gap-1" data-testid="achievement-for">
      <h3 className="text-caption font-semibold text-muted">{t('ach.view.for')}</h3>
      <p className="selectable break-words text-headline font-medium">«{grant.note}»</p>
      <p className="text-caption text-muted">
        {grant.grantedAt ? t('ach.grantedBy', { name: by, date: fmt.date(new Date(grant.grantedAt)) }) : t('ach.grantedByOnly', { name: by })}
      </p>
    </section>
  );
}

function GrantList({ workspaceId, grants }: { workspaceId: string; grants: GrantLine[] }): ReactNode {
  return (
    <section className="mt-4 flex flex-col gap-1">
      <h3 className="text-caption font-semibold text-muted">{t('ach.view.grants', { n: grants.length })}</h3>
      <ul className="flex flex-col divide-y divide-[var(--color-card-line)] rounded-[var(--radius-card)] bg-[var(--color-card)]">
        {grants.map((g) => (
          <GrantRow key={g.id} workspaceId={workspaceId} grant={g} />
        ))}
      </ul>
    </section>
  );
}

const GrantRow = memo(function GrantRow({ workspaceId, grant }: { workspaceId: string; grant: GrantLine }): ReactNode {
  const by = useMemberName(workspaceId || null, grant.grantedBy);
  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-caption text-muted">
          {grant.grantedAt ? fmt.shortDate(new Date(grant.grantedAt)) : ''} · {by}
        </p>
        <p className="selectable break-words text-body">«{grant.note}»</p>
      </div>
      {grant.messageId && grant.roomId && workspaceId ? (
        <button
          type="button"
          aria-label={t('ach.view.openChat')}
          title={t('ach.view.openChat')}
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
          onClick={() => openGrantInChat(workspaceId, grant)}
        >
          <MessageSquare className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </li>
  );
});
