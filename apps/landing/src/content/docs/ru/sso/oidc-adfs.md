---
title: AD FS 2019+
description: Подключение Active Directory Federation Services к пространству Calab по OpenID Connect с PKCE S256.
order: 5
---

AD FS подключается по OpenID Connect. Поддерживаются только **AD FS 2019 и новее**: в более старых версиях нет PKCE `S256`, без которого Calab не принимает вход. Общие требования — на странице [OpenID Connect](./oidc-generic).

## Что важно заранее

| Требование | Как проверить |
|---|---|
| AD FS 2019+ | `https://adfs.example.com/adfs/.well-known/openid-configuration` содержит `"code_challenge_methods_supported"` со значением `"S256"`. Если списка нет или в нём нет `S256`, проверка подключения и вход не пройдут |
| Публичный адрес или разрешение оператора | AD FS во внутренней сети доступен Calab, только если оператор разрешил его URL (см. [для операторов](./operators)) |
| `auth_time` в ID token | Обязателен, как у всех провайдеров |
| Аутентификация клиента | `client_secret_post` — Calab выбирает её для AD FS автоматически |

Issuer у AD FS обычно `https://adfs.example.com/adfs` — проверьте поле `issuer` в discovery и скопируйте его посимвольно.

## Шаг 1. Группа приложений в AD FS

В оснастке «AD FS Management»:

1. «Application Groups» → «Add Application Group».
2. Шаблон «Server application» (конфиденциальный клиент с секретом). Name — например, `Calab`.
3. Запишите **Client Identifier**.
4. Redirect URI — `https://id.example.com/api/auth/sso/callback/<connection-id>`. ID подключения появится после шага 2; адрес можно добавить позже в свойствах приложения.
5. «Generate a shared secret» — скопируйте секрет, его покажут один раз.
6. Убедитесь, что приложению разрешён scope `openid`.

## Шаг 2. Подключение в Calab

Настройки пространства → «Настройка SSO» → «SSO-подключение»:

| Поле | Значение |
|---|---|
| «Название» | Например, «Вход через AD FS» |
| «Провайдер» | «AD FS 2019+» |
| «Issuer URL» | Значение `issuer` из discovery, например `https://adfs.example.com/adfs` |
| «Client ID» | Client Identifier |
| «Секрет клиента» | Shared secret |

«Сохранить». Возьмите `connection.id` из `GET /api/workspaces/{workspace_id}/identity` и добавьте адрес возврата в AD FS.

<!-- screenshot: identity/connection-adfs -->

## Шаг 3. Привязка, проверка, активация

1. «Привязать корпоративный вход» — привяжите свою учётную запись.
2. «Проверка и активация» → «Проверить вход в браузере».
3. В течение 5 минут — «Активировать проверенное подключение».

## Каталог

AD FS отвечает только за вход. Чтобы Calab узнавал об отключённых учётных записях и выходе из групп, подключите [каталог](./directory) — тот же Active Directory по LDAPS.

> [!NOTE]
> Связь «учётная запись AD FS ↔ аккаунт Calab» и связь «объект каталога ↔ участник» независимы. Первую делает сам сотрудник при привязке, вторую — владелец по `objectGUID`.

## Частые ошибки

| Симптом | Причина |
|---|---|
| Проверка сразу заканчивается ошибкой | В discovery нет `S256` (AD FS старше 2019) или `issuer` не совпадает с введённым |
| AD FS показывает ошибку адреса возврата | Адрес возврата в AD FS не совпадает с адресом подключения |
| «identity access denied» после входа | Нет `auth_time` в ID token, неверный секрет, или вход выполнен не той учётной записью, что привязана |

Больше — в [диагностике](./troubleshooting).
