import type { PersonKey, Short } from './copy';

/**
 * Landing v6 scenes (landing-v6.spec.ts, docs/plans/landing-v6.md §5): the data of the «one day of a team»
 * story in each language — one request, one task (APP-7), one meeting, one wiki page, one canvas, one
 * phone call — plus the telephony, role, recording and AI windows. Only data lives here; the UI text
 * comes from the app's own dictionaries. People, rooms and the board are those of copy.ts (by key).
 */

export interface Copy4 {
  /** The thread of «общий» (chat-full / chat-focus / story-message). */
  chat: {
    request: string;
    reqReply: string;
    sticker: string;
    taskLead: string;
    meetingNote: string;
  };
  /** APP-7 — the task made of Вера's request. */
  task: {
    title: string;
    description: string;
    checklistTitle: string;
    /** 4 items, the first two done. */
    checklist: [string, string, string, string];
    comment: [PersonKey, string][];
    review: string;
  };
  /** «Ревью экспорта CSV» — 15:00 in the meeting room, four invited. */
  meeting: { title: string; description: string };
  /** The board «Продукт»: 14 tasks (APP-7 is the 7th), the open one is `export`. */
  board: {
    tasks: BoardTask[];
  };
  /** The calendar week: events by weekday (Mon 12 … Sun 18 January 2026). */
  week: { title: string; day: number; from: string; to: string; room?: boolean; who?: PersonKey[]; organizer?: PersonKey }[];
  wiki: {
    title: string;
    tree: { handbook: string; product: string; export: string; onboarding: string; day: string; processes: string; releases: string; review: string; glossary: string; meetings: string; retro: string; drafts: string };
    intro: string;
    goal: string;
    steps: string;
    tasks: [string, string, string, string];
    who: string;
    table: [[string, string], [string, string], [string, string], [string, string]];
    taskCard: string;
    canvasCard: string;
  };
  canvas: {
    name: string;
    folder: string;
    title: string;
    cols: [string, string, string];
    /** Nine stickies: three per column (green / pink / blue). */
    stickies: [string, string, string, string, string, string, string, string, string];
    shapes: [string, string];
    post: string;
    reply: string;
  };
  tel: {
    /** `ivr[0]` is the main menu with a recording and keys. */
    menus: [string, string];
    groups: [string, string];
    ext: [string, string, string];
    /** Calls: number, where the first is in the menu, the second answered by Вера. */
    calls: [string, string];
    journalVia: string;
  };
  /** The custom roles of «Роли»: the one opened and the second. */
  role: { name: string; other: string };
  /** The workspace's web apps in the rail (tooltips). */
  apps: [string, string];
  temp: { name: string };
  rec: {
    summary: string;
    transcript: string[];
    query: string;
  };
  ai: { text: string; files: [string, string] };
}

export interface BoardTask {
  title: string;
  status: number;
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  labels?: ('bug' | 'feature' | 'design' | 'infra')[];
  lead?: PersonKey;
  helpers?: PersonKey[];
  start?: string;
  due?: string;
  estimate?: number;
}

/** Task rows shared by all languages (statuses, priorities, people, dates); only the titles differ. */
const ROWS: Omit<BoardTask, 'title'>[] = [
  { status: 0, priority: 'none', labels: ['feature'] },
  { status: 0, priority: 'low', labels: ['feature'], lead: 'dina' },
  { status: 0, priority: 'low', labels: ['design'] },
  { status: 1, priority: 'medium', labels: ['design'], lead: 'vera', start: '2026-01-19', due: '2026-01-23' },
  { status: 1, priority: 'high', labels: ['feature'], lead: 'boris', start: '2026-01-20', due: '2026-01-27' },
  { status: 1, priority: 'high', labels: ['infra'], lead: 'grigory', start: '2026-01-16', due: '2026-01-22' },
  // APP-7: the story task.
  { status: 2, priority: 'high', labels: ['feature'], lead: 'boris', helpers: ['anna'], start: '2026-01-14', due: '2026-01-16', estimate: 5 },
  { status: 2, priority: 'urgent', labels: ['bug'], lead: 'boris', start: '2026-01-12', due: '2026-01-16', estimate: 3 },
  { status: 2, priority: 'medium', labels: ['feature'], lead: 'anna', start: '2026-01-13', due: '2026-01-20' },
  { status: 3, priority: 'high', labels: ['infra'], lead: 'grigory', start: '2026-01-09', due: '2026-01-16' },
  { status: 3, priority: 'medium', labels: ['design'], lead: 'vera', helpers: ['anna'], start: '2026-01-15', due: '2026-01-21' },
  { status: 3, priority: 'low', labels: ['bug'], lead: 'dina', due: '2026-01-19' },
  { status: 4, priority: 'medium', labels: ['feature'], lead: 'anna', start: '2026-01-05', due: '2026-01-12' },
  { status: 4, priority: 'low', labels: ['infra'], lead: 'grigory', start: '2026-01-06', due: '2026-01-09' },
];

const rows = (titles: string[]): BoardTask[] => ROWS.map((r, i) => ({ ...r, title: titles[i] ?? '' }));

const ru: Copy4 = {
  chat: {
    request: 'Клиент просит экспорт доски в CSV до пятницы',
    reqReply: 'Беру. Заведу задачу и соберу всех на ревью 🙌',
    sticker: 'like',
    taskLead: 'Завела задачу, смотрите:',
    meetingNote: 'Ревью — в 15:00 в «Переговорке», жду всех 👌',
  },
  task: {
    title: 'Экспорт доски в CSV',
    description: 'Клиент просит выгрузку доски в CSV до пятницы. Колонки: ключ, название, статус, приоритет, исполнители, срок, метки.',
    checklistTitle: 'План работ',
    checklist: ['Согласовать формат и колонки', 'Выгрузка на сервере', 'Кнопка «Экспорт» на доске', 'Проверка на больших досках'],
    comment: [['vera', 'Клиент просит экспорт доски в CSV до пятницы'], ['boris', 'Беру сервер, кнопку сделаем после ревью.']],
    review: 'Согласует: Анна',
  },
  meeting: { title: 'Ревью экспорта CSV', description: 'Формат файла, колонки, кнопка на доске.' },
  board: {
    tasks: rows([
      'Шаблоны досок для маркетинга',
      'Импорт задач из таблицы',
      'Иконки для таймлайна',
      'Тёмная тема для страницы встречи',
      'Напоминания о сроке задачи',
      'Аудит прав приватных досок',
      'Экспорт доски в CSV',
      'Эхо в звонке при колонках',
      'Подбор времени: рабочие часы',
      'Права приватных досок',
      'Скриншоты для лендинга',
      'Сбой превью PDF в чате',
      'Горячие клавиши досок',
      'Миграции для вех',
    ]),
  },
  week: [
    { title: 'Ревью дизайна', day: 13, from: '11:00', to: '12:00', room: true, who: ['anna', 'dina'], organizer: 'vera' },
    { title: 'Планёрка по релизу', day: 15, from: '12:00', to: '13:00', room: true, who: ['anna', 'vera', 'dina'], organizer: 'boris' },
    { title: 'Ревью экспорта CSV', day: 15, from: '15:00', to: '16:00', room: true, who: ['anna', 'vera', 'grigory'], organizer: 'boris' },
    { title: 'Демо для клиента', day: 16, from: '12:00', to: '13:00', room: true, who: ['boris'], organizer: 'anna' },
    { title: 'Ретро спринта 12', day: 16, from: '16:00', to: '17:00', room: true, who: ['anna', 'boris', 'grigory', 'dina'], organizer: 'vera' },
  ],
  wiki: {
    title: 'Экспорт в CSV',
    tree: { handbook: 'Справочник команды', product: 'Продукт', export: 'Экспорт в CSV', onboarding: 'Онбординг', day: 'Первый день', processes: 'Процессы', releases: 'Релизы', review: 'Код-ревью', glossary: 'Глоссарий', meetings: 'Встречи', retro: 'Ретро 14.01', drafts: 'Черновики' },
    intro: 'Клиент «Северстрой» просит выгрузку доски в CSV до пятницы. Здесь — что делаем и кто за что отвечает.',
    goal: 'Что выгружаем',
    steps: 'План работ',
    tasks: ['Согласовать формат и колонки', 'Выгрузка на сервере', 'Кнопка «Экспорт» на доске', 'Проверка на больших досках'],
    who: 'Кто за что отвечает',
    table: [['Область', 'Ответственный'], ['Сервер', 'Борис'], ['Кнопка на доске', 'Вера'], ['Приёмка', 'Анна']],
    taskCard: 'Задача:',
    canvasCard: 'Холст:',
  },
  canvas: {
    name: 'Ретро спринта 12',
    folder: 'Продукт',
    title: 'Ретро спринта 12',
    cols: ['Что получилось', 'Что не получилось', 'Что попробуем'],
    stickies: ['Релиз вышел\nв срок', 'Доски стали\nбыстрее', 'Хорошее ревью\nдизайна', 'Эхо в звонках\nу части команды', 'Поздно нашли\nбаг в CSV', 'Мало времени\nна тесты', 'Парная\nработа', 'Демо раз\nв неделю', 'Чек-лист\nрелиза в вики'],
    shapes: ['Итоги спринта', 'Действия'],
    post: 'Холст ретро — добавляйте стикеры до 16:00:',
    reply: 'Добавила свои, проголосуем в конце 👍',
  },
  tel: {
    menus: ['Главное меню', 'Нерабочее время'],
    groups: ['Продажи', 'Поддержка'],
    ext: ['Директор', 'Бухгалтерия', 'Склад'],
    calls: ['+79161234567', '+79035550142'],
    journalVia: 'Главное меню',
  },
  role: { name: 'Поддержка', other: 'Модератор' },
  apps: ['Продажи', 'Поддержка'],
  temp: { name: 'Встреча с клиентом' },
  rec: {
    summary: ['## Решения', '- Экспорт доски в CSV выпускаем в пятницу', '- Колонки: ключ, статус, исполнители, срок', '- Кнопку на доске делает Вера'].join('\n'),
    transcript: [
      'Коллеги, начнём. Сегодня обсуждаем экспорт доски в CSV.',
      'Клиент просит выгрузку до пятницы, колонки согласовали вчера.',
      'Нужны эталоны файла, чтобы проверить кодировку и разделители.',
      'Хорошо, Анна всё подготовит. Борис, что с сервером?',
      'Выгрузка готова на стенде, большие доски проверяю сегодня.',
      'Кнопку на доске я нарисую после обеда.',
      'Остался вопрос: отдаём файл сразу или по ссылке?',
      'Давайте по ссылке, как у остальных отчётов. Ещё раз про эталоны: пришлю до вечера.',
      'Договорились.',
    ],
    query: 'эталоны',
  },
  ai: { text: 'Подготовить договор для Северстроя до пятницы\nНужны реквизиты и счёт, детали — в письме бухгалтерии.', files: ['Письмо бухгалтерии.pdf', 'Реквизиты.xlsx'] },
};

const en: Copy4 = {
  chat: {
    request: 'The client asks for a board export to CSV by Friday',
    reqReply: 'On it. I’ll create the task and gather everyone for a review 🙌',
    sticker: 'like',
    taskLead: 'Created the task, take a look:',
    meetingNote: 'Review is at 3 pm in the Meeting room, see you there 👌',
  },
  task: {
    title: 'Export a board to CSV',
    description: 'The client asks for a board export to CSV by Friday. Columns: key, title, status, priority, assignees, due date, labels.',
    checklistTitle: 'Work plan',
    checklist: ['Agree on the format and columns', 'Export on the server', '“Export” button on the board', 'Check on large boards'],
    comment: [['vera', 'The client asks for a board export to CSV by Friday'], ['boris', 'I’ll take the server; the button comes after the review.']],
    review: 'Approver: Emma',
  },
  meeting: { title: 'CSV export review', description: 'File format, columns, the button on the board.' },
  board: {
    tasks: rows([
      'Board templates for marketing',
      'Import tasks from a spreadsheet',
      'Icons for the timeline',
      'Dark theme for the meeting page',
      'Due date reminders',
      'Private board permissions audit',
      'Export a board to CSV',
      'Echo in calls with speakers',
      'Find a time: work hours',
      'Private board permissions',
      'Screenshots for the landing',
      'PDF preview fails in chat',
      'Board keyboard shortcuts',
      'Milestone migrations',
    ]),
  },
  week: [
    { title: 'Design review', day: 13, from: '11:00', to: '12:00', room: true, who: ['anna', 'dina'], organizer: 'vera' },
    { title: 'Release planning', day: 15, from: '12:00', to: '13:00', room: true, who: ['anna', 'vera', 'dina'], organizer: 'boris' },
    { title: 'CSV export review', day: 15, from: '15:00', to: '16:00', room: true, who: ['anna', 'vera', 'grigory'], organizer: 'boris' },
    { title: 'Customer demo', day: 16, from: '12:00', to: '13:00', room: true, who: ['boris'], organizer: 'anna' },
    { title: 'Sprint 12 retro', day: 16, from: '16:00', to: '17:00', room: true, who: ['anna', 'boris', 'grigory', 'dina'], organizer: 'vera' },
  ],
  wiki: {
    title: 'CSV export',
    tree: { handbook: 'Team handbook', product: 'Product', export: 'CSV export', onboarding: 'Onboarding', day: 'First day', processes: 'Processes', releases: 'Releases', review: 'Code review', glossary: 'Glossary', meetings: 'Meetings', retro: 'Retro Jan 14', drafts: 'Drafts' },
    intro: 'Our client Brightline asks for a board export to CSV by Friday. Here is what we do and who owns what.',
    goal: 'What we export',
    steps: 'Work plan',
    tasks: ['Agree on the format and columns', 'Export on the server', '“Export” button on the board', 'Check on large boards'],
    who: 'Who owns what',
    table: [['Area', 'Owner'], ['Server', 'Ben'], ['Button on the board', 'Olivia'], ['Acceptance', 'Emma']],
    taskCard: 'Task:',
    canvasCard: 'Canvas:',
  },
  canvas: {
    name: 'Sprint 12 retro',
    folder: 'Product',
    title: 'Sprint 12 retro',
    cols: ['What went well', 'What did not', 'What we will try'],
    stickies: ['Shipped\non time', 'Boards got\nfaster', 'Great design\nreview', 'Echo in calls\nfor some of us', 'Found the CSV\nbug late', 'Little time\nfor testing', 'Pair on each\nhard task', 'Weekly\ndemo', 'Release\nchecklist in wiki'],
    shapes: ['Sprint summary', 'Actions'],
    post: 'Retro canvas — add your stickies by 4 pm:',
    reply: 'Added mine, we vote at the end 👍',
  },
  tel: {
    menus: ['Main menu', 'After hours'],
    groups: ['Sales', 'Support'],
    ext: ['Director', 'Accounting', 'Warehouse'],
    calls: ['+14155550134', '+12125550187'],
    journalVia: 'Main menu',
  },
  role: { name: 'Support', other: 'Moderator' },
  apps: ['Sales', 'Help desk'],
  temp: { name: 'Client meeting' },
  rec: {
    summary: ['## Decisions', '- Board export to CSV ships on Friday', '- Columns: key, status, assignees, due date', '- Olivia builds the button on the board'].join('\n'),
    transcript: [
      'Team, let’s start. Today we talk about the board export to CSV.',
      'The client wants it by Friday, we agreed on the columns yesterday.',
      'We need samples of the file to check the encoding and separators.',
      'Good, Emma will take care of it. Ben, how is the server?',
      'The export is ready on staging, I test large boards today.',
      'I will draw the button on the board after lunch.',
      'One question left: do we send the file at once or by a link?',
      'Let’s use a link, like our other reports. And again about the samples: I will send them tonight.',
      'Agreed.',
    ],
    query: 'samples',
  },
  ai: { text: 'Prepare the contract for Brightline by Friday\nWe need the details and an invoice, see the accounting email.', files: ['Accounting email.pdf', 'Details.xlsx'] },
};

const es: Copy4 = {
  chat: {
    request: 'El cliente pide exportar el tablero a CSV antes del viernes',
    reqReply: 'Me encargo. Creo la tarea y reúno a todos para revisarlo 🙌',
    sticker: 'like',
    taskLead: 'He creado la tarea, mirad:',
    meetingNote: 'La revisión es a las 15:00 en la Sala de reuniones, os espero 👌',
  },
  task: {
    title: 'Exportar el tablero a CSV',
    description: 'El cliente pide exportar el tablero a CSV antes del viernes. Columnas: clave, título, estado, prioridad, responsables, fecha límite, etiquetas.',
    checklistTitle: 'Plan de trabajo',
    checklist: ['Acordar formato y columnas', 'Exportación en el servidor', 'Botón «Exportar» en el tablero', 'Prueba con tableros grandes'],
    comment: [['vera', 'El cliente pide exportar el tablero a CSV antes del viernes'], ['boris', 'Yo me encargo del servidor; el botón, tras la revisión.']],
    review: 'Aprueba: Lucía',
  },
  meeting: { title: 'Revisión de la exportación CSV', description: 'Formato del archivo, columnas, botón en el tablero.' },
  board: {
    tasks: rows([
      'Plantillas de tableros para marketing',
      'Importar tareas desde una hoja',
      'Iconos para la línea de tiempo',
      'Tema oscuro para la página de reunión',
      'Recordatorios de fecha límite',
      'Auditoría de permisos de tableros privados',
      'Exportar el tablero a CSV',
      'Eco en llamadas con altavoces',
      'Buscar hora: horario laboral',
      'Permisos de tableros privados',
      'Capturas para la landing',
      'Falla la vista previa de PDF',
      'Atajos de teclado de tableros',
      'Migraciones de hitos',
    ]),
  },
  week: [
    { title: 'Revisión de diseño', day: 13, from: '11:00', to: '12:00', room: true, who: ['anna', 'dina'], organizer: 'vera' },
    { title: 'Planificación de la versión', day: 15, from: '12:00', to: '13:00', room: true, who: ['anna', 'vera', 'dina'], organizer: 'boris' },
    { title: 'Revisión de la exportación CSV', day: 15, from: '15:00', to: '16:00', room: true, who: ['anna', 'vera', 'grigory'], organizer: 'boris' },
    { title: 'Demo para el cliente', day: 16, from: '12:00', to: '13:00', room: true, who: ['boris'], organizer: 'anna' },
    { title: 'Retro del sprint 12', day: 16, from: '16:00', to: '17:00', room: true, who: ['anna', 'boris', 'grigory', 'dina'], organizer: 'vera' },
  ],
  wiki: {
    title: 'Exportación a CSV',
    tree: { handbook: 'Manual del equipo', product: 'Producto', export: 'Exportación a CSV', onboarding: 'Incorporación', day: 'Primer día', processes: 'Procesos', releases: 'Versiones', review: 'Revisión de código', glossary: 'Glosario', meetings: 'Reuniones', retro: 'Retro 14/01', drafts: 'Borradores' },
    intro: 'Nuestro cliente Costa Norte pide exportar el tablero a CSV antes del viernes. Aquí: qué hacemos y quién se encarga de qué.',
    goal: 'Qué exportamos',
    steps: 'Plan de trabajo',
    tasks: ['Acordar formato y columnas', 'Exportación en el servidor', 'Botón «Exportar» en el tablero', 'Prueba con tableros grandes'],
    who: 'Quién se encarga de qué',
    table: [['Área', 'Responsable'], ['Servidor', 'Javier'], ['Botón en el tablero', 'Valeria'], ['Aceptación', 'Lucía']],
    taskCard: 'Tarea:',
    canvasCard: 'Lienzo:',
  },
  canvas: {
    name: 'Retro del sprint 12',
    folder: 'Producto',
    title: 'Retro del sprint 12',
    cols: ['Lo que salió bien', 'Lo que no salió', 'Lo que probaremos'],
    stickies: ['Versión a\ntiempo', 'Tableros\nmás rápidos', 'Buena revisión\nde diseño', 'Eco en\nllamadas', 'Fallo CSV\nvisto tarde', 'Poco tiempo\npara pruebas', 'Pareja en\ntareas difíciles', 'Demo\nsemanal', 'Lista de\nla versión en el wiki'],
    shapes: ['Resumen del sprint', 'Acciones'],
    post: 'Lienzo de la retro: añadid vuestras notas antes de las 16:00:',
    reply: 'He añadido las mías, votamos al final 👍',
  },
  tel: {
    menus: ['Menú principal', 'Fuera de horario'],
    groups: ['Ventas', 'Soporte'],
    ext: ['Dirección', 'Contabilidad', 'Almacén'],
    calls: ['+34910000123', '+34600000456'],
    journalVia: 'Menú principal',
  },
  role: { name: 'Soporte', other: 'Moderador' },
  apps: ['Ventas', 'Atención al cliente'],
  temp: { name: 'Reunión con el cliente' },
  rec: {
    summary: ['## Decisiones', '- La exportación del tablero a CSV sale el viernes', '- Columnas: clave, estado, responsables, fecha límite', '- Valeria hace el botón del tablero'].join('\n'),
    transcript: [
      'Equipo, empecemos. Hoy hablamos de la exportación del tablero a CSV.',
      'El cliente la quiere para el viernes, las columnas se acordaron ayer.',
      'Necesitamos ejemplos del archivo para revisar la codificación y los separadores.',
      'Bien, Lucía se encarga. Javier, ¿cómo va el servidor?',
      'La exportación está lista en el entorno de pruebas, hoy pruebo tableros grandes.',
      'El botón del tablero lo dibujo después de comer.',
      'Queda una duda: ¿enviamos el archivo directo o con un enlace?',
      'Mejor con un enlace, como el resto de informes. Y sobre los ejemplos: los envío esta noche.',
      'De acuerdo.',
    ],
    query: 'ejemplos',
  },
  ai: { text: 'Preparar el contrato para Costa Norte antes del viernes\nHacen falta los datos y la factura, detalles en el correo de contabilidad.', files: ['Correo de contabilidad.pdf', 'Datos.xlsx'] },
};

const zh: Copy4 = {
  chat: {
    request: '客户希望周五前能把看板导出为 CSV',
    reqReply: '我来接。我先建任务，再把大家叫来评审 🙌',
    sticker: 'like',
    taskLead: '任务建好了，大家看看：',
    meetingNote: '评审 15:00 在会议室，等大家 👌',
  },
  task: {
    title: '看板导出为 CSV',
    description: '客户希望周五前能把看板导出为 CSV。列：编号、标题、状态、优先级、负责人、截止日期、标签。',
    checklistTitle: '工作计划',
    checklist: ['确定格式和列', '服务端导出', '看板上的「导出」按钮', '大看板验证'],
    comment: [['vera', '客户希望周五前能把看板导出为 CSV'], ['boris', '服务端我来做，按钮评审后再做。']],
    review: '审批：林晓雯',
  },
  meeting: { title: 'CSV 导出评审', description: '文件格式、列、看板上的按钮。' },
  board: {
    tasks: rows([
      '市场部看板模板',
      '从表格导入任务',
      '时间线图标',
      '会议页深色主题',
      '任务截止提醒',
      '私有看板权限审计',
      '看板导出为 CSV',
      '外放音箱通话回声',
      '找时间：工作时间',
      '私有看板权限',
      '落地页截图',
      '聊天中 PDF 预览失败',
      '看板快捷键',
      '里程碑数据迁移',
    ]),
  },
  week: [
    { title: '设计评审', day: 13, from: '11:00', to: '12:00', room: true, who: ['anna', 'dina'], organizer: 'vera' },
    { title: '版本发布计划会', day: 15, from: '12:00', to: '13:00', room: true, who: ['anna', 'vera', 'dina'], organizer: 'boris' },
    { title: 'CSV 导出评审', day: 15, from: '15:00', to: '16:00', room: true, who: ['anna', 'vera', 'grigory'], organizer: 'boris' },
    { title: '客户演示', day: 16, from: '12:00', to: '13:00', room: true, who: ['boris'], organizer: 'anna' },
    { title: '第 12 期迭代复盘', day: 16, from: '16:00', to: '17:00', room: true, who: ['anna', 'boris', 'grigory', 'dina'], organizer: 'vera' },
  ],
  wiki: {
    title: '导出为 CSV',
    tree: { handbook: '团队手册', product: '产品', export: '导出为 CSV', onboarding: '新人入职', day: '第一天', processes: '流程', releases: '发布', review: '代码评审', glossary: '术语表', meetings: '会议', retro: '1 月 14 日复盘', drafts: '草稿' },
    intro: '客户「北辰集团」希望周五前能把看板导出为 CSV。这里写清楚做什么、谁负责什么。',
    goal: '导出什么',
    steps: '工作计划',
    tasks: ['确定格式和列', '服务端导出', '看板上的「导出」按钮', '大看板验证'],
    who: '谁负责什么',
    table: [['领域', '负责人'], ['服务端', '王磊'], ['看板按钮', '陈思琪'], ['验收', '林晓雯']],
    taskCard: '任务：',
    canvasCard: '白板：',
  },
  canvas: {
    name: '第 12 期迭代复盘',
    folder: '产品',
    title: '第 12 期迭代复盘',
    cols: ['做得好的', '没做好的', '接下来尝试'],
    stickies: ['版本按时\n发布', '看板变\n快了', '设计评审\n很顺利', '部分同事\n通话有回声', 'CSV 问题\n发现太晚', '测试时间\n不够', '难题两人\n结对', '每周一次\n演示', '发布清单\n放知识库'],
    shapes: ['迭代总结', '行动项'],
    post: '复盘白板，16:00 前请补充便签：',
    reply: '我补充了，最后一起投票 👍',
  },
  tel: {
    menus: ['主菜单', '非工作时间'],
    groups: ['销售', '客服'],
    ext: ['总监', '财务', '仓库'],
    calls: ['+861055550134', '+8613800000123'],
    journalVia: '主菜单',
  },
  role: { name: '客服', other: '版主' },
  apps: ['销售', '客服中心'],
  temp: { name: '客户会议' },
  rec: {
    summary: ['## 结论', '- 看板导出 CSV 周五发布', '- 列：编号、状态、负责人、截止日期', '- 看板按钮由陈思琪负责'].join('\n'),
    transcript: [
      '各位，开始吧。今天讨论看板导出为 CSV。',
      '客户要求周五前完成，列昨天已经确认了。',
      '需要几份样例文件，用来检查编码和分隔符。',
      '好，林晓雯来准备。王磊，服务端怎么样？',
      '导出已经在测试环境完成，我今天验证大看板。',
      '看板上的按钮我午饭后来画。',
      '还有个问题：直接发文件，还是发链接？',
      '用链接吧，和其他报表一样。样例的事，我今晚发出来。',
      '就这么定。',
    ],
    query: '样例',
  },
  ai: { text: '周五前准备好北辰集团的合同\n需要资料和发票，详情见财务邮件。', files: ['财务邮件.pdf', '资料.xlsx'] },
};

export const COPY4: Record<Short, Copy4> = { ru, en, es, zh };
