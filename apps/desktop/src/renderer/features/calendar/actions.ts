import { EventRepeat } from '@calaba/protocol';
import { confirmAction } from '../../components/Confirm';
import { t } from '../../i18n';
import { deletePrompt } from '../../lib/calendar/external';
import type { ExternalDeleteScopeName, ExternalEvent } from '../../lib/calendar/freebusyApi';
import { eventSpan, formatLongDay } from '../../lib/calendar/time';
import { cancelEvent, canEditEvent, eventOf } from '../../services/calendar';
import { deleteExternalEvent } from '../../services/freebusy';
import { useFreeBusy } from '../../stores/freebusy';
import { useSession } from '../../stores/session';
import { useUi, type EventDraftInit } from '../../stores/ui';

/*
 * The meeting actions shared by the card, the block's context menu and the day view's keys
 * (owner addendum: «каждое действие карточки есть и в контекстном меню блока»).
 */

/** «+ Встреча» / a range on the grid / N: the dialog for a new meeting. */
export function newEvent(workspaceId: string, draft?: EventDraftInit): void {
  useUi.getState().openDialog({ kind: 'event', workspaceId, ...(draft ? { draft } : {}) });
}

/** «Изменить» (double click, the card, the menu). */
export function editEvent(key: string): void {
  const ev = eventOf(key);
  if (!ev || !canEditEvent(ev)) return;
  useUi.getState().openDialog({ kind: 'event', workspaceId: ev.workspaceId, eventKey: key });
}

/** «Дублировать»: a new meeting with the same fields, prefilled. */
export function duplicateEvent(key: string): void {
  const ev = eventOf(key);
  if (!ev) return;
  const { start, end } = eventSpan(ev);
  newEvent(ev.workspaceId, { copyOf: key, start, end, allDay: ev.allDay, roomId: ev.roomId });
}

/**
 * «Отменить» (Delete in the day view): a confirmation first; a series asks «this occurrence» (the
 * menu's first choice) — «all» goes through the card's second button.
 */
export async function cancelWithConfirm(key: string, all = false): Promise<void> {
  const ev = eventOf(key);
  if (!ev || !canEditEvent(ev)) return;
  const series = ev.repeat !== EventRepeat.UNSPECIFIED && !all;
  const ok = series
    ? await confirmAction(t('cal.cancelOneTitle', { date: formatLongDay(eventSpan(ev).start) }), t('cal.cancelOneText'), t('cal.cancelOne'))
    : await confirmAction(t('cal.cancelTitle', { title: ev.title }), t('cal.cancelText'), t('cal.cancel'));
  if (ok) await cancelEvent(ev, series);
}

/**
 * «Удалить из календаря» of my external event (ADR-0045 amendment 1): a confirmation that says whom
 * it reaches (I organize it with others — they get a cancellation from my calendar; else only my
 * calendar), then the delete (gone at once, back on a refusal). My addresses: Calab's and the
 * CalDAV login (usually the calendar's address).
 */
export async function deleteExternalWithConfirm(ev: ExternalEvent, scope: ExternalDeleteScopeName): Promise<boolean> {
  const mine = [useSession.getState().me?.email ?? '', useFreeBusy.getState().caldav?.username ?? ''];
  const p = deletePrompt(ev, scope, mine);
  if (!(await confirmAction(p.title, p.text, p.action))) return false;
  return deleteExternalEvent(ev, scope);
}
