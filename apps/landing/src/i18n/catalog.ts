import type { Locale } from './locales';

/**
 * Landing 3.3 (docs/10 «Лендинг 3.3»): the home page's feature catalog — every big feature as a
 * screenshot and one or two sentences — plus the «Уведомления» section and the «скоро iOS / Android»
 * block. Screenshots: lib/screens.ts (the app and its team in the page's language).
 */
export type CatalogKey = 'voice' | 'gallery' | 'chat' | 'boards' | 'calendar' | 'search' | 'mail' | 'wiki' | 'disk' | 'phone' | 'notify' | 'apps' | 'sip';
export type CatalogCard = { key: CatalogKey; title: string; text: string; alt: string };
type Channel = { title: string; points: string[] };

export type Catalog = {
  title: string;
  lead: string;
  more: string;
  /** Badges: the plan a card's feature needs (Team = Team and above; Business = Business and Enterprise). */
  desktopOnly: string;
  cards: CatalogCard[];
  notify: {
    eyebrow: string;
    title: string;
    lead: string;
    channels: { desktop: Channel; phone: Channel; telegram: Channel };
    levelsTitle: string;
    levels: string[];
    tasksTitle: string;
    tasks: string[];
    tasksNote: string;
    alt: string;
    shotCaption: string;
  };
  mobile: {
    eyebrow: string;
    title: string;
    lead: string;
    points: string[];
    now: string;
    nowLink: string;
    alts: [string, string, string];
  };
};

const catalogs: Record<Locale, Catalog> = {
  ru: {
    title: 'Что есть в Calab',
    lead: 'Каждый экран ниже — настоящее приложение, а не макет. Всё работает в одном окне, на компьютере и в браузере.',
    more: 'Подробнее',
    desktopOnly: 'Приложение для компьютера',
    cards: [
      { key: 'voice', title: 'Голосовые комнаты и демонстрация экрана', text: 'Комнаты всегда открыты: зашли — и говорите. Экран в AV1 или H.264, указка и рисование поверх стрима, шумо- и эхоподавление.', alt: 'Голосовая комната во время звонка: на сцене демонстрация экрана, ниже камеры участников' },
      { key: 'gallery', title: 'Видеовстречи с галереей', text: 'Все участники одинаковыми плитками, до 25 на экране. Тот, кто заговорил, сам оказывается на первой странице; есть режим «Спикер».', alt: 'Видеовстреча в режиме «Галерея»: три камеры и плитка с аватаром, говорящий подсвечен' },
      { key: 'chat', title: 'Чат, как в Telegram', text: 'Ответы, реакции, стикеры, голосовые, файлы с превью и пересылка в несколько чатов. Любое сообщение — в задачу одним действием.', alt: 'Чат комнаты: короткие сообщения с реакциями, ответ с цитатой и галочки прочтения' },
      { key: 'boards', title: 'Доски задач с историей', text: 'Доска, список и таймлайн, согласования, наблюдатели и вехи. Вкладка «История» показывает, кто и что поменял в задаче — по дням.', alt: 'Доска задач и открытая задача на вкладке «История»: смена срока, приоритета, согласование, правило автоматизации' },
      { key: 'calendar', title: 'Календарь и подбор времени', text: 'Встречи со ссылкой на комнату и приглашением .ics, подбор общего окна по занятости коллег, синхронизация CalDAV.', alt: 'Подбор времени для четырёх человек: колонки занятости и выбранный слот' },
      { key: 'search', title: 'Поиск по всему', text: '⌘K находит сообщения, задачи, комментарии, встречи, файлы, заметки и расшифровки записей встреч — с подсветкой и опечатками.', alt: 'Окно поиска: по запросу «релиз» найдены заметки, комната, сообщения, задачи и комментарии' },
      { key: 'mail', title: 'Почта прямо в Calab', text: 'Подключите Gmail, Яндекс, Mail.ru, iCloud или рабочий ящик по IMAP — настройки подберутся сами. Читайте, отвечайте и отправляйте письмо в чат вместе с файлом.', alt: 'Раздел «Почта»: список писем «Все входящие» и открытое письмо с двумя вложениями' },
      { key: 'wiki', title: 'Вики', text: 'Страницы и подстраницы деревом, редактирование вместе в реальном времени, версии, доступ по страницам и публикация по ссылке.', alt: 'Вики: дерево страниц и открытая страница с обложкой, чек-листом, таблицей и курсорами коллег' },
      { key: 'disk', title: 'Диск команды', text: 'Папки и файлы с превью, доступ по папкам, публичные ссылки и корзина. Индикатор показывает, сколько места осталось.', alt: '«Диск» плитками: папки (одна закрытая), файлы с превью и индикатор места' },
      { key: 'phone', title: 'С телефона', text: 'Веб-версия на телефоне уже работает: комнаты, чат, голос, доски и календарь. Приложения для iPhone и Android — скоро.', alt: 'Calab на телефоне' },
      { key: 'notify', title: 'Уведомления под контролем', text: 'Уровень для каждого пространства и комнаты, «Не беспокоить», триггеры задач по отдельности и пересылка своему боту — например, в Telegram.', alt: 'Настройки уведомлений о задачах: переключатели по событиям и «Передавать боту»' },
      { key: 'apps', title: 'Веб-приложения и боты', text: 'CRM, дашборд продаж или вики открываются прямо в окне Calab, звонок продолжается. Боты присылают в чат сводки с кнопками и работают через тот же API: чат, задачи, календарь, голос.', alt: 'Дашборд «Продажи» открыт в окне Calab, поверх — сводка бота с кнопками «Открыть отчёт» и «Напомнить»' },
      { key: 'sip', title: 'Звонки на телефонные номера', text: 'Подключите своего SIP-провайдера — и из голосовой комнаты можно набрать любой номер. Абонента слышат все в комнате.', alt: 'Голосовая комната с окном «Позвонить на номер»' },
    ],
    notify: {
      eyebrow: 'Уведомления',
      title: 'Важное — сразу, лишнее — никогда',
      lead: 'Calab сообщает о сообщениях, звонках, встречах и задачах туда, где вам удобно, и ровно настолько, насколько вы хотите.',
      channels: {
        desktop: { title: 'На компьютере', points: ['Системные уведомления об упоминаниях или обо всех сообщениях', 'Звуки входа, выхода и нового сообщения — можно выключить', 'Напоминания о встречах, в том числе при «Не беспокоить» — по желанию'] },
        phone: { title: 'На телефоне', points: ['Пуш с отправителем, аватаром и текстом — текст можно скрыть', 'Входящий звонок на экране блокировки, как обычный телефонный', 'Работает в приложениях для iPhone и Android (скоро)'] },
        telegram: { title: 'В Telegram', points: ['Выберите своего бота — он получает ваши уведомления о задачах', 'Бот видит ровно то же, что и вы, по тем же настройкам', 'Так легко получать задачи в Telegram или в любой свой сервис'] },
      },
      levelsTitle: 'Сколько уведомлений',
      levels: ['Для пространства и каждой комнаты: «Все сообщения», «Только упоминания» или «Ничего»', 'Заглушить комнату на час, 8 часов, до утра или навсегда', 'Статус «Не беспокоить» — тишина, пока вы заняты'],
      tasksTitle: 'Уведомления о задачах',
      tasks: ['Назначили, сняли с задачи, упомянули, добавили наблюдателем', 'Срок завтра и сегодня, задача просрочена', 'Просят согласовать, согласовано или отклонено', 'Комментарий, смена статуса, срока, приоритета, вехи, файлы'],
      tasksNote: 'Каждый тип события отключается отдельно; согласования приходят всегда.',
      alt: 'Настройки → Уведомления → Задачи: часть событий выключена, внизу «Передавать боту» с ботом «Уведомления в Telegram»',
      shotCaption: 'Настройки → Уведомления → Задачи',
    },
    mobile: {
      eyebrow: 'Скоро',
      title: 'Приложение для iPhone и Android',
      lead: 'Скоро выйдет мобильное приложение — чтобы всегда быть на связи с командой.',
      points: ['Звонки на экране блокировки — ответить можно, не открывая приложение', 'Пуш-уведомления о сообщениях, упоминаниях и задачах', 'Тот же интерфейс: комнаты, чат, голос, доски и календарь'],
      now: 'А пока откройте {link} в браузере телефона — всё работает уже сейчас.',
      nowLink: 'веб-версию',
      alts: ['Список комнат на телефоне: последние сообщения и кто в голосе', 'Чат «общий» на телефоне', 'Карточка «В голосе» на телефоне: три участника и кнопка «Присоединиться»'],
    },
  },
  en: {
    title: 'What’s inside Calab',
    lead: 'Every screen below is the real app, not a mockup. It all works in one window, on the desktop and in the browser.',
    more: 'Learn more',
    desktopOnly: 'Desktop app',
    cards: [
      { key: 'voice', title: 'Voice rooms and screen sharing', text: 'Rooms are always open: step in and talk. Screen sharing in AV1 or H.264, a pointer and drawing on top, noise and echo suppression.', alt: 'A voice room in a call: a shared screen on the stage, participants’ cameras below' },
      { key: 'gallery', title: 'Video meetings with a gallery', text: 'Everyone in equal tiles, up to 25 on screen. Whoever starts talking moves to the first page by themselves; there’s a Speaker view too.', alt: 'A video meeting in Gallery view: three cameras and an avatar tile, the speaker highlighted' },
      { key: 'chat', title: 'Chat like Telegram', text: 'Replies, reactions, stickers, voice messages, files with previews and forwarding to several chats. Any message becomes a task in one step.', alt: 'A room chat: short messages with reactions, a quoted reply and read ticks' },
      { key: 'boards', title: 'Task boards with history', text: 'Board, list and timeline, approvals, watchers and milestones. The History tab shows who changed what in a task, day by day.', alt: 'A task board and an open task on the History tab: due date, priority, an approval and an automation rule' },
      { key: 'calendar', title: 'Calendar and find a time', text: 'Meetings with a room link and an .ics invitation, a shared free slot from colleagues’ busy times, CalDAV sync.', alt: 'Finding a time for four people: busy columns and the picked slot' },
      { key: 'search', title: 'Search everything', text: '⌘K finds messages, tasks, comments, meetings, files, notes and meeting transcripts, with highlights and typo tolerance.', alt: 'The search window: notes, a room, messages, tasks and comments found for “release”' },
      { key: 'mail', title: 'Email right inside Calab', text: 'Connect Gmail, iCloud, Yandex, Mail.ru or any IMAP work mailbox — the settings are found for you. Read, reply and send a letter to a chat with its file.', alt: 'The Mail section: the All inboxes list and an open letter with two attachments' },
      { key: 'wiki', title: 'Wiki', text: 'Pages and subpages in a tree, real-time editing together, versions, per-page access and publishing by link.', alt: 'Wiki: the page tree and an open page with a cover, a checklist, a table and teammates’ cursors' },
      { key: 'disk', title: 'Team disk', text: 'Folders and files with previews, per-folder access, public links and a trash. A meter shows how much space is left.', alt: 'Disk as tiles: folders (one restricted), files with previews and the storage meter' },
      { key: 'phone', title: 'On your phone', text: 'The web app already works on phones: rooms, chat, voice, boards and calendar. iPhone and Android apps are coming soon.', alt: 'Calab on a phone' },
      { key: 'notify', title: 'Notifications under control', text: 'A level for every workspace and room, Do not disturb, task triggers one by one and relaying to your own bot — to Telegram, for example.', alt: 'Task notification settings: a switch per event and “Relay to a bot”' },
      { key: 'apps', title: 'Web apps and bots', text: 'A CRM, a sales dashboard or the wiki open right inside Calab while the call goes on. Bots post summaries with buttons to the chat and use the same API: chat, tasks, calendar, voice.', alt: 'The Sales dashboard open inside Calab, with a bot’s summary and its Open report and Remind me buttons on top' },
      { key: 'sip', title: 'Calls to phone numbers', text: 'Connect your own SIP provider and dial any number from a voice room. Everyone in the room hears the caller.', alt: 'A voice room with the “Call a number” popover' },
    ],
    notify: {
      eyebrow: 'Notifications',
      title: 'What matters, right away. Noise, never.',
      lead: 'Calab tells you about messages, calls, meetings and tasks where it suits you, and exactly as much as you want.',
      channels: {
        desktop: { title: 'On the desktop', points: ['System notifications for mentions or for every message', 'Join, leave and new-message sounds, all optional', 'Meeting reminders, even in Do not disturb if you like'] },
        phone: { title: 'On the phone', points: ['A push with the sender, avatar and text — the text can be hidden', 'An incoming call on the lock screen, like a regular phone call', 'In the iPhone and Android apps (coming soon)'] },
        telegram: { title: 'In Telegram', points: ['Pick your own bot and it gets your task notifications', 'The bot sees exactly what you see, by the same settings', 'An easy way to get tasks in Telegram or any service of yours'] },
      },
      levelsTitle: 'How much to hear',
      levels: ['For the workspace and every room: All messages, Mentions only or Nothing', 'Mute a room for an hour, 8 hours, until morning or forever', 'Do not disturb status: quiet while you’re busy'],
      tasksTitle: 'Task notifications',
      tasks: ['Assigned, unassigned, mentioned, added as a watcher', 'Due tomorrow and today, overdue', 'Approval requested, approved or rejected', 'Comments, status, due date, priority, milestone, files'],
      tasksNote: 'Each kind of event can be switched off on its own; approvals always arrive.',
      alt: 'Settings → Notifications → Tasks: a few events off, “Relay to a bot” below with the “Telegram notifications” bot',
      shotCaption: 'Settings → Notifications → Tasks',
    },
    mobile: {
      eyebrow: 'Coming soon',
      title: 'Apps for iPhone and Android',
      lead: 'A mobile app is coming soon, so you can always stay in touch with your team.',
      points: ['Calls on the lock screen: answer without opening the app', 'Push notifications for messages, mentions and tasks', 'The same interface: rooms, chat, voice, boards and calendar'],
      now: 'Until then, open the {link} in your phone’s browser — it all works today.',
      nowLink: 'web app',
      alts: ['The room list on a phone: last messages and who is in voice', 'The “general” chat on a phone', 'The “In voice” card on a phone: three people and a Join button'],
    },
  },
  es: {
    title: 'Qué hay en Calab',
    lead: 'Cada pantalla de abajo es la aplicación real, no una maqueta. Todo funciona en una sola ventana, en el ordenador y en el navegador.',
    more: 'Más información',
    desktopOnly: 'App de escritorio',
    cards: [
      { key: 'voice', title: 'Salas de voz y pantalla compartida', text: 'Las salas están siempre abiertas: entra y habla. Pantalla en AV1 o H.264, puntero y dibujo encima, supresión de ruido y eco.', alt: 'Una sala de voz en una llamada: una pantalla compartida en el escenario y las cámaras de los participantes debajo' },
      { key: 'gallery', title: 'Videollamadas con galería', text: 'Todos en mosaicos iguales, hasta 25 en pantalla. Quien empieza a hablar pasa solo a la primera página; también hay vista «Orador».', alt: 'Una videollamada en vista Galería: tres cámaras y un mosaico con avatar, quien habla aparece resaltado' },
      { key: 'chat', title: 'Chat como Telegram', text: 'Respuestas, reacciones, stickers, mensajes de voz, archivos con vista previa y reenvío a varios chats. Cualquier mensaje se convierte en tarea en un paso.', alt: 'El chat de una sala: mensajes cortos con reacciones, una respuesta con cita y marcas de lectura' },
      { key: 'boards', title: 'Tableros de tareas con historial', text: 'Tablero, lista y cronograma, aprobaciones, observadores e hitos. La pestaña «Historial» muestra quién cambió qué en la tarea, día a día.', alt: 'Un tablero y una tarea abierta en la pestaña «Historial»: fecha límite, prioridad, una aprobación y una regla de automatización' },
      { key: 'calendar', title: 'Calendario y buscar hora', text: 'Reuniones con enlace a la sala e invitación .ics, un hueco común según la disponibilidad de tus colegas, sincronización CalDAV.', alt: 'Buscar hora para cuatro personas: columnas de ocupación y la franja elegida' },
      { key: 'search', title: 'Busca en todo', text: '⌘K encuentra mensajes, tareas, comentarios, reuniones, archivos, notas y transcripciones de reuniones, con resaltado y tolerancia a erratas.', alt: 'La ventana de búsqueda: notas, una sala, mensajes, tareas y comentarios para «versión»' },
      { key: 'mail', title: 'Correo dentro de Calab', text: 'Conecta Gmail, iCloud, Yandex, Mail.ru o cualquier buzón IMAP del trabajo: la configuración se detecta sola. Lee, responde y envía un correo al chat con su archivo.', alt: 'La sección Correo: la lista «Todas las bandejas» y un correo abierto con dos adjuntos' },
      { key: 'wiki', title: 'Wiki', text: 'Páginas y subpáginas en árbol, edición conjunta en tiempo real, versiones, acceso por página y publicación por enlace.', alt: 'Wiki: el árbol de páginas y una página abierta con portada, lista de tareas, tabla y los cursores de los compañeros' },
      { key: 'disk', title: 'Disco del equipo', text: 'Carpetas y archivos con vista previa, acceso por carpeta, enlaces públicos y papelera. Un indicador muestra cuánto espacio queda.', alt: 'Disco en mosaico: carpetas (una restringida), archivos con vista previa y el indicador de espacio' },
      { key: 'phone', title: 'Desde el móvil', text: 'La versión web ya funciona en el móvil: salas, chat, voz, tableros y calendario. Las apps para iPhone y Android llegan pronto.', alt: 'Calab en un móvil' },
      { key: 'notify', title: 'Notificaciones bajo control', text: 'Un nivel para cada espacio y sala, «No molestar», avisos de tareas uno a uno y reenvío a tu propio bot, por ejemplo a Telegram.', alt: 'Ajustes de notificaciones de tareas: un interruptor por evento y «Reenviar a un bot»' },
      { key: 'apps', title: 'Aplicaciones web y bots', text: 'Un CRM, un panel de ventas o la wiki se abren dentro de Calab mientras sigue la llamada. Los bots publican en el chat resúmenes con botones y usan la misma API: chat, tareas, calendario y voz.', alt: 'El panel «Ventas» abierto dentro de Calab y, encima, el resumen de un bot con los botones «Abrir informe» y «Recordar»' },
      { key: 'sip', title: 'Llamadas a números de teléfono', text: 'Conecta tu proveedor SIP y marca cualquier número desde una sala de voz. Todos en la sala oyen a la persona llamada.', alt: 'Una sala de voz con la ventana «Llamar a un número»' },
    ],
    notify: {
      eyebrow: 'Notificaciones',
      title: 'Lo importante, al momento. El ruido, nunca.',
      lead: 'Calab te avisa de mensajes, llamadas, reuniones y tareas donde te va bien, y justo tanto como quieras.',
      channels: {
        desktop: { title: 'En el ordenador', points: ['Notificaciones del sistema para menciones o para todos los mensajes', 'Sonidos de entrada, salida y mensaje nuevo, todos opcionales', 'Recordatorios de reuniones, también en «No molestar» si quieres'] },
        phone: { title: 'En el móvil', points: ['Push con remitente, avatar y texto; el texto se puede ocultar', 'Llamada entrante en la pantalla de bloqueo, como una llamada normal', 'En las apps para iPhone y Android (pronto)'] },
        telegram: { title: 'En Telegram', points: ['Elige tu propio bot y recibirá tus avisos de tareas', 'El bot ve exactamente lo mismo que tú, con los mismos ajustes', 'Una forma fácil de recibir tareas en Telegram o en tu servicio'] },
      },
      levelsTitle: 'Cuánto oír',
      levels: ['Para el espacio y cada sala: «Todos los mensajes», «Solo menciones» o «Nada»', 'Silenciar una sala una hora, 8 horas, hasta mañana o para siempre', 'Estado «No molestar»: silencio mientras estás ocupado'],
      tasksTitle: 'Avisos de tareas',
      tasks: ['Te asignan, te quitan, te mencionan, te añaden como observador', 'Vence mañana y hoy, tarea vencida', 'Piden tu aprobación, aprobada o rechazada', 'Comentarios, estado, fecha límite, prioridad, hito, archivos'],
      tasksNote: 'Cada tipo de evento se puede desactivar por separado; las aprobaciones llegan siempre.',
      alt: 'Ajustes → Notificaciones → Tareas: algunos eventos desactivados y abajo «Reenviar a un bot» con el bot «Avisos a Telegram»',
      shotCaption: 'Ajustes → Notificaciones → Tareas',
    },
    mobile: {
      eyebrow: 'Próximamente',
      title: 'Apps para iPhone y Android',
      lead: 'Pronto llegará la app móvil, para estar siempre en contacto con tu equipo.',
      points: ['Llamadas en la pantalla de bloqueo: responde sin abrir la app', 'Notificaciones push de mensajes, menciones y tareas', 'La misma interfaz: salas, chat, voz, tableros y calendario'],
      now: 'Mientras tanto, abre la {link} en el navegador del móvil: ya funciona todo.',
      nowLink: 'versión web',
      alts: ['La lista de salas en un móvil: últimos mensajes y quién está en voz', 'El chat «general» en un móvil', 'La tarjeta «En voz» en un móvil: tres personas y el botón «Unirse»'],
    },
  },
  zh: {
    title: 'Calab 里有什么',
    lead: '下面每个界面都是真实应用，而非设计稿。一切都在同一个窗口里完成，桌面端和浏览器均可使用。',
    more: '了解更多',
    desktopOnly: '桌面应用',
    cards: [
      { key: 'voice', title: '语音房间与屏幕共享', text: '房间始终开放：进来就能说。AV1 或 H.264 屏幕共享，可在画面上指示和绘画，并有降噪和回声消除。', alt: '通话中的语音房间：舞台上是共享屏幕，下方是参会者的摄像头' },
      { key: 'gallery', title: '画廊式视频会议', text: '所有人以相同大小的画面显示，一屏最多 25 人。谁开口说话，谁就自动出现在第一页；也可切换“发言人”视图。', alt: '画廊视图的视频会议：三个摄像头和一个头像格，正在发言的人被高亮' },
      { key: 'chat', title: '像 Telegram 一样的聊天', text: '回复、表情回应、贴纸、语音消息、带预览的文件，还能一次转发到多个聊天。任何消息一步变成任务。', alt: '房间聊天：带表情回应的简短消息、引用回复和已读标记' },
      { key: 'boards', title: '带历史记录的任务看板', text: '看板、列表与时间线，审批、关注者和里程碑。“历史”标签按天显示谁改了任务的什么。', alt: '任务看板和“历史”标签下打开的任务：截止日期、优先级、审批和自动化规则' },
      { key: 'calendar', title: '日历与查找时间', text: '会议附房间链接和 .ics 邀请，根据同事的忙闲找到共同空档，支持 CalDAV 同步。', alt: '为四个人查找时间：忙闲列与选中的时段' },
      { key: 'search', title: '全局搜索', text: '⌘K 可搜索消息、任务、评论、会议、文件、笔记和会议转写，支持高亮和容错。', alt: '搜索窗口：按“发布”找到的笔记、房间、消息、任务和评论' },
      { key: 'mail', title: '在 Calab 里收发邮件', text: '连接 Gmail、iCloud、Yandex、Mail.ru 或任意 IMAP 工作邮箱，设置会自动识别。阅读、回复，还能把邮件连同附件发到聊天。', alt: '“邮件”分区：“全部收件箱”列表和带两个附件的已打开邮件' },
      { key: 'wiki', title: '维基', text: '页面与子页面树状排列，多人实时共同编辑，版本历史，按页面设置权限，并可通过链接发布。', alt: '维基：页面树和打开的页面，含封面、清单、表格以及同事的光标' },
      { key: 'disk', title: '团队网盘', text: '带预览的文件夹和文件、按文件夹的权限、公开链接和回收站。用量条显示还剩多少空间。', alt: '平铺视图的网盘：文件夹（其中一个受限）、带预览的文件和空间用量条' },
      { key: 'phone', title: '在手机上', text: '手机网页版已经可用：房间、聊天、语音、看板和日历。iPhone 和 Android 应用即将推出。', alt: '手机上的 Calab' },
      { key: 'notify', title: '通知尽在掌控', text: '为每个空间和房间设置通知级别、“请勿打扰”、逐项开关任务通知，还能转发给你自己的机器人，例如 Telegram。', alt: '任务通知设置：按事件的开关和“转发给机器人”' },
      { key: 'apps', title: '网页应用与机器人', text: 'CRM、销售仪表盘或维基直接在 Calab 窗口中打开，通话不中断。机器人把带按钮的摘要发到聊天，并使用同一套 API：聊天、任务、日历和语音。', alt: '在 Calab 中打开的“销售”仪表盘，上方叠加机器人的摘要和“打开报告”“提醒我”按钮' },
      { key: 'sip', title: '拨打电话号码', text: '接入你自己的 SIP 服务商，就能从语音房间拨打任意号码。房间里的所有人都能听到对方。', alt: '带“拨打号码”弹窗的语音房间' },
    ],
    notify: {
      eyebrow: '通知',
      title: '重要的立刻送达，无关的绝不打扰',
      lead: 'Calab 会把消息、来电、会议和任务的通知发到你方便的地方，多少由你决定。',
      channels: {
        desktop: { title: '在电脑上', points: ['@提及或所有消息的系统通知', '进出房间和新消息提示音，均可关闭', '会议提醒，可选在“请勿打扰”时照常提醒'] },
        phone: { title: '在手机上', points: ['推送显示发送者、头像和内容，内容可隐藏', '锁屏来电，像普通电话一样接听', '在 iPhone 和 Android 应用中提供（即将推出）'] },
        telegram: { title: '在 Telegram 中', points: ['选择你自己的机器人，它会收到你的任务通知', '机器人看到的内容与你完全相同，遵循同样的设置', '轻松在 Telegram 或你自己的服务中接收任务'] },
      },
      levelsTitle: '通知多少由你定',
      levels: ['空间和每个房间：“所有消息”“仅提及”或“不通知”', '房间静音 1 小时、8 小时、到早上或永久', '“请勿打扰”状态：忙碌时保持安静'],
      tasksTitle: '任务通知',
      tasks: ['被指派、被移出、被提及、被添加为关注者', '明天和今天到期、已逾期', '请求审批、已批准或已拒绝', '评论、状态、截止日期、优先级、里程碑、文件'],
      tasksNote: '每类事件都可单独关闭；审批通知始终送达。',
      alt: '设置 → 通知 → 任务：部分事件已关闭，下方“转发给机器人”中开启了“Telegram 通知”机器人',
      shotCaption: '设置 → 通知 → 任务',
    },
    mobile: {
      eyebrow: '即将推出',
      title: 'iPhone 和 Android 应用',
      lead: '移动应用即将推出，让你随时与团队保持联系。',
      points: ['锁屏来电：无需打开应用即可接听', '消息、@提及和任务的推送通知', '同样的界面：房间、聊天、语音、看板和日历'],
      now: '在此之前，可以在手机浏览器中打开{link}，现在就能使用全部功能。',
      nowLink: '网页版',
      alts: ['手机上的房间列表：最新消息和语音中的成员', '手机上的“综合”聊天', '手机上的“语音中”卡片：三位成员和“加入”按钮'],
    },
  },
};

export const getCatalog = (locale: Locale): Catalog => catalogs[locale];
