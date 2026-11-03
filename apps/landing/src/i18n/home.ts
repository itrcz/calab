import { en } from './home-en';
import { es } from './home-es';
import { zh } from './home-zh';
import type { Locale } from './locales';
import type { ScreenName } from '@/lib/screens';

/**
 * Landing v6 home page copy (docs/plans/landing-v6.md §4, §5): the typed contract the home components read.
 * Scene names are the screenshot names of §5 (lib/screens.ts); each has an alt text in `alts`, so a missing
 * alt fails typecheck. Plan facts: apps/server/internal/plans/limits.go and the pricing table in ru.ts
 * (canvases Free 3 / Team 30 / Business 100, AI and telephony Business and Enterprise, mail desktop only).
 * Per-locale texts: ru here (source), the rest in home-<locale>.ts. No foreign trademarks in headings.
 */
export type Tuple<T, N extends number, A extends T[] = []> = A['length'] extends N ? A : Tuple<T, N, [...A, T]>;

export type SceneName =
  // hero: whole windows (a phone crop each, lib/screens.ts `focus`)
  | 'voice' | 'chat-full' | 'kanban-full' | 'calendar-week' | 'wiki-full' | 'canvas' | 'mail-window' | 'disk-full' | 'phone-incoming'
  // the day story
  | 'story-message' | 'story-task' | 'story-meeting' | 'recording-focus' | 'story-wiki' | 'story-incoming'
  // panels cut out of the scenes (scripts/assets.mjs `from`): the story's disk and canvas, the AI row's smart task
  | 'canvas-panel' | 'disk-panel' | 'aitask'
  // telephony, AI, phones
  | 'telephony-ivr' | 'telephony-groups' | 'telephony-call' | 'recording-transcript' | 'phone-canvas' | 'phone-rooms' | 'phone-voice';

/** Every scene is a screenshot of lib/screens.ts (fails typecheck otherwise). */
export const SCENES_ARE_SCREENS: Exclude<SceneName, ScreenName> extends never ? true : never = true;

/** Scene order of the hero chips and the screenshot each chip shows (§4.1). */
export const HERO_SCENES = ['voice', 'chat', 'tasks', 'calendar', 'mail', 'wiki', 'canvas', 'disk', 'phone'] as const;
export type HeroSceneKey = (typeof HERO_SCENES)[number];
export const HERO_SHOT: Record<HeroSceneKey, SceneName> = {
  voice: 'voice', chat: 'chat-full', tasks: 'kanban-full', calendar: 'calendar-week', mail: 'mail-window', wiki: 'wiki-full', canvas: 'canvas', disk: 'disk-full', phone: 'phone-incoming',
};

export type FooterLinkId =
  | 'features' | 'telephony' | 'pricing' | 'download' | 'changelog'
  | 'docs' | 'botApi' | 'mcp' | 'github'
  | 'contacts' | 'support' | 'form'
  | 'offer' | 'terms' | 'privacy' | 'payments' | 'cookies' | 'license' | 'trademarks';

export type Home = {
  nav: { features: string; telephony: string; developers: string; pricing: string; download: string; openWeb: string };
  hero: {
    title: string;
    /** The tail of the title set in the italic accent (chatdeck-style); must end the title. */
    accent: string;
    /** The hero list: the main things, one line each. */
    list: Tuple<string, 4>;
    /** The muted italic line under the list. */
    lead: string;
    download: string;
    /** The second hero button: the web app, free plan. */
    startFree: string;
    platforms: string;
    /** aria-label of the chip tablist. */
    scenesLabel: string;
    scenes: Tuple<{ key: HeroSceneKey; label: string }, 9>;
  };
  replace: {
    title: string;
    /** The words of the title set in the accent (must occur in it). */
    accent: string;
    lead: string;
  };
  story: {
    /** Visually hidden: the section opens straight with the steps (owner, 24.10). */
    title: string;
    steps: Tuple<{ title: string; text: string; shot: SceneName }, 8>;
  };
  telephony: {
    title: string;
    /** The words of the title set in the accent (must occur in it). */
    accent: string;
    lead: string;
    shots: Tuple<{ shot: SceneName; caption: string }, 3>;
    points: Tuple<string, 6>;
    botTitle: string;
    botText: string;
    plan: string;
    docs: string;
    botApi: string;
  };
  ai: {
    title: string;
    /** The words of the title set in the accent (must occur in it). */
    accent: string;
    lead: string;
    /** Third tile has no screenshot: a three-line MCP snippet is drawn instead (`shot` is null). */
    tiles: Tuple<{ title: string; text: string; shot: SceneName | null }, 3>;
    plan: string;
  };
  phone: {
    title: string;
    text: string;
    soon: string;
    soonText: string;
    shots: Tuple<SceneName, 3>;
  };
  trust: {
    title: string;
    /** The part of the title in the accent. */
    accent: string;
    facts: Tuple<string, 5>;
  };
  pricing: {
    /** `<summary>` of the collapsed comparison table on desktop. */
    compare: string;
    /** The four key rows of a plan card. */
    rows: { members: string; room: string; boards: string; canvases: string };
  };
  faq: {
    items: {
      canvas: { q: string; a: string };
      ai: { q: string; a: string };
    };
  };
  footer: {
    columns: Tuple<{ title: string; links: { id: FooterLinkId; label: string }[] }, 4>;
  };
  /** Alt text of every screenshot, by scene name (§5). */
  alts: Record<SceneName, string>;
};

export const ru: Home = {
  nav: { features: 'Возможности', telephony: 'Телефония', developers: 'Разработчикам', pricing: 'Тарифы', download: 'Скачать', openWeb: 'Открыть в браузере' },
  hero: {
    title: 'Вся работа команды — в одном окне',
    accent: 'в одном окне',
    list: ['Видеовстречи', 'Чат', 'Голосовые комнаты', 'Задачи, вики, холст, диск, почта и телефония'],
    lead: 'Всё связано между собой и работает в облаке или на вашем сервере.',
    download: 'Скачать',
    startFree: 'Начать бесплатно',
    platforms: 'macOS · Windows · Linux · Web · iOS · Android',
    scenesLabel: 'Что внутри Calab',
    scenes: [
      { key: 'voice', label: 'Общение и стримы' },
      { key: 'chat', label: 'Привычные чаты' },
      { key: 'tasks', label: 'Задачи и доски' },
      { key: 'calendar', label: 'Календарь' },
      { key: 'mail', label: 'Почта' },
      { key: 'wiki', label: 'Вики' },
      { key: 'canvas', label: 'Холст' },
      { key: 'disk', label: 'Облачный диск' },
      { key: 'phone', label: 'Телефония и IVR' },
    ],
  },
  replace: {
    title: 'Вместо десятка сервисов — одно окно',
    accent: 'одно окно',
    lead: 'Мессенджер, видеозвонки, трекер задач, вики, онлайн-холст, диск, почта, телефония, боты и ИИ-ассистенты — у команды обычно это отдельные вкладки и отдельные счета. В Calab всё это в одном окне, и общий поиск находит что угодно по всей системе.',
  },
  story: {
    title: 'Один день команды — не выходя из окна',
    steps: [
      { title: 'Из сообщения — в задачу', text: 'Клиент просит выгрузку? Откройте меню сообщения и выберите «Создать задачу» — задача заводится прямо из чата.', shot: 'story-message' },
      { title: 'Задача с чек-листом и согласованием', text: 'Исполнители, срок, чек-лист и согласующий — всё в одной панели задачи.', shot: 'story-task' },
      { title: 'Встреча прямо в комнате', text: 'Событие в календаре открывает голосовую комнату: участникам достаточно нажать «Перейти».', shot: 'story-meeting' },
      { title: 'Запись и расшифровка — в чат', text: 'После встречи в чате комнаты появляется карточка: решения, запись и полный транскрипт.', shot: 'recording-focus' },
      { title: 'Итог — на странице вики', text: 'На странице — план работ и ссылки на задачу и холст. Один клик — и вы на месте.', shot: 'story-wiki' },
      { title: 'Файлы — на облачном диске', text: 'Макеты, договоры и записи встреч лежат на диске команды: папки с доступом, превью и публичные ссылки.', shot: 'disk-panel' },
      { title: 'Ретро — на холсте', text: 'Стикеры по колонкам, голосование и таймер: команда разбирает спринт вместе и видит курсоры друг друга.', shot: 'canvas-panel' },
      { title: 'Звонок клиента — прямо в Calab', text: 'Вечером клиент звонит на номер команды: вызов приходит в приложение, ответить можно с компьютера или телефона.', shot: 'story-incoming' },
    ],
  },
  telephony: {
    title: 'Телефонная станция в команде',
    accent: 'в команде',
    lead: 'Подключите SIP-провайдера, и входящие на ваш номер принимают сотрудники прямо в Calab: на компьютере и в веб-версии, в том числе на телефоне. Исходящие набираются из голосовой комнаты.',
    shots: [
      { shot: 'telephony-ivr', caption: 'Голосовое меню: приветствие и маршруты по кнопкам.' },
      { shot: 'telephony-call', caption: 'Активные звонки: кто в голосовом меню, кому звонит группа, кто уже разговаривает.' },
      { shot: 'telephony-groups', caption: 'Группы: звонят все сразу или по очереди, через N секунд — дальше.' },
    ],
    points: [
      'Работает по SIP',
      'Внутренние номера',
      'Голосовое меню (IVR)',
      'Группы и переадресация',
      'Перевод звонка',
      'Запись на Диск',
    ],
    botTitle: 'Даже бот может взять трубку',
    botText: 'Бот может сам принять звонок через Bot API — например, ответить голосом и завести задачу. Для этого бот должен обрабатывать звонки в своём коде: готового бота без программирования нет.',
    plan: 'Business и Enterprise. Звонки оплачиваются у вашего SIP-провайдера.',
    docs: 'Как настроить',
    botApi: 'Bot API',
  },
  ai: {
    title: 'AI там, где он экономит время',
    accent: 'экономит время',
    lead: 'Администратор один раз подключает модель в настройках пространства. Без этого AI не работает.',
    tiles: [
      { title: 'Умная задача', text: 'Опишите задачу своими словами и приложите файлы — ИИ выберет доску и оформит задачу, а вы её поправите.', shot: 'aitask' },
      { title: 'Расшифровка встреч', text: 'Сводка и полный текст разговора. Поиск находит слова из расшифровок по всем встречам.', shot: 'recording-transcript' },
      { title: 'Любой LLM через MCP', text: 'Claude или агент в IDE работает в Calab как бот: ищет, читает, ставит задачи и пишет в комнаты.', shot: null },
    ],
    plan: 'AI — с тарифа Business. Расшифровки — через GPTunneL.',
  },
  phone: {
    title: 'Calab на телефоне',
    text: 'Веб-версия на телефоне уже работает: комнаты, чат, голос, доски, календарь и холст — просмотр и правка.',
    soon: 'Скоро',
    soonText: 'Приложения для iPhone и Android: звонки на экране блокировки и push-уведомления.',
    shots: ['phone-rooms', 'phone-voice', 'phone-canvas'],
  },
  trust: {
    title: 'Под вашим контролем — on‑premise',
    accent: 'on‑premise',
    facts: [
      'Свой сервер',
      'Данные в вашей стране',
      'SSO и Active Directory',
      'Код открыт, BSL 1.1',
      '0,05 % CPU без звонка',
    ],
  },
  pricing: {
    compare: 'Сравнить все возможности',
    rows: { members: 'Участников', room: 'В комнате', boards: 'Досок', canvases: 'Холстов' },
  },
  faq: {
    items: {
      canvas: {
        q: 'Есть ли онлайн-доска (холст)?',
        a: 'Да. Холст — бесконечная доска со стикерами, фигурами, стрелками, голосованием и таймером; коллеги правят её вместе, курсоры видны. Холсты можно открыть из чата, на телефоне — просмотр и правка. В пространстве: Free — 3 холста, Team — 30, Business — 100, Enterprise — без ограничений.',
      },
      ai: {
        q: 'Что умеет AI и куда уходят данные?',
        a: 'AI доступен с тарифа Business: администратор один раз подключает модель в настройках пространства. «Умная задача» получает текст, имена файлов и названия досок, где вы можете создавать задачи, и оформляет задачу от вашего имени. Расшифровки встреч делает GPTunneL, аудио хранится 30 дней.',
      },
    },
  },
  footer: {
    columns: [
      {
        title: 'Продукт',
        links: [
          { id: 'features', label: 'Возможности' },
          { id: 'telephony', label: 'Телефония' },
          { id: 'pricing', label: 'Тарифы' },
          { id: 'download', label: 'Скачать' },
          { id: 'changelog', label: 'Что нового' },
        ],
      },
      {
        title: 'Разработчикам',
        links: [
          { id: 'docs', label: 'Документация' },
          { id: 'botApi', label: 'Bot API' },
          { id: 'mcp', label: 'MCP' },
          { id: 'github', label: 'GitHub' },
        ],
      },
      {
        title: 'Компания',
        links: [
          { id: 'contacts', label: 'Контакты' },
          { id: 'support', label: 'Поддержка' },
          { id: 'form', label: 'Форма связи' },
        ],
      },
      {
        title: 'Документы',
        links: [
          { id: 'offer', label: 'Оферта' },
          { id: 'terms', label: 'Условия' },
          { id: 'privacy', label: 'Конфиденциальность' },
          { id: 'payments', label: 'Оплата' },
          { id: 'cookies', label: 'Cookies' },
          { id: 'license', label: 'Лицензии' },
          { id: 'trademarks', label: 'Товарные знаки' },
        ],
      },
    ],
  },
  alts: {
    'voice': 'Голосовая комната «Переговорка»: на сцене экран Веры Ким, ниже три камеры, слева участники комнаты и плашка «Голос подключён»',
    'chat-full': 'Чат «#общий»: закреплённое сообщение, ответ с цитатой, голосовое, стикер и карточка задачи APP-7',
    'kanban-full': 'Доска «Продукт» с четырьмя колонками: карточки с приоритетами, метками, сроками и исполнителями',
    'calendar-week': 'Календарь на неделю: события по дням, линия текущего времени и событие с комнатой',
    'wiki-full': 'Вики: дерево страниц и страница «Экспорт в CSV» с обложкой, чек-листом и курсорами двух коллег',
    'canvas': 'Холст «Ретро спринта 12»: стикеры трёх цветов, фигуры, стрелки, голоса, таймер и курсор коллеги',
    'phone-incoming': 'Входящий звонок на номер команды поверх чата: номер +7 916 123-45-67, группа «Продажи», кнопки «Отклонить» и «Принять»',
    'story-incoming': 'Окно входящего звонка: +7 916 123-45-67, входящий на номер группы «Продажи», «Отклонить» и «Принять»',
    'mail-window': 'Окно почты в приложении для компьютера (почта есть только в нём): ящики двух аккаунтов, список входящих и открытое письмо «Договор на внедрение Calab — финальная версия» с двумя вложениями',
    'disk-full': 'Диск команды плитками: папки «Дизайн», «Договоры» и «Проекты», таблица, видео, превью картинок и шкала занятого места',
    'story-message': 'Сообщение Веры Ким «Клиент просит экспорт доски в CSV до пятницы» и меню сообщения с пунктом «Создать задачу»',
    'story-task': 'Панель задачи APP-7 «Экспорт доски в CSV»: описание, чек-лист 2 из 4, исполнители, срок 16 января и согласующий',
    'story-meeting': 'Событие «Ревью экспорта CSV» в 15:00 в комнате «Переговорка» с кнопкой «Перейти» и ответами четырёх участников',
    'recording-focus': 'Карточка записанной встречи в чате комнаты: три решения, кнопка воспроизведения и «Полный транскрипт»',
    'story-wiki': 'Страница вики «Экспорт в CSV»: план работ и ссылки на задачу APP-7 и холст «Ретро спринта 12»',
    'canvas-panel': 'Холст «Ретро спринта 12»: стикеры трёх цветов, стрелки, голоса, таймер и курсор коллеги',
    'disk-panel': 'Диск плитками: папки (одна закрытая), файлы с превью и занятое место',
    'aitask': 'Окно «Умная задача»: описание задачи и два прикреплённых файла',
    'telephony-ivr': 'Настройки телефонии, вкладка IVR: «Главное меню» с записью и кнопками, «Нерабочее время» и кнопка «Новое меню»',
    'telephony-groups': 'Вкладка «Группы»: «Продажи» — все сразу, переадресация через 20 с, «Поддержка» — по очереди',
    'telephony-call': 'Вкладка «Активные звонки»: три звонка — в голосовом меню, звонит группе «Продажи», разговор с Верой Ким',
    'recording-transcript': 'Окно «Транскрипт встречи» с поиском по слову «эталоны» и двумя найденными репликами',
    'phone-canvas': 'Холст на телефоне в режиме просмотра с кнопкой «Править»',
    'phone-rooms': 'Список комнат на телефоне: последние сообщения и кто сейчас в голосе',
    'phone-voice': 'Карточка «В голосе» на телефоне: три участника и кнопка «Подключиться»',
  },
};

export const homes: Record<Locale, Home> = { ru, en, es, zh };
export const getHome = (locale: Locale): Home => homes[locale];
