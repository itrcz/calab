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
| `PUSH_APNS_ENVIRONMENT` | `development` для подготовленной новой локальной development-сборки |
| `PUSH_VOIP_ENABLED` | `true` только для согласованной проверки PushKit/CallKit; default `false` |

Можно использовать действующий `.p8` или replacement key: он должен принадлежать
**той же Apple team** и быть разрешён для того же приложения/topic. Другой team/app
не исправляется сменой server env: потребуется новая согласованная подпись и сборка.
Перед device test требуется согласованная установка новой APS-enabled сборки;
старое приложение на телефоне не подтверждает эту готовность. Фактический APS entitlement
установленной для теста сборки определяет sandbox (`development`) или production endpoint;
перед тестом оператор сверяет entitlement, App ID и capability ответа API.
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
        - {name: PUSH_APNS_ENVIRONMENT, value: development}
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
No additional migration, provider keys, environment variables or Apple capability changes
are required. Install the matching new phone host afterwards: it reads `callerName`,
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
