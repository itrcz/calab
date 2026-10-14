// Interface strings of the developer docs (ADR-0099). The docs exist in Russian and English; es/zh
// show the English pages with the English interface and a notice in their own language.
import type { Locale } from '../i18n/locales';

export type DocLang = 'ru' | 'en';
export type Callout = 'note' | 'tip' | 'warning' | 'danger';
export type Decision = 'allow' | 'deny' | 'public';

/** Language of the interface and of the preferred content for a site locale. */
export const docLang = (l: Locale): DocLang => (l === 'ru' ? 'ru' : 'en');

const ru = {
  docs: 'Документация',
  title: 'Документация для разработчиков',
  description: 'Как интегрироваться с Calab: боты и интеграционный API, OAuth 2 / OIDC, SSO и каталог AD.',
  home: 'Calab — на главную',
  search: 'Поиск по документации',
  searchShort: 'Поиск',
  noResults: 'Ничего не найдено',
  menu: 'Разделы документации',
  onThisPage: 'На этой странице',
  breadcrumbs: 'Навигационная цепочка',
  prev: 'Назад',
  next: 'Далее',
  updated: 'Изменено',
  edit: 'Редактировать на GitHub',
  copy: 'Копировать',
  copied: 'Скопировано',
  codeExamples: 'Примеры кода',
  pages: 'Страницы раздела',
  pagesCount: (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'страница' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'страницы' : 'страниц'}`,
  /** Shown when the page exists only in the other language. */
  otherLanguage: 'Эта страница пока только по-английски.',
  callouts: { note: 'Примечание', tip: 'Совет', warning: 'Внимание', danger: 'Опасно' } satisfies Record<Callout, string>,
  routes: { method: 'Метод', path: 'Путь', bots: 'Боты' },
  decisions: { allow: 'да', deny: 'нет — только люди', public: 'без авторизации' } satisfies Record<Decision, string>,
};

export type DocsUi = typeof ru;

const en: DocsUi = {
  docs: 'Docs',
  title: 'Developer documentation',
  description: 'How to integrate with Calab: bots and the integration API, OAuth 2 / OIDC, SSO and the AD directory.',
  home: 'Calab home',
  search: 'Search the docs',
  searchShort: 'Search',
  noResults: 'Nothing found',
  menu: 'Docs sections',
  onThisPage: 'On this page',
  breadcrumbs: 'Breadcrumbs',
  prev: 'Previous',
  next: 'Next',
  updated: 'Updated',
  edit: 'Edit on GitHub',
  copy: 'Copy',
  copied: 'Copied',
  codeExamples: 'Code examples',
  pages: 'Pages in this section',
  pagesCount: (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`,
  otherLanguage: 'This page is only available in Russian for now.',
  callouts: { note: 'Note', tip: 'Tip', warning: 'Warning', danger: 'Danger' },
  routes: { method: 'Method', path: 'Path', bots: 'Bots' },
  decisions: { allow: 'yes', deny: 'no — people only', public: 'no auth' },
};

export const docsUi = (lang: DocLang): DocsUi => (lang === 'ru' ? ru : en);

/** es/zh: the docs are not translated into these languages. */
export const UNTRANSLATED_NOTICE: Partial<Record<Locale, string>> = {
  es: 'La documentación para desarrolladores está disponible en inglés.',
  zh: '开发者文档目前仅提供英文版。',
};
