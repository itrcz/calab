# Push: передача оператору

Исходники подготовлены локально для review. Этот документ не подтверждает публикацию,
миграцию production, APNs-доставку или ответ на заблокированном телефоне.
Конфигурация и ключи передаются оператору отдельно, вне публичного репозитория.

## Релиз в текущий Kubernetes

Основной путь: согласованный commit в `main` → тег `vX.Y.Z` → зелёный
[ci.yml](../../.github/workflows/ci.yml) на этом SHA →
[images.yml](../../.github/workflows/images.yml) → GitHub Deployment `calab-prod` →
consumer кластера. `images` принимает обычный тег из трёх чисел без prerelease,
публикует API/web по digest и передаёт оба digest в одной заявке. В web image уже
входят Caddy, конфиг «за прокси» и статика. GitHub workflow не подключается к кластеру.
SSH-доступ к compose-стенду не является условием этого production-пути.
[release.yml](../../.github/workflows/release.yml) отдельно собирает desktop-релиз;
Expo/iOS binary и push-конфигурацию этот workflow не выпускает.

Манифесты, mount, Vault и consumer живут вне репозитория. Оператор добавляет конфигурацию
в их действующий источник. В текущей схеме env синхронизируется из Vault в `calab-env`:
Secret-only значения reconciler удаляет. Не дублировать имя env в Secret и ConfigMap.
Общий контракт: [docs/06-deployment.md](../06-deployment.md#прод-kubernetes-с-2026-10-02)
и [identity preflight](../plans/identity-v2-operator-preflight.md).

## APNs: шесть переменных и файл

| Переменная API | Значение оператора |
| --- | --- |
| `PUSH_APNS_KEY_FILE` | `/run/calab-push/apns.p8` внутри контейнера |
| `PUSH_APNS_KEY_ID` | ID действующего APNs key, через Secret |
| `PUSH_APNS_TEAM_ID` | Apple team согласованной APS-enabled сборки, через Secret |
| `PUSH_APNS_APP_ID` | Точный bundle ID приложения, через Secret |
| `PUSH_APNS_ENVIRONMENT` | `production` для TestFlight/App Store; `development` только для сборки с development-подписью |
| `PUSH_VOIP_ENABLED` | `true` только для согласованной проверки PushKit/CallKit; default `false` |

Можно использовать действующий `.p8` или replacement key: он должен принадлежать
**той же Apple team** и быть разрешён для того же приложения/topic. Другой team/app
не исправляется сменой server env: потребуется новая согласованная подпись и сборка.
Перед device test проверить фактический `aps-environment` в подписи установленной
APS-enabled сборки: он определяет sandbox (`development`) или production endpoint.
TestFlight, включая публичные тестовые группы, использует `production`
([Apple: APS Environment](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment)).
Сверить его с `CalabMessagePushEnvironment` в native host, App ID и capability ответа
API. Имя Debug/Release или успешная локальная установка не заменяют эту проверку.
Если установленная сборка уже подписана правильно, смена server env не требует
новой сборки или переустановки.
Ключевые байты, Apple IDs, device tokens и signing credentials не помещать в git/логи.

Пример фрагмента Pod spec, который оператор адаптирует к своему Secret и манифестам:

```yaml
spec:
  securityContext:
    fsGroup: 65532
  containers:
    - name: api
      securityContext:
        runAsUser: 65532
        runAsGroup: 65532
      env:
        - {name: PUSH_APNS_KEY_FILE, value: /run/calab-push/apns.p8}
        - name: PUSH_APNS_KEY_ID
          valueFrom: {secretKeyRef: {name: calab-push-config, key: apns-key-id}}
        - name: PUSH_APNS_TEAM_ID
          valueFrom: {secretKeyRef: {name: calab-push-config, key: apns-team-id}}
        - name: PUSH_APNS_APP_ID
          valueFrom: {secretKeyRef: {name: calab-push-config, key: apns-app-id}}
        - {name: PUSH_APNS_ENVIRONMENT, value: production}
        - {name: PUSH_VOIP_ENABLED, value: "true"}
      volumeMounts:
        - {name: apns-key, mountPath: /run/calab-push, readOnly: true}
  volumes:
    - name: apns-key
      secret:
        secretName: calab-push-key
        defaultMode: 0440
        items:
          - {key: apns.p8, path: apns.p8}
```

Файл должен реально читаться uid/gid 65532; проверить применимость `fsGroup` к
используемому Secret/CSI volume. Если драйвер не выставляет группу, оператор
обеспечивает эквивалентное owner/group read-only разрешение. Не копировать `.p8`
в image. Env выше иллюстрирует имена: при `envFrom`/Vault сохранять один источник.

Без полного APNs-конфига transport отсутствует, capability не объявляется;
частичный конфиг отклоняется при старте. FCM также отсутствует без полного набора
трёх `PUSH_FCM_*`; Android и FCM не входят в эту iPhone-проверку.
Compose overlay `infra/docker/compose.push.yml` остаётся вариантом self-host/стенда,
проверка его структуры: `docker compose -f compose.yml -f compose.push.yml config --quiet`.
Он не изменяет манифесты Kubernetes.

## TestFlight: переключение APNs с development на production

Признак несовпадения: установленная TestFlight-сборка имеет `aps-environment=production`,
а аутентифицированный `GET /api/me/push-capabilities` объявляет `development`.
Общий клиент сравнивает `appId` и `environment` с native state и при несовпадении
не регистрирует endpoint. Проверку не обходить: production-токен не подходит sandbox.
Кнопка Test notification / Show проверяет локальное уведомление, а не доставку APNs.

**Merge этого документа или обычный релиз API/web не переключает Vault.** Оператор
отдельно применяет следующий config-only change в действующем источнике конфигурации:

```diff
-PUSH_APNS_ENVIRONMENT=development
+PUSH_APNS_ENVIRONMENT=production
```

1. Сохранить предыдущую версию конфигурации. Изменить только это значение в Vault
   `kv/app/calab`, сохранив остальные поля; не заменять весь map неполным набором.
   Сохранить согласованные `PUSH_APNS_APP_ID`, team и key; отдельно проверить, что
   действующий APNs key разрешён для production и нужного topic. Не печатать ключи
   или токены в логах/PR. Несовпадение team/app требует отдельного исправления.
2. Дождаться env-sync в `calab-env` и применить обычный rollout API. Проверить
   readiness и новое значение на всех API-репликах, чтобы не осталось смешанных
   сред. Новый image/tag, миграция БД или iOS-билд для этой смены не нужны.
3. В local-account сессии на точном origin телефона проверить живой
   `GET /api/me/push-capabilities`: APNs должен объявлять правильный `appId` и
   `production`; VoIP при включённом `PUSH_VOIP_ENABLED` использует ту же среду.
   Успешный env-sync или rollout без этой проверки не подтверждает конфигурацию API.
4. Полностью закрыть и снова открыть установленный Calab из TestFlight, чтобы
   повторить регистрацию. Проверить успешную регистрацию APNs, затем свернуть
   приложение и заблокировать телефон. Отправить новое личное сообщение с другого
   аккаунта или существующего тестового бота. Подтвердить уведомление на этом iPhone
   и переход в нужную личку. HTTP 200 отправки сообщения и локальный Show не являются
   доказательством доставки. До этого результата восстановление остаётся непроверенным.

Сервер выбирает **одну среду** для APNs и VoIP: development-установки после переключения
больше не совпадают с capability. Для их проверки использовать отдельный sandbox-стенд,
не переключать production обратно во время публичного тестирования.
Откат конфигурации: восстановить предыдущее значение в источнике, дождаться env-sync,
повторить rollout и проверку capabilities. Это вернёт sandbox и остановит TestFlight
push; откат БД или приложения для такой смены не требуется.

## Миграция, проверка, откат

1. Перед разрешённым rollout: restorable PostgreSQL 17 backup, защищённая копия
   identity keyrings и версии Vault/config. Проверить restore в изолированной БД.
   Согласовать совместимые API/web digests и сохранённый rollback pair.
2. В этой ветке push schema — `00068_mobile_push.sql`, после identity/boards
   `00001`–`00067`. Goose применяет embedded migrations при старте API под advisory
   lock. Убедиться, что в целевом релизе нет другого `00068`, проверить migration
   status на всех API-репликах. Локальные тесты не подтверждают production migration.
3. После заявки `calab-prod`: проверить реальные API/web digests, readiness всех
   реплик и `/api/version` (commit/version). Consumer выкатывает компоненты
   последовательно, может оставить смешанные версии и не публикует deployment
   statuses; зелёная заявка или CronJob не доказывают rollout.
4. Origin: новая установка может использовать `https://app.calab.io`; существующий
   `https://app.calab.ru` остаётся отдельным точным origin. Не расширять native
   allowlist, iframe bridge или cookie-доступ ради алиаса. Оператор сверяет
   `PUBLIC_APP_URL(S)` и identity redirect config с нужными origin. Смена origin
   не переносит browser session автоматически.
5. Push registry разрешён только local-account сессии. Workspace message требует
   свежего допуска **этой** сессии, включая SSO assurance, directory и membership;
   dispatch и tap повторяют проверку. Scoped SSO/recovery/bot маршруты отвергаются.
   Внешний SSO/step-up в phone host пока unavailable: общего native callback
   adapter нет. Password login в обычные пространства остаётся отдельным тестом;
   доступ к enforced SSO workspace на телефоне — открытый parity gate.
6. На согласованной сборке и устройстве отдельно проверить: message APNs в фоне
   и после завершения процесса, tap в правильную сессию, stale tap после logout;
   PushKit в заблокированном состоянии, CallKit answer/decline/expiry, вход через
   общий web call flow и двусторонний звук. Не считать sandbox/build checks их
   заменой. Эти реальные проверки пока **UNVERIFIED**.

Откат: согласованный **identity-aware** API/web pair, совместимый с текущей БД,
keyrings и конфигурацией. Не перезапускать старый успешный `images` с pre-identity
binary. Для остановки calls выставить `PUSH_VOIP_ENABLED=false`; для всех APNs
убрать полный набор четырёх APNs credentials вместе. Не выполнять автоматический
Goose Down: он удалит push registry/receipts и не решает image compatibility.
Backup restore и повторный rollout требуют отдельного решения оператора.

## Notification preview / system Answer update (ADR-0072)

Deploy the matching web and API changes together through the normal release workflow.
The original answer repair needs no provider keys or environment variables. The combined
PR also requires migration 00070 for preview privacy and the R11 native profiles described below. Install the matching new phone host afterwards: it reads `callerName`,
configures CallKit voice audio and retains readiness events arriving before answer fulfilment.
The existing host can display the new APNs message previews; existing servers remain a generic
fallback for new hosts. Full answer-race repair requires the updated web, API and host.
Retest one system answer with desktop already in a room and >30 s locked two-way audio.

The same repair adds optional call-bridge microphone controls, delivered-notification cleanup on
logout and lifecycle-triggered APNs registration retry. Deploy web/API before installing the
new host; web remains compatible with the installed v1 host. Existing message receipts keep
their old expiry. New deliveries keep the five-minute transport limit and retain authenticated
tap routes for up to seven additional days (at most 2048 ordinary receipts per endpoint).
The retention change uses existing columns; no migration or provider configuration change.
Follow the updated device checklists; cold locked answer remains an unverified acceptance gate.


### R11 avatar follow-up

The same PR adds inline sender avatars and per-conversation grouping. No additional server
environment variable, migration or APNs key is required. Old phone builds show text normally.
The new phone build adds the `CalabNotificationService` extension (`<bundle>.notifications`)
and `com.apple.developer.usernotifications.communication` to the containing app only.
The notification extension uses an ordinary profile without this app-only entitlement.
Regenerate matching development profiles before signing; deploy web/API first, then install that build.
This native signing requirement is additional to the R09/R10-only update described above.
CallKit caller-photo rendering remains an explicit device check, not a server release claim.

### PR review: privacy settings

Apply migration `00070_push_preview_privacy.sql` with the API release, then deploy the
matching shared web. Message preview defaults to on. Users can turn it off in Settings →
Notifications. This hides text in room and direct-message pushes; sender name/avatar and
room name remain, and calls retain caller name/avatar. There is no workspace override.
Migration 00070 adds only the personal user column. The setting is enforced before
sending to APNs/FCM; it works with the existing installed phone. Old clients changing
audio settings do not reset it. New native installation is needed for avatars and call
lifecycle repairs, not for this privacy switch. No new server environment/secret.

Do not run Goose Down as a rollout shortcut: it discards privacy choices. A rollback to
an API without this policy can send text again. Stop message push delivery first if
rolling back the API, and have the operator explicitly assess the privacy impact.
