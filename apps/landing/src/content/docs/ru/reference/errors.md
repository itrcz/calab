---
title: Коды ошибок
description: Все значения ErrorCode REST API с HTTP-статусами, частые значения reason и где искать ошибки OAuth и SSO.
order: 3
---

Каждый ответ REST не из диапазона `2xx` несёт тело `ApiError { code, message, field?, reason?, used?, limit? }`. Ветвитесь по `code` и `reason`; `message` — только для логов. Как обрабатывать ошибки в боте — [Ошибки и лимиты](../bots/errors-limits).

Ошибки протокола OAuth (`invalid_grant`, `invalid_client` и другие) имеют формат RFC 6749 — см. [OAuth: ошибки](../oauth/errors). Ошибки входа через SSO — [SSO: диагностика](../sso/troubleshooting).

## ErrorCode

| `code` | HTTP | Значение |
|---|---|---|
| `ERROR_CODE_INTERNAL` | 500 | внутренняя ошибка сервера |
| `ERROR_CODE_BAD_REQUEST` | 400 | битое тело или параметры запроса |
| `ERROR_CODE_VALIDATION` | 422 | запрос корректен, но значение поля неверно; `field` — какое |
| `ERROR_CODE_UNAUTHENTICATED` | 401 | нет токена, он неверный, истёк или отозван |
| `ERROR_CODE_FORBIDDEN` | 403 | вход выполнен, но не хватает права; `reason: "BOT_NOT_ALLOWED"` — маршрут только для людей |
| `ERROR_CODE_NOT_FOUND` | 404 | объекта нет — или он скрыт от вызывающего |
| `ERROR_CODE_CONFLICT` | 409 | конфликт: уникальность, лимит, состояние; подробности в `reason` |
| `ERROR_CODE_RATE_LIMITED` | 429 | превышен лимит частоты; заголовок `Retry-After` — через сколько секунд повторить |
| `ERROR_CODE_INVALID_CREDENTIALS` | 401 | вход не удался |
| `ERROR_CODE_INVALID_REFRESH_TOKEN` | 401 | refresh-токен неизвестен, истёк или использован повторно |
| `ERROR_CODE_REGISTRATION_CLOSED` | 403 | регистрация только по приглашению |
| `ERROR_CODE_INVITE_INVALID` | 404 / 410 | приглашение неизвестно, истекло или исчерпано |
| `ERROR_CODE_FILE_TOO_LARGE` | 413 | файл больше допустимого |
| `ERROR_CODE_FILE_QUOTA_EXCEEDED` | 413 | исчерпана квота хранилища пространства (`used` / `limit` в байтах) |
| `ERROR_CODE_PAYLOAD_TOO_LARGE` | 413 | тело запроса слишком велико |
| `ERROR_CODE_UNAVAILABLE` | 503 | временный сбой — повторите позже |
| `ERROR_CODE_ROOM_FULL` | 409 | голосовая комната заполнена (`used` / `limit`) |
| `ERROR_CODE_WORKSPACE_LIMIT` | 409 | достигнут предел пространств на владельца |
| `ERROR_CODE_STORAGE_FULL` | 507 | заполнено хранилище всего сервера |
| `ERROR_CODE_EMAIL_NOT_VERIFIED` | 403 | почта аккаунта не подтверждена |
| `ERROR_CODE_CODE_INVALID` · `ERROR_CODE_CODE_EXPIRED` | 422 | неверный или истёкший код из письма |
| `ERROR_CODE_NOT_PAIRED` | 409 | распознавание записей не подключено в пространстве |
| `ERROR_CODE_ALREADY_RECORDING` | 409 | комната уже записывается |
| `ERROR_CODE_RECORDING_LIMIT` | 409 | на сервере идёт максимум одновременных записей |
| `ERROR_CODE_WORKSPACE_SUSPENDED` | 403 | пространство приостановлено: писать нельзя, читать можно |
| `ERROR_CODE_BANNED` | 403 | вызывающий забанен в пространстве |
| `ERROR_CODE_INVITE_EMAIL_MISMATCH` | 403 | приглашение отправлено на другой адрес |
| `ERROR_CODE_FILE_GONE` · `ERROR_CODE_ALREADY_UPLOADED` | 409 | повторная выгрузка записи невозможна |
| `ERROR_CODE_BOT_BLOCKED` | 403 | человек заблокировал бота |
| `ERROR_CODE_BUSY` · `ERROR_CODE_IN_CALL` · `ERROR_CODE_CALL_NOT_ACTIVE` | 409 | звонки один на один (не для ботов) |
| `ERROR_CODE_SESSION_REVOKED` | 401 | сессия человека завершена; `reason` — почему |
| `ERROR_CODE_EVENT_OVER` | 410 | ссылка ответа на встречу после её окончания |
| `ERROR_CODE_INVITE_NOT_YET_VALID` | 409 | гостевая ссылка встречи ещё не действует |
| `ERROR_CODE_NO_COMMON_HOURS` | 409 | у людей не пересекаются рабочие часы в окне подбора времени |
| `ERROR_CODE_TEMP_ROOM_LIMIT` | 409 | предел временных комнат (20 на пространство или 5 на создателя, `reason: "PER_USER"`) |
| `ERROR_CODE_ROOM_ARCHIVED` | 410 | временная комната в архиве: читать можно, писать нельзя |
| `ERROR_CODE_SIP_DISABLED` | 409 | телефония выключена в пространстве |
| `ERROR_CODE_SIP_CALL_ACTIVE` | 409 | в комнате уже идёт телефонный звонок |
| `ERROR_CODE_SIP_NUMBER_NOT_ALLOWED` | 422 | номер вне разрешённых префиксов (`field: "number"`) |
| `ERROR_CODE_SIP_RATE_LIMITED` | 429 | 20 звонков в час на пространство |
| `ERROR_CODE_SIP_PROVIDER_ERROR` | 502 | провайдер телефонии отклонил настройки |
| `ERROR_CODE_SSO_REQUIRED` | 403 | пространство требует вход через SSO |
| `ERROR_CODE_IDENTITY_SCOPE_DENIED` | 403 | сессия не даёт доступа к этому пространству |
| `ERROR_CODE_DIRECTORY_ACCESS_DENIED` | 403 | каталог закрыл доступ участнику |
| `ERROR_CODE_RECOVERY_ONLY` | 403 | сессия восстановления: разрешены только действия по восстановлению SSO |
| `ERROR_CODE_IDENTITY_CONFIG_CHANGED` | 409 | настройки identity изменились — перечитайте и повторите |
| `ERROR_CODE_IDENTITY_NOT_LINKED` | 409 | аккаунт не связан с корпоративной учётной записью |
| `ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE` | 503 | провайдер SSO или каталог недоступен |
| `ERROR_CODE_RECENT_AUTH_REQUIRED` | 403 | нужна повторная аутентификация — см. [SSO: повторная аутентификация](../sso/reauth) |
| `ERROR_CODE_USERNAME_TAKEN` | 409 | никнейм занят |
| `ERROR_CODE_USERNAME_INVALID` | 422 | неверный или зарезервированный никнейм |

> [!NOTE]
> Ветвитесь по `code`, а не по HTTP-статусу: один статус объединяет много разных причин.

## Частые значения reason

| `reason` | С каким `code` | Значение |
|---|---|---|
| `BOT_NOT_ALLOWED` | `FORBIDDEN` | маршрут только для людей |
| `PLAN_LIMIT` | `CONFLICT`, `ROOM_FULL`, `FILE_QUOTA_EXCEEDED` | лимит тарифа; `used` / `limit` |
| `PLAN_LIMITS_EXCEEDED` | `CONFLICT` | смена тарифа отклонена: пространство использует больше, чем позволяет новый тариф |
| `REACTION_LIMIT` | `CONFLICT` | не больше 3 разных реакций одного участника на сообщение |
| `FEATURE_DISABLED` | `CONFLICT` | функция доски выключена; `field` — поле |
| `CHECKLIST_LIMIT` · `CHECKLIST_ITEM_LIMIT` · `BOARD_CATEGORY_LIMIT` | `CONFLICT` | 10 чек-листов на задачу · 100 пунктов в чек-листе · 50 категорий досок |
| `TASK_MILESTONE_LIMIT` · `TASK_MILESTONE_AUTO` | `CONFLICT` | 20 вех на задачу · готовность вехи считает сервер |
| `KEYBOARD_STALE` · `BUTTON_UNAVAILABLE` | `CONFLICT` | клавиатура сообщения изменилась · кнопка недоступна |
| `FORM_CHANGED` · `NONCE_CONFLICT` · `FORM_TARGET_UNAVAILABLE` | `CONFLICT` | форма изменилась · `nonce` использован для другого содержимого · статус формы удалён |
| `OWNER_ONLY` | `FORBIDDEN` | только владелец пространства |
| `MESSAGE_NOT_EDITABLE` · `NOT_FORWARDABLE` | `VALIDATION` | пересланную копию нельзя править · это сообщение нельзя переслать |
| `TASK_NOTIFY_BOT_UNAVAILABLE` | `VALIDATION` | выбранный для уведомлений бот недоступен |
| `IDENTITY_NOT_CONFIGURED` | `CONFLICT` | на сервере не настроен identity (SSO, каталог, OAuth-провайдер) |
| `ADMISSION_DECLINED` · `ADMISSION_QUEUE_FULL` | `RATE_LIMITED` | гостю отказали недавно · ждут уже 50 гостей |
