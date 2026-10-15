// Developer documentation navigation (ADR-0099): sections and pages in display order.
// Each page is `apps/landing/src/content/docs/<locale>/<section slug>/<page slug>.md`;
// `index` is the section's landing page. Labels are the sidebar captions per locale.

export type DocsLocale = 'ru' | 'en';

export type DocsLabel = Record<DocsLocale, string>;

export interface DocsNavPage {
  slug: string;
  ru: string;
  en: string;
}

export interface DocsNavSection {
  section: DocsLabel;
  slug: string;
  pages: DocsNavPage[];
}

export const nav: DocsNavSection[] = [
  {
    section: { ru: 'Обзор', en: 'Overview' },
    slug: 'overview',
    pages: [{ slug: 'index', ru: 'Что можно интегрировать', en: 'What you can integrate' }],
  },
  {
    section: { ru: 'Боты и интеграционный API', en: 'Bots and integration API' },
    slug: 'bots',
    pages: [
      { slug: 'index', ru: 'Обзор', en: 'Overview' },
      { slug: 'quickstart', ru: 'Быстрый старт', en: 'Quickstart' },
      { slug: 'auth', ru: 'Токен и права', en: 'Token and permissions' },
      { slug: 'rest-messages', ru: 'Сообщения', en: 'Messages' },
      { slug: 'rest-rooms', ru: 'Комнаты и голос', en: 'Rooms and voice' },
      { slug: 'rest-members', ru: 'Пространство и участники', en: 'Workspace and members' },
      { slug: 'rest-boards', ru: 'Доски и задачи', en: 'Boards and tasks' },
      { slug: 'rest-forms', ru: 'Формы досок', en: 'Board forms' },
      { slug: 'rest-calendar', ru: 'Календарь', en: 'Calendar' },
      { slug: 'rest-dm', ru: 'Личные сообщения', en: 'Direct messages' },
      { slug: 'rest-files', ru: 'Файлы', en: 'Files' },
      { slug: 'rest-stickers', ru: 'Стикеры', en: 'Stickers' },
      { slug: 'rest-search', ru: 'Поиск', en: 'Search' },
      { slug: 'rest-disk', ru: 'Диск', en: 'Disk' },
      { slug: 'rest-wiki', ru: 'Вики', en: 'Wiki' },
      { slug: 'rest-profile', ru: 'Профиль бота', en: 'Bot profile' },
      { slug: 'gateway', ru: 'Gateway: события', en: 'Gateway: events' },
      { slug: 'commands-buttons', ru: 'Команды и кнопки', en: 'Commands and buttons' },
      { slug: 'webhooks', ru: 'Вебхуки', en: 'Webhooks' },
      { slug: 'task-notices', ru: 'Уведомления о задачах', en: 'Task notifications' },
      { slug: 'rest-mailbox', ru: 'Почтовый ящик', en: 'Mailbox' },
      { slug: 'sdk', ru: 'SDK для Node.js', en: 'Node.js SDK' },
      { slug: 'errors-limits', ru: 'Ошибки и лимиты', en: 'Errors and limits' },
      { slug: 'changelog', ru: 'Журнал изменений', en: 'Changelog' },
    ],
  },
  {
    section: { ru: 'OAuth 2 / OIDC', en: 'OAuth 2 / OIDC' },
    slug: 'oauth',
    pages: [
      { slug: 'index', ru: 'Вход через Calab', en: 'Sign in with Calab' },
      { slug: 'register-client', ru: 'Регистрация клиента', en: 'Register a client' },
      { slug: 'flow', ru: 'Authorization Code + PKCE', en: 'Authorization Code + PKCE' },
      { slug: 'tokens', ru: 'Токены и сроки', en: 'Tokens and lifetimes' },
      { slug: 'userinfo-refresh-revoke', ru: 'Userinfo, обновление, отзыв', en: 'Userinfo, refresh, revoke' },
      { slug: 'consent', ru: 'Согласие и доступы', en: 'Consent and access' },
      { slug: 'errors', ru: 'Ошибки', en: 'Errors' },
      { slug: 'security', ru: 'Безопасность', en: 'Security' },
    ],
  },
  {
    section: { ru: 'SSO и каталог (AD)', en: 'SSO and directory (AD)' },
    slug: 'sso',
    pages: [
      { slug: 'index', ru: 'Обзор и термины', en: 'Overview and terms' },
      { slug: 'modes', ru: 'Режимы входа', en: 'Sign-in modes' },
      { slug: 'oidc-generic', ru: 'OIDC: любой провайдер', en: 'OIDC: any provider' },
      { slug: 'oidc-entra', ru: 'Microsoft Entra ID', en: 'Microsoft Entra ID' },
      { slug: 'oidc-adfs', ru: 'AD FS', en: 'AD FS' },
      { slug: 'recovery-kit', ru: 'Recovery kit', en: 'Recovery kit' },
      { slug: 'directory', ru: 'Каталог (AD)', en: 'Directory (AD)' },
      { slug: 'reauth', ru: 'Повторная аутентификация', en: 'Reauthentication' },
      { slug: 'operators', ru: 'Для операторов', en: 'For operators' },
      { slug: 'troubleshooting', ru: 'Диагностика', en: 'Troubleshooting' },
      { slug: 'limitations', ru: 'Ограничения', en: 'Limitations' },
    ],
  },
  {
    section: { ru: 'Справочник', en: 'Reference' },
    slug: 'reference',
    pages: [
      { slug: 'routes', ru: 'Маршруты ботов', en: 'Bot routes' },
      { slug: 'gateway-events', ru: 'События gateway', en: 'Gateway events' },
      { slug: 'errors', ru: 'Коды ошибок', en: 'Error codes' },
      { slug: 'limits', ru: 'Лимиты', en: 'Limits' },
      { slug: 'tokens', ru: 'Форматы токенов', en: 'Token formats' },
      { slug: 'version', ru: 'Версия API', en: 'API version' },
    ],
  },
];
