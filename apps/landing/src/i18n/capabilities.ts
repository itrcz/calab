import type { Locale } from './locales';

/** Plan a line is limited to: `team` = Team and above, `business` = Business and Enterprise. */
export type CapPlan = 'team' | 'business';
export type CapLine = { t: string; plan?: CapPlan };
export type CapCard = {
  key: 'voice' | 'chat' | 'meetings' | 'boards' | 'bots' | 'company';
  title: string;
  lines: CapLine[];
};
export type ShowRow = { key: 'voice' | 'chat' | 'calendar' | 'kanban'; title: string; text: string; alt: string };

export type Capabilities = {
  title: string;
  lead: string;
  more: string;
  legend: string;
  cards: CapCard[];
  showTitle: string;
  showLead: string;
  rows: ShowRow[];
};

const caps: Record<Locale, Capabilities> = {
  ru: {
    title: 'Что умеет Calab',
    lead: 'Всё, что команде нужно каждый день, — в одном приложении и без внешних сервисов.',
    more: 'Подробнее',
    legend: 'Team — тариф Team и выше. Business — Business и Enterprise (свой сервер). Остальное доступно на всех тарифах.',
    cards: [
      { key: 'voice', title: 'Голос и видео',
        lines: [
          { t: 'Голосовые комнаты: один клик — и вы в разговоре' },
          { t: 'Шумо- и эхоподавление (RNNoise, AEC3), push-to-talk на любую клавишу' },
          { t: 'Демонстрация экрана в AV1 или H.264, указка и рисование поверх' },
          { t: 'Запись встреч с расшифровкой и резюме в чате' },
          { t: 'Режим музыканта: звук без обработки', plan: 'team' },
        ] },
      { key: 'chat', title: 'Чат',
        lines: [
          { t: 'Ответы, реакции, пересылка сразу в несколько чатов' },
          { t: 'Голосовые сообщения, файлы с превью, закрепы' },
          { t: 'Встроенный набор стикеров для всех тарифов' },
          { t: 'Поиск по пространству, упоминания, быстрый переход по ⌘K' },
          { t: 'Личные сообщения, заметки-полки и веб-версия для телефона' },
        ] },
      { key: 'meetings', title: 'Встречи и календарь',
        lines: [
          { t: 'Календарь с карточкой встречи, повторами и напоминаниями' },
          { t: 'Приглашения по почте с invite.ics для Apple, Google, Outlook' },
          { t: 'Поиск общего времени по занятости коллег' },
          { t: 'Временные комнаты и гостевые ссылки без регистрации' },
          { t: 'Синхронизация CalDAV: Яндекс, iCloud, Nextcloud', plan: 'team' },
        ] },
      { key: 'boards', title: 'Доски задач',
        lines: [
          { t: 'Доска, список и таймлайн с вехами' },
          { t: 'Статусы, приоритеты, метки, подзадачи и связи' },
          { t: 'Задача из любого сообщения; ссылка раскрывается карточкой в чате' },
          { t: 'Согласование: задача не двигается без нужных одобрений' },
          { t: 'Чек-листы в задачах', plan: 'team' },
          { t: 'Вебхук доски с подписью событий', plan: 'business' },
        ] },
      { key: 'bots', title: 'Боты и интеграции',
        lines: [
          { t: 'Боты — участники с токеном: чат, доски, календарь, голос' },
          { t: 'События по WebSocket или webhook с подписью HMAC' },
          { t: 'SDK на TypeScript, примеры на Node и Python' },
          { t: 'Веб-приложения пространства (Grafana, вики, CRM) прямо в окне Calab' },
          { t: 'Звонки на телефон через вашего SIP-провайдера', plan: 'business' },
        ] },
      { key: 'company', title: 'On-premise',
        lines: [
          { t: 'Свой сервер: один docker compose, данные остаются у вас' },
          { t: 'Корпоративный вход (SSO, OpenID Connect)', plan: 'business' },
          { t: 'Каталог сотрудников Active Directory (LDAPS)', plan: 'business' },
          { t: '«Войти через Calab»: OAuth-клиенты пространства', plan: 'business' },
          { t: 'Роли и права, DTLS-SRTP, HTTPS, открытый исходный код (BSL 1.1)' },
        ] },
    ],
    showTitle: 'Как это выглядит',
    showLead: 'Четыре экрана, на которых команда проводит день.',
    rows: [
      { key: 'voice', title: 'Голос: зашли и говорите', text: 'Комнаты всегда открыты. Видно, кто говорит, камеры и экран — рядом, без отдельных ссылок и приложений.', alt: 'Голосовая комната Calab во время планёрки' },
      { key: 'chat', title: 'Чат, как в Telegram', text: 'Ответы, реакции, стикеры, голосовые и файлы. У каждой комнаты свой чат, у каждого сообщения — быстрый путь в задачу.', alt: 'Чат комнаты с реакциями, ответом и стикером' },
      { key: 'calendar', title: 'Календарь и поиск времени', text: 'Встречи со ссылкой на комнату и приглашением по почте. «Найти время» показывает общие окна коллег.', alt: 'Поиск времени для четырёх человек в календаре' },
      { key: 'kanban', title: 'Доски задач', text: 'Доска, список и таймлайн. Обсудили в чате — задача уже на доске, статусы и согласования на месте.', alt: 'Доска «Продукт» с колонками задач' },
    ],
  },
  en: {
    title: 'What Calab can do',
    lead: 'Everything a team needs every day, in one app and with no external services.',
    more: 'Learn more',
    legend: 'Team — the Team plan and above. Business — Business and Enterprise (your own server). Everything else is on every plan.',
    cards: [
      { key: 'voice', title: 'Voice and video',
        lines: [
          { t: 'Voice rooms: one click and you’re in the conversation' },
          { t: 'Noise and echo suppression (RNNoise, AEC3), push-to-talk on any key' },
          { t: 'Screen sharing in AV1 or H.264, with a pointer and drawing on top' },
          { t: 'Meeting recordings with a transcript and summary in the chat' },
          { t: 'Musician mode: sound without processing', plan: 'team' },
        ] },
      { key: 'chat', title: 'Chat',
        lines: [
          { t: 'Replies, reactions, forwarding to several chats at once' },
          { t: 'Voice messages, files with previews, pins' },
          { t: 'A built-in sticker pack on every plan' },
          { t: 'Workspace search, mentions, quick switcher on ⌘K' },
          { t: 'Direct messages, notes shelves and a phone-friendly web app' },
        ] },
      { key: 'meetings', title: 'Meetings and calendar',
        lines: [
          { t: 'A calendar with meeting cards, recurrence and reminders' },
          { t: 'Email invitations with invite.ics for Apple, Google, Outlook' },
          { t: 'Find a time across colleagues’ busy slots' },
          { t: 'Temporary rooms and guest links without sign-up' },
          { t: 'CalDAV sync: Yandex, iCloud, Nextcloud', plan: 'team' },
        ] },
      { key: 'boards', title: 'Task boards',
        lines: [
          { t: 'Board, list and timeline with milestones' },
          { t: 'Statuses, priorities, labels, subtasks and relations' },
          { t: 'A task from any message; the link unfolds into a card in chat' },
          { t: 'Approvals: a task can’t move on without the needed sign-offs' },
          { t: 'Checklists inside tasks', plan: 'team' },
          { t: 'Board webhook with signed events', plan: 'business' },
        ] },
      { key: 'bots', title: 'Bots and integrations',
        lines: [
          { t: 'Bots are members with a token: chat, boards, calendar, voice' },
          { t: 'Events over WebSocket or a webhook with an HMAC signature' },
          { t: 'A TypeScript SDK, examples in Node and Python' },
          { t: 'Workspace web apps (Grafana, wiki, CRM) right inside Calab' },
          { t: 'Phone calls through your own SIP provider', plan: 'business' },
        ] },
      { key: 'company', title: 'On-premise',
        lines: [
          { t: 'Your own server: one docker compose, your data stays with you' },
          { t: 'Corporate sign-in (SSO, OpenID Connect)', plan: 'business' },
          { t: 'Active Directory employee directory (LDAPS)', plan: 'business' },
          { t: 'Sign in with Calab: OAuth clients of your workspace', plan: 'business' },
          { t: 'Roles and permissions, DTLS-SRTP, HTTPS, source available (BSL 1.1)' },
        ] },
    ],
    showTitle: 'How it looks',
    showLead: 'Four screens where a team spends its day.',
    rows: [
      { key: 'voice', title: 'Voice: step in and talk', text: 'Rooms are always open. See who is speaking; cameras and screens sit right there, with no separate links or apps.', alt: 'A Calab voice room during a planning meeting' },
      { key: 'chat', title: 'Chat like Telegram', text: 'Replies, reactions, stickers, voice messages and files. Every room has its own chat, and every message a short path to a task.', alt: 'A room chat with reactions, a reply and a sticker' },
      { key: 'calendar', title: 'Calendar and find a time', text: 'Meetings with a room link and an email invitation. “Find a time” shows the free windows colleagues share.', alt: 'Finding a time for four people in the calendar' },
      { key: 'kanban', title: 'Task boards', text: 'Board, list and timeline. Talk it through in chat and the task is already on the board, with statuses and approvals in place.', alt: 'The Product board with task columns' },
    ],
  },
  es: {
    title: 'Qué puede hacer Calab',
    lead: 'Todo lo que un equipo necesita cada día, en una sola aplicación y sin servicios externos.',
    more: 'Más información',
    legend: 'Team: plan Team o superior. Business: Business y Enterprise (tu propio servidor). Lo demás está en todos los planes.',
    cards: [
      { key: 'voice', title: 'Voz y vídeo',
        lines: [
          { t: 'Salas de voz: un clic y ya estás en la conversación' },
          { t: 'Supresión de ruido y eco (RNNoise, AEC3), pulsar para hablar en cualquier tecla' },
          { t: 'Pantalla compartida en AV1 o H.264, con puntero y dibujo encima' },
          { t: 'Grabación de reuniones con transcripción y resumen en el chat' },
          { t: 'Modo músico: sonido sin procesar', plan: 'team' },
        ] },
      { key: 'chat', title: 'Chat',
        lines: [
          { t: 'Respuestas, reacciones y reenvío a varios chats a la vez' },
          { t: 'Mensajes de voz, archivos con vista previa, mensajes fijados' },
          { t: 'Un pack de stickers integrado en todos los planes' },
          { t: 'Búsqueda en el espacio, menciones, cambio rápido con ⌘K' },
          { t: 'Mensajes directos, estantes de notas y web adaptada al móvil' },
        ] },
      { key: 'meetings', title: 'Reuniones y calendario',
        lines: [
          { t: 'Calendario con ficha de reunión, repeticiones y recordatorios' },
          { t: 'Invitaciones por correo con invite.ics para Apple, Google, Outlook' },
          { t: 'Buscar hora según la disponibilidad de tus colegas' },
          { t: 'Salas temporales y enlaces de invitado sin registro' },
          { t: 'Sincronización CalDAV: Yandex, iCloud, Nextcloud', plan: 'team' },
        ] },
      { key: 'boards', title: 'Tableros de tareas',
        lines: [
          { t: 'Tablero, lista y cronograma con hitos' },
          { t: 'Estados, prioridades, etiquetas, subtareas y relaciones' },
          { t: 'Una tarea desde cualquier mensaje; el enlace se muestra como tarjeta' },
          { t: 'Aprobaciones: la tarea no avanza sin los vistos buenos necesarios' },
          { t: 'Listas de comprobación en las tareas', plan: 'team' },
          { t: 'Webhook del tablero con eventos firmados', plan: 'business' },
        ] },
      { key: 'bots', title: 'Bots e integraciones',
        lines: [
          { t: 'Los bots son miembros con token: chat, tableros, calendario, voz' },
          { t: 'Eventos por WebSocket o webhook con firma HMAC' },
          { t: 'SDK en TypeScript, ejemplos en Node y Python' },
          { t: 'Aplicaciones web del espacio (Grafana, wiki, CRM) dentro de Calab' },
          { t: 'Llamadas a teléfono con tu propio proveedor SIP', plan: 'business' },
        ] },
      { key: 'company', title: 'On-premise',
        lines: [
          { t: 'Tu servidor: un docker compose, los datos se quedan contigo' },
          { t: 'Acceso corporativo (SSO, OpenID Connect)', plan: 'business' },
          { t: 'Directorio de empleados Active Directory (LDAPS)', plan: 'business' },
          { t: 'Iniciar sesión con Calab: clientes OAuth de tu espacio', plan: 'business' },
          { t: 'Roles y permisos, DTLS-SRTP, HTTPS, código disponible (BSL 1.1)' },
        ] },
    ],
    showTitle: 'Así se ve',
    showLead: 'Cuatro pantallas donde un equipo pasa el día.',
    rows: [
      { key: 'voice', title: 'Voz: entra y habla', text: 'Las salas están siempre abiertas. Se ve quién habla; las cámaras y la pantalla están ahí mismo, sin enlaces ni apps aparte.', alt: 'Una sala de voz de Calab durante una reunión de planificación' },
      { key: 'chat', title: 'Chat como Telegram', text: 'Respuestas, reacciones, stickers, mensajes de voz y archivos. Cada sala tiene su chat y cada mensaje, un camino corto hacia una tarea.', alt: 'El chat de una sala con reacciones, una respuesta y un sticker' },
      { key: 'calendar', title: 'Calendario y buscar hora', text: 'Reuniones con enlace a la sala e invitación por correo. «Buscar hora» muestra los huecos libres comunes.', alt: 'Buscar hora para cuatro personas en el calendario' },
      { key: 'kanban', title: 'Tableros de tareas', text: 'Tablero, lista y cronograma. Lo hablas en el chat y la tarea ya está en el tablero, con estados y aprobaciones.', alt: 'El tablero Producto con columnas de tareas' },
    ],
  },
  zh: {
    title: 'Calab 能做什么',
    lead: '团队每天需要的一切，集中在一个应用里，无需外部服务。',
    more: '了解更多',
    legend: 'Team：Team 及以上方案。Business：Business 和 Enterprise（自有服务器）。其余功能所有方案均可使用。',
    cards: [
      { key: 'voice', title: '语音与视频',
        lines: [
          { t: '语音房间：一键加入，立即交谈' },
          { t: '降噪与回声消除（RNNoise、AEC3），任意按键一键说话' },
          { t: 'AV1 或 H.264 屏幕共享，可在画面上指示和绘画' },
          { t: '会议录制，聊天中附转写与摘要' },
          { t: '音乐人模式：声音不经处理', plan: 'team' },
        ] },
      { key: 'chat', title: '聊天',
        lines: [
          { t: '回复、表情回应、一次转发到多个聊天' },
          { t: '语音消息、带预览的文件、置顶' },
          { t: '内置贴纸包，所有方案可用' },
          { t: '空间搜索、@提及、⌘K 快速切换' },
          { t: '私信、笔记架，以及适配手机的网页版' },
        ] },
      { key: 'meetings', title: '会议与日历',
        lines: [
          { t: '日历含会议卡片、重复和提醒' },
          { t: '邮件邀请附 invite.ics，兼容 Apple、Google、Outlook' },
          { t: '根据同事的忙闲时间查找共同空档' },
          { t: '临时房间与免注册访客链接' },
          { t: 'CalDAV 同步：Yandex、iCloud、Nextcloud', plan: 'team' },
        ] },
      { key: 'boards', title: '任务看板',
        lines: [
          { t: '看板、列表与带里程碑的时间线' },
          { t: '状态、优先级、标签、子任务与关联' },
          { t: '任何消息都能转成任务，链接在聊天中展开为卡片' },
          { t: '审批：未获所需批准，任务无法推进' },
          { t: '任务内清单', plan: 'team' },
          { t: '看板 webhook，事件带签名', plan: 'business' },
        ] },
      { key: 'bots', title: '机器人与集成',
        lines: [
          { t: '机器人是持令牌的成员：聊天、看板、日历、语音' },
          { t: '通过 WebSocket 或带 HMAC 签名的 webhook 接收事件' },
          { t: 'TypeScript SDK，另有 Node 与 Python 示例' },
          { t: '空间网页应用（Grafana、Wiki、CRM）直接在 Calab 内打开' },
          { t: '通过你自己的 SIP 服务商拨打电话', plan: 'business' },
        ] },
      { key: 'company', title: 'On-premise',
        lines: [
          { t: '自有服务器：一条 docker compose，数据留在你手中' },
          { t: '企业登录（SSO，OpenID Connect）', plan: 'business' },
          { t: 'Active Directory 员工目录（LDAPS）', plan: 'business' },
          { t: '“使用 Calab 登录”：空间内的 OAuth 客户端', plan: 'business' },
          { t: '角色与权限、DTLS-SRTP、HTTPS、源代码可查阅（BSL 1.1）' },
        ] },
    ],
    showTitle: '界面一览',
    showLead: '团队每天都在用的四个界面。',
    rows: [
      { key: 'voice', title: '语音：进来就能说', text: '房间始终开放。谁在说话一目了然，摄像头和屏幕就在身边，无需额外链接或应用。', alt: '规划会议中的 Calab 语音房间' },
      { key: 'chat', title: '像 Telegram 一样的聊天', text: '回复、表情回应、贴纸、语音消息和文件。每个房间都有自己的聊天，每条消息都能快速变成任务。', alt: '带表情回应、回复和贴纸的房间聊天' },
      { key: 'calendar', title: '日历与查找时间', text: '会议附房间链接和邮件邀请。“查找时间”显示同事共同的空闲时段。', alt: '在日历中为四个人查找时间' },
      { key: 'kanban', title: '任务看板', text: '看板、列表和时间线。在聊天里讨论完，任务已经在看板上，状态与审批一应俱全。', alt: '以看板形式显示的“产品”看板' },
    ],
  },
};

export const getCapabilities = (locale: Locale): Capabilities => caps[locale];
