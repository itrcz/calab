---
title: Почтовый ящик
description: Сброс пароля корпоративного почтового ящика через бота — проверить, что ящик на хостинге оператора, и выдать человеку одноразовую ссылку с новым паролем.
order: 20.5
---

На серверах Calab с почтовым хостингом — когда домен компании и ящики держит оператор — пароль ящика человеку восстанавливает бот: человек просит, бот спрашивает Calab, Calab просит хостинг завести новый пароль, и человек получает одноразовую ссылку. Маршруты открыты только ботам из списка оператора (`MAILHOST_RESET_BOTS`); на сервере без почтового хостинга оба отвечают `404`.

Адрес ящика бот не видит никогда: `hosting-check` возвращает только домен и флаги. Новый пароль бот тоже не видит — он получает лишь ссылку; пароль показывает одноразовая страница, и живёт ссылка 10 минут.

## Маршруты

<!-- routes:mailbox -->
| Метод | Путь | Что делает |
|---|---|---|
| `POST` | `/api/mailbox/hosting-check` | Ящик пользователя на хостинге оператора? → `{hosted, domain, verified}` |
| `POST` | `/api/mailbox/password-reset` | Завести новый пароль на хостинге → `{token, redeemUrl, expiresAt}` |
| `POST` | `/api/mailbox/password/redeem` | публично: одноразовая страница человека меняет токен на `{email, password}` |
<!-- /routes -->

## Проверить ящик

`POST /api/mailbox/hosting-check {userId}` — про любого пользователя сервера, общее пространство не нужно. Ответ:

```json
{ "hosted": true, "domain": "calab.io", "verified": true }
```

| Поле | Что значит |
|---|---|
| `hosted` | адрес на доменах хостинга оператора (`MAILHOST_DOMAINS`) |
| `domain` | домен адреса — домен, не сам адрес |
| `verified` | почта аккаунта подтверждена; без этого сброс вернёт `403` |

```sh tab="curl"
curl -s -X POST $CALAB/api/mailbox/hosting-check -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"userId\": \"$USER\"}"
# → {"hosted": true, "domain": "calab.io", "verified": true}
```

## Сбросить пароль

`POST /api/mailbox/password-reset {userId}` прогоняет проверки по порядку и только потом обращается к хостингу:

| Ситуация | Ответ |
|---|---|
| бот не в списке оператора | `403 FORBIDDEN` |
| пользователя нет | `404 NOT_FOUND` |
| цель — гость или бот | `403 FORBIDDEN` |
| нет общего пространства с целью | `403 FORBIDDEN` |
| почта цели не подтверждена | `403 ERROR_CODE_EMAIL_NOT_VERIFIED` |
| домен адреса не на хостинге | `422 ERROR_CODE_VALIDATION`, `field: "domain"`, `reason: "DOMAIN_NOT_HOSTED"` |
| лимит сбросов | `429` + `Retry-After` |
| ящика нет на хостинге | `404 NOT_FOUND` |
| хостинг не отвечает или злой админ-токен | `503 ERROR_CODE_UNAVAILABLE` — повторите позже |

Ответ — `{token, redeemUrl, expiresAt}`: сервер уже завёл на хостинге новый пароль и спрятал его под одноразовым токеном на 10 минут. Отправьте `redeemUrl` человеку — например, в [личные сообщения](./rest-dm).

```sh tab="curl"
curl -s -X POST $CALAB/api/mailbox/password-reset -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"userId\": \"$USER\"}"
# → {"token": "kQ…", "redeemUrl": "https://app.example.com/mail-reset/kQ…", "expiresAt": "2026-10-15T12:10:00Z"}
```

```js tab="JavaScript"
const r = await fetch(`${CALAB}/api/mailbox/password-reset`, {
  method: 'POST', headers: H, body: JSON.stringify({ userId }),
});
if (!r.ok) throw new Error(`reset: ${r.status}`);
const { redeemUrl } = await r.json();
await bot.send(dm.room.id, `Новый пароль ящика: ${redeemUrl}`);
```

```python tab="Python"
r = requests.post(f"{CALAB}/api/mailbox/password-reset", headers=H, json={"userId": user_id})
r.raise_for_status()
# отправьте ссылку человеку, например в личные сообщения
print(r.json()["redeemUrl"])
```

## Страница человека

`redeemUrl` ведёт на `/mail-reset/<token>`. Страница сама делает единственный анонимный `POST /api/mailbox/password/redeem {token}` — сервер отдаёт `{email, password}` и тут же удаляет токен. Человек видит адрес и новый пароль один раз: моноширинно, с «Скопировать» и «Открыть в Calab». Повторное открытие или истёкшая ссылка — `410 ERROR_CODE_CODE_EXPIRED`; человеку остаётся попросить бота новую. Боту этот маршрут не нужен: его вызывает страница.

## Лимиты

| Лимит | Значение |
|---|---|
| Сбросы на одного человека | 3 в час |
| Сбросы одного бота | 10 в час |
| Ссылка | одна на 10 минут, одноразовая |

> [!NOTE]
> Журнал аудита записывает кто просил (бот), для кого и когда. Ни адрес, ни пароль в журнал и в базу не попадают: пароль живёт только внутри одноразового токена до первого открытия ссылки.
