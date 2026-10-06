import { timestampMs } from '@bufbuild/protobuf/wkt';
import { AttendeeStatus, EventRepeat, type EventRsvpTokenResponse } from '@calaba/protocol';
import { CalendarX, Clock, Repeat, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Logo } from '../../components/Logo';
import { Button, Spinner, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { ApiError } from '../../lib/api/client';
import { api } from '../../lib/api/endpoints';
import { fmt } from '../../lib/format';
import { formatRange, formatWhen, viewerZone } from '../../lib/calendar/time';
import { Markdown } from '../../lib/markdown/Markdown';
import type { EventPage } from '../../services/eventPage';
import { AuthLegalFooter } from '../legal/Legal';
import { useNow } from '../shell/voiceFormat';
import { REPEAT_LABEL, RsvpButtons } from './EventCard';

type State = { kind: 'loading' } | { kind: 'ok'; data: EventRsvpTokenResponse; saved: AttendeeStatus | null } | { kind: 'error'; text: string; gone: boolean };

const ANSWER: Record<number, 'cal.rsvp.accept' | 'cal.rsvp.decline' | 'cal.rsvp.maybe'> = {
  [AttendeeStatus.ACCEPTED]: 'cal.rsvp.accept',
  [AttendeeStatus.DECLINED]: 'cal.rsvp.decline',
  [AttendeeStatus.MAYBE]: 'cal.rsvp.maybe',
};

function errorState(e: unknown): State {
  if (e instanceof ApiError && e.status === 410) return { kind: 'error', text: t('cal.rsvpPage.over'), gone: true };
  if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return { kind: 'error', text: t('cal.rsvpPage.notFound'), gone: true };
  return { kind: 'error', text: t('cal.rsvpPage.failed'), gone: false };
}

/**
 * The public meeting page (ADR-0038 «Диплинки для приглашённых»): an invited address without an
 * account opens `/e/<id>?t=…` from its mail and sees the meeting as the in-app card shows it —
 * title, time in its own zone (and the organizer's, when it differs), repeat, organizer (mail
 * link), room, description, its answer with «Приму / Отклоню / Может быть» (the answer tokens of
 * the response; idempotent), and «Присоединиться к встрече» — the guest link into the room, active
 * from 15 minutes before the start. No other attendees (privacy). An answer link
 * (`/e/<id>/rsvp?t=…`) applies its answer once on arrival. The guest link is single use: the
 * page never opens it by itself.
 */
export function EventPublicPage({ page }: { page: EventPage }): ReactNode {
  useLocale();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState<AttendeeStatus | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const load = page.answer ? api.calendar.rsvpAnswer(page.token) : api.calendar.rsvpPreview(page.token);
    load.then(
      (data) => setState({ kind: 'ok', data, saved: page.answer ? data.status : null }),
      (e: unknown) => setState(errorState(e)),
    );
  }, [page]);

  const answer = async (status: AttendeeStatus): Promise<void> => {
    if (state.kind !== 'ok') return;
    const d = state.data;
    const token = status === AttendeeStatus.ACCEPTED ? d.acceptToken : status === AttendeeStatus.DECLINED ? d.declineToken : d.maybeToken;
    if (!token) return;
    setBusy(status);
    try {
      const data = await api.calendar.rsvpAnswer(token);
      setState({ kind: 'ok', data: { ...data, myStatus: data.myStatus || status }, saved: status });
    } catch (e) {
      setState(errorState(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="auth-backdrop flex h-full flex-col items-center overflow-y-auto px-4 py-10 mobile:pb-[calc(var(--safe-bottom)+24px)] mobile:pt-[calc(var(--safe-top)+16px)]" data-testid="event-public">
      <main className="my-auto flex w-full max-w-[480px] flex-col items-stretch">
        <div className="mb-5 flex justify-center">
          <Logo size={48} alt="Calab" />
        </div>
        <div className="mat-popover flex flex-col rounded-[var(--radius-panel)] p-6 mobile:p-5">
          {state.kind === 'loading' ? (
            <div className="grid h-40 place-items-center">
              <Spinner className="size-6" label={t('common.loading')} />
            </div>
          ) : state.kind === 'error' ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center" role="alert">
              <CalendarX className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
              <p className="text-body">{state.text}</p>
            </div>
          ) : (
            <Card data={state.data} saved={state.saved} busy={busy} onAnswer={(s) => void answer(s)} />
          )}
        </div>
      </main>
      {/* NOTICE: the «Powered by GPTunneL» attribution is required in the UI (BUSL-1.1 grant). */}
      <AuthLegalFooter className="mobile:mt-6 mobile:shrink-0" />
    </div>
  );
}

function Card({ data: d, saved, busy, onAnswer }: { data: EventRsvpTokenResponse; saved: AttendeeStatus | null; busy: AttendeeStatus | null; onAnswer: (s: AttendeeStatus) => void }): ReactNode {
  const now = useNow(60_000);
  const zone = viewerZone();
  const span = { startsAt: d.startsAt, endsAt: d.endsAt, allDay: d.allDay, tz: d.tz };
  const mine = d.myStatus !== AttendeeStatus.UNSPECIFIED ? d.myStatus : d.status;
  const canAnswer = !d.cancelled && !!(d.acceptToken || d.declineToken || d.maybeToken);
  const from = d.guestFrom ? timestampMs(d.guestFrom) : 0;
  const until = d.guestUntil ? timestampMs(d.guestUntil) : 0;
  const linkState = !d.guestUrl ? 'none' : now < from ? 'soon' : until && now >= until ? 'over' : 'open';
  return (
    <article className="flex flex-col" aria-labelledby="event-public-title">
      <p className="text-caption font-medium uppercase tracking-wide text-faint">{t('cal.rsvpPage.title')}</p>
      <h1 id="event-public-title" className="mt-1 break-words text-title font-semibold" data-testid="event-title">
        {d.title}
      </h1>
      {d.cancelled ? (
        <p className="mt-2 rounded-[var(--radius-card)] bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2 text-body text-danger-text" role="status" data-testid="event-cancelled">
          {t('cal.rsvpPage.cancelled')}
        </p>
      ) : null}
      <Row icon={<Clock className="size-4" aria-hidden />}>
        <span className="flex flex-col">
          <span data-testid="event-when">{formatWhen(span)}</span>
          {!d.allDay && d.tz && d.tz !== zone ? (
            <span className="text-caption text-muted" data-testid="event-org-time">
              {t('cal.page.orgTime', { time: formatRange(span, d.tz), zone: d.tz })}
            </span>
          ) : null}
        </span>
      </Row>
      {d.repeat !== EventRepeat.UNSPECIFIED ? (
        <Row icon={<Repeat className="size-4" aria-hidden />}>
          {d.repeatUntil ? t('cal.repeatUntil', { repeat: t(REPEAT_LABEL[d.repeat]), date: fmt.date(new Date(timestampMs(d.repeatUntil))) }) : t(REPEAT_LABEL[d.repeat])}
        </Row>
      ) : null}
      {d.roomName ? (
        <Row icon={<Volume2 className="size-4" aria-hidden />}>
          <span className="min-w-0 truncate">{d.roomName}</span>
        </Row>
      ) : null}
      <p className="mt-3 text-body text-muted">
        {d.organizerEmail ? (
          <>
            {t('cal.organizer')}:{' '}
            <a href={`mailto:${d.organizerEmail}`} className="text-accent-text underline underline-offset-2">
              {d.organizerName}
            </a>
            {d.workspaceName ? ` · ${d.workspaceName}` : ''}
          </>
        ) : (
          t('cal.rsvpPage.from', { organizer: d.organizerName, workspace: d.workspaceName })
        )}
      </p>
      {d.description ? (
        <div className="mt-3 select-text whitespace-pre-wrap break-words text-body [&_a]:text-accent-text">
          <Markdown text={d.description} mention={(v, k) => <span key={k}>@{v}</span>} />
        </div>
      ) : null}

      {d.roomName && !d.cancelled ? (
        <div className="mt-5 flex flex-col gap-1.5">
          <Button
            size="lg"
            className="h-10 w-full font-semibold"
            disabled={linkState !== 'open'}
            onClick={() => window.location.assign(d.guestUrl)}
            data-testid="event-join"
          >
            {t('cal.page.join')}
          </Button>
          {linkState !== 'open' ? (
            <p className="text-center text-caption text-muted" data-testid="event-join-hint">
              {linkState === 'soon' ? t('cal.page.notYet') : linkState === 'over' ? t('cal.page.ended') : t('cal.noGuestLinks')}
            </p>
          ) : null}
        </div>
      ) : null}

      {canAnswer ? (
        <div className={cx('mt-4', busy !== null && 'pointer-events-none opacity-70')} aria-busy={busy !== null}>
          <RsvpButtons mine={mine} onAnswer={onAnswer} />
          {d.email ? <p className="mt-1.5 text-caption text-faint">{t('cal.rsvpPage.as', { email: d.email })}</p> : null}
        </div>
      ) : null}
      <p role="status" aria-live="polite" className={cx('mt-2 text-center text-caption text-muted', saved === null && 'sr-only')} data-testid="event-saved">
        {saved !== null && ANSWER[saved] ? t('cal.rsvpPage.saved', { answer: t(ANSWER[saved]) }) : ''}
      </p>
    </article>
  );
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="mt-2 flex min-h-7 items-center gap-2 text-body">
      <span className="grid size-5 shrink-0 place-items-center text-muted">{icon}</span>
      {children}
    </div>
  );
}
