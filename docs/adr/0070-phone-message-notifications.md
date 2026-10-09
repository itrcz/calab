# ADR-0070. Телефон: сообщения push через общую web-сессию

Статус: принято для локальной реализации (2026-10-02). Дополняет ADR-0067/0069.

## Решение

- Общий renderer остаётся владельцем экранов, маршрутизации, auth и медиа. Опциональная
  `platform.notifications` расширяет тот же document/sequence канал R04. Разрешение Live
  Activities не влияет на notifications. Android capability выключена; старые host и обычный
  веб используют прежний путь.
- До RN WebView проверяет основной фрейм, точный origin, текущий документ и экземпляр WebView.
  Нативный consumer повторно проверяет document до и после async permission/token callbacks.
  Авторизация Calab не попадает в натив. Expo app-delegate subscriber принимает APNs callbacks;
  чужой UserNotifications delegate не заменяется, capability в таком случае unavailable.
- `CALAB_IOS_PUSH_ENVIRONMENT=development|production` явно включает Info.plist конфигурацию и
  запрос `aps-environment` при будущей сборке. Без настройки permission/token capability
  unsupported; ошибка APNs registration тоже даёт безопасный fallback. Default build без
  настройки APNs остаётся запускаемым. Entitlement не подменяется и не удаляется
  для обхода подписи.
- Переиспользованы server registry, bounded fanout/retry, provider clients и auth revocation.
  Новой refresh/session системы нет. Endpoint привязан к текущей сессии, установке, token и
  версии; повторная регистрация идемпотентна. Logout/revocation удаляет endpoint, регистрация и
  отправка требуют свежей DB-сессии. Providers APNs/FCM отсутствуют без полного env/file конфига;
  в R05 входящие события только сообщения, calls/VoIP capability не выдаётся.
- Send-time policy использует общие notification levels, DND, mute/block/access и дополнительный
  существующий renderer gate `(DM/mention && notifyMentions) || notifyAll`. Настройки передаются
  с endpoint; смена preference/token обновляет версию, выключение alerts отзывает endpoint.
- Push payload содержит opaque binding/event/expiry и общий локализованный текст, без комнаты,
  сообщения, участников, credentials или URL. Foreground APNs alert подавлен: обычный renderer
  остаётся владельцем звука/alerts.
- Tap разрешается `POST /api/me/push-resolve` под существующей web-сессией: сервер проверяет
  текущую привязку, доставленную unexpired receipt, версию и свежий доступ. Затем используется
  существующий `openRoom`, отдельной native таблицы маршрутов нет. Чужой/устаревший reference
  не открывает экран. Native сохраняет cold tap через status probes/reload и удаляет только
  после успешного authenticated resolve/ack или logout; неуспешный resolve можно повторить.
- Logout revoke очищает pending tap до вращения shared document. Pagehide/reload отзывает
  document authority без семантики logout. Поздние callbacks старой сессии не регистрируют и
  не открывают экран; переключение настроек в той же сессии не теряет in-flight endpoint.

## Ворота

R05 Swift/APNs hooks и WidgetKit скомпилированы в Release без ошибок; доставка на устройстве
ещё не проверена. Development APS profile и matching локальная подпись подтверждены отдельно.
Для реальной доставки нужны
APNs-capable профиль и matching Apple team/key/bundle, `PUSH_APNS_KEY_FILE`, `PUSH_APNS_KEY_ID`,
`PUSH_APNS_TEAM_ID`, `PUSH_APNS_APP_ID`, `PUSH_APNS_ENVIRONMENT`, серверная миграция и публикация
web/server. FCM серверу нужны `PUSH_FCM_SERVICE_ACCOUNT_FILE`, `PUSH_FCM_PROJECT_ID`,
`PUSH_FCM_APP_ID`; Android host остаётся выключенным до эквивалентной native границы.
Matching APNs provider key ещё нужен; web/server/migration не опубликованы.
Источники/checks не доказывают native isolation или provider delivery;
[сценарий устройства](../mobile/message-notifications-testing.md),
[deployment contract](../mobile/push-deployment.md). R06 calls опт-ин описан в ADR-0071.

## Интеграция identity (R07)

Registry маршруты имеют local-account scope; workspace_sso, recovery и bot не
регистрируют endpoints и не открывают receipts. Worker и resolver используют
точную session identity и общий workspace evaluator с актуальным SSO assurance,
directory/access state; source locks идут workspace → user → membership → session.
Proof другой сессии того же пользователя не заменяет proof endpoint-сессии.
Внешний SSO adapter телефона пока отсутствует; enforced SSO parity остаётся gate.

## Permission and local test correction (2026-10-09)

The shared renderer remains the only settings/onboarding UI. Returning local-account
users get the native permission prompt after login, in the foreground, once onboarding
is complete and no voice/call is active. Only `notDetermined` may prompt. New users
keep the existing explanatory notification step; visiting it records that permission
was offered, so choosing Later is respected. A per-device preference records this
offer; denial is never re-prompted. Guests, bots and non-local authorities do not prompt.

`notificationsTestVersion: 1` adds an optional `test(body)` capability. Its bounded
operation carries only localized sample text (1–512 characters), no URL or auth data,
over the existing verified main-frame/origin/document/sequence channel. A separate
reply returns `scheduled | denied | unsupported | failed`; it cannot alter a push
registration or resolve a message. Old binaries show an update hint instead of calling
the unavailable browser Notification constructor. Web/Electron keep their browser path.

iOS checks document authority before and after asynchronous work, requires foreground
and authorization, and schedules one immediate local notification with a fixed title
and identifier. Only this local test can show a foreground banner; remote foreground
APNs remain suppressed to avoid duplicate alerts. A test proves local permission and
presentation, not server/APNs delivery. No server API, migration, auth or billing changes.

Acceptance: default/denied/granted, skipped onboarding, background and stale-session
prompt guards; bounded bridge payload, old-host fallback and revoke/timeout replies;
test results do not reach push-state subscribers; shared permission UI reflects native
state; iOS compilation plus device banner check. A new web deployment and native build
are needed for the complete fix. Existing TestFlight review is not changed by this work.
