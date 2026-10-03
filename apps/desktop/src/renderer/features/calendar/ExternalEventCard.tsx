import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { WorkspaceRole } from '@calaba/protocol';
import { CalendarPlus, CalendarSync, Clock, ExternalLink, Mail, MapPin, Trash2, Video } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, cx } from '../../components/ui';
import { t } from '../../i18n';
import { parseExternalKey, splitAttendees } from '../../lib/calendar/external';
import type { ExternalAttendee, ExternalEvent } from '../../lib/calendar/freebusyApi';
import { formatLongDay, formatTime } from '../../lib/calendar/time';
import { platform } from '../../platform';
import { calendarAvailable } from '../../services/calendar';
import { selectExternalDay, useFreeBusy } from '../../stores/freebusy';
import { myUserId, useSession } from '../../stores/session';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, popoverBox } from '../shell/menu';
import { deleteExternalWithConfirm, newEvent } from './actions';
import { PX_PER_MIN } from './gridParts';

/*
 * My external calendar's events in my day (ADR-0045 §3, docs/08 «Календарь»): a card in the
 * «external» style — dashed outline, `CalendarSync`, muted — with the title, the time and the place;
 * a click opens a popover with the attendees (members of this workspace with their avatar and
 * name, the others by address), «Подключиться» (the conference link) and «Открыть в календаре»
 * (the provider's page of the event, only when the server could build it — ADR-0045 amendment 1),
 * «Удалить из календаря» (a series: «only this» / «the whole series») and «Создать встречу в
 * Calab» — the meeting dialog prefilled with the title, the time and the attendees who are members
 * here.
 */

/** The event behind a grid key, from the day's list (the same object until that day is reloaded). */
function useExternal(day: string, extKey: string): ExternalEvent | undefined {
  const { uid, start, end } = parseExternalKey(extKey);
  return useFreeBusy((s) => selectExternalDay(day)(s).find((e) => e.uid === uid && e.start === start && e.end === end));
}

const tone = 'border border-dashed border-[var(--color-label-tertiary)] bg-[var(--color-fill)] text-muted';

const titleOf = (e: ExternalEvent): string => e.summary || t('ext.noTitle');

/** A timed external event on the grid. */
export const ExternalBlock = memo(function ExternalBlock({
  workspaceId,
  day,
  extKey,
  top,
  height,
  col,
  cols,
}: {
  workspaceId: string;
  day: string;
  extKey: string;
  top: number;
  height: number;
  col: number;
  cols: number;
}): ReactNode {
  const ev = useExternal(day, extKey);
  if (!ev) return null;
  const px = height * PX_PER_MIN;
  const short = px < 38;
  const time = `${formatTime(ev.start)} – ${formatTime(ev.end)}`;
  return (
    <ExternalPopover workspaceId={workspaceId} ev={ev}>
      <button
        type="button"
        data-testid="external-block"
        data-ext={extKey}
        aria-label={t('ext.block', { title: titleOf(ev), time })}
        className={cx('absolute z-[1] overflow-hidden rounded-[6px] px-1.5 text-left', short ? 'py-0' : 'py-1', tone, 'hover:bg-[var(--color-fill-hover)]')}
        style={{
          top: top * PX_PER_MIN + 1,
          height: Math.max(18, px - 2),
          left: `calc(${(col / cols) * 100}% + 2px)`,
          width: `calc(${100 / cols}% - 4px)`,
        }}
      >
        {short ? (
          <p className="flex items-center gap-1 truncate text-caption leading-4">
            <CalendarSync className="size-3 shrink-0" aria-hidden />
            <span className="truncate font-semibold">{titleOf(ev)}</span>
            <span className="shrink-0 opacity-80">· {formatTime(ev.start)}</span>
          </p>
        ) : (
          <>
            <p className="flex items-center gap-1 text-caption font-semibold">
              <CalendarSync className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{titleOf(ev)}</span>
            </p>
            <p className="truncate text-caption opacity-80">
              {time}
              {ev.location ? ` · ${ev.location}` : ''}
            </p>
          </>
        )}
      </button>
    </ExternalPopover>
  );
});

/** An all-day external event in the «весь день» row. */
export const ExternalChip = memo(function ExternalChip({ workspaceId, day, extKey }: { workspaceId: string; day: string; extKey: string }): ReactNode {
  const ev = useExternal(day, extKey);
  if (!ev) return null;
  return (
    <ExternalPopover workspaceId={workspaceId} ev={ev}>
      <button
        type="button"
        data-testid="external-block"
        data-ext={extKey}
        aria-label={t('ext.block', { title: titleOf(ev), time: t('cal.allDay') })}
        className={cx('flex items-center gap-1 truncate rounded-[6px] px-1.5 text-left text-caption font-semibold leading-5', tone)}
      >
        <CalendarSync className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{titleOf(ev)}</span>
      </button>
    </ExternalPopover>
  );
});

function ExternalPopover({ workspaceId, ev, children }: { workspaceId: string; ev: ExternalEvent; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cx(popoverBox, 'flex max-h-[var(--radix-popover-content-available-height)] w-80 flex-col gap-3 overflow-y-auto p-3')}
          onOpenAutoFocus={(e) => e.preventDefault()}
          // «Создать встречу» opens the (non-modal) meeting dialog: the focus must not jump back.
          onCloseAutoFocus={(e) => e.preventDefault()}
          data-testid="external-popover"
        >
          {open ? <ExternalDetails workspaceId={workspaceId} ev={ev} onDone={() => setOpen(false)} /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ExternalDetails({ workspaceId, ev, onDone }: { workspaceId: string; ev: ExternalEvent; onDone: () => void }): ReactNode {
  const creatable = calendarAvailable(workspaceId);
  const myEmail = useSession((s) => s.me?.email ?? '');
  const when = ev.allDay ? `${formatLongDay(ev.start)} · ${t('cal.allDay')}` : `${formatLongDay(ev.start)} · ${formatTime(ev.start)} – ${formatTime(ev.end)}`;
  const create = (): void => {
    const ws = useWorkspaces.getState().byId[workspaceId];
    const { members, outside } = splitAttendees(ev.attendees, {
      me: myUserId(),
      myEmail,
      canInvite: (id) => {
        const m = ws?.members[id];
        return !!m?.user && !m.user.isBot && m.role !== WorkspaceRole.GUEST;
      },
    });
    onDone();
    newEvent(workspaceId, { start: ev.start, end: ev.end, allDay: ev.allDay, title: ev.summary, attendees: members, outside });
  };
  return (
    <>
      <div className="flex items-start gap-2">
        <CalendarSync className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0">
          <h2 className="break-words text-list font-semibold" data-testid="external-title">
            {titleOf(ev)}
          </h2>
          <p className="text-caption text-muted">{t('ext.source')}</p>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5 text-body">
        <li className="flex items-start gap-2">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <span className="first-letter:uppercase">{when}</span>
        </li>
        {ev.location ? (
          <li className="flex items-start gap-2" data-testid="external-location">
            <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 break-words">{ev.location}</span>
          </li>
        ) : null}
        {ev.organizer ? (
          <li className="flex items-start gap-2 text-caption text-muted">
            <Mail className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{t('ext.organizer', { email: ev.organizer })}</span>
          </li>
        ) : null}
      </ul>
      {ev.url || ev.webUrl ? (
        <div className="flex flex-wrap gap-2" data-testid="external-links">
          {ev.url ? (
            // Synchronously in the click: the web build's window.open must not be blocked.
            <Button variant="secondary" size="sm" onClick={() => void platform.app.openExternal(ev.url)} title={ev.url} data-testid="external-join">
              <Video className="size-3.5" aria-hidden />
              {t('ext.join')}
            </Button>
          ) : null}
          {ev.webUrl ? (
            <Button variant="ghost" size="sm" onClick={() => void platform.app.openExternal(ev.webUrl)} title={ev.webUrl} data-testid="external-open-calendar">
              <ExternalLink className="size-3.5" aria-hidden />
              {t('ext.openCalendar')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {ev.attendees.length ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-caption font-medium text-muted">{t('ext.attendees', { n: ev.attendees.length })}</p>
          <ul className="flex flex-col" data-testid="external-attendees">
            {ev.attendees.map((a) => (
              <AttendeeRow key={a.email} workspaceId={workspaceId} a={a} />
            ))}
          </ul>
        </div>
      ) : null}
      {ev.href || creatable ? (
        // The main action first; «Удалить из календаря» wraps under it in the 320 px popover.
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {creatable ? (
            <Button size="sm" onClick={create} data-testid="external-create">
              <CalendarPlus className="size-3.5" aria-hidden />
              {t('ext.create')}
            </Button>
          ) : null}
          {ev.href ? <DeleteButton ev={ev} onDone={onDone} /> : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * «Удалить из календаря» (ADR-0045 amendment 1); a series offers this occurrence or all of them.
 * The popover closes first, then the confirmation (it says whom the delete reaches).
 */
function DeleteButton({ ev, onDone }: { ev: ExternalEvent; onDone: () => void }): ReactNode {
  const run = (scope: 'this' | 'series'): void => {
    onDone();
    void deleteExternalWithConfirm(ev, scope);
  };
  const button = (
    <Button size="sm" variant="destructive" onClick={ev.recurring ? undefined : () => run('this')} data-testid="external-delete">
      <Trash2 className="size-3.5" aria-hidden />
      {t('ext.delete')}
    </Button>
  );
  if (!ev.recurring) return button;
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>{button}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className={cx(menuBox, 'w-56')} sideOffset={4} align="start" collisionPadding={16} data-testid="external-delete-menu">
          <Dropdown.Item className={menuItem} onSelect={() => run('this')}>
            {t('ext.deleteOne')}
          </Dropdown.Item>
          <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => run('series')}>
            {t('ext.deleteSeries')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** A member of this workspace: avatar and name; anyone else: the envelope and the address (their name as the tip). */
function AttendeeRow({ workspaceId, a }: { workspaceId: string; a: ExternalAttendee }): ReactNode {
  const member = useWorkspaces((s) => !!(a.userId && s.byId[workspaceId]?.members[a.userId]));
  if (member) return <MemberRow workspaceId={workspaceId} userId={a.userId} />;
  return (
    <li className="flex h-7 items-center gap-2 text-body" title={a.name || undefined} data-testid="external-attendee">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--color-fill)] text-muted">
        <Mail className="size-3" aria-hidden />
      </span>
      <span className="min-w-0 truncate">{a.email}</span>
    </li>
  );
}

function MemberRow({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const name = useMemberName(workspaceId, userId);
  const avatar = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.user?.avatarFileId ?? '');
  return (
    <li className="flex h-7 items-center gap-2 text-body" data-testid="external-attendee" data-user={userId}>
      <Avatar userId={userId} name={name} {...(avatar ? { fileId: avatar } : {})} size={20} />
      <span className="min-w-0 truncate">{userId === myUserId() ? t('fb.me') : name}</span>
    </li>
  );
}
