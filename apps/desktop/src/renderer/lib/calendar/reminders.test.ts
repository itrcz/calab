import { PresenceStatus } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { externalReminderText, reminderChip, reminderText, remindNow, toggleReminder } from './reminders';

describe('reminder chips (Settings → Уведомления)', () => {
  it('adds and removes, largest first like the server', () => {
    expect(toggleReminder([60, 5], 15)).toEqual([60, 15, 5]);
    expect(toggleReminder([60, 15, 5], 60)).toEqual([15, 5]);
    expect(toggleReminder([], 1440)).toEqual([1440]);
  });

  it('at most five; unknown values are refused', () => {
    expect(toggleReminder([120, 60, 30, 15, 5], 10)).toBeNull();
    // Removing still works at the limit.
    expect(toggleReminder([120, 60, 30, 15, 5], 30)).toEqual([120, 60, 15, 5]);
    expect(toggleReminder([60], 7)).toBeNull();
  });

  it('labels the chips', () => {
    expect([5, 60, 120, 1440].map(reminderChip)).toEqual(['5 мин', '1 ч', '2 ч', '1 день']);
  });
});

describe('EVENT_REMINDER → system notification', () => {
  it('says when, what and where', () => {
    expect(reminderText(15, 'Планёрка', 'Переговорка')).toBe('Через 15 минут: Планёрка · Переговорка');
    expect(reminderText(60, 'Планёрка', 'Переговорка')).toBe('Через 1 час: Планёрка · Переговорка');
    expect(reminderText(1440, 'Ревью', '')).toBe('Через 1 день: Ревью');
    expect(reminderText(5, 'Ревью', '')).toBe('Через 5 минут: Ревью');
  });

  it('external events: the title or a stand-in, the place unless it is a link', () => {
    expect(externalReminderText(15, 'Стоматолог', 'Ленина, 1', 'Без названия')).toBe('Через 15 минут: Стоматолог · Ленина, 1');
    expect(externalReminderText(5, ' ', 'https://telemost.yandex.ru/j/1', 'Без названия')).toBe('Через 5 минут: Без названия');
  });

  it('«Не беспокоить» silences it only with the setting off', () => {
    expect(remindNow(PresenceStatus.ONLINE, false)).toBe(true);
    expect(remindNow(PresenceStatus.DND, true)).toBe(true);
    expect(remindNow(PresenceStatus.DND, false)).toBe(false);
  });
});
