# Вики v1 — задачи

ADR: [0096 Вики](../adr/0096-wiki.md). Ветка интеграции — `feat/wiki` (от `feat/disk`, PR #208); задачи — в своих worktree, лид мержит в `feat/wiki`, затем одним PR в `main` после Диска.

| # | Задача | Модель | Зависит | Пути |
|---|--------|--------|---------|------|
| W1 | Контракт и права: `wiki.proto` (§8), биты 38–40, рефакторинг `ComputeDiskItem` → `perm.ComputeTree` (Go) / `treeItemPermissions` (TS) с двумя наборами битов и правилом WRITE-на-содержимое для вики (§2), векторы; миграция `00090_wiki.sql` (§1, индексы для дерева/корзины/`seq`, GIN по `title || plain_text`, trgm по `title`, `wiki_page_files` в `ListOrphanFiles`/`UnattachedBytesByUploader`), sqlc-запросы (дерево, версии, обновления/снимок/компакция, ссылки, журнал); `SearchType.WIKI` в proto; docs/04 | Opus | — | `proto/`, `packages/protocol`, `apps/server/internal/{perm,db,files}` |
| W2 | Сервер `internal/wiki`: REST §8, сокет `/sync` §4 (кадры 0–4, Redis `wiki:<pageId>`, лимиты, компакция, версии §1/§5), публичная страница и файлы §6, события `WIKI_PAGE_*` с фильтром по получателю, журнал, `TrashSweep` для вики, поиск §7 (секция + фильтр доступа), загрузка картинок `POST …/files` → `wiki_page_files`, экспорт `.md` (сервер отдаёт `plain`? нет — экспорт делает клиент; маршрут не нужен, убрать из §8 при реализации), интеграционные тесты (матрица прав, sync двух клиентов через фейковые Yjs-байты, компакция, лимиты, публичная ветка, поиск) | Opus | W1 | `apps/server/internal/{wiki,app,gateway,search,files}` |
| W3 | Десктоп — редактор: зависимости Tiptap/Yjs (ленивый чанк), `features/wiki/editor/` — расширения §3 (блоки, `/`-меню, bubble-панель, markdown-шорткаты, картинки через загрузку, упоминания, код с Prism в idle, таблица, callout, toggle), провайдер синхронизации §4 (`lib/wikiSync.ts`: кадры, батч 200 мс, awareness-троттлинг, реконнект, компакция по запросу/бездействию/закрытию, дробление > 64 КиБ), курсоры соавторов, экспорт в Markdown, режим чтения (для публичной страницы и телефона); юнит-тесты сериализации/протокола; работает против мок-сокета | Opus | W1 (контракт) | `apps/desktop/src/renderer/features/wiki/editor`, `lib/wikiSync.ts`, `package.json` |
| W4 | Десктоп — раздел: рейл «Вики», колонка-дерево (ленивые дети, перетаскивание, «+», поиск по заголовкам, корзина), экран страницы §9 (обложка, иконка через `EmojiPicker`, заголовок, соавторы онлайн, шапка), диалоги Доступ (общий с Диском)/Ссылка (с `include_children`)/История версий (дифф `textDiff`, восстановление)/Переместить; сторы по id; настройки `wiki_trash_days`; i18n; визуальная спека `wiki` (dark-960; light для страницы); мок-сервер с фикстурами | Opus | W3 | `features/wiki/*`, `stores/wiki*.ts`, `services/wiki.ts`, `e2e-support/mock-wiki.ts` |
| W5 | Публичная страница `/w/{code}` в вебе (как `FormPublicPage`): чтение тем же редактором, оглавление подстраниц, картинки по публичному маршруту, `noindex`; телефон: «Вики» в «Ещё», экраны стеком, редактор с упрощённой панелью §7; визуальные `m-wiki-*`, `wiki-public` | Sonnet | W4 | `features/wiki/phone*`, `features/wiki/PublicPage.tsx`, `app/App.tsx` |
| W6 | Второе ревью W1+W2 (права, `/sync` — auth/лимиты/DoS, публичные маршруты, компакция и двойное освобождение квоты) | Opus | W2 | — |
| W7 | Сверка клиента с сервером: два реальных клиента (Playwright chromium ×2) правят одну страницу через живой Go-сервер, сходимость; компакция; восстановление версии; `tools/wiki-walk.sh` | Sonnet | W2, W4 | `apps/desktop/e2e-web/wiki.spec.ts`, `tools/` |
| Q2 | QA скриншотами (десктоп/телефон/публичная) | Sonnet | W4, W5 | — |
| R2 | Docs (01, 05, 08 «Вики» и правила редактора, 16), CHANGELOG «Коротко», статусы | Sonnet | всё | `docs/` |

## Статусы (14.10)

| Задача | Статус |
|---|---|
| W1 | готово (контракт, биты 38–40, `ComputeTree`, миграции 00090/00091) |
| W2 | готово (`internal/wiki`, `/sync`, публичные маршруты, поиск, `TrashSweep`) |
| W3 | готово (редактор, `lib/wikiSync.ts`, пакет `packages/wiki-doc`) |
| W4 | готово (раздел, диалоги, настройки, визуальная спека `wiki`) |
| W5 | готово (`PublicPage`, `PhoneWiki`, спеки `m-wiki-*`, `wiki-public`) |
| W6 | готово (минорные замечания — docs/12) |
| W7 | готово (два клиента через живой сервер, `tools/wiki-walk.sh`) |
| Q2 | отдельного прохода не было: визуальные спеки W4/W5 смотрелись агентами |
| R2 | готово (docs, CHANGELOG 3.4.0, полная проверка ветки) |
| Боты на Диске и в Вики | готово (дополнения ADR-0094/0096, `bot.disk.*`, `bot.wiki.*`) |

Параллельно стартуют W1 и W3 (редактор не зависит от сервера). W2 — после W1; W4 — после W3 и контракта W1.

## Проверка W7

Живой стек (PG17 и Redis локально, без Docker, LiveKit не нужен): `createdb calaba_w7`; сервер — `DATABASE_URL=postgres://$USER@localhost/calaba_w7 REDIS_URL=redis://localhost:6379/14 REDIS_KEY_PREFIX=w7: JWT_SECRET=<32+ символов> REGISTRATION_MODE=open EMAIL_VERIFICATION=optional HTTP_ADDR=127.0.0.1:3077 PUBLIC_APP_URL=http://localhost:4177 STORAGE_PATH=/tmp/w7 AUTH_RATE_BURST=1000 AUTH_RATE_PER_MINUTE=1000 go run ./cmd/server` (в `apps/server`; миграции применяются сами).
- REST: `tools/wiki-walk.sh http://127.0.0.1:3077 [dir]` — 40 шагов с теми же запросами, что `services/wiki.ts`; с `dir` сохраняет ответы-фикстуры в `apps/desktop/src/renderer/services/__fixtures__/wiki` (читает `services/wiki.wire.test.ts`; версии и состояния — из прогона e2e, см. ниже).
- Два клиента: `pnpm -F @calaba/desktop build:web`, затем `CALABA_WEB_PROXY=http://127.0.0.1:3077 pnpm -F @calaba/desktop preview:web --port 4177` (прокси `/api` теперь с `ws: true` — без него сокет `/sync` не доходит до сервера) и `CALABA_WIKI_REAL=1 CALABA_WEB_URL=http://localhost:4177 pnpm -F @calaba/desktop e2e:web --project=chromium wiki.spec.ts`.
- Спека: два контекста chromium (два участника одного пространства) — страница приходит к B событием без перезагрузки, текст A у B ≈ 0,3–0,8 с, текст B у A ≈ 0,1–0,2 с, каретки с именами, сходимость двух одновременных вставок, компакция по бездействию (превью страницы ≈ 3 с после последней клавиши), перезагрузка, восстановление версии (у B ≈ 0,1–0,4 с), публичная ссылка анонимно: `/api/public/wiki/{code}` и поток `/state`.
- Правило «версия не чаще 5 мин» обходится само: первая компакция страницы создаёт версию (нет предыдущей); второй версии спека не ждёт — восстановление проверено на первой.
- Расхождения и правки — ниже: загрузка картинки отвечает `{file}`; событие теперь несёт `my_bits` получателя (шлюз), без `link`/`shared`; список, запрошенный до события, не затирает новый заголовок; цвет awareness-пользователя — `#rrggbb` (y-tiptap иначе пишет предупреждение на каждый курсор).
- Остановить: `pkill -f vite.*preview`, остановить сервер, `dropdb calaba_w7`.
