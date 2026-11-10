/**
 * Russian UI strings — the member / room picker (docs/08 «Выбор участника», docs/09 #33) and the
 * «Пригласить в комнату» dialog. Same rules as ru.ts: flat dotted keys, `{param}` placeholders.
 */
export const ruPicker = {
  'picker.empty': "Никого не найдено",
  'picker.noRooms': "Комнат не найдено",
  'picker.searchPeople': "Имя, ник, email или телефон",
  'picker.searchRooms': "Найти комнату",
  'picker.roles': "Роли",
  'picker.members': "Участники",
  'picker.guests': "Гости · {n}",
  'picker.rooms': "Комнаты",
  'picker.fullAccess': "полный доступ",
  'picker.alwaysFull': "Всегда полный доступ: настройки комнаты на эту роль не действуют",
  'picker.listed': "в списке",
  'roomInvite.title': "Пригласить в {room}",
  'roomInvite.hint': "Приглашение придёт в личные сообщения со ссылкой на комнату.",
  'roomInvite.send': "Пригласить",
  'roomInvite.sent': "Отправлено",
  'roomInvite.inRoom': "уже в комнате",
  'roomInvite.dmText': "Приглашаю в {room}: {link}",
  'roomInvite.failed': "Не удалось отправить приглашение",
  'roomInvite.link': "Или отправьте ссылку",
  'roomInvite.copy': "Копировать",
} as const;
