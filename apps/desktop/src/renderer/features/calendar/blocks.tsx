import * as ContextMenu from '../../components/radix/context-menu';
import { AttendeeStatus, EventRepeat } from '@calaba/protocol';
import { Copy, Link2, Pencil, Repeat, Trash2, Video } from 'lucide-react';
import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { plural, t } from '../../i18n';
import { involvedIndexes, myStatusOf } from '../../lib/calendar/events';
import { sharedLabel } from '../../lib/calendar/external';
import { personColor } from '../../lib/calendar/people';
import { eventSpan, formatMinutes, formatRange, formatTime } from '../../lib/calendar/time';
import { canEditEvent, copyEventLink } from '../../services/calendar';
import { useCalendar } from '../../stores/calendar';
import { selectPeople, useFreeBusy } from '../../stores/freebusy';
import { useRooms } from '../../stores/rooms';
import { myUserId } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { menuBox, menuItem, menuSeparator } from '../shell/menu';
import { cancelWithConfirm, duplicateEvent, editEvent } from './actions';
import { parseBusyKey } from './calendarData';
import { useDayDrag } from './dragState';
import { PX_PER_MIN, blockBox } from './gridParts';

/*
 * The blocks of the calendar grid shared by the day and the week view (ADR-0038 §7): a meeting
 * block, its all-day chip and context menu, the «Люди» dots, the free / busy blocks and the drag
 * ghost. Every one a memo leaf with primitive props: a change re-renders the blocks it touches.
 */

/** While a locked meeting is dragged: the «not allowed» cursor over everything. */
export function DropCursor(): ReactNode {
  const locked = useDayDrag((s) => s.locked);
  return locked ? <div className="fixed inset-0 z-[var(--z-popover)] cursor-not-allowed" aria-hidden /> : null;
}

// ---------------------------------------------------------------- blocks

export type BlockDown = (e: ReactPointerEvent<HTMLElement>, key: string, mode: 'move' | 'resize') => void;

/** How a block looks: my answer tints it (declined — faded, no answer yet — dashed), selected — filled. */
function blockTone(status: AttendeeStatus, selected: boolean): string {
  if (selected) return 'bg-accent-strong text-accent-fg border-accent-strong';
  // Declined: already `muted` — the time line's extra opacity-80 would drop it below 4.5:1 (4.48 in light).
  if (status === AttendeeStatus.DECLINED) return 'bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-muted border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] [&_.opacity-80]:opacity-100';
  if (status === AttendeeStatus.PENDING) return 'bg-[color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg))] text-fg border-accent border-dashed';
  return 'bg-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-bg))] text-fg border-accent';
}

export const EventBlock = memo(function EventBlock({
  occKey,
  top,
  height,
  col,
  cols,
  onDown,
  minPx,
}: {
  occKey: string;
  top: number;
  height: number;
  col: number;
  cols: number;
  onDown: BlockDown;
  /** The week view: the narrowest block (gridParts.blockBox). */
  minPx?: number;
}): ReactNode {
  const ev = useCalendar((s) => s.occ[occKey]);
  const roomName = useRooms((s) => (ev?.roomId ? (s.byId[ev.roomId]?.name ?? '') : ''));
  const selected = useUi((s) => s.calEvent === occKey);
  const lifted = useDayDrag((s) => s.key === occKey && !s.locked && (s.mode === 'move' || s.mode === 'resize'));
  if (!ev) return null;
  const editable = canEditEvent(ev);
  const status = myStatusOf(ev, myUserId());
  const time = formatRange(ev);
  const label = roomName ? t('cal.blockRoom', { title: ev.title, time, room: roomName }) : t('cal.block', { title: ev.title, time });
  const px = height * PX_PER_MIN;
  const short = px < 38;
  return (
    <BlockMenu occKey={occKey} editable={editable}>
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-pressed={selected}
        data-occ={occKey}
        data-testid="event-block"
        title={editable ? undefined : t('cal.locked')}
        onPointerDown={(e) => onDown(e, occKey, 'move')}
        onDoubleClick={() => editable && editEvent(occKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            useUi.getState().selectCalEvent(occKey);
          }
        }}
        className={cx(
          'absolute z-[1] overflow-hidden rounded-[6px] border-l-[3px] px-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent',
          short ? 'py-0' : 'py-1',
          blockTone(status, selected),
          // Cascaded over a neighbour (a narrow week column): a hairline of the page keeps them apart.
          !!minPx && cols > 1 && 'shadow-[0_0_0_1px_var(--color-bg)]',
          lifted && 'opacity-40',
        )}
        style={blockBox(top, height, col, cols, minPx)}
      >
        {short ? (
          <p className="truncate text-caption leading-4">
            <span className="font-semibold">{ev.title}</span>
            <span className="opacity-80"> · {formatTime(eventSpan(ev).start)}</span>
          </p>
        ) : (
          <>
            <p className={cx('truncate text-caption font-semibold', status === AttendeeStatus.DECLINED && !selected && 'line-through')}>{ev.title}</p>
            <p className="truncate text-caption opacity-80">
              {time}
              {/* phone: side-by-side events are narrow — the full time stays, the room name goes */}
              {roomName ? <span className={cx(cols > 1 && 'mobile:hidden')}>{` · ${roomName}`}</span> : null}
            </p>
            {px > 70 && ev.repeat !== EventRepeat.UNSPECIFIED ? <Repeat className="mt-0.5 size-3 opacity-70" aria-hidden /> : null}
          </>
        )}
        <PersonDots occKey={occKey} className="absolute right-1 top-1" />
        {editable ? (
          <span
            aria-hidden
            data-testid="event-resize"
            onPointerDown={(e) => {
              e.stopPropagation();
              onDown(e, occKey, 'resize');
            }}
            className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
          />
        ) : null}
      </div>
    </BlockMenu>
  );
});

/** Right click on a block: every action of the card (owner addendum). */
function BlockMenu({ occKey, editable, children }: { occKey: string; editable: boolean; children: ReactNode }): ReactNode {
  const ev = useCalendar((s) => s.occ[occKey]);
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-56')}>
          {editable ? (
            <ContextMenu.Item className={menuItem} onSelect={() => editEvent(occKey)}>
              <Pencil className="size-4" aria-hidden /> {t('cal.edit')}
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Item className={menuItem} onSelect={() => duplicateEvent(occKey)}>
            <Copy className="size-4" aria-hidden /> {t('cal.duplicate')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItem} onSelect={() => ev && copyEventLink(ev.id)}>
            <Link2 className="size-4" aria-hidden /> {t('cal.copyLink')}
          </ContextMenu.Item>
          {ev?.roomId ? (
            <ContextMenu.Item className={menuItem} onSelect={() => useUi.getState().openRoom(ev.workspaceId, ev.roomId)}>
              <Video className="size-4" aria-hidden /> {t('cal.go')}
            </ContextMenu.Item>
          ) : null}
          {editable ? (
            <>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void cancelWithConfirm(occKey)}>
                <Trash2 className="size-4" aria-hidden /> {t('cal.cancelItem')}
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}


export const AllDayChip = memo(function AllDayChip({ occKey, onDown }: { occKey: string; onDown: BlockDown }): ReactNode {
  const ev = useCalendar((s) => s.occ[occKey]);
  const selected = useUi((s) => s.calEvent === occKey);
  if (!ev) return null;
  const editable = canEditEvent(ev);
  return (
    <BlockMenu occKey={occKey} editable={editable}>
      <div
        role="button"
        tabIndex={0}
        data-occ={occKey}
        data-testid="event-block"
        aria-pressed={selected}
        aria-label={t('cal.block', { title: ev.title, time: formatRange(ev) })}
        title={editable ? undefined : t('cal.locked')}
        onPointerDown={(e) => onDown(e, occKey, 'move')}
        onDoubleClick={() => editable && editEvent(occKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            useUi.getState().selectCalEvent(occKey);
          }
        }}
        className={cx('flex min-w-0 items-center gap-1 rounded-[6px] border-l-[3px] px-1.5 text-caption font-semibold leading-5 outline-none focus-visible:ring-2 focus-visible:ring-accent', blockTone(myStatusOf(ev, myUserId()), selected))}
      >
        <span className="min-w-0 flex-1 truncate">{ev.title}</span>
        <PersonDots occKey={occKey} />
      </div>
    </BlockMenu>
  );
});

/**
 * With the «Люди» filter on: a dot per selected person the meeting involves, in their chip colour
 * (docs/08 «Фильтр «Люди»»). A leaf: a selection change re-renders the dots, not the block.
 */
const PersonDots = memo(function PersonDots({ occKey, className }: { occKey: string; className?: string }): ReactNode {
  const ws = useCalendar((s) => s.occ[occKey]?.workspaceId ?? '');
  const people = useFreeBusy(selectPeople(ws));
  // A primitive: the involved positions, re-computed only when the meeting or the selection changes.
  const sig = useCalendar((s) => {
    const ev = s.occ[occKey];
    return ev && people.length ? involvedIndexes(ev, people).join(',') : '';
  });
  if (!sig) return null;
  const idx = sig.split(',').map(Number);
  const names = idx.map((i) => memberName(ws, people[i] ?? '')).join(', ');
  return (
    <span className={cx('pointer-events-none flex shrink-0 items-center gap-0.5', className)} title={names} data-testid="person-dots">
      {idx.map((i) => (
        <span key={i} className="size-1.5 rounded-full ring-1 ring-[var(--color-bg)]" style={{ background: personColor(i) }} aria-hidden />
      ))}
      <span className="sr-only">{names}</span>
    </span>
  );
});

/**
 * The dragged block's (or the selected range's) outline with its time — the only thing that follows
 * the pointer. `day` (the week view): drawn only in the column of the day under the pointer.
 */
export const DragGhost = memo(function DragGhost({ day }: { day?: string }): ReactNode {
  const range = useDayDrag((s) => (s.locked || (day !== undefined && s.day !== day) ? null : s.range));
  const mode = useDayDrag((s) => s.mode);
  if (!range || !mode) return null;
  const top = range.start * PX_PER_MIN;
  const h = (range.end - range.start) * PX_PER_MIN;
  const text = `${formatMinutes(range.start)} – ${formatMinutes(range.end % 1440 === 0 && range.end > 0 ? 0 : range.end)}`;
  return (
    <div
      className="pointer-events-none absolute inset-x-0.5 z-[3] rounded-[6px] border-2 border-dashed border-accent bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
      style={{ top, height: Math.max(12, h) }}
      data-testid="drag-ghost"
    >
      <span className="absolute left-1.5 top-0.5 rounded bg-accent-strong px-1 text-micro font-semibold tabular-nums text-accent-fg">{text}</span>
    </div>
  );
});

// ---------------------------------------------------------------- busy blocks (free / busy)

/**
 * «Занято · Анна, Борис» / mine from the external calendar: «Занято · внешний календарь»; a
 * colleague's shared external event (ADR-0045 §4): «Название · Анна» / «Название · 3 участника · Анна».
 */
function useBusyLabel(workspaceId: string, busyKey: string): { text: string; external: boolean } {
  const b = parseBusyKey(busyKey);
  const names = useWorkspaces((s) => b.users.map((u) => s.byId[workspaceId]?.members[u]?.nickname || s.byId[workspaceId]?.members[u]?.user?.displayName || '').join(', '));
  const mineOnly = b.users.length === 1 && b.users[0] === myUserId();
  const who = mineOnly ? (b.external ? t('fb.external') : '') : names;
  const shared = b.external ? sharedLabel(b) : null;
  if (shared) {
    const label = shared.count ? plural('fb.sharedCount', shared.count, { title: shared.title }) : shared.title;
    return { text: who ? t('fb.sharedWho', { label, who }) : label, external: true };
  }
  return { text: who ? t('fb.busyWho', { who }) : t('fb.busy'), external: b.external };
}

/** Grey, hatched when it comes from an external calendar (docs/08 «Календарь»). */
const busyStyle = (external: boolean): CSSProperties =>
  external
    ? { backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, var(--color-label-tertiary) 35%, transparent) 6px 8px)' }
    : {};

export const BusyBlock = memo(function BusyBlock({
  workspaceId,
  busyKey,
  top,
  height,
  col,
  cols,
  minPx,
}: {
  workspaceId: string;
  busyKey: string;
  top: number;
  height: number;
  col: number;
  cols: number;
  minPx?: number;
}): ReactNode {
  const { text, external } = useBusyLabel(workspaceId, busyKey);
  const { start, end } = parseBusyKey(busyKey);
  const px = height * PX_PER_MIN;
  return (
    <div
      role="img"
      aria-label={`${text}, ${formatTime(start)} – ${formatTime(end)}`}
      title={text}
      data-testid="busy-block"
      className="pointer-events-none absolute z-[1] overflow-hidden rounded-[6px] border-l-[3px] border-[var(--color-label-tertiary)] bg-[var(--color-fill)] px-1.5 text-caption text-muted"
      style={{ ...blockBox(top, height, col, cols, minPx), ...busyStyle(external) }}
    >
      <p className={cx('truncate font-medium', px < 38 ? 'leading-4' : 'pt-1')}>{text}</p>
    </div>
  );
});

export const BusyChip = memo(function BusyChip({ workspaceId, busyKey }: { workspaceId: string; busyKey: string }): ReactNode {
  const { text, external } = useBusyLabel(workspaceId, busyKey);
  return (
    <div role="img" aria-label={text} data-testid="busy-block" className="truncate rounded-[6px] border-l-[3px] border-[var(--color-label-tertiary)] bg-[var(--color-fill)] px-1.5 text-caption font-medium leading-5 text-muted" style={busyStyle(external)}>
      {text}
    </div>
  );
});
