---
title: Вебхуки
description: Вебхук бота с подписью sha256 и вебхук доски с подписью v1 и событиями task.* — настройка, формат, проверка подписи, повторы.
order: 19
---

В Calab два вида вебхуков:

| | Вебхук бота | Вебхук доски |
|---|---|---|
| Кто настраивает | сам бот, своим токеном | человек с `MANAGE_BOARD` на доске и `MANAGE_INTEGRATIONS` в пространстве |
| Тариф | любой | Business и выше |
| Что приходит | события сообщений, реакций, задач, встреч, кнопок, уведомлений — то же, что в gateway | каждое изменение задач одной доски: `task.*` |
| Формат тела | `BotWebhookUpdate` (protojson, lowerCamelCase) | `BoardWebhookEvent` (protojson с именами полей proto, snake_case) |
| Подпись | `X-Calab-Signature: sha256=<hex>` | `X-Calab-Signature: v1=<hex>` с меткой времени |

## Вебхук бота

Вместо gateway — или вместе с ним — сервер может присылать боту события по HTTPS. Удобно для serverless: боту не нужен постоянный процесс.

### Настройка

```sh tab="curl"
curl -s -X PUT $CALAB/api/bots/me/webhook \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"url\": \"https://bot.example.com/calab\", \"secret\": \"$WEBHOOK_SECRET\"}"
```

```js tab="JavaScript"
await bot.webhook.set('https://bot.example.com/calab', process.env.WEBHOOK_SECRET);
```

- `url` — только `https://` на публичный адрес: частные сети, `localhost` и приватные диапазоны IP отклоняются.
- `secret` — от 16 до 256 символов. Храните его отдельно от токена.
- Ответ — `{ "webhook": { "url", "enabled", "disabledAt", "failingSince", "lastOkAt", "lastError", "pending" } }`.
- `GET /api/bots/me/webhook` — текущее состояние, `DELETE` → `204` (очередь сбрасывается).

### Какие события приходят

- `messageCreate`, `messageUpdate`, `messageDelete`, `messageReactionAdd`, `messageReactionRemove` — комнат, которые бот видит, и его DM. **Кроме** собственных сообщений и реакций бота. Команды — как в gateway, в `message.command`.
- `taskCreate`, `taskUpdate`, `taskDelete`, `taskActivity` — досок, которые бот видит.
- `eventCreate`, `eventUpdate`, `eventDelete`, `eventRsvp` — как в gateway: внешние адреса только боту, который может менять встречу.
- `workspaceMemberUpdate`.
- `botCallback` — нажатия кнопок под сообщениями бота (см. [Команды и кнопки](./commands-buttons)).
- `taskNotice` — уведомления людей, выбравших этого бота (см. [Уведомления о задачах](./task-notices)).

События голоса (`voiceStateUpdate` и другие) приходят **только** через gateway.

### Запрос

```http
POST /calab HTTP/1.1
Host: bot.example.com
Content-Type: application/json
User-Agent: CalabBot-Webhook/1.0
X-Calab-Delivery: 0192c4a0-…
X-Calab-Signature: sha256=5d2f…c41a
```

```json
{
  "id": "0192c4a0-…",
  "botUserId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
  "createdAt": "2026-10-14T10:05:00Z",
  "event": {
    "messageCreate": {
      "workspaceId": "0191f0c2-0000-7000-8000-00000000a001",
      "message": {
        "id": "0192c3f0-…",
        "roomId": "0191f0d4-0000-7000-8000-00000000b001",
        "authorId": "0191f0c2-7a10-7d3e-9b11-5c2f8e4a6d01",
        "content": "/ping",
        "command": { "botUserId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b", "name": "ping", "args": "" }
      }
    }
  }
}
```

Тело — `BotWebhookUpdate { id, botUserId, createdAt, event }`, где `event` — тот же `DispatchEvent`, что в gateway.

### Проверка подписи

`X-Calab-Signature` = `sha256=` + hex(HMAC-SHA256(secret, тело)). Считайте HMAC над **сырыми байтами** тела, а не над пересобранным JSON, и сравнивайте за постоянное время.

```js tab="JavaScript"
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret, rawBody, header) {
  const want = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}
```

```python tab="Python"
import hashlib, hmac

def verify(secret: bytes, raw_body: bytes, header: str) -> bool:
    want = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, header or "")
```

В SDK: `new Bot(token, { server, webhookSecret })` и `bot.handleWebhook(rawBody, headers)` — проверяет подпись, отбрасывает повторы и генерирует те же события `message` / `command` / `reaction` / `callback`, что и gateway. Отдельно — `verifyWebhookSignature(secret, rawBody, header)`.

```js tab="JavaScript"
import { createServer } from 'node:http';
import { Bot } from '@calaba/bot-sdk';

const bot = new Bot(process.env.BOT_TOKEN, { server: 'https://app.example.com', webhookSecret: process.env.WEBHOOK_SECRET });
bot.on('command', (c) => bot.reply(c, 'pong'));

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    res.statusCode = bot.handleWebhook(Buffer.concat(chunks), req.headers) ? 204 : 401;
    res.end();
  });
}).listen(8080);
```

### Доставка и повторы

- Успех — любой `2xx` за 10 секунд. Редиректы не выполняются и считаются ошибкой.
- Повторы: через 1 мин, 2, 4 … до 1 часа между попытками; доставка живёт сутки.
- Вебхук, который ошибается целые сутки, **отключается**: `webhook.disabledAt`, очередь сбрасывается, владелец бота и управляющие получают `botUpdate`. `PUT` включает его снова.
- Порядок не гарантирован, повторы возможны — дедуплицируйте по `id`. Отвечайте быстро, работу делайте после ответа.

## Вебхук доски

Доска отправляет JSON на ваш HTTPS-адрес при каждом изменении её задач. Это не вебхук бота: один вебхук на доску, все изменения задач, без фильтра событий. Подходит для синхронизации с трекерами, BI и CRM.

> [!NOTE]
> Вебхук доски настраивают **только люди**: он хранит секрет и выгружает данные доски. Бот получает `403 BOT_NOT_ALLOWED`. Нужны `MANAGE_BOARD` на доске и `MANAGE_INTEGRATIONS` в пространстве, тариф Business и выше (ниже — `409 CONFLICT`, `reason: "PLAN_LIMIT"`). Вебхук принадлежит доске, а не создателю: его видит и меняет любой с `MANAGE_BOARD`.

### Маршруты

| Метод | Путь | Что делает |
|---|---|---|
| `PUT` | `/api/boards/{id}/webhook` | создать, заменить или включить отключённый: `{url, secret?}` |
| `GET` | `/api/boards/{id}/webhook` | состояние: `url`, `hasSecret`, `enabled`, `disabledAt`, `failingSince`, `lastOkAt`, `lastError`, `pending`, `pausedReason` |
| `DELETE` | `/api/boards/{id}/webhook` | удалить → `204`, очередь помечается `failed` |
| `POST` | `/api/boards/{id}/webhook/ping` | синхронно отправить событие `ping` → `{ok, status, error}`; не чаще раза в 10 с (`429`) |

`url` — только `https://` на публичный адрес. `secret` — от 16 до 256 символов; пусто — сервер сгенерирует 32 случайных байта (base64url) и вернёт `secret` **один раз** в ответе. Потом секрет не возвращается никогда.

### События

| `type` | Когда |
|---|---|
| `task.created` | задача создана |
| `task.updated` | любое изменение: поля, статус, исполнители, связи, вложения, согласование, чек-листы, вехи, Git-связи |
| `task.archived` · `task.restored` | задача в архиве · восстановлена (автоархив — `actor: null`) |
| `task.moved_in` | задача пришла с другой доски (у неё уже новый ключ) — на доску-получатель |
| `task.moved_out` | задача ушла на другую доску — на доску-источник |
| `task.comment.created` · `task.comment.updated` · `task.comment.deleted` | комментарии |
| `ping` | проверочное событие |

Изменения одной транзакции — одно событие. `changes` — записи журнала задачи: `field` — вид записи (`status`, `assignees`, `checklist`, `milestones`, `git` …), `before` / `after` — её данные. Изменения, сделанные **правилом автоматизации**, приходят отдельным событием той же транзакции с `"actor": null` и `"rule": {"id", "name"}`; у изменений людей и ботов `rule` — `null`. Git-события (связи задачи с ветками и pull request) — это `task.updated` с `changes[field=git]` и `"actor": null`.

### Запрос

| Заголовок | Значение |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Calab-Webhook/1.0` |
| `X-Calab-Webhook-Version` | `1` — контракт только расширяется новыми полями |
| `X-Calab-Event` | `type` события |
| `X-Calab-Delivery` | id доставки (= `id` в теле) |
| `X-Calab-Timestamp` | Unix-время отправки в секундах |
| `X-Calab-Signature` | `v1=<hex HMAC-SHA256(secret, timestamp + "." + тело)>` |

### Формат тела

`BoardWebhookEvent` в protojson, но с **именами полей proto (snake_case)**, а не lowerCamelCase, как в REST. Все поля присутствуют: незаданные — `null` (`actor: null` для серверных изменений, `edited_at: null`), пустые строки и списки — как есть; `uint64` (например, `size` вложения) — **строка**, `sequence` — число. `task` — задача без данных зрителя (`subscribed`, `muted`, `unread`, `viewer_state` — всегда по умолчанию), `attachments` и `checklists` всегда пусты (счётчики `attachment_count`, `checklist_total` / `checklist_done` остаются), вехи (`milestones`, `milestone_progress`, `task_milestone_id`) — как есть; `comment` — только у `task.comment.*`. Ссылка на задачу — `task_url`.

Пример (поля по алфавиту; чтобы показать и `changes`, и `comment`, они собраны вместе — в настоящем `task.updated` поле `comment` равно `null`):

```json
{
  "actor": { "id": "0192a000-0000-7000-8000-0000000000cc", "is_bot": false, "name": "Анна" },
  "board": { "id": "0192a000-0000-7000-8000-0000000000bb", "key": "FNG", "name": "Финансы" },
  "changes": [
    {
      "after": { "status_id": "s2", "status_type": "started" },
      "before": { "status_id": "s1", "status_type": "unstarted" },
      "field": "status"
    }
  ],
  "comment": {
    "attachments": [{ "mime": "application/pdf", "name": "a.pdf", "size": "1024" }],
    "author_id": "u1",
    "created_at": "2026-10-02T12:00:00Z",
    "edited_at": null,
    "id": "m1",
    "text": "готово"
  },
  "id": "0192a000-0000-7000-8000-000000000001",
  "occurred_at": "2026-10-02T12:00:00Z",
  "rule": null,
  "sequence": 42,
  "task": {
    "approval_required": 0,
    "approval_state": "TASK_APPROVAL_STATE_UNSPECIFIED",
    "approvers": [],
    "archived_at": null,
    "assignees": [],
    "attachment_count": 0,
    "attachments": [],
    "board_id": "0192a000-0000-7000-8000-0000000000bb",
    "checklist_done": 3,
    "checklist_total": 7,
    "checklists": [],
    "comment_count": 0,
    "completed_at": null,
    "completed_by": "",
    "created_at": "2026-10-02T12:00:00Z",
    "created_by": "",
    "description": "",
    "due_on": "",
    "estimate": 3,
    "git_links": [],
    "git_links_count": 0,
    "id": "0192a000-0000-7000-8000-0000000000dd",
    "key": "FNG-12",
    "label_ids": [],
    "milestone_id": "",
    "milestone_progress": null,
    "milestones": [],
    "muted": false,
    "number": 12,
    "parent_id": "",
    "position": 0,
    "priority": "TASK_PRIORITY_HIGH",
    "relations": [],
    "room_id": "",
    "start_on": "",
    "started_at": null,
    "status_id": "s2",
    "subscribed": false,
    "subtask_count": 0,
    "subtask_done": 0,
    "task_milestone_id": "",
    "title": "Отчёт",
    "unread": false,
    "updated_at": "2026-10-02T12:00:00Z",
    "viewer_state": false,
    "workspace_id": ""
  },
  "task_url": "https://app.example.com/t/FNG-12",
  "type": "task.updated",
  "version": 1,
  "workspace_id": "0192a000-0000-7000-8000-0000000000aa"
}
```

`task.moved_out` несёт только то, что знала доска-источник: в `task` — лишь `id`, старый `key` и `board_id` источника, `changes` — одна запись `moved_board` с `before`. Задача целиком (новый ключ, статусы и метки получателя) приходит в `task.moved_in` доски-получателя.

### Проверка подписи

HMAC считается над `timestamp + "." + сырые байты тела`. Отклоняйте запрос, если `|сейчас − timestamp| > 5 минут` (защита от повтора), и сравнивайте подписи за постоянное время.

```js tab="JavaScript"
import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody — сырые байты тела (Buffer), headers — заголовки в нижнем регистре
export function verifyBoardWebhook(secret, rawBody, headers, now = Date.now() / 1000) {
  const ts = headers['x-calab-timestamp'];
  if (!ts || Math.abs(now - Number(ts)) > 300) return false; // окно ±5 минут
  const want = Buffer.from('v1=' + createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex'));
  const got = Buffer.from(headers['x-calab-signature'] ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}
```

```python tab="Python"
import hashlib, hmac, time

def verify_board_webhook(secret: bytes, raw_body: bytes, headers: dict, now: float | None = None) -> bool:
    ts = headers.get("X-Calab-Timestamp", "")
    if not ts.isdigit() or abs((now or time.time()) - int(ts)) > 300:  # окно ±5 минут
        return False
    mac = hmac.new(secret, ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v1=" + mac, headers.get("X-Calab-Signature", ""))
```

В SDK: `verifyBoardWebhook(secret, timestamp, body, signature)` проверяет подпись и окно ±5 минут, `parseBoardWebhookEvent(body)` разбирает тело.

### Доставка

- **Как минимум один раз**: повторы возможны, порядок прихода не гарантирован. Идемпотентность — по `id` (запоминайте увиденные), порядок — по `sequence` (монотонно на доску, с 1; у `ping` — 0).
- Успех — любой `2xx` за 10 секунд, редиректы — ошибка. Принимайте тела до 256 КБ.
- Повторы: через 1 мин, 2, 4 … до 1 часа, доставка живёт сутки. Вебхук, который ошибается сутки подряд, **отключается** (`enabled: false`, очередь сбрасывается); `PUT` включает его снова.
- **Пауза по тарифу**: когда тариф опускается ниже Business, вебхук сохраняется, но встаёт на паузу (`pausedReason = PLAN`) — новые события не копятся; после повышения тарифа доставка продолжается с новых событий.
- Архивная доска доступна только на чтение и событий не порождает; уже накопленная очередь доставляется.

> [!NOTE]
> События комментариев ставятся в очередь **после** фиксации сообщения: если процесс сервера упадёт ровно между этими шагами, событие потеряется. Окно редкое; события изменений задач пишутся в той же транзакции и не теряются.
