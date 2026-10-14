import { PresenceStatus } from '@calaba/protocol';
import { plural, t } from '../../i18n';

/*
 * Meeting reminders (ADR-0038 §5): the per-user choice of up to five «minutes before» and the text
 * of the system notification an EVENT_REMINDER shows. Pure.
 */

/** Allowed values (minutes), as the server validates them. */
export const REMINDER_CHOICES = [5, 10, 15, 30, 60, 120, 1440] as const;
export const MAX_REMINDERS = 5;
/** The server's default for a new user. */
export const DEFAULT_REMINDERS: readonly number[] = [60, 5];

/**
 * A chip clicked: adds or removes `minutes`. Returns the new list (largest first, as the server
 * stores it), or null when a sixth would be added (the chip stays off).
 */
export function toggleReminder(list: readonly number[], minutes: number): number[] | null {
  if (!(REMINDER_CHOICES as readonly number[]).includes(minutes)) return null;
  const on = new Set(list);
  if (on.has(minutes)) on.delete(minutes);
  else if (on.size >= MAX_REMINDERS) return null;
  else on.add(minutes);
  return [...on].sort((a, b) => b - a);
}

/** Chip text: «5 мин», «1 ч», «2 ч», «1 день». */
export function reminderChip(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return plural('cal.chipDays', minutes / 1440);
  if (minutes >= 60 && minutes % 60 === 0) return t('cal.chipHours', { n: minutes / 60 });
  return t('cal.chipMinutes', { n: minutes });
}

/** «Через 15 минут», «Через 1 час», «Через 1 день». */
export function reminderWhen(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return plural('cal.inDays', minutes / 1440);
  if (minutes >= 60 && minutes % 60 === 0) return plural('cal.inHours', minutes / 60);
  return plural('cal.inMinutes', minutes);
}

/** The notification's text: «Через 15 минут: Планёрка · Переговорка» (no room: without « · …»). */
export function reminderText(minutes: number, title: string, roomName: string): string {
  const what = roomName ? `${title} · ${roomName}` : title;
  return t('cal.reminder', { when: reminderWhen(minutes), what });
}

/**
 * An external event's notification (ADR-0045 amendment 3): its title (or `untitled`) and its place,
 * unless the place is only a link (a conference link is offered as «Подключиться»).
 */
export function externalReminderText(minutes: number, summary: string, location: string, untitled: string): string {
  const place = /^\s*https?:\/\//i.test(location) ? '' : location.trim();
  return reminderText(minutes, summary.trim() || untitled, place);
}

/**
 * Show it now? «Не беспокоить» silences reminders only when the user turned «Напоминать при
 * "Не беспокоить"» off (the server checks it too; the local status may be ahead of it).
 */
export const remindNow = (presence: PresenceStatus, remindInDnd: boolean): boolean => presence !== PresenceStatus.DND || remindInDnd;
