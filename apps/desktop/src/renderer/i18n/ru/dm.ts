/**
 * Russian UI strings — direct messages (ADR-0020). Same rules as ru.ts: flat dotted keys,
 * `{param}` placeholders, short, verb-first, no exclamation marks (docs/08).
 */
export const ruDm = {
  'dm.home': 'Личные сообщения',
  'dm.homeUnread': 'Личные сообщения, непрочитанных: {n}',
  'dm.list': 'Личные сообщения',
  'dm.new': 'Новое сообщение',
  'dm.empty': 'Личных сообщений пока нет',
  'dm.emptyHint': 'Напишите коллеге: кнопка «Новое сообщение», профиль или меню участника.',
  'dm.pickTitle': 'Личные сообщения',
  'dm.pickText': 'Выберите переписку слева или начните новую.',
  'dm.you': 'Вы',
  'dm.noMessages': 'Нет сообщений',
  'dm.placeholder': 'Написать @{name}',
  'dm.searchIn': 'Поиск в переписке',
  'dm.searchMessages': 'Поиск по сообщениям',
  'dm.searchChats': 'Чаты',
  'dm.searchFailed': 'Поиск не сработал. Повторите запрос.',
  'dm.write': 'Написать',
  'dm.welcomeText': 'Здесь начинается ваша личная переписка.',
  'dm.markRead': 'Отметить прочитанным',
  'dm.copyLink': 'Копировать ссылку',
  'dm.linkCopied': 'Ссылка скопирована',
  'dm.chat': 'Переписка с {name}',
  // «Новое сообщение»
  'dm.newTitle': 'Новое сообщение',
  'dm.newSearch': 'Имя или ник',
  'dm.newHint': 'Написать можно участникам ваших пространств.',
  'dm.newEmpty': 'Никого не нашли',
  'dm.newFailed': 'Не удалось загрузить список',
  // errors of POST /api/dms
  'dm.errRateLimited': 'Слишком много новых переписок — попробуйте позже',
  'dm.errGuest': 'Гостям личные сообщения недоступны',
  'dm.errNoCommon': 'Нет общего пространства с этим человеком',
  'dm.errSelf': 'Нельзя написать самому себе',
  'dm.errCreate': 'Не удалось начать переписку',
  // a /dm/<id> link of someone else's (or a deleted) conversation
  'dm.errLink': 'Переписка по ссылке недоступна: она не ваша или удалена',
  // archive and «delete for me» (docs/09 #51)
  'dm.archive': 'В архив',
  'dm.unarchive': 'Вернуть из архива',
  'dm.archiveSection': 'Архив — {n}',
  'dm.deleteTitle': 'Удалить чат?',
  'dm.deleteConfirm': 'История будет удалена только у вас; у собеседника она останется.',
  'dm.errState': 'Не удалось изменить переписку',
  'dm.actions': 'Действия с перепиской',
  // quick switcher
  'search.dms': 'Личные сообщения',
} as const;
