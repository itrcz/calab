# Диск v1 и мобильные правки 14.10 — задачи

ADR: [0094 Диск](../adr/0094-disk.md), [0095 Телефон: закреплённые вкладки и «Ещё»](../adr/0095-phone-pinned-tabs-more.md). Ветка интеграции — `feat/disk`; задачи — в своих ветках/worktree, лид мержит в `feat/disk`, затем одним PR в `main`.

| # | Задача | Модель | Зависит | Пути |
|---|--------|--------|---------|------|
| D1 | Контракт и права: `disk.proto`, биты 35–37, `ComputeDiskItem` Go+TS + векторы, миграции (`disk_items`, `disk_permissions`, `disk_links`, `disk_activity`, `workspace_storage_addons`, `workspaces.disk_trash_days`, индекс `files(workspace_id)`, выдача битов роли участника), sqlc-запросы, `ListOrphanFiles`/`UnattachedBytesByUploader` + тест | Opus | — | `proto/`, `packages/protocol`, `apps/server/internal/{perm,db}`, `internal/files/cleanup*` |
| D2 | Сервер: `internal/disk` — REST ADR-0094 §7, `files.CanRead` ветка диска, события `DISK_ITEM_*` с фильтром по получателю, корзина + `TrashSweep`, публичная ссылка `/api/public/disk/{code}` с лимитами, `DiskUsage`, журнал; интеграционные тесты (`internal/disk`, шард `rest`) | Opus | D1 | `apps/server/internal/{disk,app,gateway,files}` |
| D3 | Второе ревью D1+D2 (права, публичный маршрут, квота/корзина) | Opus | D2 | — |
| D4 | Десктоп: раздел «Диск» на рейле, экран (плитки/список, крошки, drag&drop загрузка, меню элемента, «Переместить», диалог «Доступ», ссылка, история, корзина), индикатор места (диск/корзина/вне диска, порог тарифа) здесь и в `PlanTab` + «Докупить место» (пакеты с ценами, кнопки заблокированы — ADR-0094 §6), настройка срока корзины в настройках пространства; стор по id, строки в `memo`; визуальная спека `disk` (dark-960, light для «Доступ») | Opus | D1 (контракт), D2 для e2e | `apps/desktop/src/renderer/features/disk`, `features/shell/AppRail*`, `features/workspace/PlanTab.tsx`, `stores/disk.ts`, `i18n/*/disk.ts` |
| D5 | Телефон: экран «Диск» (корень + вложенные папки стеком, плитки/список, «⋯» меню, системный пикер для загрузки, корзина и место через «⋯» шапки); визуальная спека `m-disk` (iPhone 14) | Sonnet | D4 (сторы/компоненты), M1 (вкладка) | `features/disk/phone*`, `features/shell/MobileShell.tsx` |
| M1 | Телефон, ADR-0095: три закреплённые + «Ещё» (карточка, булавки, подложка активного раздела, бейджи), `prefs.phonePinnedTabs`, `'disk'` в `PHONE_TABS`/`Section`; **кнопка поиска в одном слоте** на всех корнях: `RootTitle`/`Sidebar`/`DayView` → один порядок `[…][⋯?][поиск][+]`, зазор 8 px везде, слот «+» резервируется пустым 36 px, когда создавать нечего; эталоны корней + `m-more-card`, `m-more-active` | Sonnet | — | `features/shell/MobileShell.tsx`, `features/shell/Sidebar.tsx`, `features/calendar/DayView.tsx` (только шапка), `lib/phoneNav.ts`, `stores/prefs.ts`, `components/PhoneHeader.tsx`, `e2e-visual/mobile.visual.spec.ts` |
| M2 | Телефон, фиксы касаний: (a) меню Radix (`Dropdown.Trigger`) на `(hover: none)` открывать по `click`, не по `pointerdown` — централизованно в `lib/phoneMenus.ts` (capture-слушатель, пропускающий pointerdown с `pointerType !== 'mouse'` на триггере; проверить `ContextMenu` долгим нажатием не сломан); (b) `BoardsList`: перетаскивание досок и категорий только для `pointerType === 'mouse'`; (c) календарь: заголовок дня с днём недели («Ср, 14 окт»), тап по дате — карточка с месячной сеткой (переиспользовать сетку `DateMenu`/`MiniCalendar`), выбор дня закрывает карточку и открывает день; обход остальных мест с `onPointerDown`-открытием из отчёта (список в брифе) — только там, где открывается меню/экран, не жесты | Sonnet | — | `lib/phoneMenus.ts`, `features/boards/BoardsList.tsx`, `features/calendar/DayView.tsx` (тело заголовка даты, не слоты шапки — их меняет M1), `features/calendar/MiniCalendar.tsx` |
| Q1 | QA скриншотами (Sonnet): Диск десктоп/телефон, «Ещё», календарь; список проблем → лид | Sonnet | D4, D5, M1, M2 | — |
| R1 | Docs: `docs/04` (биты, таблицы), `docs/08` («Диск», «Навигация»), `docs/01` (раздел), CHANGELOG «Коротко», `docs/13-usage.md` | Sonnet | всё | `docs/` |

### Статус (14.10)
- D1 — сделано: контракт, биты 35–37, миграция 00088, `ComputeDiskItem` + векторы.
- D2 — сделано: `internal/disk` (REST, события, корзина, ссылки, журнал), интеграционные тесты.
- D3 — сделано: ревью D1+D2, правки замка удаления и журнала (685e1c24).
- D4 — сделано: раздел на рейле, экран, диалоги, индикатор места, пакеты, срок корзины, спека `disk-*`.
- D5 — сделано: `PhoneDisk`, стек папок и корзины, спека `m-disk`.
- M1 — сделано: три вкладки + «Ещё», поиск на одном месте на корнях.
- M2 — сделано: меню по отпусканию, доски без случайного drag, дата с днём недели и выбором.
- Q1 — сделано: список проблем разобран в ветке.
- R1 — сделано: CHANGELOG 3.4.0, сверка docs 01/04/08/16, ADR README; `docs/13-usage.md` — при теге.

Параллельно стартуют D1, M1, M2 (непересекающиеся пути; M1 и M2 оба трогают `DayView.tsx` — M1 только слоты шапки `DayHeader` phone-ветки, M2 — текст даты и пикер; конфликт решает лид при мерже). D4 стартует после D1 (контракт сгенерирован), до D2 — на мок-данных стора.

Отложено (бэклог `docs/09`): версии файлов, ссылка на папку, пароль на ссылку, личный диск, покупка пакетов (после включения платежей — задача в `billing-v1-tasks`).

### Проверка D6

Клиент D4 сверен с реальным сервером D2 (локальный PG17 `calaba_d6`, Redis DB 13, без LiveKit). Расхождений в REST нет: поле multipart `file` и `?parent=`, `trashed=1`, `sort=name|updated|size`, `next_cursor` (клиент идёт по курсору в `readAll`), `PUT permissions` (клиент не читает тело), события без `access`. Исправлено: `GET/PUT …/disk/settings` читаются и пишутся схемой `DiskSettings` (было `Struct`), журнал берёт `parent_name` без запасных имён, мок отдаёт страницы (`limit`, `next_cursor`, `pageMax`) и `DiskSettings`.
```
cd apps/server && DATABASE_URL=postgres://mac@localhost:5432/calaba_d6 REDIS_URL=redis://localhost:6379/13 \
  JWT_SECRET=dev-only-jwt-secret-dev-only-jwt-secret REGISTRATION_MODE=open LIVEKIT_URL=ws://localhost:7880 \
  LIVEKIT_INTERNAL_URL=http://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret SMTP_HOST= \
  STORAGE_PATH=/tmp/d6files HTTP_ADDR=127.0.0.1:3066 PUBLIC_APP_URL=http://127.0.0.1:3066 go run ./cmd/server
tools/disk-walk.sh http://127.0.0.1:3066   # register, folder, upload, paging (limit=1), rename/move, trash/restore, link, usage, settings
```
Ответы сервера сохранены в `apps/desktop/src/renderer/services/__fixtures__/disk/` и читаются схемами клиента в `disk.wire.test.ts`.
