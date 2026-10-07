# 21 — Доски задач: автоматическая матрица тестов (ADR-0042, 1.1.0)

Ручные сценарии — `TESTING.md` «Доски задач (1.1.0)», K.1–K.20. Здесь — какой автотест стоит за каждым K.n
(как `docs/20-calendar-testing.md`). Столбцы: **(a)** Go-интеграционные (`internal/app/boards_integration_test.go`,
`-run 'Board|Task'`) и unit (`internal/boards`, `internal/perm`, `internal/notifications`) · **(b)** unit
`packages/protocol` (общие векторы) · **(c)** десктоп: vitest / Playwright против мока (клиентская ветка) ·
**(e)** только вручную.

| K.n | Сценарий | (a) Go | (b) protocol | (c) клиент | (e) вручную |
|---|---|---|---|---|---|
| K.1 | Создать доску: ключ из названия, шаблоны статусов, занятый ключ | `TestBoardPermissions` (FNG / FNG2, 409, 422), unit `TestKeys` | — | мок `mock-boards` | — |
| K.2 | Биты доски у ролей по умолчанию, member не управляет | `TestBoardPermissions` | векторы `board: …` (20) в `permissions.json` | — | — |
| K.3 | Приватная доска, доступ лично / ролью, живое появление | `TestBoardPermissions`, `TestTaskComments` (BOARD_CREATE / DELETE по гранту) | векторы `board: private …` | — | — |
| K.4 | Гость: 403 список, 404 доска / задача / комната | `TestBoardPermissions` | вектор `board: a guest never sees` | — | — |
| K.5 | Бот: список, задачи, исполнитель, личный доступ; нельзя PUT permissions / purge | `TestBoardPermissions`, `TestBotRouteTable` | — | — | — |
| K.6 | Задача: номер, позиция, исполнители (один ответственный), лейблы, подзадачи, связи | `TestTaskLifecycle`, unit `TestPositions`, `TestReorder` | — | — | — |
| K.7 | Канбан-перенос: статус, соседи, перенумерация колонки | `TestTaskLifecycle` (120 переносов), unit `TestPositions` | — | d&d — клиент | — |
| K.8 | `started_at` / `completed_at` / `completed_by` | `TestTaskLifecycle`, unit `TestFinishFields` | — | — | — |
| K.9 | Права на правку: свои / назначенные / чужие, EDIT_TASKS | `TestBoardPermissions` | — | — | — |
| K.10 | Журнал: запись на каждое изменение, лента с комментариями, CSV | `TestTaskLifecycle` | — | — | вид CSV в Excel / Numbers — глазами |
| K.11 | Комментарии: реакция, закреп, поиск, файл, пересылка; комната не в READY / списке | `TestTaskComments` | — | — | стикер / голосовое в комментарии — вместе с клиентом |
| K.12 | Фильтры: все поля / операции, `any`, «me», относительные даты | unit `TestTranslateFields`, `TestTranslateAnyAndErrors`, `TestResolveDate`; `TestTaskFilters` | — | реестр полей — клиент | — |
| K.13 | Виды: общие / личные / по умолчанию | `TestBoardViews` | — | — | — |
| K.14 | «Мои задачи», ⌘K, `/t/KEY-N` | `TestTaskFilters`, `TestTaskLifecycle` | — | — | — |
| K.15 | Задача из сообщения: цитата + ссылка; невидимое — 404 | `TestTaskLifecycle` | — | e2e `boards-timeline.spec.ts` (POST с `fromMessageId`) | — |
| K.16 | Перенос на другую доску, ключ, `moved_board` | `TestTaskLifecycle` | — | — | — |
| K.17 | Архив / восстановление, метёлка автоархива | `TestTaskLifecycle`, `TestTaskArchiveSweeper` | — | — | — |
| K.18 | Уведомления «Задачи»: назначение, упоминание, комментарий, статус, уровни, непрочитанные | `TestTaskNotifications`, unit `notifications.TestVectors` | векторы `task …` (72) в `notifications.json` | «Задачи» в меню пространства — вручную (K.23) | нативное уведомление ОС — раз на релиз |
| K.19 | Unfurl `/t/` и `/b/` по правам смотрящего | `TestTaskUnfurl` | — | unit `lib/boards/card.test.ts`; e2e `boards-timeline.spec.ts` (карточка → панель); снимок `chat-task-card` | — |
| K.20 | Тариф: Free 3 доски; удаление статуса с переносом | `TestBoardPlanLimit`, `TestTaskLifecycle` | — | — | — |
| K.21 | Таймлайн: перенос, края, «Без дат», вехи, метка блокировки | — | — | unit `lib/boards/timeline.test.ts` (даты, привязка, окно, группы, блокировка); e2e `boards-timeline.spec.ts` (тела `PATCH`); снимок `boards-timeline` | телефон — только чтение |
| K.22 | Задача из сообщения (клиент), `/m/` прокручивает к сообщению | `TestTaskLifecycle` | — | e2e `boards-timeline.spec.ts` | переход по `/m/` — вручную |
| K.23 | Карточки `/t/` `/b/` в чате, «Задачи» в уведомлениях, архив досок | `TestTaskUnfurl` | — | unit `card.test.ts`, e2e, снимки `chat-task-card`, `m-boards-kanban` | уровни и восстановление — вручную |
| K.24–25 | Доска по карточкам (ADR-0059): позвать со стороны исполнителем / согласующим, видна только своя карточка, снять — карточка и доска уходят; закрытая доска, гость, бот — 422 | `TestTaskScopedAccess`, unit `perm.TestTaskBits`, `perm.TestResolverTaskRoom`, gateway `TestTaskScopedTransitions` | `taskPermissions` (та же таблица, `permissions.test.ts`) | клиентская ветка ADR-0059 | бейдж «Только мои карточки», пикер — QA скриншотами |
| K.24н | Наблюдатели (ADR-0076): наблюдатель без доступа видит только свою карточку; снятие отнимает доступ, если нет другого основания; закрытая доска открывается по карточке; упоминание без права правки не даёт доступа, редактором — делает наблюдателем; гость — 422, бот без `VIEW_BOARD` — 422; обычный подписчик, снятый с доски, карточку теряет; `task_scoped_count` | `TestTaskWatchers`, `TestTaskScopedAccess`, unit `perm.TestTaskBits` (общая таблица `task_bits.json`), `TestResolverTaskRoom`, gateway `TestTaskScopedTransitions` | `taskPermissions` (`permissions.test.ts`, та же таблица) | vitest `lib/boards/watchers.test.ts`, `access.test.ts` | поле «Наблюдатели» — QA скриншотами |
| K.26 | Клиент доски по карточкам (ADR-0059 §5): чип «Только мои карточки», скрытые контролы, подписи пикера | — | — | vitest `lib/boards/access.test.ts`, `services/boards.test.ts` | QA-скриншоты `docs/qa/2.2.0/task-scoped/` |
| K.27 | Правила автоматизации (ADR-0060 §2–3): тариф (Free — 409 `PLAN_LIMIT`), права (бот читает, пишет — 403), валидация, ≤ 20 на доску, события 92/93, статус → приоритет / комментарий / уведомление `RULE` / сообщение в комнату, approval gate внутри правила и откат savepoint’а, «Согласовано → Готово», «Все пункты → Готово» + подзадача, цепочка глубины 3 и `RULE_LOOP`, «Просрочено» раз на срок, вебхук доски с `actor: null` + `rule` | `TestBoardRules`; unit `boards.TestMatchTrigger`, `TestRenderTemplate`, `TestRuleEncoding`, `TestWebhookPayloadGolden` | векторы `task rule …` в `notifications.json` | клиентская ветка ADR-0060 (`Rules.tsx`) | редактор и журнал правила — QA скриншотами |
| K.28 | Git-связи (ADR-0060 §4): настройка GitHub / GitLab / Gitea, 401 без подписи, 413 > 1 МБ, повтор доставки — без эффекта, PR открыт → связь + запись `git` + `TASK_GIT_LINKS_UPDATE` (зрителям и приглашённому по карточке) + правило «PR открыт → В работу», смержен → `merged` + «Готово», чужой ключ — игнор | `TestBoardGit`; unit `vcs.TestParseGolden` (фикстуры `internal/boards/vcs/testdata`), `TestVerify`, `TestKeys`, `TestLinksBounds` | — | клиентская ветка ADR-0060 (секция «Git», вкладка настроек) | настройка в настоящем GitHub / GitLab / Forgejo — раз на релиз |
| K.29 | Вехи внутри задачи (ADR-0063): CRUD, ≤ 20, у подзадачи нет, порядок, ручная отметка; привязка подзадачи только к вехе родителя, сброс при смене родителя, удаление вехи отвязывает; прогресс без `cancelled`, авто-выполнение и снятие (в т. ч. архив / восстановление подзадачи), ручная отметка при авто — `409 TASK_MILESTONE_AUTO`; права: свои / назначенные, исполнитель по карточке, согласующий — 403, скрытая — 404, бот как человек; фича выкл. — `409 FEATURE_DISABLED` (удаление и отвязка — да); журнал `milestones`, `TASK_UPDATE` родителя | `TestTaskMilestones` (crud / progress / feature / rights / events); unit `boards.TestMilestoneProgress`, `TestWebhookPayloadGolden` | — | vitest `lib/boards/milestones.test.ts` (состояние, прогресс, строка ввода, позиции, слияние в сторе) | — |
| K.29к | Клиент вех и шкала таймлайна: секция «Вехи», «Веха родителя», чип `◇ 2/4`; шкала — числа по понедельникам, месяц строкой выше, «сегодня» и наведение, подписи «вне окна», ромбы на полосах | — | — | vitest `lib/boards/timeline.test.ts` (метки шкалы, подписи месяцев и таблеток в 2 локалях, геометрия сегодня / наведения, сторона и текст «вне окна», прокрутка к задаче) | QA-скриншоты `docs/qa/2.3.0/task-milestones/`; D&D порядка вех — вручную |

## Пробелы
- Стикер и голосовое в комментарии задачи отдельным тестом не покрыты: путь тот же, что у любой комнаты (`TestStickers*`, `TestVoiceMessages`), отличие — только права комнаты задачи (K.11).
- Нагрузка (5000 задач, 50 досок) — не автоматизирована; бюджет — `docs/14-energy.md` после клиента.

## Security-ревью (1.1.0)
Проверено по коду (`internal/boards`, `perm/board*.go`, gateway `boards.go`, резолвер комнат задач, файлы, unfurl, поиск, пересылка, таблица ботов):
- Биты и дефолты ролей, `BOARD_ONLY` Go/TS и векторы `permissions.json` (биты доски в комнатах и комнатные в досках игнорируются) — верно.
- Видимость приватной доски: READY (`boards`, `unread_task_ids`), список, задачи, «Мои задачи», ⌘K, `/t/KEY-N` (404), unfurl `/t/` и `/b/`, уведомления (`sees` на момент события), fan-out gateway (`board:<id>` и комната задачи — по битам получателя), сообщения/файлы/реакции/закрепы/поиск комнаты задачи, гости (403/404), боты (`botAllow`, override доски целит бота) — утечек нет.
- `from_message_id` — `VIEW_ROOM` комнаты сообщения (или участник DM), иначе 404; описание не создаётся.
- Вложения: `POST /boards/{id}/files` — `VIEW_BOARD` (как `ATTACH_FILES` комментария) + квота пространства; `attachment_ids` — только свои неприкреплённые загрузки пространства; скачивание — по правам доски через комнату задачи.
- `EDIT_TASKS` / свои и назначенные при `CREATE_TASKS`; архив чужих — `EDIT_TASKS`; модерация комментариев = `MANAGE_MESSAGES` из `EDIT_TASKS`.
- `MANAGE_BOARD`: статусы/вехи/настройки/общие виды, личные виды — только автор; `PUT …/permissions` — люди, `MANAGE_BOARD`, выдавать/снимать только свои биты (как у комнат); `?purge=1` — люди; восстановление — `MANAGE_BOARD`.
- Перенос задачи — `MANAGE_BOARD` на обеих досках, одно пространство. Журнал/CSV — `MANAGE_BOARD` или `EDIT_TASKS`; `related`/родитель — только видимые задачи; фильтры не ссылаются на чужие задачи.

Исправлено (тест `TestBoardSecurityReview`):
- **Major:** иконкой доски можно было назначить любой файл-картинку пространства (например, вложение приватной доски или закрытой комнаты) — иконку читают все участники, файл утекал. Теперь — только своя загрузка (или текущая иконка доски).
- Лимиты частоты: создание задачи 60 сразу / 1 в с на пользователя (`rl:task-create:`), поиск ⌘K 30 / 1 в с (`rl:task-search:`); комментарии — под лимитом сообщений.

Вердикт: блокеров нет; остаточные риски — `docs/12-tech-backlog.md` (2026-09-30).
