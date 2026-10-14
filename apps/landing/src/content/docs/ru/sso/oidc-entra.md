---
title: Microsoft Entra ID
description: Регистрация приложения в Entra ID, обязательный claim auth_time и подключение к пространству Calab.
order: 4
---

Microsoft Entra ID (бывший Azure AD) подключается по OpenID Connect с двумя дополнениями: issuer привязан к конкретному tenant, а `auth_time` нужно включить вручную как дополнительный claim. Общие требования — на странице [OpenID Connect](./oidc-generic).

## Что важно заранее

- **Только конкретный tenant.** Issuer URL — строго `https://login.microsoftonline.com/<tenant-id>/v2.0`. Адреса `common`, `organizations` и `consumers` не принимаются. Calab дополнительно сверяет claim `tid` в каждом ID token с указанным Tenant ID.
- **`auth_time` не приходит по умолчанию.** В Entra v2 его нужно добавить как optional claim. Без него вход отклоняется.
- **Аутентификация клиента** — `client_secret_post` (Calab выбирает её для Entra автоматически).

## Шаг 1. Регистрация приложения

В центре администрирования Microsoft Entra:

1. «App registrations» → «New registration».
2. Name — например, `Calab`. Supported account types — «Accounts in this organizational directory only» (single tenant).
3. Redirect URI — платформа «Web», адрес `https://id.example.com/api/auth/sso/callback/<connection-id>`. ID подключения появится после шага 3; можно зарегистрировать приложение без адреса и добавить его позже в «Authentication».
4. Нажмите «Register» и запишите **Application (client) ID** и **Directory (tenant) ID** со страницы «Overview».

## Шаг 2. Секрет и `auth_time`

1. «Certificates & secrets» → «New client secret». Скопируйте **Value** (не Secret ID) — его покажут один раз.
2. «Token configuration» → «Add optional claim» → тип токена **ID** → отметьте `auth_time` → «Add».

> [!WARNING]
> Без optional claim `auth_time` проверка подключения и вход сотрудников заканчиваются ошибкой «identity access denied». Сервер записывает в журнал аудита событие `auth_time_missing` — оператор найдёт его по этому подключению.

## Шаг 3. Подключение в Calab

Настройки пространства → «Настройка SSO» → «SSO-подключение»:

| Поле | Значение |
|---|---|
| «Название» | Например, «Вход через Microsoft» |
| «Провайдер» | «Microsoft Entra ID» |
| «Issuer URL» | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| «Tenant ID» | Directory (tenant) ID в каноническом виде, строчными буквами: `00000000-0000-0000-0000-000000000000` |
| «Client ID» | Application (client) ID |
| «Секрет клиента» | Value секрета из шага 2 |

«Сохранить». Затем возьмите `connection.id` из `GET /api/workspaces/{workspace_id}/identity` и добавьте адрес возврата в «Authentication» приложения Entra.

<!-- screenshot: identity/connection-entra -->

> [!NOTE]
> Tenant ID в Issuer URL и в поле «Tenant ID» должны совпадать. Если они расходятся, Calab не сохранит подключение.

## Шаг 4. Привязка, проверка, активация

Как для любого OIDC-провайдера:

1. «Привязать корпоративный вход» — привяжите свою учётную запись Entra.
2. «Проверка и активация» → «Проверить вход в браузере».
3. Не позже чем через 5 минут — «Активировать проверенное подключение».

Затем выберите режим в «Политике входа» — см. [режимы](./modes).

## Сроки секрета

У секретов Entra есть срок действия. Заведите напоминание: до истечения создайте новый секрет в Entra, введите его в «Секрет клиента» и снова проверьте и активируйте подключение. Ротация отзывает текущие подтверждения SSO — подробности в разделе [смена секрета](./oidc-generic#смена-секрета).

## Частые ошибки

| Симптом | Причина |
|---|---|
| Не сохраняется подключение | Issuer не tenant-specific, или Tenant ID не совпадает с issuer, или Tenant ID записан не в каноническом виде |
| «identity access denied» при проверке | Нет optional claim `auth_time`; адрес возврата не зарегистрирован; вход выполнен учётной записью другого tenant |
| AADSTS50011 в браузере | Адрес возврата в Entra не совпадает с `https://id.example.com/api/auth/sso/callback/<connection-id>` |

Больше — в [диагностике](./troubleshooting).
