import * as Popover from '@radix-ui/react-popover';
import { CalendarDays } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { Button, cx } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { occKey, roomMeeting } from '../../lib/calendar/events';
import { eventSpan, formatTime } from '../../lib/calendar/time';
import { markPrompted } from '../../services/calendar';
import { startRecording } from '../../services/recording';
import { useCalendar } from '../../stores/calendar';
import { useRecordings } from '../../stores/recordings';
import { myUserId } from '../../stores/session';
import { useVoice } from '../../stores/voice';
import { EventCard } from './EventCard';

/**
 * A voice room's meeting badge (ADR-0038 §6): from 15 minutes before a meeting in the room until it
 * ends, the room row (and the room header) show «Планёрка в 15:00»; a click opens the meeting card
 * as a popover. Its own subscription by room id: nothing else re-renders when a meeting starts.
 */
export const RoomEventBadge = memo(function RoomEventBadge({ roomId, variant, compact = false }: { roomId: string; variant: 'row' | 'header'; compact?: boolean }): ReactNode {
  useLocale();
  const ev = useCalendar((s) => roomMeeting(s.active, roomId));
  const [openLocal, setOpenLocal] = useState(false);
  // A guest's /e/<id> (services/calendar.ts): the header badge of the room opens its card.
  const requested = useCalendar((s) => variant === 'header' && s.badgeOpen === roomId);
  const open = openLocal || requested;
  const setOpen = (o: boolean): void => {
    setOpenLocal(o);
    if (!o && requested) useCalendar.setState({ badgeOpen: null });
  };
  if (!ev) return null;
  const time = formatTime(eventSpan(ev).start);
  const text = t('cal.badge', { title: ev.title, time });
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t('cal.badgeLabel', { title: ev.title, time })}
          data-testid="room-event-badge"
          className={cx(
            'no-drag flex min-w-0 items-center gap-1 rounded-full text-caption font-medium text-accent-text transition-colors duration-[var(--motion-fast)] hover:bg-hover',
            variant === 'row' ? 'ml-[26px] mr-2 h-5 max-w-[calc(100%-34px)] px-1.5' : compact ? 'size-9 shrink-0 justify-center rounded-[var(--radius-bar)] bar-hit' : 'h-7 max-w-[40%] shrink px-2',
          )}
        >
          <CalendarDays className={compact ? 'size-5 shrink-0' : 'size-3.5 shrink-0'} aria-hidden />
          {compact ? null : <span className="truncate">{text}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={variant === 'row' ? 'right' : 'bottom'}
          align="start"
          sideOffset={8}
          collisionPadding={16}
          // The card itself takes the focus: its «×» would show its tooltip right away.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          tabIndex={-1}
          className="mat-popover anim-in z-[var(--z-popover)] flex max-h-[min(560px,calc(100vh-32px))] w-80 flex-col overflow-hidden rounded-[var(--radius-panel)] text-body text-fg"
          data-testid="room-event-card"
        >
          <EventCard event={ev} variant="popover" onClose={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

/**
 * The island's «Начать запись встречи «X»?» (ADR-0038 §6): the organizer is in the room of a
 * meeting with «Записывать встречу» inside its window, nothing records yet, not answered for this
 * occurrence. «Начать» = the room's recording start (ADR-0025), «Не сейчас» — once per occurrence.
 */
export function MeetingRecordPrompt(): ReactNode {
  const roomId = useVoice((s) => (s.phase === 'connected' ? s.roomId : null));
  const workspaceId = useVoice((s) => s.workspaceId);
  const ev = useCalendar((s) => (roomId ? roomMeeting(s.active, roomId) : undefined));
  const key = ev ? occKey(ev) : '';
  const answered = useCalendar((s) => !!key && !!s.prompted[key]);
  const recording = useRecordings((s) => (roomId ? !!s.byRoom[roomId] : false));
  if (!roomId || !ev || !workspaceId || !ev.record || ev.organizerId !== myUserId() || answered || recording || ev.recordingId) return null;
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" role="status" data-testid="record-prompt">
      <p className="text-body font-medium">{t('cal.recordPrompt', { title: ev.title })}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            markPrompted(key);
            void startRecording(roomId, workspaceId);
          }}
        >
          {t('cal.recordStart')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => markPrompted(key)}>
          {t('cal.recordLater')}
        </Button>
      </div>
    </div>
  );
}
