import { Clock, DoorClosed, DoorOpen, Loader2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '../../components/Logo';
import { Button } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { AuthLegalFooter } from '../legal/Legal';
import { fmt } from '../../lib/format';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';
import { waitView, type MyKnock } from './admissionsModel';
import { cancelKnock, closeKnock, hideKnock, knockAgain, knockCode } from './services/admissions';
import { useFocusKnock } from './stores/admissions';

/**
 * The guest's waiting room (ADR-0040 §5, docs/08 «Подтверждение входа гостей»): in place of the app
 * while a knock is on — the room and workspace, «Ожидаем подтверждения организатора…» with the
 * loader (the only endless animation allowed: something is being waited for), «Отменить». Outcomes:
 * admitted → the room opens by itself; «Организатор отклонил вход» (a new knock after 10 minutes,
 * the time shown); «Никто не ответил» + «Постучать снова»; cancelled → the join card with «Постучать».
 * Same card as the join page (GuestScreen), so the flow reads as one place.
 */
export function WaitingScreen(): ReactNode {
  useLocale();
  const k = useFocusKnock();
  if (!k) return null;
  return (
    <div className="mat-content drag flex h-full flex-col items-center overflow-y-auto px-4 py-8 mobile:pb-[calc(var(--safe-bottom)+24px)] mobile:pt-[calc(var(--safe-top)+16px)]">
      <main className="mat-popover no-drag my-auto w-full max-w-[400px] shrink-0 rounded-[var(--radius-panel)] p-8 mobile:p-6" data-testid="guest-waiting" data-phase={k.phase}>
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={64} alt="Calab" className="mb-4" />
          <h1 className="max-w-full truncate text-title font-semibold" title={k.roomName}>
            {k.roomName}
          </h1>
          {k.workspaceName ? (
            <p className="mt-1 max-w-full truncate text-body text-muted" title={k.workspaceName}>
              {t('guest.in', { ws: k.workspaceName })}
            </p>
          ) : null}
        </div>
        {/* key: a new phase is a new status, announced once by the live region. */}
        <Phase key={k.phase} k={k} />
      </main>
      <AuthLegalFooter className="no-drag mt-6 shrink-0" />
    </div>
  );
}

/** The loader inside the status region (its text is the status, so the icon is decorative). */
const LOADER = <Loader2 className="size-7 animate-spin text-muted" aria-hidden />;

function Phase({ k }: { k: MyKnock }): ReactNode {
  const code = knockCode(k.roomId);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const v = waitView(k, now, code !== null);
  // Declined: one timeout to the moment a new knock is allowed (no ticking).
  const retryAt = v.retryAt;
  useEffect(() => {
    if (!retryAt) return undefined;
    const id = window.setTimeout(() => setNow(Date.now()), Math.max(0, retryAt - Date.now()) + 500);
    return () => window.clearTimeout(id);
  }, [retryAt]);
  // A registered user with other workspaces may go back to the app while waiting.
  const me = useSession((s) => s.me?.user);
  const elsewhere = useWorkspaces((s) => s.order.some((id) => id !== k.workspaceId));
  const canLeave = v.cancel && !me?.isGuest && elsewhere;

  const knock = async (): Promise<void> => {
    setBusy(true);
    await knockAgain(k.roomId);
    setBusy(false);
  };

  let icon: ReactNode;
  let title: string;
  let hint: string | null;
  switch (v.title) {
    case 'waiting':
      icon = LOADER;
      title = t('adm.waitTitle');
      hint = t('adm.waitHint');
      break;
    case 'entering':
      icon = LOADER;
      title = t('adm.entering');
      hint = null;
      break;
    case 'declined':
      icon = <DoorClosed className="size-7 text-danger" strokeWidth={1.5} aria-hidden />;
      title = t('adm.declinedTitle');
      hint = v.retryAt ? t('adm.declinedRetryAt', { time: fmt.time(new Date(v.retryAt)) }) : code ? t('adm.declinedHint') : t('adm.noCode');
      break;
    case 'noAnswer':
      icon = <Clock className="size-7 text-muted" strokeWidth={1.5} aria-hidden />;
      title = t('adm.noAnswerTitle');
      hint = code ? t('adm.noAnswerHint') : t('adm.noCode');
      break;
    case 'join':
      icon = <DoorOpen className="size-7 text-muted" strokeWidth={1.5} aria-hidden />;
      title = t('adm.joinTitle');
      hint = code ? t('adm.joinHint') : t('adm.noCode');
      break;
  }

  return (
    <div className="flex flex-col gap-5">
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 text-center" data-testid="guest-waiting-status">
        {icon}
        <div className="flex flex-col gap-1">
          <p className="text-headline font-semibold">{title}</p>
          {hint ? <p className="text-body text-muted">{hint}</p> : null}
        </div>
      </div>
      {v.cancel || v.knock || v.close ? (
        <div className="flex flex-col gap-2">
          {v.knock ? (
            <Button autoFocus busy={busy} className="h-9 w-full text-body font-semibold" onClick={() => void knock()}>
              {v.title === 'join' ? t('adm.knock') : t('adm.knockAgain')}
            </Button>
          ) : null}
          {v.cancel ? (
            <Button variant="secondary" className="h-9 w-full text-body" onClick={() => void cancelKnock(k.roomId)}>
              {t('adm.cancel')}
            </Button>
          ) : null}
          {canLeave ? (
            <Button variant="ghost" className="h-9 w-full text-body" onClick={() => hideKnock(k.roomId)}>
              {t('adm.toApp')}
            </Button>
          ) : null}
          {v.close ? (
            <Button autoFocus={!v.knock} variant="secondary" className="h-9 w-full text-body" onClick={() => closeKnock(k)}>
              {t('adm.close')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
