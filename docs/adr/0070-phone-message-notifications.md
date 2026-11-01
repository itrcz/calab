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

## Android (2026-10-29)

DEV-5031/DEV-5033. Канал host включён и на Android; сообщения push идут через FCM тем же
контрактом `CalabMessageNotifications` (`pushState`, `acknowledgePush`, `testNotification`,
`onPushChanged`), что и на iOS.

- **Граница канала.** Как на iOS, она нативная и живёт в патче react-native-webview
  (`patches/react-native-webview@13.16.1.patch`) поверх origin guard DEV-5032 (ADR-0067,
  Android). WebMessageListener получает от Chromium `isMainFrame` и сериализованный
  `sourceOrigin` (`https://host[:port]`, без пути). Патч передаёт сообщение в RN, только если
  это main frame и origin **точно равен** origin приложения из manifest meta-data
  `dev.calab.mobile.WEB_ORIGIN` (`CalabOriginGuard`). Остальное отбрасывается в Java, до JS:
  чужой и same-origin iframe, main frame чужого origin, opaque `null`. Запасной
  JavascriptInterface (WebView без `WEB_MESSAGE_LISTENER`) не знает фрейма и не доставляет
  ничего: канала нет, как у старого бинарника. Main frame не может оказаться на чужом origin,
  потому что origin guard отменяет такие навигации нативно. JS-проверок фрейма и
  challenge/proof больше нет: `activityProtocol.ts` одинаков на обеих платформах и только
  сужает схему и порядок. Отличие от iOS: Android не сверяет «текущий документ» в native.
  Hello прошлого документа того же origin, пришедший после навигации, — это наш же код, а не
  чужой. RN сбрасывает протокол на каждом loadStart/remount, и новая страница при своём hello
  заново получает document authority. Native не получает auth Calab.
- **Document authority в native.** На iOS её выдаёт патч WebView (`CalabHostDocumentGranted`).
  На Android RN передаёт её модулю после hello (`setDocument(document)`) и отзывает при каждом
  loadStart/ошибке/remount/revoke (`setDocument(null, logout)`). Logout дополнительно стирает
  отложенный tap и уведомления Calab. Async-ответы перепроверяют документ, как на iOS.
- **Объявляем только реализованное.** Bridge Android: `notificationsVersion`,
  `notificationsTestVersion`, `platform: 'android'`; ack — `notifications: 1, links: 1`.
  `mediaPermissionsVersion` и `calls*` не объявляются, поэтому веб сразу идёт обычными путями
  браузера, без таймаутов. Live Activity на Android нет (capability `notifications`).
  С 2026-11-01 (доска #141) Android также объявляет `mediaSessionVersion` / ack `mediaSession: 1`:
  веб сообщает `media` (`room`/`call`/`none`), хост держит foreground service типа microphone,
  действие уведомления возвращается событием `calab-host-media` (`leave`). Полномочий у него нет:
  страница лишь выходит из своей голосовой сессии. Подробности — shared-web-status.md.
- **Ссылки.** `calab-host-link` работает и на Android: ссылка в уже открытую страницу
  открывается на месте, без remount и обрыва звонка. Remount остаётся до handshake
  (ограничение ADR-0142 для Android снято).
- **Транспорт.** Endpoint = FCM registration token, `PUSH_PROVIDER_FCM`, `environment`
  всегда `production`, `appId` = applicationId (`PUSH_FCM_APP_ID` должен совпадать с ним).
  Веб регистрирует провайдера по `state.provider` (`fcm` — аддитивное поле; без него APNs).
  FCM-сообщения только data, high priority, TTL до 10 минут (`restricted_package_name`);
  уведомление рисует модуль. Текст — только из payload сервера: для сообщений сервер теперь
  кладёт в data тот же title/subtitle/body, что и в APNs alert, после настройки превью
  ADR-0072. Без них и для task/calendar — общий «Новое сообщение». Аватар отбрасывается, если
  data превысит лимит FCM 4096 байт.
- **Foreground.** Как на iOS: общий renderer владеет звуком/alert, native ничего не показывает.
- **Tap.** Trampoline-Activity сохраняет opaque `{binding,eventId,expiresAt}` и поднимает
  задачу приложения как иконка лаунчера, не трогая intent MainActivity. Дальше — тот же путь
  iOS: `tap` в `pushState`, веб разрешает через `POST /api/me/push-resolve`, открывает комнату,
  `acknowledgePush`. Ссылка на экран есть только у message и call, как на iOS.
- **Разрешение.** Android 13+ `POST_NOTIFICATIONS` запрашивается только по запросу веба
  (тот же prompt, что и на iOS). Android не отличает «ещё не спрашивали» от «отказано»: модуль
  помнит собственный запрос, `default` — только до него. Ниже 13 — `areNotificationsEnabled`.
- **Retry.** `CalabPushRetry` повторён один в один: ошибка токена блокирует попытки на 15 с,
  снимается при явном запросе или возврате в foreground, не таймером. Ожидание токена ≤ 10 с.
  Ротация токена (`onNewToken`/`onRegistered`) отправляет новое состояние в веб, и тот
  перерегистрирует endpoint идемпотентно.
- **Сборка.** Обычный Firebase SDK (`firebase-messaging` через gradle модуля), без
  react-native-firebase. `google-services.json` — из `CALAB_ANDROID_GOOGLE_SERVICES_FILE`
  через встроенный `android.googleServicesFile` Expo. Без файла сборка проходит, default
  FirebaseApp отсутствует → `unsupported`.

Ворота: unit-тесты (протокол, состояние FCM, регистрация), `go test` push и интеграционные
`Push`, компиляция патча и Kotlin (`assembleDebug` с файлом и без), merged manifest.
Фильтр WebMessageListener в живом WebView (main frame против iframe), доставка FCM на
устройство, tap в холодном/тёплом состоянии, prompt Android 13 и время
внедрения bootstrap (Android выполняет его в `onPageStarted`, не гарантированно до скриптов
страницы — тогда канала просто нет, как у старого бинарника) **не проверены**.
Операторский контракт — [push-deployment](../mobile/push-deployment.md#fcm-android-2026-10-29).
