/**
 * Landing / README screenshots (docs/09 #139): the scene's data in each language — people, the
 * workspace, rooms, the chat, meetings, boards and notes — so a Spanish page shows a Spanish team,
 * not a Russian one with a Spanish UI. Only data lives here; the UI text comes from the app's own
 * dictionaries (the page switches its language live before each shot).
 *
 * Keys of `people` are the fixture users (IDS.users): anna is «me» (the signed-in owner).
 */

export type Short = 'ru' | 'en' | 'es' | 'zh';
/** Landing locale → the app's locale (and the folder name under apps/landing/public/screens). */
export const APP_LOCALE: Record<Short, 'ru' | 'en' | 'es' | 'zh-CN'> = { ru: 'ru', en: 'en', es: 'es', zh: 'zh-CN' };

type Person = { name: string; status: string };
type Task = {
  title: string;
  status: number;
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  labels?: string[];
  lead?: PersonKey;
  helpers?: PersonKey[];
  start?: string;
  due?: string;
  estimate?: number;
  milestone?: boolean;
};
export type PersonKey = 'anna' | 'boris' | 'vera' | 'grigory' | 'dina';

export interface Copy {
  company: string;
  otherWorkspaces: [string, string];
  people: Record<PersonKey, Person>;
  rooms: { general: string; dev: string; releases: string; standup: string; meeting: string };
  topics: { general: string; dev: string; releases: string; meeting: string };
  categories: { product: string; voice: string };
  /** The voice room's status line. */
  voiceStatus: string;
  chat: {
    kickoff: string;
    mockupCaption: string;
    mockupFile: string;
    mockup: { nav: string[]; title: string; lead: string; cta: string; secondary: string };
    reply: string;
    replyBack: string;
    reportFile: string;
    report: string;
    voiceIntro: string;
    mention: string;
    answer: string;
    /** The morning thread's end after the reply to the mockup: Вера, Борис, Дина, Анна (reactions in seed.ts). */
    thread: [vera: string, boris: string, dina: string, anna: string];
  };
  /** The screen-share slide (1280×720). */
  slide: { eyebrow: string; title: string; items: string[]; done: number; footer: string };
  dm: { hi: string; answer: string; checklist: string; callAsk: string };
  calendar: {
    release: string;
    standup: string;
    designReview: string;
    oneOnOne: string;
    planning: string;
    planningAgenda: string;
    interview: string;
    demo: string;
    retro: string;
    external: string;
  };
  board: {
    name: string;
    description: string;
    statuses: [string, string, string, string, string, string];
    labels: { bug: string; feature: string; design: string; infra: string };
    milestone: string;
    tasks: Task[];
    /** The task opened in the panel (index in `tasks`) and its description, subtasks and comments. */
    open: { index: number; description: string; subtasks: string[]; comments: [PersonKey, string][] };
    marketing: string;
  };
  notes: {
    shelves: [string, string][];
    open: string;
    items: string[];
    forwarded: string;
  };
  guest: string;
}

// Task statuses by index: 0 Backlog, 1 Todo, 2 In progress, 3 Review, 4 Done, 5 Cancelled.
const ru: Copy = {
  company: 'Нордлайт',
  otherWorkspaces: ['Дизайн-студия', 'Сообщество'],
  people: {
    anna: { name: 'Анна Смирнова', status: 'Готовлю релиз 1.1' },
    boris: { name: 'Борис Петров', status: 'На созвоне' },
    vera: { name: 'Вера Ким', status: '' },
    grigory: { name: 'Григорий Соколов', status: 'В отпуске до 26.01' },
    dina: { name: 'Дина Лебедева', status: 'Тестирую 1.1' },
  },
  rooms: { general: 'общий', dev: 'разработка', releases: 'релизы', standup: 'Стендап', meeting: 'Переговорка' },
  topics: { general: 'Общие вопросы команды', dev: 'Код, ревью и CI', releases: 'Сборки и заметки к релизам', meeting: 'Для встреч' },
  categories: { product: 'Продукт', voice: 'Голосовые' },
  voiceStatus: 'Планёрка по релизу 1.1',
  chat: {
    kickoff: 'Всем привет! Сегодня выкатываем 1.1 — доски задач уже на стенде 🚀',
    mockupCaption: 'Макет главной для нового лендинга',
    mockupFile: 'landing-hero.png',
    mockup: {
      nav: ['Возможности', 'Тарифы', 'Скачать'],
      title: 'Вся команда — в одном окне',
      lead: 'Голос, чат, встречи и задачи на вашем сервере',
      cta: 'Скачать',
      secondary: 'Открыть в браузере',
    },
    reply: 'Очень круто. Может, hero чуть светлее?',
    replyBack: 'Да, поправлю к обеду 👌',
    reportFile: 'Регресс 1.1.pdf',
    report: 'Прогнала регресс — всё зелёное ✅',
    voiceIntro: 'Коротко голосом, что осталось по релизу',
    mention: 'глянешь чек-лист релиза перед планёркой?',
    answer: 'Да, уже открыла. Буду в «Переговорке» в 14:00.',
    thread: ['Сделаю светлее и пришлю вечером ✨', 'И кнопку «Скачать» покрупнее бы 👀', 'Проверю на телефоне после обеда 📱', 'Отлично, решим на планёрке в 14:00 🙌'],
  },
  slide: {
    eyebrow: 'Планёрка · 15 января',
    title: 'Релиз 1.1',
    items: ['Доски задач: канбан, список, таймлайн', 'Подбор времени встречи', 'Календарь по CalDAV', 'Скриншоты и лендинг', 'Заметки к релизу'],
    done: 3,
    footer: 'Выкатываем сегодня в 18:00',
  },
  dm: {
    hi: 'Привет! Посмотришь сегодня PR с досками?',
    answer: 'Да, после стендапа.',
    checklist: 'Чек-лист релиза:\n1. миграции на стенде\n2. смоук-тесты\n3. заметки к релизу',
    callAsk: 'Созвонимся на пару минут?',
  },
  calendar: {
    release: 'Релиз 1.1',
    standup: 'Стендап',
    designReview: 'Ревью дизайна лендинга',
    oneOnOne: '1:1 с Борисом',
    planning: 'Планёрка по релизу',
    planningAgenda: 'Повестка: что едет в 1.1, риски, кто дежурит',
    interview: 'Интервью: фронтенд',
    demo: 'Демо для клиента',
    retro: 'Ретро спринта',
    external: 'olga@partner.example',
  },
  board: {
    name: 'Продукт',
    description: 'Задачи продукта и релизы',
    statuses: ['Бэклог', 'К работе', 'В работе', 'Ревью', 'Готово', 'Отменено'],
    labels: { bug: 'Баг', feature: 'Фича', design: 'Дизайн', infra: 'Инфра' },
    milestone: 'Релиз 1.1',
    tasks: [
      { title: 'Экспорт доски в CSV', status: 0, priority: 'low', labels: ['feature'] },
      { title: 'Шаблоны досок для маркетинга', status: 0, priority: 'none', labels: ['feature'] },
      { title: 'Тёмная тема для страницы встречи', status: 1, priority: 'medium', labels: ['design'], lead: 'vera', start: '2026-01-19', due: '2026-01-23' },
      { title: 'Напоминания о сроке задачи', status: 1, priority: 'high', labels: ['feature'], lead: 'boris', start: '2026-01-20', due: '2026-01-27', milestone: true },
      { title: 'Эхо в звонке при колонках', status: 2, priority: 'urgent', labels: ['bug'], lead: 'boris', helpers: ['anna'], start: '2026-01-12', due: '2026-01-16', estimate: 3, milestone: true },
      { title: 'Подбор времени: рабочие часы', status: 2, priority: 'high', labels: ['feature'], lead: 'anna', start: '2026-01-13', due: '2026-01-20', estimate: 5, milestone: true },
      { title: 'Иконки для таймлайна', status: 2, priority: 'medium', labels: ['design'], lead: 'vera', start: '2026-01-14', due: '2026-01-19' },
      { title: 'Права приватных досок', status: 3, priority: 'high', labels: ['infra'], lead: 'grigory', start: '2026-01-09', due: '2026-01-16', milestone: true },
      { title: 'Скриншоты для лендинга', status: 3, priority: 'medium', labels: ['design'], lead: 'vera', helpers: ['anna'], start: '2026-01-15', due: '2026-01-21' },
      { title: 'Горячие клавиши досок', status: 4, priority: 'medium', labels: ['feature'], lead: 'anna', start: '2026-01-05', due: '2026-01-12' },
      { title: 'Миграции для вех', status: 4, priority: 'low', labels: ['infra'], lead: 'grigory', start: '2026-01-06', due: '2026-01-09' },
      { title: 'Старый прототип канбана', status: 5, priority: 'none' },
    ],
    open: {
      index: 4,
      description: 'Повторяется на Windows 11 с внешними колонками: собеседники слышат себя через ~10 секунд после входа. Шаги и запись — в комментариях.',
      subtasks: ['Воспроизвести на стенде', 'Проверить на Mac со встроенными динамиками'],
      comments: [
        ['boris', 'Воспроизвёл: Windows 11, колонки Logitech, эхо через ~10 секунд.'],
        ['anna', 'Проверю на Mac сегодня, после планёрки.'],
        ['vera', 'Если нужно — у меня есть те же колонки, могу подключиться 🙌'],
      ],
    },
    marketing: 'Маркетинг',
  },
  notes: {
    shelves: [
      ['Идеи', '💡'],
      ['Ссылки', '🔗'],
      ['К релизу', '🚀'],
    ],
    open: 'Идеи',
    items: ['Сделать онбординг досок за 30 секунд — три подсказки прямо на канбане', 'Показать «Подобрать время» на демо клиенту', 'Шаблон доски «Найм» для HR'],
    forwarded: 'Давайте на ретро обсудим, как делить задачи между досками',
  },
  guest: 'Ольга (партнёр)',
};

const en: Copy = {
  company: 'Northwind',
  otherWorkspaces: ['Design Studio', 'Community'],
  people: {
    anna: { name: 'Emma Carter', status: 'Shipping 1.1' },
    boris: { name: 'Ben Walker', status: 'In a call' },
    vera: { name: 'Olivia Kim', status: '' },
    grigory: { name: 'Greg Foster', status: 'On vacation until Jan 26' },
    dina: { name: 'Dana Lee', status: 'Testing 1.1' },
  },
  rooms: { general: 'general', dev: 'engineering', releases: 'releases', standup: 'Stand-up', meeting: 'Meeting room' },
  topics: { general: 'Team-wide questions', dev: 'Code, reviews and CI', releases: 'Builds and release notes', meeting: 'For meetings' },
  categories: { product: 'Product', voice: 'Voice' },
  voiceStatus: 'Release 1.1 planning',
  chat: {
    kickoff: 'Morning, everyone! 1.1 ships today — task boards are already on staging 🚀',
    mockupCaption: 'Home page mockup for the new landing',
    mockupFile: 'landing-hero.png',
    mockup: {
      nav: ['Features', 'Pricing', 'Download'],
      title: 'Your whole team in one window',
      lead: 'Voice, chat, meetings and tasks on your own server',
      cta: 'Download',
      secondary: 'Open in browser',
    },
    reply: 'Love it. Maybe a slightly lighter hero?',
    replyBack: 'Sure, I’ll fix it before lunch 👌',
    reportFile: 'Regression 1.1.pdf',
    report: 'Regression run is done — all green ✅',
    voiceIntro: 'Quick voice note on what’s left for the release',
    mention: 'could you check the release checklist before planning?',
    answer: 'Yes, on it. See you in the Meeting room at 2 pm.',
    thread: ['I’ll make it lighter and send it tonight ✨', 'And maybe a bigger “Download” button 👀', 'I’ll check it on my phone after lunch 📱', 'Great, let’s settle it at the 2 pm planning 🙌'],
  },
  slide: {
    eyebrow: 'Planning · January 15',
    title: 'Release 1.1',
    items: ['Task boards: kanban, list, timeline', 'Find a time for meetings', 'CalDAV calendar sync', 'Screenshots and landing page', 'Release notes'],
    done: 3,
    footer: 'Shipping today at 6 pm',
  },
  dm: {
    hi: 'Hi! Could you review the boards PR today?',
    answer: 'Sure, right after stand-up.',
    checklist: 'Release checklist:\n1. migrations on staging\n2. smoke tests\n3. release notes',
    callAsk: 'Quick call?',
  },
  calendar: {
    release: 'Release 1.1',
    standup: 'Stand-up',
    designReview: 'Landing design review',
    oneOnOne: '1:1 with Ben',
    planning: 'Release planning',
    planningAgenda: 'Agenda: what ships in 1.1, risks, who is on call',
    interview: 'Interview: frontend',
    demo: 'Customer demo',
    retro: 'Sprint retro',
    external: 'olivia@partner.example',
  },
  board: {
    name: 'Product',
    description: 'Product work and releases',
    statuses: ['Backlog', 'Todo', 'In progress', 'In review', 'Done', 'Canceled'],
    labels: { bug: 'Bug', feature: 'Feature', design: 'Design', infra: 'Infra' },
    milestone: 'Release 1.1',
    tasks: [
      { title: 'Export a board to CSV', status: 0, priority: 'low', labels: ['feature'] },
      { title: 'Board templates for marketing', status: 0, priority: 'none', labels: ['feature'] },
      { title: 'Dark theme for the meeting page', status: 1, priority: 'medium', labels: ['design'], lead: 'vera', start: '2026-01-19', due: '2026-01-23' },
      { title: 'Due date reminders', status: 1, priority: 'high', labels: ['feature'], lead: 'boris', start: '2026-01-20', due: '2026-01-27', milestone: true },
      { title: 'Echo in calls with speakers', status: 2, priority: 'urgent', labels: ['bug'], lead: 'boris', helpers: ['anna'], start: '2026-01-12', due: '2026-01-16', estimate: 3, milestone: true },
      { title: 'Find a time: work hours', status: 2, priority: 'high', labels: ['feature'], lead: 'anna', start: '2026-01-13', due: '2026-01-20', estimate: 5, milestone: true },
      { title: 'Timeline icons', status: 2, priority: 'medium', labels: ['design'], lead: 'vera', start: '2026-01-14', due: '2026-01-19' },
      { title: 'Private board permissions', status: 3, priority: 'high', labels: ['infra'], lead: 'grigory', start: '2026-01-09', due: '2026-01-16', milestone: true },
      { title: 'Screenshots for the landing', status: 3, priority: 'medium', labels: ['design'], lead: 'vera', helpers: ['anna'], start: '2026-01-15', due: '2026-01-21' },
      { title: 'Board keyboard shortcuts', status: 4, priority: 'medium', labels: ['feature'], lead: 'anna', start: '2026-01-05', due: '2026-01-12' },
      { title: 'Milestone migrations', status: 4, priority: 'low', labels: ['infra'], lead: 'grigory', start: '2026-01-06', due: '2026-01-09' },
      { title: 'Old kanban prototype', status: 5, priority: 'none' },
    ],
    open: {
      index: 4,
      description: 'Happens on Windows 11 with external speakers: people hear themselves about 10 seconds after joining. Steps and a recording are in the comments.',
      subtasks: ['Reproduce on staging', 'Check on a Mac with built-in speakers'],
      comments: [
        ['boris', 'Reproduced: Windows 11, Logitech speakers, echo after ~10 seconds.'],
        ['anna', 'I’ll check on a Mac today, after planning.'],
        ['vera', 'I have the same speakers if you need another test 🙌'],
      ],
    },
    marketing: 'Marketing',
  },
  notes: {
    shelves: [
      ['Ideas', '💡'],
      ['Links', '🔗'],
      ['For the release', '🚀'],
    ],
    open: 'Ideas',
    items: ['Board onboarding in 30 seconds — three hints right on the kanban', 'Show “Find a time” in the customer demo', 'A “Hiring” board template for HR'],
    forwarded: 'Let’s discuss how to split tasks between boards at the retro',
  },
  guest: 'Olivia (partner)',
};

const es: Copy = {
  company: 'Brisa Labs',
  otherWorkspaces: ['Estudio de diseño', 'Comunidad'],
  people: {
    anna: { name: 'Lucía Fernández', status: 'Preparando la 1.1' },
    boris: { name: 'Javier Morales', status: 'En una llamada' },
    vera: { name: 'Valeria Ruiz', status: '' },
    grigory: { name: 'Gonzalo Herrera', status: 'De vacaciones hasta el 26/01' },
    dina: { name: 'Daniela Castro', status: 'Probando la 1.1' },
  },
  rooms: { general: 'general', dev: 'desarrollo', releases: 'versiones', standup: 'Daily', meeting: 'Sala de reuniones' },
  topics: { general: 'Temas de todo el equipo', dev: 'Código, revisiones y CI', releases: 'Compilaciones y notas de versión', meeting: 'Para reuniones' },
  categories: { product: 'Producto', voice: 'Voz' },
  voiceStatus: 'Planificación de la versión 1.1',
  chat: {
    kickoff: '¡Buenos días! Hoy sale la 1.1: los tableros de tareas ya están en staging 🚀',
    mockupCaption: 'Maqueta de la portada de la nueva web',
    mockupFile: 'landing-hero.png',
    mockup: {
      nav: ['Funciones', 'Precios', 'Descargar'],
      title: 'Todo el equipo en una ventana',
      lead: 'Voz, chat, reuniones y tareas en tu propio servidor',
      cta: 'Descargar',
      secondary: 'Abrir en el navegador',
    },
    reply: 'Me encanta. ¿Quizá el hero un poco más claro?',
    replyBack: 'Claro, lo ajusto antes de comer 👌',
    reportFile: 'Regresión 1.1.pdf',
    report: 'Regresión terminada: todo en verde ✅',
    voiceIntro: 'Un audio rápido con lo que falta para la versión',
    mention: '¿puedes revisar la checklist de la versión antes de la reunión?',
    answer: 'Sí, ya la tengo abierta. Nos vemos en la Sala de reuniones a las 14:00.',
    thread: ['Lo aclaro y te lo paso esta tarde ✨', 'Y el botón «Descargar», un poco más grande 👀', 'Lo pruebo en el móvil después de comer 📱', 'Perfecto, lo decidimos en la reunión de las 14:00 🙌'],
  },
  slide: {
    eyebrow: 'Planificación · 15 de enero',
    title: 'Versión 1.1',
    items: ['Tableros: kanban, lista, cronograma', 'Buscar hora para reuniones', 'Calendario por CalDAV', 'Capturas y web', 'Notas de la versión'],
    done: 3,
    footer: 'Sale hoy a las 18:00',
  },
  dm: {
    hi: '¡Hola! ¿Puedes revisar hoy el PR de los tableros?',
    answer: 'Sí, después de la daily.',
    checklist: 'Checklist de la versión:\n1. migraciones en staging\n2. pruebas de humo\n3. notas de la versión',
    callAsk: '¿Hablamos un par de minutos?',
  },
  calendar: {
    release: 'Versión 1.1',
    standup: 'Daily',
    designReview: 'Revisión del diseño de la web',
    oneOnOne: '1:1 con Javier',
    planning: 'Planificación de la versión',
    planningAgenda: 'Orden del día: qué entra en la 1.1, riesgos, guardias',
    interview: 'Entrevista: frontend',
    demo: 'Demo para el cliente',
    retro: 'Retro del sprint',
    external: 'olga@partner.example',
  },
  board: {
    name: 'Producto',
    description: 'Tareas de producto y versiones',
    statuses: ['Backlog', 'Por hacer', 'En curso', 'Revisión', 'Hecho', 'Cancelado'],
    labels: { bug: 'Bug', feature: 'Función', design: 'Diseño', infra: 'Infra' },
    milestone: 'Versión 1.1',
    tasks: [
      { title: 'Exportar el tablero a CSV', status: 0, priority: 'low', labels: ['feature'] },
      { title: 'Plantillas de tablero para marketing', status: 0, priority: 'none', labels: ['feature'] },
      { title: 'Tema oscuro en la página de reunión', status: 1, priority: 'medium', labels: ['design'], lead: 'vera', start: '2026-01-19', due: '2026-01-23' },
      { title: 'Recordatorios de fecha límite', status: 1, priority: 'high', labels: ['feature'], lead: 'boris', start: '2026-01-20', due: '2026-01-27', milestone: true },
      { title: 'Eco en llamadas con altavoces', status: 2, priority: 'urgent', labels: ['bug'], lead: 'boris', helpers: ['anna'], start: '2026-01-12', due: '2026-01-16', estimate: 3, milestone: true },
      { title: 'Buscar hora: horario laboral', status: 2, priority: 'high', labels: ['feature'], lead: 'anna', start: '2026-01-13', due: '2026-01-20', estimate: 5, milestone: true },
      { title: 'Iconos del cronograma', status: 2, priority: 'medium', labels: ['design'], lead: 'vera', start: '2026-01-14', due: '2026-01-19' },
      { title: 'Permisos de tableros privados', status: 3, priority: 'high', labels: ['infra'], lead: 'grigory', start: '2026-01-09', due: '2026-01-16', milestone: true },
      { title: 'Capturas para la web', status: 3, priority: 'medium', labels: ['design'], lead: 'vera', helpers: ['anna'], start: '2026-01-15', due: '2026-01-21' },
      { title: 'Atajos de teclado del tablero', status: 4, priority: 'medium', labels: ['feature'], lead: 'anna', start: '2026-01-05', due: '2026-01-12' },
      { title: 'Migraciones de hitos', status: 4, priority: 'low', labels: ['infra'], lead: 'grigory', start: '2026-01-06', due: '2026-01-09' },
      { title: 'Prototipo antiguo del kanban', status: 5, priority: 'none' },
    ],
    open: {
      index: 4,
      description: 'Ocurre en Windows 11 con altavoces externos: los demás se oyen a sí mismos unos 10 segundos después de entrar. Pasos y grabación en los comentarios.',
      subtasks: ['Reproducir en staging', 'Probar en un Mac con altavoces integrados'],
      comments: [
        ['boris', 'Reproducido: Windows 11, altavoces Logitech, eco a los ~10 segundos.'],
        ['anna', 'Lo pruebo hoy en el Mac, después de la reunión.'],
        ['vera', 'Tengo los mismos altavoces si hace falta otra prueba 🙌'],
      ],
    },
    marketing: 'Marketing',
  },
  notes: {
    shelves: [
      ['Ideas', '💡'],
      ['Enlaces', '🔗'],
      ['Para la versión', '🚀'],
    ],
    open: 'Ideas',
    items: ['Onboarding de tableros en 30 segundos: tres pistas en el kanban', 'Enseñar «Buscar hora» en la demo del cliente', 'Plantilla de tablero «Contratación» para RR. HH.'],
    forwarded: 'En la retro hablamos de cómo repartir las tareas entre tableros',
  },
  guest: 'Olga (socia)',
};

const zh: Copy = {
  company: '星河科技',
  otherWorkspaces: ['设计工作室', '社区'],
  people: {
    anna: { name: '林晓雯', status: '正在准备 1.1' },
    boris: { name: '王磊', status: '通话中' },
    vera: { name: '陈思琪', status: '' },
    grigory: { name: '张伟', status: '休假至 1 月 26 日' },
    dina: { name: '刘丹', status: '测试 1.1 中' },
  },
  rooms: { general: '综合', dev: '研发', releases: '版本发布', standup: '站会', meeting: '会议室' },
  topics: { general: '团队公共话题', dev: '代码、评审和 CI', releases: '构建与发布说明', meeting: '开会用' },
  categories: { product: '产品', voice: '语音' },
  voiceStatus: '1.1 版本规划会',
  chat: {
    kickoff: '大家早！1.1 今天发布，任务看板已经在测试环境上线了 🚀',
    mockupCaption: '新官网首页设计稿',
    mockupFile: 'landing-hero.png',
    mockup: {
      nav: ['功能', '价格', '下载'],
      title: '整个团队，一个窗口',
      lead: '语音、聊天、会议和任务，都在你自己的服务器上',
      cta: '下载',
      secondary: '在浏览器中打开',
    },
    reply: '很棒！首屏能再亮一点吗？',
    replyBack: '没问题，午饭前改好 👌',
    reportFile: '回归测试 1.1.pdf',
    report: '回归测试跑完了，全部通过 ✅',
    voiceIntro: '用语音简单说下发布还剩什么',
    mention: '规划会前能看一下发布清单吗？',
    answer: '好的，已经在看了。14:00 会议室见。',
    thread: ['我调亮一点，晚上发出来 ✨', '“下载”按钮也可以再大一点 👀', '午饭后我在手机上测一下 📱', '好的，下午 2 点规划会上定 🙌'],
  },
  slide: {
    eyebrow: '规划会 · 1 月 15 日',
    title: '1.1 版本',
    items: ['任务看板：看板、列表、时间线', '会议找时间', 'CalDAV 日历同步', '截图和官网', '发布说明'],
    done: 3,
    footer: '今天 18:00 发布',
  },
  dm: {
    hi: '你好！今天能看一下看板的 PR 吗？',
    answer: '可以，站会后看。',
    checklist: '发布清单：\n1. 测试环境迁移\n2. 冒烟测试\n3. 发布说明',
    callAsk: '通个话，两分钟？',
  },
  calendar: {
    release: '1.1 版本发布',
    standup: '站会',
    designReview: '官网设计评审',
    oneOnOne: '与王磊 1:1',
    planning: '发布规划会',
    planningAgenda: '议程：1.1 包含什么、风险、值班安排',
    interview: '面试：前端',
    demo: '客户演示',
    retro: '迭代回顾',
    external: 'li@partner.example',
  },
  board: {
    name: '产品',
    description: '产品任务与版本发布',
    statuses: ['待办池', '待处理', '进行中', '评审中', '已完成', '已取消'],
    labels: { bug: '缺陷', feature: '功能', design: '设计', infra: '基础设施' },
    milestone: '1.1 版本',
    tasks: [
      { title: '看板导出为 CSV', status: 0, priority: 'low', labels: ['feature'] },
      { title: '市场部看板模板', status: 0, priority: 'none', labels: ['feature'] },
      { title: '会议页面深色主题', status: 1, priority: 'medium', labels: ['design'], lead: 'vera', start: '2026-01-19', due: '2026-01-23' },
      { title: '截止日期提醒', status: 1, priority: 'high', labels: ['feature'], lead: 'boris', start: '2026-01-20', due: '2026-01-27', milestone: true },
      { title: '外放音箱通话回声', status: 2, priority: 'urgent', labels: ['bug'], lead: 'boris', helpers: ['anna'], start: '2026-01-12', due: '2026-01-16', estimate: 3, milestone: true },
      { title: '找时间：工作时间', status: 2, priority: 'high', labels: ['feature'], lead: 'anna', start: '2026-01-13', due: '2026-01-20', estimate: 5, milestone: true },
      { title: '时间线图标', status: 2, priority: 'medium', labels: ['design'], lead: 'vera', start: '2026-01-14', due: '2026-01-19' },
      { title: '私有看板权限', status: 3, priority: 'high', labels: ['infra'], lead: 'grigory', start: '2026-01-09', due: '2026-01-16', milestone: true },
      { title: '官网截图', status: 3, priority: 'medium', labels: ['design'], lead: 'vera', helpers: ['anna'], start: '2026-01-15', due: '2026-01-21' },
      { title: '看板快捷键', status: 4, priority: 'medium', labels: ['feature'], lead: 'anna', start: '2026-01-05', due: '2026-01-12' },
      { title: '里程碑迁移', status: 4, priority: 'low', labels: ['infra'], lead: 'grigory', start: '2026-01-06', due: '2026-01-09' },
      { title: '旧版看板原型', status: 5, priority: 'none' },
    ],
    open: {
      index: 4,
      description: '在 Windows 11 外接音箱时出现：进入约 10 秒后，对方会听到自己的声音。复现步骤和录音见评论。',
      subtasks: ['在测试环境复现', '在 Mac 内置扬声器上验证'],
      comments: [
        ['boris', '已复现：Windows 11，罗技音箱，约 10 秒后出现回声。'],
        ['anna', '规划会后我在 Mac 上验证一下。'],
        ['vera', '我也有同款音箱，需要的话可以一起测 🙌'],
      ],
    },
    marketing: '市场',
  },
  notes: {
    shelves: [
      ['想法', '💡'],
      ['链接', '🔗'],
      ['发布相关', '🚀'],
    ],
    open: '想法',
    items: ['30 秒看板引导：在看板上直接给三个提示', '客户演示时展示「找时间」', '给 HR 做一个「招聘」看板模板'],
    forwarded: '回顾会上讨论一下任务如何在看板之间划分',
  },
  guest: '李娜（合作方）',
};

export const COPY: Record<Short, Copy> = { ru, en, es, zh };
