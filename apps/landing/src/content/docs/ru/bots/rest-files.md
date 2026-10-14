---
title: Файлы
description: Загрузка файлов в пространство, личные сообщения и задачи, скачивание и миниатюры.
order: 11
---

Файлы в Calab загружаются отдельно от сообщений: сначала файл, затем его id в `attachmentIds` сообщения или задачи. Скачивание и миниатюры требуют того же заголовка `Authorization`, что и остальной API, — публичных ссылок на файлы нет.

| Действие | Право |
|---|---|
| загрузить в пространство или личные сообщения | `ATTACH_FILES` |
| загрузить для задачи | права на задачу (`CREATE_TASKS` / `EDIT_TASKS`) |
| скачать, миниатюра | доступ к комнате, задаче или объекту, где файл используется |

## Маршруты

<!-- routes:files -->
| Метод | Путь | Что делает |
|---|---|---|
| `POST` | `/api/workspaces/{id}/files` | Загрузить файл в пространство (multipart `file`) → `{file}` |
| `POST` | `/api/dms/{id}/files` | Загрузить файл в личные сообщения → `{file}` |
| `POST` | `/api/boards/{id}/files` | Загрузить файл для описания или комментария задачи → `{file}` |
| `GET` | `/api/files/{id}` | Скачать файл |
| `GET` | `/api/files/{id}/thumbnail` | Миниатюра изображения |
<!-- /routes -->

### Недоступно ботам

`POST /api/files/convert` — преобразование HEIC в JPEG для клиентов без декодера HEIF; это служебный маршрут приложения, не часть API ботов.

## Загрузить

Ответ — `FileMeta`:

| Поле | Описание |
|---|---|
| `id` | id файла — его передают в `attachmentIds` |
| `name`, `mime` | Имя и тип (тип определяет сервер по содержимому) |
| `size` | Размер в байтах — **строка** (`uint64`) |
| `width`, `height` | Для изображений, иначе `0` |
| `sha256` | Хеш, вычисленный сервером при приёме |
| `url`, `thumbnailUrl` | `/api/files/{id}` и `/api/files/{id}/thumbnail` (только для изображений) |

```sh tab="curl"
curl -s -X POST $CALAB/api/workspaces/$WS/files -H "Authorization: Bearer $TOKEN" -F file=@chart.png
```

```js tab="JavaScript"
import { readFile } from 'node:fs/promises';

// загрузка в пространство комнаты (или в личные сообщения) и отправка одним вызовом
await bot.send(roomId, { text: 'График за неделю', files: [{ name: 'chart.png', data: await readFile('chart.png') }] });
// или только загрузка
const meta = await bot.upload(roomId, { name: 'chart.png', data: await readFile('chart.png'), type: 'image/png' });
```

```python tab="Python"
with open("chart.png", "rb") as f:
    r = requests.post(f"{CALAB}/api/workspaces/{ws_id}/files", headers=H,
                      files={"file": ("chart.png", f, "image/png")})
file_id = r.json()["file"]["id"]
```

```json
{
  "file": {
    "id": "0192b3f0-0000-7000-8000-0000000000f1",
    "workspaceId": "0191f0aa-0000-7000-8000-000000000001",
    "uploaderId": "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
    "name": "chart.png",
    "mime": "image/png",
    "size": "48213",
    "width": 1200,
    "height": 800,
    "sha256": "9f2c…",
    "url": "/api/files/0192b3f0-0000-7000-8000-0000000000f1",
    "thumbnailUrl": "/api/files/0192b3f0-0000-7000-8000-0000000000f1/thumbnail",
    "createdAt": "2026-10-14T10:00:00Z"
  }
}
```

## Скачать

```sh tab="curl"
curl -s -L -o chart.png $CALAB/api/files/$FILE -H "Authorization: Bearer $TOKEN"
```

```python tab="Python"
data = requests.get(f"{CALAB}/api/files/{file_id}", headers=H).content
```

## Лимиты

| Лимит | Значение |
|---|---|
| Загрузки бота | 30 сразу, 120 в час |
| Размер файла и квота хранилища | по тарифу пространства (`413 FILE_TOO_LARGE`, `413 FILE_QUOTA_EXCEEDED`) |
| Вложений в сообщении | ≤ 20 |

> [!NOTE]
> Файлы для значков и звуков — это обычные загрузки бота в то же пространство: сначала `POST /api/workspaces/{id}/files`, затем `fileId` в запросе. Картинки стикеров загружаются сразу в набор, см. [Стикеры](./rest-stickers).
