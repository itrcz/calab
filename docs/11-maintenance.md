# 11 — Сопровождение: зависимости, PR, обновления

## Dependabot: что приходит и как группируется
Конфиг в `.github/dependabot.yml`. Все экосистемы проверяются раз в неделю, у каждой не больше 5 открытых PR.

| Экосистема | Группа | Замечания |
|---|---|---|
| GitHub Actions | `actions` | экшены закреплены по SHA, в комментарии указан тег |
| Go (`apps/server`) | `gomod` | каждый PR обязан обновить `apps/server/THIRD-PARTY-NOTICES.txt`, иначе CI красный |
| npm (pnpm workspace, корень) | `minor-and-patch`, `electron`, `uiohook` | мажоры `electron` и `next` игнорируются: их поднимаем руками |
| Docker (`apps/server`, `infra/docker/caddy`) | `docker` | образы закреплены по digest; minor/major образа `golang` игнорируются (см. «Go-тулчейн») |
| docker-compose (`infra/docker`) | `docker-compose` | |

## Автомерж (`.github/workflows/dependabot-auto-merge.yml`)
На каждый PR от `dependabot[bot]` workflow читает метаданные (`dependabot/fetch-metadata`) и выбирает одно из двух:

- **Автомерж** (`gh pr merge --auto --squash`) для `semver-patch`, `semver-minor` и обновлений только digest/SHA (update-type пустой). GitHub сольёт PR сам, когда пройдут обязательные проверки.
- **`needs-review`** (метка и один комментарий, автомержа нет) в трёх случаях:
  - любой `semver-major`, включая мажоры GitHub Actions: `release.yml` в CI не гоняется, поэтому ломающие изменения в upload/download-artifact сам CI не поймает;
  - minor-бамп Docker-тега, например `golang:1.26` → `1.27`: это смена тулчейна или рантайма, а CI образы не собирает;
  - любой бамп `uiohook-napi`, см. ниже.

Для Go-PR workflow сам запускает `make third-party-notices` и пушит коммит в ветку PR. Пуш через `GITHUB_TOKEN` не запускает CI повторно, и обязательные проверки так и остались бы висеть, поэтому workflow пушит с отдельным токеном `DEPENDABOT_PUSH_TOKEN`.

**`DEPENDABOT_PUSH_TOKEN`.** Это fine-grained PAT на этот репозиторий с правом `contents: write`. Хранится в Settings → Secrets and variables → **Dependabot** (не Actions: workflow на PR от Dependabot видит только Dependabot-секреты). Исходное значение лежит в `.env` (`GITHUB_TOKEN`). После ротации или истечения PAT обновите секрет: `gh secret set DEPENDABOT_PUSH_TOKEN --app dependabot --repo itrcz/calab`. Если секрета нет или токен протух, workflow выводит предупреждение или падает на пуше, и notices обновляют руками: `make third-party-notices`, затем коммит в ветку PR.

**Защита `main`.** Обязательны все джобы `ci.yml`: `buf lint / breaking`, `generated code is up to date`, `go vet / test / lint`, `govulncheck`, `go integration tests`, `pnpm typecheck / test`, `landing lint / typecheck / build`. Ревью не требуется, ветку перед мержем обновлять не обязательно (strict выключен), админы могут обойти защиту. Если переименовали джобу в `ci.yml`, обновите список required checks (`gh api repos/itrcz/calab/branches/main/protection`), иначе автомерж зависнет. «go integration tests» — сводный джоб над шардами `go integration app-1…3/rest (PostgreSQL 18)`: шарды можно переименовывать и добавлять без правки защиты. Пуш только с `docs/**`/`*.md` CI не запускает (`paths-ignore` на `push`); на PR фильтра нет — иначе обязательные проверки docs-PR ждали бы вечно.

## Ручной разбор PR
1. `gh pr list --state open`. По каждому PR смотрим: что поднимается, откуда и куда, уровень semver, `gh pr checks <n>`.
2. Patch/minor с зелёным CI мержим (`gh pr merge --squash --delete-branch`). Если несколько PR трогают один lockfile, мержим по одному, а остальным пишем `@dependabot rebase`.
3. Для мажоров читаем release notes и changelog и ищем ломающие изменения, которые касаются нас. В PR оставляем комментарий: что ломается и что придётся поменять. Ставим метку `needs-review`.
4. Если CI красный из-за старой базы (фикс уже в `main`), пишем `@dependabot rebase` и не мержим красное.

## Что требует человека
- **Electron, мажор.** Меняются Chromium, Node ABI и V8.
  1. Поднять `electron` в `apps/desktop/package.json`. Версия закреплена точно, без `^`.
  2. `pnpm install`: postinstall пересобирает `uiohook-napi` под новый ABI. На Linux нужны X11-заголовки, как в `ci.yml`.
  3. Проверить, что патч применился: `grep VC_CAPS_LOCK_STATE node_modules/uiohook-napi/libuiohook/include/uiohook.h`.
  4. Прочитать breaking changes Electron: `contextIsolation`/sandbox, `webPreferences`, `desktopCapturer`, разрешения медиа, `safeStorage`.
  5. Проверить звонок вручную: эхоподавление (`docs/02-media.md`), push-to-talk, демонстрацию экрана.
  6. Перезаписать визуальные снапшоты: `pnpm -F @calaba/desktop e2e:visual:update`. Затем просмотреть diff глазами: снапшоты коммитятся, изменение должно быть объяснимо.
  7. Проверить подписанную сборку (`SIGN=1`) и релизный workflow.
- **Electron, minor/patch в пределах 44.x.** Мержится автоматически. Если снапшоты разъехались, перезаписать и проверить.
- **`uiohook-napi`, любой бамп.** Наш патч `patches/uiohook-napi@1.5.5.patch` (`patchedDependencies` в корневом `package.json`) привязан к версии.
  1. `pnpm patch uiohook-napi@<new>`, перенести изменения, затем `pnpm patch-commit`.
  2. Удалить старый патч.
  3. Обновить проверку `uiohook patch applied` в `release.yml`, если изменился заголовок.
  4. Пересобрать и проверить горячие клавиши на macOS, Windows и Linux.
- **`livekit-client`.** Закреплён точно (`2.22.3`, без `^`) намеренно: медиа-стек проверяется вручную. Dependabot будет предлагать каждую новую версию. Patch с зелёным CI можно брать. На minor и major смотрим changelog (изменения в `Room`/`RoomOptions`, `adaptiveStream`/`dynacast`, публикации треков, E2EE) и проверяем звонок вручную: 2–3 участника, переподключение, демонстрация экрана. Версию сервера LiveKit (`livekit/livekit-server` в compose и CI) поднимаем отдельно, сверяясь с матрицей совместимости.
- **Next.js, мажор.** `apps/landing`, static export. Поднимаем руками. Проверяем `pnpm -F @calaba/landing lint typecheck build` и наличие `apps/landing/out/index.html`, затем глазами сравниваем лендинг.
- **Go-тулчейн** (Docker `golang:*`). Dependabot предлагает только patch/digest образа `golang`: minor и major игнорируются в `dependabot.yml`. Смена версии Go — отдельный запланированный PR (ближайший — после 0.2). Поднимаем разом в трёх местах: `apps/server/Dockerfile`, `go-version` во всех джобах `ci.yml` и, при необходимости, `go` в `go.mod`. Затем проверяем, что текущая версия `golangci-lint` поддерживает новый Go.
- **Мажоры GitHub Actions.** Проверяем, что затронуто в `release.yml`: `upload-artifact`/`download-artifact` (`pattern` + `merge-multiple`, digest-проверки), `pnpm/action-setup` (версия pnpm берётся из `packageManager`).

- **GitHub Release публикует `release.sh`, а не workflow.** `release.yml` всегда создаёт черновик: при публикации релиза запушенного тега токен Actions получает 403 «Resource not accessible by integration», хотя у job `contents: write`. Похоже, токен Actions не может публиковать релиз тега, коммит которого меняет `.github/workflows`; черновик ref не трогает. Так случилось в v0.1.0.
- Черновик публикует шаг `desktop` в `infra/docker/release.sh` токеном владельца (`GITHUB_TOKEN` из `.env` как `GH_TOKEN`; в секреты репозитория не кладётся) после проверок фида: тело — секция версии из `CHANGELOG.md`. Если черновика нет, релиз создаётся из артефактов прогона. Руками: `gh release edit v<версия> --draft=false --latest`.
- Последний шаг `release.sh` — `announce`: бот (`CALAB_RELEASE_BOT_TOKEN` из `.env`) публикует в комнату «Calab - что нового? ✨» блок `### Коротко` секции версии из `CHANGELOG.md` без ссылок (нет блока — всю секцию; `tools/release-announce.py`, docs/06 «Анонс релиза»). Повтор безопасен (nonce `release-<версия>`). Если бот перестал видеть комнату или токен перевыпущен — шаг падает с HTTP-кодом; перевыпустить токен в «Настройки пространства → Боты» и обновить `.env`.

## Внешние PR
Правила в `CONTRIBUTING.md`. Главное: вклад принимается только на условиях CLA. Коммиты должны содержать `Signed-off-by:` (`git commit -s`). Без подписи PR не мержим, а просим автора подписать коммиты (`git rebase --signoff`). Для внешних PR автомерж не работает: нужно ревью человека, на UI-изменения нужны скриншоты и обновлённые визуальные снапшоты.

## Внешние PR (репозиторий публичный, 28.09)

Любой может форкнуть и открыть PR: CI (`ci.yml`) запускается на `pull_request`, для первого PR от нового автора прогон workflow требует одобрения мейнтейнера (настройка GitHub «first-time contributors»). Шаблоны: `.github/PULL_REQUEST_TEMPLATE.md` (проверки, скриншоты, чекбокс CLA), `.github/ISSUE_TEMPLATE/*`; `CODEOWNERS` назначает ревью владельцу. Процесс:
1. Триаж (агент по расписанию или по просьбе владельца): CI зелёный, чекбокс CLA отмечен, PR не трогает `.github/workflows`, `infra/`, секреты и лицензии без явного согласования — иначе комментарий с просьбой разбить.
2. Ревью кода агентом (одно; для auth/прав/токенов/протокола — второе), замечания комментариями в PR по-английски; мелочи — фиксит ревьюер коммитом в ветку PR, если автор разрешил «maintainers can edit».
3. Слияние — только владелец/лид (squash), в `CHANGELOG.md` — строка с `@автор`. Прямые пуши в `main` остаются у лида; ветки внешних авторов в `main` не пушим.
4. Сразу закрываем PR: изменения лицензии, автогенерированный код без исходного `.proto`/SQL, массовые переформатирования, PR без описания после напоминания через 14 дней.

## Ротация e2e-аккаунтов
При утечке паролей из `/opt/calaba/infra/docker/.env.accounts`: `cd apps/server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/pwhash ./cmd/pwhash && scp /tmp/pwhash root@<стенд>:/root/.calaba-hasher-tmp && ssh root@<стенд> 'chmod 700 /root/.calaba-hasher-tmp && STEPS=accounts,invite bash -s' < ../../infra/docker/tools/rotate-accounts.sh` (только инвайт — `STEPS=invite`, хэшер не нужен).
Скрипт генерирует пароли на стенде, пишет argon2id-хэш в `users`, отзывает сессии (+ маркеры `auth:revoked:*` в Valkey), меняет код инвайта `invite` одной транзакцией в `workspace_invites` (те же пространство/автор/`max_uses`/срок; через API нельзя — у `@calaba.test` не подтверждён email), переписывает `.env.accounts` (600), проверяет логин и превью инвайта (новый 200, старый 404) и печатает только `#строка ma***@домен: статус`; контейнеры не перезапускаются.

## Логи десктопа
`main.log` в `userData/logs` (macOS `~/Library/Application Support/Calab/logs/main.log`, Windows `%APPDATA%\Calab\logs\main.log`, Linux `~/.config/Calab/logs/main.log`; 5 МБ, затем `main.old.log`), краш-дампы — `logs/crashes`. Строки рендерера — с префиксом `[renderer]`: `log.warn/error` из `lib/log.ts`, `uncaught` (`window.onerror`), `unhandled rejection`, `message row render failed` (строка ленты не отрисовалась). Не больше 120 строк в минуту (сверх — одна строка «N lines dropped»), до 4000 символов на строку; текстов сообщений и токенов в логах нет — только ошибка и id. Веб — только консоль браузера. Застрявшая загрузка чата (docs/09 #146) видна как `load messages failed LoadTimeout`. Main-процесс пишет `api request timeout <method> <path>` (без query и токенов), когда `calaba-api://` упёрся в дедлайн (`apps/desktop/src/main/apiProtocol.ts`: 20 с на connect+заголовки, 30 с простоя тела) — сама по себе не инцидент, если единична; частая — признак мёртвого/сменившегося соединения к серверу. `api transport reset (<причина>)` — main закрыл все соединения к API (`main/apiTransport.ts`, docs/09 #146) и рендерер перезапросит упавшее; причины: `2 timeouts in 60 s`, `timeout while another request has no response` (залипло соединение), `power resume`, `power unlock-screen`, `network online`. После него запросы должны пойти; если `api request timeout` продолжаются и после сброса — проблема не в соединении клиента (сеть, сервер, Caddy).
