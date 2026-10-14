# Документация на сайте (ADR-0099) — задачи

Ветка `feat/docs-site` (от `main`). Контракт контента: `apps/landing/src/content/docs/{ru,en}/<section>/<page>.md`, frontmatter `title`, `description`, `order?`; навигация `apps/landing/src/content/docs/nav.ts`; callouts `> [!NOTE|TIP|WARNING|DANGER]`; вкладки кода — подряд блоки с `tab="…"`; относительные ссылки между страницами.

| # | Задача | Модель | Зависит |
|---|--------|--------|---------|
| DOC1 | Платформа: markdown-пайплайн (unified + shiki, сборка), страница `[locale]/docs/[...slug]`, боковая навигация/оглавление/prev-next/поиск/копирование кода/вкладки/callouts, фолбэк локали, sitemap + hreflang + llms.txt из контента, проверка ссылок и nav-переводов на сборке, генератор `tools/gen-bot-routes.ts` → `_routes.json` + CI-дрейф, адаптив (1280 / iPhone 14), docs/08 «Сайт → Документация» | Opus | — |
| DOC2 | Контент ru+en по структуре ADR §2: обзор, боты (из `docs/19-bot-api*.md`, по главам, с таблицами из `_routes.json`), OAuth 2/OIDC (с диаграммой потока SVG), SSO и каталог, справочник; точность — из кода/proto; `docs/19` → ссылка | Opus | контракт из ADR (параллельно с DOC1) |
| DOC3 | QA: сборка, скриншоты страниц (1280 + iPhone 14), проверка ссылок и кода примеров (`curl` против локального сервера для 3–5 ключевых запросов), CHANGELOG «Коротко» | Sonnet | DOC1, DOC2 |
| DOC4 | Главы «Диск» и «Вики» для ботов — после B1 (ветка `feat/wiki`) | Sonnet | B1 |
