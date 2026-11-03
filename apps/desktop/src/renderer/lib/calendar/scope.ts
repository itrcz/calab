import type { MessageInitShape } from '@bufbuild/protobuf';
import { EventRepeat, EventScope, type CalendarEvent, type UpdateCalendarEventRequestSchema } from '@calaba/protocol';

/**
 * A change of one occurrence of a repeating meeting (ADR-0157, board #147): «Только эту» — that
 * occurrence alone (it becomes an override of the series), «Всю серию» — it and the following
 * ones (the series splits there; past occurrences stay as they were).
 */
export type SeriesScope = 'this' | 'following';

type UpdateInit = MessageInitShape<typeof UpdateCalendarEventRequestSchema>;

/**
 * Does changing / cancelling this occurrence ask «Только эту / Всю серию»: an occurrence of a
 * series as listed (with its start). An override is a meeting of its own and a series fetched
 * without an occurrence changes as a whole: neither asks.
 */
export function asksScope(ev: Pick<CalendarEvent, 'repeat' | 'occurrenceAt'> | undefined): boolean {
  return !!ev && ev.repeat !== EventRepeat.UNSPECIFIED && !!ev.occurrenceAt;
}

/**
 * The PATCH of a change of the occurrence `ev` in `scope`: its times are the occurrence's new
 * times as they are (not a shift of the series' first start). «Только эту» does not repeat: the
 * form's repeat fields do not apply to it.
 */
export function scopedUpdate(init: UpdateInit, ev: Pick<CalendarEvent, 'occurrenceAt'>, scope: SeriesScope): UpdateInit {
  const out: UpdateInit = {
    ...init,
    scope: scope === 'this' ? EventScope.THIS : EventScope.FOLLOWING,
  };
  if (ev.occurrenceAt) out.occurrenceAt = ev.occurrenceAt;
  if (scope === 'this') {
    delete out.repeat;
    delete out.repeatUntil;
    delete out.clearRepeatUntil;
    delete out.tempRoom;
  }
  return out;
}

/** A change of the repeat is one of the series from this occurrence on: no «Только эту» then. */
export function touchesRepeat(init: UpdateInit): boolean {
  return init.repeat !== undefined || init.repeatUntil !== undefined || !!init.clearRepeatUntil;
}
