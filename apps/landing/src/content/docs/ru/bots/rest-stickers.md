---
title: Стикеры
description: Отправка стикеров, наборы пространства, установка наборов для бота и управление наборами.
order: 12
---

Бот отправляет стикеры как обычные сообщения, устанавливает наборы себе и — с правом `MANAGE_STICKERS` — создаёт и меняет наборы пространства.

| Действие | Право |
|---|---|
| смотреть наборы, отправлять стикеры, устанавливать наборы себе | участник пространства (не гость) |
| создавать, менять, удалять наборы и стикеры | `MANAGE_STICKERS` |

## Маршруты

<!-- routes:stickers -->
| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/workspaces/{id}/sticker-packs` | Наборы пространства → `{packs}` |
| `POST` | `/api/workspaces/{id}/sticker-packs` | Создать набор `{name, shortName}` → `201 {pack}` (`MANAGE_STICKERS`) |
| `GET` | `/api/sticker-packs/{id}` | Один набор → `{pack}` |
| `PATCH` | `/api/sticker-packs/{id}` | Изменить набор `{name?, shortName?, coverStickerId?, stickerIds}` |
| `DELETE` | `/api/sticker-packs/{id}` | Удалить набор |
| `POST` | `/api/sticker-packs/{id}/stickers` | Добавить стикеры (multipart: пары `emoji` + `file`) → `{pack, added}` |
| `PUT` | `/api/sticker-packs/{id}/stickers/{sid}` | Заменить картинку и/или emoji стикера (multipart `file`, `emoji`) |
| `PATCH` | `/api/stickers/{id}` | Изменить emoji стикера `{emoji}` |
| `DELETE` | `/api/stickers/{id}` | Удалить стикер |
| `GET` | `/api/me/sticker-packs` | Установленные у бота наборы и доступные → `{installed, available}` |
| `PUT` | `/api/me/sticker-packs/order` | Порядок установленных наборов `{packIds}` |
| `PUT` | `/api/me/sticker-packs/{id}` | Установить набор себе |
| `DELETE` | `/api/me/sticker-packs/{id}` | Удалить набор из своих |
<!-- /routes -->

Картинки встроенных стикеров отдаёт публичный `GET /api/stickers/builtin/{name}` без авторизации.

## Отправить стикер

`POST /api/rooms/{id}/messages {stickerId, nonce}` — с пустым `content` и без вложений. Стикер должен быть из набора этого пространства; в личных сообщениях — из набора пространства, где оба участника не гости.

```sh tab="curl"
curl -s -X POST $CALAB/api/rooms/$ROOM/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"stickerId\": \"$STICKER\", \"nonce\": \"st-1\"}"
```

```js tab="JavaScript"
const packs = await bot.stickers.list(wsId);
await bot.send(roomId, { stickerId: packs[0].stickers[0].id });
```

## Создать набор

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/sticker-packs -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name": "Котики", "shortName": "cats"}'        # → 201 {"pack": {…}}
curl -s -X POST $CALAB/api/sticker-packs/$PACK/stickers -H "Authorization: Bearer $TOKEN" \
  -F emoji=😺 -F file=@cat1.webp -F emoji=😿 -F file=@cat2.webp                         # → {"pack", "added": […]}
```

```js tab="JavaScript"
import { readFile } from 'node:fs/promises';

const pack = await bot.stickers.createPack(wsId, { name: 'Котики', shortName: 'cats' });
const { added } = await bot.stickers.addStickers(pack.id, [
  { emoji: '😺', data: await readFile('cat1.webp') },
  { emoji: '😿', data: await readFile('cat2.webp') },
]);
await bot.stickers.remove(added[1].id);
```

- Каждому `file` предшествует поле `emoji` (одна последовательность emoji — по ней ищут стикер).
- Файл — WebP, стороны ≤ 512 px, ≤ 512 КБ для статичного и ≤ 1 МБ для анимированного.
- До 50 стикеров за запрос, всё или ничего: ошибка в одном — `422`, `field: "file[i]"`.
- ≤ 120 стикеров в наборе; `shortName` — `[a-z0-9_]{1,32}`, уникален среди наборов пространства.
- Лимиты тарифа на число наборов и стикеров — `409 PLAN_LIMIT` с `used`/`limit`.

## Свои наборы

`GET /api/me/sticker-packs` возвращает `{installed, available}`: установленные наборы в их порядке и живые наборы пространств бота, которые он ещё не установил. `PUT /api/me/sticker-packs/{id}` ставит набор первым (не больше 50 установленных, иначе `422`); все маршруты `me/sticker-packs` отвечают тем же `{installed, available}`.
