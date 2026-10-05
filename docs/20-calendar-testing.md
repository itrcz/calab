# 20 — Календарь: автоматическая матрица тестов (ADR-0038, 1.0.0)

Главная фича релиза 1.0.0 — тестируется тщательно, по всем каналам. Ручные сценарии — `TESTING.md`
«Календарь и встречи (1.0.0)», C.1–C.21. Этот файл — какой автотест (или его отсутствие) стоит за
каждым C.n, чтобы имплементирующие агенты писали тест одновременно с кодом, а не «потом».

Столбцы: **(a)** Go-интеграционные (`internal/app/events_*_integration_test.go`) · **(b)** десктоп unit
(vitest) · **(c)** Playwright e2e/visual против мока (`apps/desktop/e2e-visual`) · **(d)** прод-smoke
после деплоя · **(e)** только вручную (и почему автоматизировать нельзя/не стоит).

## Матрица

| C.n | Сценарий | (a) Go integration | (b) desktop unit | (c) Playwright | (d) прод-smoke | (e) только вручную |
|---|---|---|---|---|---|---|
| C.1 | Создание (комната/участники/описание/запись) | `TestEventCreate` | `lib/calendar/events.test.ts`, `lib/calendar/draft.test.ts` (модель диалога) | `calendar-day.spec.ts` (создание → блок, тело POST), `calendar-dialog`, `calendar-day` (visual) | создать через API, проверить 201 + `event_attendees` | — |
| C.2 | Правка времени → письмо + `SEQUENCE+1` | `TestEventUpdateSequence` (парсит сгенерированный `.ics`) | — | `calendar-day.spec.ts` (перенос → PATCH, блок на новом месте) | PATCH, проверить рост `SEQUENCE` через API (если отдаётся) | вид письма в реальном ящике — разово глазами (не за каждый релиз) |
| C.3 | Отмена → письмо `CANCEL` | `TestEventCancel` | — | карточка пропадает из дня (мок `EVENT_DELETE`) | DELETE, проверить `cancelled_at` | — |
| C.4 | RSVP из приложения (3 статуса) | `TestEventRSVP` | `lib/calendar/events.test.ts` (редьюсер RSVP) | `calendar-rsvp.spec.ts` (клик по каждому статусу, счётчики) | — (полностью покрыто a–c) | — |
| C.5 | RSVP по ссылке из письма (внешний, 3 статуса) | `TestEventRSVPExternalToken` (accept/decline/maybe, идемпотентность) | — | гап — публичная RSVP-страница не в моке (см. «Пробелы») | — | клик по реальной ссылке (Mailpit/внешний ящик) — логика уже покрыта (a), это проверка вёрстки страницы подтверждения |
| C.6 | Просроченная RSVP-ссылка → 410 | `TestEventRSVPExternalToken` (кейс `expired`) | — | — | — | — |
| C.7 | Напоминания 5/15/60, DND, «Перейти в комнату»; о внешних событиях CalDAV (ADR-0045 поправка 3) | `TestEventReminders` (дедуп `event_reminders_sent`, окно 25 ч, DND-флаг), `TestExternalEventReminders` (выкл. по умолчанию, отклонённые и весь день — нет) | `lib/calendar/reminders.test.ts`, обработчик действия уведомления | `calendar-reminder.spec.ts` (мок `EVENT_REMINDER` → in-app баннер/тост, клик по действию подключает к голосу) | — | реальное системное уведомление ОС (текст, тайминг, клик из Notification Center/Action Center) — раз на релиз на каждой ОС |
| C.8 | Значок комнаты за 15 мин → карточка → вход | `TestRoomEventBadge` (`ROOM_EVENT_ACTIVE`/`ENDED` тайминг) | — | `calendar-day.spec.ts` (значок по `ROOM_EVENT_ACTIVE` → карточка, `ENDED` убирает) | — | — |
| C.9 | Запись предлагается организатору, привязывается к встрече | расширяет `TestRecording*` (3.19) + `TestEventRecordingLink` (`events.recording_id`) | мок-сценарий предложения записи (описание паттерна — R.1–R.4) | `chat-recording-card` с привязкой к событию (visual) | — | — |
| C.10 | Повтор день/неделя/2 недели/месяц + `until` | `TestEventRecurrenceExpand`, `TestEventException` (отмена одного вхождения) | — (клиент вхождения не разворачивает — считает сервер, ADR-0038 п. 1) | `calendar-day` с несколькими вхождениями (visual) | — | — |
| C.11 | DST-переход (Europe/Berlin) | `TestEventRecurrenceDST` (фиксированные часы, вхождения до/после 25.10.2026) | — | — | — | — |
| C.12 | Часовые пояса организатор +3 / участник +7 | тривиально — сервер хранит UTC, без спец-теста | `lib/calendar/formatLocalTime.test.ts` | `calendar-tz.spec.ts` (два `BrowserContext` с разным `timezoneId`, сверка отображаемого времени) | — | — |
| C.13 | Гостевая ссылка внешнего участника (окно, `restricted`) | `TestEventGuestLink` (окно `[-15 мин; конец]`, `restricted`-комната) | — | — | — | точная формулировка экрана «ссылка ещё не активна» — глазами один раз после реализации |
| C.14 | Мобильный веб: день + карточка | — | — | `mobile.visual.spec.ts`: `m-calendar-day` (+ карточка на весь экран) | — | — |
| C.15 | Deep link `/e/<id>` из письма | — | `services/links.test.ts` (маршрут `/e/<id>`, как `/join/`/`/r/`) | `calendar-deep-link.spec.ts` (веб: без входа → карточка встречи) | GET `/e/<id>` на стенде → 200/карточка | диалог ОС «Открыть Calab?» и переход на передний план (десктоп) — как W14, вручную |
| C.16 | `.ics` в Apple Calendar и Google Calendar | — | — | — | — | полностью: сторонние приложения не автоматизируем; проверка раз на релиз с реальным внешним ящиком |
| C.17 | Права: участник/организатор/админ/гость/бот | `TestEventPermissions` (таблица действие × кто, по образцу `permissions_matrix_integration_test.go`) | — | — | — | — |
| C.18 | Лимиты (100/20/120/4000) | `TestEventLimits` | — | — | — | — |
| C.19 | Диплинк внешнего `/e/<id>?t=` (view-токен → страница, ответ, гостевая ссылка с окном) | `TestEventDeepLinks` (письмо/`.ics` с `?t=`, GET по view- и answer-токену, POST view → 400, answer-токены из ответа, `guest_from/until`), unit `TestRSVPToken` (статус `view`) | — | `calendar-public.spec.ts` (страница `/e/<id>?t=` против мока: `eventViewToken`, `eventGuestLink`), эталоны `calendar-public`, `m-calendar-public` | — | клик по ссылке из реального письма — вместе с C.5 |
| C.20 | Гость комнаты видит активную встречу | `TestEventDeepLinks` (READY `active_events` без участников, `GET /api/events/{id}` 200 в окне / 404 вне, 403 на список/RSVP/правку, `ROOM_EVENT_ACTIVE/ENDED` гостю), unit `TestEventForGuest` | — | `mock-calendar.test.ts` (гость по ссылке встречи: карточка, READY, 403/404); `calendar-public.spec.ts` (гость: значок, карточка без участников) | — | — |
| C.22 | Рабочие часы и свободно/занято (ADR-0041) | `TestFreeBusyAndWorkHours` (умолчания, `PATCH workHours`, скрытый `event_id`, отклонённая не занята, «весь день» в зоне человека, 403/422); unit `TestWorkHoursAcrossDST`, `TestAllDayInZone`, `TestMergeIntersect` | — | — | — | — |
| C.23 | Подбор времени, комната, `NO_COMMON_HOURS` | `TestSuggestSlots`; unit `TestFindSlots`, `TestSlotsAcrossDSTWorkHours` | — | — | — | — |
| C.24 | CalDAV: подключение, выбор календаря, импорт занятости | `TestCalDavConnectImportPush` (фейковый CalDAV `caldavtest`: discovery, неверный пароль, http, sync, `EXTERNAL` у коллеги, удаление аккаунта); unit `TestDiscoverQueryPutDelete`, `TestBusy*` (RRULE/BYDAY/COUNT/EXDATE/RECURRENCE-ID/TRANSP/DST), `TestClientLimits` | — | — | — | реальные iCloud / Яндекс / Fastmail / Nextcloud — раз на релиз |
| C.26 | Внешнее событие: «Подключиться» / «Открыть в календаре» | unit `TestLinks*` (фикстуры Яндекс / Google / iCloud / Nextcloud в `caldav/testdata`); `TestExternalEventDelete` (url, web_url) | `platform/web.test.ts` (openExternal: регистр схемы, пробелы) | — | — | реальные Яндекс / Nextcloud — вручную |
| C.27 | Удаление внешнего события: событие, вхождение (EXDATE), серия, 412 → 409, read-only → 422, не владелец, бот, гость | `TestExternalEventDelete` (фейковый CalDAV: If-Match, EXDATE, 412, 403); unit `TestExcludeOccurrence`, `TestConditionalWrites` | `lib/calendar/external.test.ts` (роль, подтверждение, откат), `services/freebusy.delete.test.ts` | — | — | реальный календарь с участниками — вручную |
| C.25 | CalDAV: экспорт встреч (создание, правка, отмена, отказ, ошибка сервера) | `TestCalDavConnectImportPush` (PUT/DELETE на фейковом сервере, без `ORGANIZER/ATTENDEE`, 5 попыток → `last_error`) | — | — | — | вид встречи в реальном календаре — вручную |
| C.21 | Дневной вид: перенос, растяжение, «весь день», другой день, выделение диапазона, меню блока, клавиши, бросок участника / комнаты | — | `lib/calendar/drag.test.ts`, `layout.test.ts` | `calendar-day.spec.ts` (перенос → PATCH, растяжение, бросок на день мини-месяца, чужая не двигается, клавиши) | — | бросок участника / комнаты из списков (нативный HTML5 d&d Playwright воспроизводит ненадёжно) — вручную |

## (a) Go-интеграционные

Реализовано (сервер, 29.09) — `apps/server/internal/app/calendar_integration_test.go` (`-run 'Event'`) и unit
`apps/server/internal/calendar/*_test.go`, `internal/mail/events_test.go`:
- `TestEventCRUDAndPermissions` — C.1, C.3, C.4, C.17: валидация (название, время, зона, текстовая комната, гость/чужой как участник, адреса, > 20 внешних), гость → 403, `EVENT_CREATE/RSVP/UPDATE/DELETE` в gateway (гостю — нет), маска адресов для не вовлечённых, RSVP только участником, правка организатором/`MANAGE_ROOM` (участник → 403), удаление из списка → `EVENT_DELETE` прежнего состояния, встреча без комнаты видна только участникам, `GET /api/me/events/today` (отклонённые не считаются), отмена (`cancelled_at`).
- `TestEventRecurringAndException` — C.10: еженедельная серия с `until`, 3 вхождения в `Europe/Moscow`, отмена одного вхождения (`?occurrence=`), `cancelled_occurrences`, `SEQUENCE + 1`.
- `TestEventMailAndGuestLinks` — C.1–C.3, C.5, C.6, C.13: письма (`event_invite/update/cancel`), разбор `invite.ics` (`METHOD`, `UID`, `SEQUENCE` 0 → 1 → 2, `ATTENDEE … mailto:`, `ORGANIZER`, `URL`, `DTSTART` в UTC), `Reply-To`, нет письма на неподтверждённый адрес; гостевая ссылка: окно `[начало − 15 мин; конец + 1 ч]`, до окна `409 INVITE_NOT_YET_VALID`, одноразовая, переносится со встречей, отзывается при удалении внешнего; подписанный ответ (preview, POST идемпотентен, битый токен → 404, прошедшая встреча → `410 EVENT_OVER`, удалённый из списка → 404); без `MANAGE_ROOM` у организатора — `guest_links = false`, ссылки нет.
- `TestEventRemindersAndRoomBadge` — C.7, C.8, C.9: настройки напоминаний (валидация, `settings`-замена их не затирает, умолчания 60/5), метёлка с заданным временем (`Calendar.Sweep(ctx, now)`): `EVENT_REMINDER{minutes}`, DND-флаг, дедуп, отклонивший не получает; `ROOM_EVENT_ACTIVE` / `ENDED`, сразу при создании в окне, `active_events` в READY (гостю пусто), привязка записи организатора к вхождению (`recording_id`), чужая запись не привязывается, отмена активной → `ENDED`.
- `TestEventBotsReadOnly` — C.17 (боты): чтение без адресов внешних, изменения → 403 `BOT_NOT_ALLOWED`; `TestBotRouteTable` — маршруты календаря в таблице.
- Unit: C.10–C.11 `TestExpandDailyWeeklyUntil`, `TestExpandMonthlySkipsShortMonths`, `TestExpandAcrossDST` (Europe/Berlin, 29.03 и 25.10.2026); C.16 (формат) `TestBuildICS` (минимальный RFC 5545-парсер: складка строк ≤ 75 октетов, BEGIN/END, экранирование, `VTIMEZONE` для серии в DST-зоне, `VALUE=DATE`); C.5 `TestRSVPToken`; C.18 `TestInputLimits` (120/4000, 101 участник, 21 внешний, дубли, синтаксис адреса); письмо `TestEventInviteMIME` (multipart/mixed, inline `text/calendar; method=REQUEST`, `invite.ics`, Reply-To, длинные подписанные ссылки не обрезаются).

- `TestEventDeepLinks` — C.19, C.20 («Диплинки для приглашённых»).

Прогон: `go test -tags integration -run 'Event' ./internal/app/` (+ `go test ./internal/calendar/ ./internal/mail/`).

## (b) Десктоп unit (vitest)

Реализовано (клиент, 29.09; компоненты в проекте без component-тестов — вся логика вынесена в чистые модули `apps/desktop/src/renderer/lib/calendar/`):
- `events.test.ts` — редьюсер `EVENT_CREATE/UPDATE/DELETE/RSVP` (ответ на всех вхождениях, `my_status` → строки участников, внешний по адресу, отменённое вхождение уходит, одиночная встреча переезжает сразу, серия — перезапрос), окно списка, дни, значки комнат `ROOM_EVENT_ACTIVE/ENDED` (C.1–C.4, C.8, C.10).
- `formatLocalTime.test.ts` — время в зоне смотрящего (Москва 15:00 / Красноярск 19:00), через полночь, «весь день» по дате организатора, ключи дней, сетка месяца от первого дня недели локали (C.12).
- `reminders.test.ts` — чипы напоминаний (до 5, порядок, отказ шестому), текст «Через 15 минут: Планёрка · Переговорка», «Не беспокоить» (C.7).
- `draft.test.ts` — модель диалога: проверки (название, конец после начала, ≤ 20 внешних), адреса, тело POST, PATCH только изменённого, сдвиг серии, поля ошибок 422 (C.1, C.2, C.18).
- `layout.test.ts` — раскладка пересекающихся встреч дня (колонки кластера, минимальная высота, обрезка по суткам); `drag.test.ts` — перенос/растяжение/выделение с шагом 15 мин (d&d, владелец 29.09).
- `services/links.test.ts` — `/e/<id>` и `calab://e/<id>` (не страница ответа `/e/<id>/rsvp`) (C.15).

## (c) Playwright против мока (`apps/desktop/e2e-visual`)

Визуальные (реализовано, по одному эталону, `dark-960` / iPhone 14): `calendar-mini` (иконка с числом и мини-месяц), `calendar-day` (дневной вид + карточка), `calendar-dialog` (диалог с чипами, внешним адресом, комнатой, повтором) — `screens.spec.ts` `KEY`; `calendar-public` (публичная страница, web 960) — `web.spec.ts`; мобильные `m-calendar-day` (+ карточка на весь экран без снимка), `m-calendar-public` — `mobile.visual.spec.ts`.

Функциональные (реализовано: веб-сборка + мок в Chromium, пояс Москвы, проект `calendar` в `playwright.visual.config.ts`, помощники `calendarWeb.ts`; `pnpm build:web && playwright test --config playwright.visual.config.ts --project calendar`):
- `calendar-day.spec.ts` — C.1 создание → блок в дне выбран, тело POST, число в иконке; d&d: перенос на 2 ч → тело PATCH, нижний край → новое окончание, бросок на день мини-месяца → PATCH на тот день; чужая встреча не двигается (и в меню нет «Изменить»); C.8 значок комнаты по `ROOM_EVENT_ACTIVE` → карточка, `ENDED` убирает; клавиши →, T, N, Esc.
- `calendar-rsvp.spec.ts` — C.4 три ответа (тело PUT, нажатая кнопка, счётчики), ответ другого участника по `EVENT_RSVP` без перезагрузки.
- `calendar-reminder.spec.ts` — C.7 `EVENT_REMINDER` → `Notification` (заглушка) с текстом и тост «Перейти в комнату» → комната и `POST …/join`.
- `calendar-tz.spec.ts` — C.12 два контекста (`Europe/Moscow` / `Asia/Krasnoyarsk`): 15:00 / 19:00, карточка, пояс в диалоге.
- `calendar-deep-link.spec.ts` — C.15 `/e/<id>` без сессии → вход → день с карточкой; неизвестный id → «Встреча не найдена».
- `calendar-public.spec.ts` — C.19 страница `/e/<id>?t=` без аккаунта (нет чужих участников, «Приму» → POST с answer-токеном, ссылка ещё не активна), в окне «Присоединиться» → `/r/<code>`, ссылка ответа `/e/<id>/rsvp?t=` применяется при открытии; C.20 гость: `/e/<id>` → комната с карточкой (счётчики без списка, без ответа и правки), значок у комнаты, иконки календаря нет.

## (d) Прод-smoke после деплоя

Делает агент релиза (docs/11, тот же аккаунт `e2e-app@calaba.test`/владелец, что и остальной smoke) сразу после выкладки: POST `/api/workspaces/{id}/events` с участниками `bob` + один реальный внешний адрес, который даёт владелец (без `record`, чтобы не плодить записи); проверить 201 и `event_attendees`; PUT RSVP от имени `bob`; GET `/api/me/events/today` видит встречу; DELETE (отмена) — чистит за собой. Агент **не читает почту и не кликает по ссылкам** — доставку писем и переход по RSVP/гостевой ссылке (C.5, C.13, C.16) владелец проверяет вручную после первого релиза с календарём, дальше — по ощущению риска, не на каждый деплой.

## (e) Честные пробелы

- **C.16 целиком** — открытие `.ics` в Apple Calendar и Google Calendar не автоматизируется (сторонние приложения, нет API в CI); ручная проверка раз на релиз с настоящим внешним ящиком.
- **C.5, C.13, C.15** — сам факт «письмо дошло, ссылка кликается, ОС спрашивает «Открыть Calab?»» проверяется только вручную; серверная и клиентская логика за ссылками покрыта (a)/(b)/(c) отдельно.
- **C.7** — точный вид и время появления нативного уведомления ОС (macOS/Windows/Linux) и его клик — вручную на каждой ОС; в моке проверяется только внутренняя логика (получено ли `EVENT_REMINDER`, дошло ли действие до подключения к голосу).
- **Публичная RSVP-страница (C.5) в Playwright-моке** — мок поднимает `GET/POST /api/event-rsvp` (токен — `server.eventRsvpToken(id, email, status)`), страницу `/e/<id>/rsvp?t=` пишет клиентская задача. Ранее: мок API не поднимал неавторизованный HTTP-маршрут RSVP; если это добавят в мок, `calendar-rsvp-external.spec.ts` закрывает этот пробел — до тех пор это раздел «вручную» в TESTING.md C.5.
- Точный путь/формат RSVP- и гостевой ссылки зависит от дополнения к ADR-0038 (внешние участники), которое дописывается параллельно; если оно разойдётся с предположениями здесь и в TESTING.md C.5/C.6/C.13 — поправить оба файла вместе с реализацией, а не считать тест устаревшим.
