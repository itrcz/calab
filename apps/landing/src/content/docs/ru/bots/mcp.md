---
title: MCP-сервер для LLM-клиентов
description: https://app.calab.io/mcp (он же POST /api/mcp) — эндпоинт Model Context Protocol — личный вход через OAuth без бота или токен бота, девятнадцать инструментов, пометка «через MCP», примеры JSON-RPC, ошибки, лимиты и что не поддержано.
order: 21
---

## Что это

`https://app.calab.io/mcp` (то же самое — `POST /api/mcp`) — сервер [Model Context Protocol](https://modelcontextprotocol.io), встроенный в API Calab. LLM-клиент (Claude Code, Codex, Cursor, Claude Desktop) подключается к нему **под вашим аккаунтом через OAuth** — без бота и без токена в конфиге — или с токеном бота, чтобы искать задачи и комнаты, читать их, создавать и править задачи, назначать исполнителей, комментировать, получать файлы задач, писать в комнаты и людям, вести календарь, отмечать чек-листы, связывать задачи и голосовать в согласовании.

Каждый инструмент вызывает обычные маршруты REST сервера **с той же личностью**, поэтому инструмент не даёт больше, чем у вас (или у бота) есть в приложении: роли, таблица маршрутов, лимиты и модерация применяются так же, как к собственному REST-вызову бота. Отказ окончателен: инструмент возвращает его как ошибку и не ищет обходных путей.

## Подключение под своим аккаунтом (OAuth)

Так подключается агент разработчика: адрес сервера — и всё, вход через браузер. Адрес и готовые команды для вашего сервера — в приложении: «Настройки → MCP».

1. Добавьте сервер в клиент. Claude Code:

   ```sh
   claude mcp add --transport http calab https://app.calab.io/mcp
   ```

   Или в `.mcp.json` / `~/.claude.json`:

   ```json
   { "mcpServers": { "calab": { "type": "http", "url": "https://app.calab.io/mcp" } } }
   ```

   Claude Desktop и claude.ai: Settings → Connectors → Add custom connector, адрес `https://app.calab.io/mcp`. Codex: `codex mcp add calab --url https://app.calab.io/mcp`, затем `codex mcp login calab`. Cursor: `~/.cursor/mcp.json` — `{"mcpServers":{"calab":{"url":"https://app.calab.io/mcp"}}}`.

2. В клиенте запустите вход (Claude Code: `/mcp` → `calab` → Authenticate). Откроется браузер со страницей «Подключить MCP-клиент»: войдите в Calab, если ещё не вошли, проверьте имя приложения и куда вернётся код («программе на этом компьютере») и нажмите «Разрешить».
3. Готово: клиент получил токен и обновляет его сам. Подключение видно в «Настройки → Сеансы» как «MCP · <имя клиента>» — там же его и отключают.

Агент работает **как вы**: автор задач и комментариев, исполнитель, `me` в инструментах — вы; права — ваши роли. Всё сделанное через MCP помечено «(через MCP)» после вашего имени, в комментариях и в истории задачи.

- Токен MCP-подключения действует только на `/mcp` и `/api/mcp`: обычный REST, gateway и обновление сессии приложения его не принимают (`403 MCP_TOKEN`).
- Подключать можно только из личного аккаунта с паролем; пространство с обязательным SSO такое подключение не пускает.
- Клиент регистрируется сам (RFC 7591); возврат кода — на `http://localhost` / `127.0.0.1` / `[::1]` (любой порт) или на callback веб-коннекторов `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` (точный список — `MCP_OAUTH_REDIRECT_URIS`).
- Метаданные для клиентов: `/.well-known/oauth-protected-resource/mcp` (для `/mcp`), `/.well-known/oauth-protected-resource/api/mcp` (для `/api/mcp`) и `/.well-known/oauth-authorization-server`; ответ `401` эндпоинта содержит `WWW-Authenticate` со ссылкой на метаданные своего адреса. Код авторизации обменивается только для того адреса (`resource`), для которого выдан; токен годен на обоих.
- Открытый в браузере `https://app.calab.io/mcp` ведёт на «Настройки → MCP».

## Подключение через бота

Для автоматизаций без человека (CI, интеграции) — токен бота:

1. Создайте бота и скопируйте токен ([Быстрый старт](./quickstart), [Токен и права](./auth)): «Настройки пространства → Боты», токен показывается один раз.
2. Дайте боту роль в пространствах, которые он должен видеть ([Права](./auth#права)).
3. Укажите клиенту адрес `https://<ваш хост Calab>/api/mcp` и заголовок `Authorization: Bearer calab_bot_…`. Токен — только в заголовке, не в URL.

### Бот от имени человека

Если нужен именно бот, но действия должны быть ваши (автор комментариев, исполнитель, создатель задачи — вы), создайте своего бота, включите у него «Действовать от моего имени» ([Токен и права](./auth#от-имени-владельца)) и добавьте клиенту второй заголовок `Calab-On-Behalf: owner`. Для участника, который сам разрешил боту действовать за него, — `Calab-On-Behalf: <id пользователя>` ([От имени участника](./auth#от-имени-участника)). Каждый вызов инструмента проверяется «от имени» так же, как REST-запрос: что закрыто «от имени» в REST, закрыто и здесь; выключенный переключатель или отозванное согласие — сразу `403`.

От имени участника работают только задачи и доски **пространства, где он разрешил**: передавайте id задачи или доски (`board` + `workspace`); поиск по ключу задачи, `find` и `list_tasks` с `mine` — общие для всех пространств и «от имени участника» закрыты (`403 ON_BEHALF_ROUTE`). Ключ доски вроде `DEV` и ключ задачи вроде `DEV-12` уникальны только в пространстве: если такой есть в нескольких ваших пространствах, инструмент вернёт ошибку со списком — укажите `workspace` или id.

Действия через MCP помечаются: у сообщений и записей журнала задачи поле `via` = `"mcp"`, в приложении после имени — «(через MCP)» при входе через OAuth и у самого бота, «(через бота X · MCP)» — человек через своего бота. `me` в инструментах — это вы (или сам бот без заголовка).

```json
{
  "mcpServers": {
    "calab": {
      "type": "http",
      "url": "https://app.calab.io/api/mcp",
      "headers": { "Authorization": "Bearer ${CALAB_BOT_TOKEN}", "Calab-On-Behalf": "owner" }
    }
  }
}
```

Транспорт — Streamable HTTP: запрос JSON-RPC 2.0 в теле `POST`, ответ — один JSON-объект.

## Методы

| Метод | Что делает |
|---|---|
| `initialize` | Рукопожатие. В ответе версия клиента `protocolVersion`, если она одна из `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, иначе новейшая; возможности — только `tools` |
| `ping` | Пустой результат |
| `tools/list` | Список инструментов с JSON-схемами |
| `tools/call` | Вызов инструмента: `params` = `{"name": "…", "arguments": {…}}` |
| уведомления (`notifications/initialized`, …) | Запрос без `id`: ответ `202`, без действий |

## Инструменты

| Инструмент | Аргументы (обязательные выделены) | Результат |
|---|---|---|
| `find` | `q` (слова; для комнат, досок и людей — часть имени, пусто = все), `kind` (`tasks` · `messages` · `rooms` · `boards` · `people`; по умолчанию все, `people` — только с `q`), `workspace` (id; по умолчанию все пространства бота), `limit` (на каждый вид, 1–20, по умолчанию 10) | Идентификаторы для других инструментов: `tasks`, `messages` (включая комментарии задач), `rooms`, `boards`, `people` (id, имя, ник); ничего нет — `{"found": 0}`. `q` обязателен для `tasks` и `messages` |
| `read` | `task` (id или ключ `ABC-12`) **или** `room` (id; комментарии задачи — в её комнате; `members: true` — кто видит комнату) **или** `person` (`me`, id, имя или ник; `workspace` — где искать), `limit` (сообщений, 1–50, по умолчанию 20), `before` (id сообщения: более старая история), `full` (`true` — объект API целиком), `comments` (с задачей: последние комментарии, 1–50) | Задача со статусами её доски, подзадачами, исполнителями и ведущим, метками, чек-листами, файлами (`files`: id, имя, тип, размер), Git-связями (`git`: MR и ветки, коммиты — числом), релизами, согласованием (`approval`: состояние, `required`, голоса, `pending` — чьё решение ждём) и связями (`links`), с `comments` — `recent_comments`; у сообщений `files` с id; или комната и последние сообщения (старые первыми, `more` — есть ещё более старые; с `members` — `members`, до 100); или профиль человека |
| `create_task` | **`board`** (id или ключ), **`title`** (1–200 символов), `description` (markdown), `status` (имя или id; по умолчанию статус доски) | `id`, `key`, `room`, `status` |
| `comment_task` | **`task`** (id или ключ), `text` (markdown), `files` (id файлов из `upload_attachment`; с ними `text` можно не давать) | `id`, `room` нового комментария, `files`. Один неверный id — комментарий не публикуется |
| `set_task_status` | **`task`**, **`status`** (имя или id статуса **доски этой задачи**) | `key`, `status`. Неизвестный статус — ошибка со списком статусов доски |
| `send_message` | **`room`** (id; подойдёт и DM) **или** `to` (человек: id, имя или ник — пишет ему в личные; `workspace` — где искать), `text` (markdown, до 4000 символов), `reply_to` (id сообщения), `files` (id файлов из `upload_attachment`) | `id`, `room`, `files`. Один неверный id — сообщение не отправляется |
| `list_tasks` | `board` (id или ключ `DEV`) или `workspace` (id), `q` (слова или ключ), `status` (имена через запятую; нужна `board`), `assignee` (`me`, id, имя или ник), `labels` (имена; нужна `board`), `state` (`open` по умолчанию · `done` · `all`), `sort` (`updated` по умолчанию · `created` · `key` · `priority` · `due`, `-` — по убыванию), `mine` (`true` без доски — мои открытые задачи везде), `limit` (1–50, по умолчанию 20), `cursor` | `tasks` (ключ, название, статус, приоритет, исполнители, метки, срок, обновлена), `next` — курсор следующей страницы |
| `update_task` | **`task`** (`workspace` — где искать ключ), и только меняемые поля: `title`, `description`, `priority` (`none` · `low` · `medium` · `high` · `urgent`), `due` / `start` (`YYYY-MM-DD`, пусто — снять), `estimate` (0 — нет), `parent` (задача, пусто — снять), `labels` (весь набор по именам) или `add_labels` / `remove_labels` | Задача после правки |
| `assign` | **`task`**, **`users`** (`me`, id, имена или ники), `mode` (`add` по умолчанию · `remove` · `set`), `lead` (ведущий из исполнителей; по умолчанию прежний, иначе первый) | `key`, `assignees`, `lead`. Неоднозначное имя — ошибка со списком подходящих |
| `get_task_attachment` | **`task`**, **`file`** (id из `read` или точное имя), `comment` (id сообщения-комментария; по умолчанию — файлы задачи, затем последних 100 комментариев) | Описание файла с `download_url` (подписанная ссылка на 10 минут, см. [Работа с вложениями](#работа-с-вложениями)); текст до 256 КиБ и картинки до 3 МиБ (больше — превью 1024 px) — ещё и прямо в ответе. Права — как на скачивание в приложении; файл другой задачи — ошибка |
| `upload_attachment` | **`task`** (id или ключ) **или** **`room`** (id), `workspace` | `upload_url` (одноразовая ссылка на 10 минут), готовая команда `curl`, `max_size`. Загруженный файл прикрепляется через `files` у `comment_task` / `send_message` |
| `edit_message` | **`message`** (id), **`text`** (markdown) | `id`, `room`, `edited`. Править можно только своё |
| `calendar` | `action` (`list` по умолчанию · `event` · `freebusy` · `suggest`), `from` / `to` (ISO 8601: со смещением, без него — в вашем часовом поясе; дата — весь день; по умолчанию с начала сегодняшнего дня на 7 дней, у `freebusy` — на сутки), `workspace` (по умолчанию все), `all` (`list`: все видимые встречи, не только мои), `event` (id встречи для `event`), `users` (`freebusy` / `suggest`: `me`, id, имена или ники, до 20), `duration` (`suggest`: минуты, по умолчанию 30), `work_hours` (`suggest`: только в общие рабочие часы, по умолчанию `true`), `room` (`suggest`: голосовая комната тоже свободна), `limit` (`list`: 1–100, по умолчанию 50) | `tz` — ваш часовой пояс (из профиля, без него UTC), все времена в нём (`when`: `2026-11-16 10:00–10:45`). `list` — мои встречи (`id`, `title`, `when`, `room`, `organizer`, `me` — мой ответ, `repeat`, у серии `occurrence`, `people`, `comments`); `event` — встреча с участниками и последними комментариями; `freebusy` — занятость и рабочие часы каждого; `suggest` — до 10 ближайших общих окон |
| `event` | **`action`** (`create` · `update` · `cancel` · `comment`), `event` (id встречи, кроме `create`), `title`, `description`, `start` / `end` (ISO 8601) или `duration` (минуты, по умолчанию 30), `all_day`, `users` (участники; в `update` с `mode`: `add` по умолчанию · `remove` · `set`), `room` (голосовая комната: id или имя; в `update` `none` — без комнаты), `repeat` (`none` · `daily` · `weekly` · `biweekly` · `monthly` · `workdays`), `occurrence` и `scope` (`this` по умолчанию · `following` · `all`) — одна встреча серии, `text` (комментарий), `workspace` (`create`, если пространств несколько) | Встреча после изменения; `update` с одним `start` сохраняет длительность. `cancel` — что отменено, `comment` — id комментария |
| `inbox` | `workspace` (упоминания одного пространства), `limit` (1–50, по умолчанию 20), `before` (id сообщения: более старые упоминания) | `dms` — непрочитанные личные сообщения (`room`, `from`, `unread`, `last`), `mentions` — сообщения с упоминанием меня, новые первыми (`more` — есть ещё) |
| `react` | **`message`** (id), **`emoji`** (например `👍`), `mode` (`add` по умолчанию · `remove`) | `message`, `emoji`, `reacted` |
| `checklist` | **`task`**, `action` (`check` по умолчанию · `uncheck` · `toggle` · `add`), `item` (пункт: номер по порядку, как в `read`, текст или id; в `add` — текст нового), `items` (`add`: несколько), `checklist` (название или id чек-листа; `add` — по умолчанию первый, а если нет — создаётся) | Чек-лист после правки (`[x]` / `[ ]`), `done` — «сделано/всего» по задаче |
| `link_tasks` | **`task`**, **`related`** (другая задача того же пространства: id или ключ), `kind` (`relates` по умолчанию · `blocks` · `blocked_by` · `duplicates` — «`task` блокирует / заблокирована / связана / дублирует `related`»), `mode` (`add` по умолчанию · `remove`) | `key`, `links` задачи |
| `approve` | **`task`**, **`decision`** (`approve` · `reject` · `withdraw` — отозвать голос), `reason` (причина, обязательна для `reject`, до 500 символов) | `key`, `approval` после голоса. Голосует только согласующий задачи, голос — ваш |

Ответы компактные: пустые поля опускаются. Обычный путь: `find` → id → `read` → действие.

## Работа с вложениями

Файлы не идут через контекст модели: агент (Codex, Claude Code) скачивает и загружает их **в своей оболочке** через `curl` по короткоживущим подписанным ссылкам. Ссылку выдаёт инструмент; она действует **10 минут**, привязана к тому, кто вызвал инструмент (бот, его токен, MCP-подключение, «от имени»), и к одному файлу (скачивание) или одной цели (загрузка). Токен в заголовке `curl` не нужен — его роль играет подпись в ссылке; при каждом запросе сервер заново проверяет, что подключение живо и что права на файл остались (как у `GET /api/files/{id}`). Отозвали токен, отключили подключение, удалили комментарий, лишили доступа — ссылка перестаёт работать до истечения срока. Публичными ссылками Диска это не является и в «Поделиться» не появляется.

### Что поддерживается

| Вид | Форматы | MIME в ответе | Лимит |
|---|---|---|---|
| Текст | TXT, CSV, TSV, JSON, XML, MD, SQL, YAML, логи, код | `text/plain`, `text/csv`, `text/tab-separated-values`, `application/json`, `application/xml`, `text/markdown`, `application/sql`, `application/yaml`… | 3 МиБ (3 145 728 байт) |
| Документы | XLSX, DOCX, PPTX, PDF | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `…wordprocessingml.document`, `…presentationml.presentation`, `application/pdf` | 3 МиБ |
| Архивы | ZIP | `application/zip` | 3 МиБ |
| Аудио | OGG/Opus (голосовые), MP3, WAV, M4A | `audio/ogg`, `audio/mpeg`, `audio/wav`, `audio/mp4` | 3 МиБ |
| Картинки | PNG, JPEG, WEBP, GIF | `image/png`, `image/jpeg`, `image/webp`, `image/gif` | 5 МиБ (5 242 880 байт) |

Лимит — по размеру исходного файла; ровно на лимите файл проходит. Видео и прочие типы — `unsupported_file_type`. Без ссылки агент всё равно видит то, что можно показать в чате: у картинки другого типа (HEIC и т. п.) или больше лимита — превью 1024 px, у текста больше лимита — первые 256 КиБ; в описании вместо `download_url` стоит `no_download` с причиной (`unsupported_file_type` / `file_too_large`). Файлы OOXML, сохранённые сервером как `application/zip` или `application/octet-stream`, получают правильный MIME по расширению.

### Вложения задачи и комментария

`get_task_attachment` находит файл среди вложений задачи и её комментариев: `file` — id (из `read`, у задачи `files`, у комментариев `recent_comments[].files`) или точное имя; `comment` — id сообщения-комментария (иначе ищется в задаче и последних 100 комментариях). Ответ — JSON с описанием:

```json
{"file":"0199…","name":"report.xlsx","mime":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
 "size":48213,"sha256":"5f1c…","task":"WEB-12","comment":"0199…",
 "download_url":"https://app.calab.io/api/mcp/file/eyJ…","expires_in":600}
```

`comment` есть только у файла комментария. Для текста и картинок следом идёт сам файл (блок `text` или `image`); для остальных — строка с командой скачивания.

### Скачать и проверить SHA-256

```sh
curl -fsSL -o "report.xlsx" "$DOWNLOAD_URL"
shasum -a 256 report.xlsx   # должно совпасть с sha256 из описания
```

Повторное скачивание по той же ссылке в течение 10 минут работает (и с `Range`); потом — снова `get_task_attachment`. Ответ — `Content-Disposition: attachment`, `Cache-Control: no-store`.

### Загрузить файл и прикрепить к комментарию

1. `upload_attachment` с `task` (комментарий задачи) или `room` (сообщение в комнате или DM) — одноразовая ссылка и команда `curl`.
2. `curl -fsS -F file=@./report.xlsx "$UPLOAD_URL"` — ответ `{"file","name","mime","size","sha256"}`. Ссылка срабатывает один раз, даже если загрузка не удалась (например, `413`) — для повтора вызовите `upload_attachment` снова; файл до 3 МиБ.
3. `comment_task` (или `send_message`) с `files: ["<file>"]`. Прикрепить можно только свой ещё не прикреплённый файл этого пространства; один неверный id — ничего не публикуется. Права на загрузку и комментарий — как в приложении (`ATTACH_FILES`, квота и лимиты тарифа).

### Ошибки

| Где | Ошибка | Что значит |
|---|---|---|
| инструмент (`isError`) | `{"error":"file_too_large","size":…,"limit":…}` | файл больше лимита, ссылки нет (картинка с превью и текст — не ошибка: превью / первые 256 КиБ и `no_download`) |
| инструмент (`isError`) | `{"error":"unsupported_file_type","supported":[…]}` | тип не поддерживается (картинка с превью — не ошибка: превью и `no_download`) |
| инструмент (`isError`) | `404 NOT_FOUND`, `403 FORBIDDEN` | нет доступа к задаче или файлу |
| ссылка | `404` | ссылка неверна, изменена или истекла, либо доступ к файлу пропал |
| ссылка | `401` | токен бота заменён или MCP-подключение отключено |
| ссылка | `403` | нет прав (`ATTACH_FILES`, «от имени» выключено) |
| загрузка | `413` `FILE_TOO_LARGE`, `reason: file_too_large`, `used` — размер, `limit` — 3 145 728 | файл больше 3 МиБ |
| загрузка | `410`, `reason: upload_url_used` | ссылка уже использована — вызовите `upload_attachment` ещё раз |

### Примеры для Codex

Скачать XLSX из задачи и прочитать: «возьми `report.xlsx` из WEB-12» → `get_task_attachment {"task":"WEB-12","file":"report.xlsx"}` → `curl -fsSL -o report.xlsx "<download_url>" && shasum -a 256 report.xlsx` → дальше `python3 -c "import openpyxl…"`.

DOCX из комментария: `get_task_attachment {"task":"WEB-12","file":"spec.docx","comment":"<id комментария>"}` → `curl -fsSL -o spec.docx "<download_url>"` → `pandoc spec.docx -t markdown`.

Голосовое OGG: `get_task_attachment {"task":"WEB-12","file":"<id>"}` (`mime: audio/ogg`) → `curl -fsSL -o voice.ogg "<download_url>"` → расшифровка локально (`whisper voice.ogg`).

Отчёт XLSX → комментарий:

```text
upload_attachment {"task":"WEB-12"}
  → {"upload_url":"https://app.calab.io/api/mcp/upload/eyJ…","curl":"curl -fsS -F file=@./report.xlsx \"…\"", …}
curl -fsS -F file=@./report.xlsx "https://app.calab.io/api/mcp/upload/eyJ…"
  → {"file":"0199…","name":"report.xlsx","mime":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","size":48213,"sha256":"5f1c…"}
comment_task {"task":"WEB-12","text":"Отчёт за неделю","files":["0199…"]}
```

## Календарь, люди, сообщения и согласование

### Календарь

Время в аргументах — ISO 8601: `2026-11-16T10:00+03:00` или `…Z`; без смещения (`2026-11-16T10:00`, `2026-11-16`) — в часовом поясе вашего профиля. Ответ — в нём же, поле `tz` называет пояс один раз. Права — как в календаре приложения: видно встречи своих комнат и те, где вы организатор или участник; менять — организатор или кто может по ролям.

```json
{"name":"calendar","arguments":{"from":"2026-11-16","to":"2026-11-20"}}
{"name":"calendar","arguments":{"action":"suggest","users":["me","Анна"],"duration":45,"from":"2026-11-16"}}
{"name":"event","arguments":{"action":"create","title":"Синк","start":"2026-11-16T10:00","duration":45,"users":["Анна","bob"],"room":"Переговорка"}}
{"name":"event","arguments":{"action":"update","event":"<id>","start":"2026-11-16T15:00"}}
```

У повторяющейся встречи `calendar` отдаёт `occurrence` каждого повтора: передайте его в `event` с `scope` `this` (только этот), `following` (этот и следующие) или без `occurrence` — вся серия.

### Люди

`read` с `person` — профиль: роль и роли пространства, статус, часовой пояс и местное время, ник, открытые задачи. `read` с `room` и `members: true` — кто видит комнату (по тем же правам, что приложение; личные сообщения — двое). Все участники пространства — `find` с `kind: "people"` и `workspace`.

```json
{"name":"read","arguments":{"person":"Анна"}}
{"name":"read","arguments":{"room":"<id>","members":true,"limit":1}}
```

### Сообщения

`send_message` с `to` пишет человеку в личные сообщения (чат откроется, если его ещё не было). `inbox` — что написали мне: непрочитанные личные и упоминания. `react` ставит и снимает реакцию.

```json
{"name":"send_message","arguments":{"to":"Анна","text":"Посмотри DEV-12, пожалуйста"}}
{"name":"inbox","arguments":{}}
{"name":"react","arguments":{"message":"<id>","emoji":"👍"}}
```

### Чек-листы, связи и согласование задач

`read` задачи показывает `approval`: состояние, сколько одобрений нужно (`required`), голос каждого согласующего и `pending` — чьё решение ждём; и `links` — связи с другими задачами.

```json
{"name":"checklist","arguments":{"task":"DEV-12","item":"Тесты"}}
{"name":"checklist","arguments":{"task":"DEV-12","action":"add","items":["Changelog","Анонс"]}}
{"name":"link_tasks","arguments":{"task":"DEV-12","related":"DEV-9","kind":"blocked_by"}}
{"name":"approve","arguments":{"task":"DEV-12","decision":"reject","reason":"Нет тестов на миграцию"}}
```

### Что не может бот без «от имени»

- **Голосовать в согласовании.** Голос — решение человека: `approve` от самого бота отвечает `403 BOT_NOT_ALLOWED` с подсказкой. Через OAuth или с `Calab-On-Behalf` голос засчитывается человеку, за которого действуют.
- **Быть участником встреч.** Бот только организует их; `calendar` без `all` для бота — встречи, которые он создал. В `freebusy` бот видит лишь занятость, без названий внешних событий.
- `inbox` и `me` у бота — его собственные: личные сообщения и упоминания самого бота.

Обратное ограничение: комментарии к встречам (`event` с `comment`) закрыты боту **«от имени»** (`403 ON_BEHALF_ROUTE`); через OAuth и самому боту — можно.

## Пример

```sh
curl -sS https://$HOST/api/mcp \
  -H "Authorization: Bearer $CALAB_BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"set_task_status","arguments":{"task":"WEB-12","status":"Done"}}}'
```

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"key\":\"WEB-12\",\"status\":\"Done\"}"}]}}
```

Результат инструмента — массив `content`, в `text` лежит строка JSON (у `get_task_attachment` — описание файла, затем блок с текстом файла или `image`). Неудачный вызов инструмента **не** ошибка протокола: HTTP-статус `200`, в результате `"isError": true`, а текст начинается со статуса и кода REST, например `404 NOT_FOUND: …` — модель может исправить аргументы или остановиться.

## Ошибки

| Где | Что | Почему |
|---|---|---|
| HTTP `401` | `UNAUTHENTICATED` + `WWW-Authenticate` | нет токена, он неверный или подключение отключено — клиент начинает вход OAuth заново |
| HTTP `403` | `FORBIDDEN` | токен сессии приложения (не MCP-подключения и не бота); с `Calab-On-Behalf` — причина «от имени» (`ON_BEHALF_DISABLED`, `ON_BEHALF_NO_CONSENT`…, см. [Токен и права](./auth#от-имени-владельца)) |
| HTTP `405` | `Allow: POST` | `GET` / `DELETE` — потока и сессий нет |
| HTTP `400` | JSON-RPC `-32700` / `-32600` | невалидный JSON; это не запрос JSON-RPC 2.0; пакет (массив) |
| HTTP `413` | JSON-RPC `-32600` | тело больше 1 МиБ |
| JSON-RPC `-32601` | `method not found` | неизвестный метод |
| JSON-RPC `-32602` | `unknown tool …`, `invalid params` | неверное имя инструмента или `params` |
| результат с `isError` | `404 NOT_FOUND`, `403`, `409 PLAN_LIMIT`, `429`, валидация | REST-вызов внутри инструмента отклонён |

## Лимиты

Вызов инструмента стоит один запрос из лимита бота (у подключения через OAuth — такой же лимит на подключение) плюс его вызовы REST ([Ошибки и лимиты](./errors-limits#лимиты): 30 запросов в секунду, 20 сообщений в минуту). `find` без `workspace` обходит все пространства бота (комнаты и доски), поэтому боту во многих пространствах лучше указывать `workspace`. При упоре в лимит инструмент возвращает `429` как ошибку с `isError`.

## Не поддержано

- Стриминг: нет SSE-ответов, `GET`-потока и возобновления.
- Сессии (`Mcp-Session-Id`) — каждый запрос самостоятельный.
- Пакеты JSON-RPC, ресурсы и промпты MCP, `structuredContent`.
- Выбор пространств и прав при подключении через OAuth: доступ — всё, что можете вы, через инструменты MCP.
- Подключение без браузера (device flow).

## Проверка эндпоинта

В репозитории есть скрипт `tools/mcp-smoke.sh` (`initialize` → `tools/list` → `find`; токен берёт из `CALAB_BOT_TOKEN` и не печатает). То же вручную:

```sh
export HOST=app.example.com CALAB_BOT_TOKEN=calab_bot_…
call() { curl -sS "https://$HOST/api/mcp" -H "Authorization: Bearer $CALAB_BOT_TOKEN" -H 'Content-Type: application/json' -d "$1"; echo; }
call '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
call '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find","arguments":{"q":"","kind":"boards"}}}'
```

Ожидаемо: `initialize` отвечает `serverInfo.name = "calab"`, `tools/list` — девятнадцать инструментов, `find` — список `boards` (или `{"found":0}`, если бот не видит досок). Проверьте отказы: без заголовка — `401`, с токеном человека — `403`.

Чтобы подключить MCP-клиент (MCP Inspector, Claude Desktop или другой), выберите транспорт Streamable HTTP (название настройки у клиентов разное), укажите адрес `https://<хост>/api/mcp` и заголовок `Authorization: Bearer <токен бота>`; после подключения клиент должен показать девятнадцать инструментов. Где именно клиент хранит настройки — в его собственной документации.
