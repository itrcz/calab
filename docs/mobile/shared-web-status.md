# Телефон: общий веб в оболочке — статус

## R17: регистрация аудиосессии CallKit, 2026-10-08

- **На устройстве до правки:** владелец подтвердил аватары. Повтор locked answer
  дошёл до общего accept, затем завершился по 15-секундному native deadline.
  В тот же момент iOS зарегистрировала `session lookup failure for SessionID 0x0`;
  событие CallKit audio activation отсутствовало. Foreground answer без слышимого
  звука также сообщён владельцем, его причина отдельно не подтверждена.
- **Реализовано локально:** перед каждым incoming report нативный host создаёт
  shared audio session и обновляет прежнюю конфигурацию того же CXProvider по
  рекомендации Apple. Принудительной активации, увеличения таймеров, нового RTC,
  изменений общего UI/web/API нет. Timeout logs различают accept/media/audio.
- **Проверено локально:** 111 mobile tests, 5 plugin tests, typecheck, mobile lint,
  Swift readiness во всех шести порядках событий, подписанная iPhone Release.
- **Осталось:** установка и [повтор на устройстве](incoming-calls-testing.md#audio-session-registration-regression-r17):
  foreground/locked/cold answer, двусторонний звук ≥60 с, mute/end и desktop voice.
  Сборка не доказывает устранение сбоя; обновление сервера для этой правки не нужно.

## R15: системный ответ и уведомления, 2026-10-07

- **Реализовано:** целые миллисекунды во всех native call actions; совместимый optional
  web-answer sync через CallKit; восстановление уже принятого звонка при позднем ring resolve;
  пробуждение parked gateway по новому входящему без обхода auth/READY.
- **Реализовано:** generic push для непропущенных исходов исключён на enqueue и dispatch;
  MISSED получает подпись пропущенного и communication call intent с прежним tap в историю.
  Avatar cold budget 500 мс, sender image и независимое от donation обновление notification.
- **Проверено локально:** Swift JSON → реальный TS parser, scoped answer/gateway regressions,
  push race units и PG17 push/call/device-takeover integration; типы mobile/desktop,
  обязательный `make lint`, 2652 desktop + 111 mobile тестов и 5 plugin tests; web bundle;
  iPhone arm64 Release с нулевым изменением входных файлов во время сборки.
  Независимые protocol/security review не оставили blocker/major.
- **На устройстве:** исходная доставка sender/body/caller name подтверждена владельцем до R15.
  Эта версия пока не установлена; реальные avatars и foreground/locked/cold answer с минутой
  двустороннего звука, mute и компьютер в комнате остаются непроверенными.
- **Следующий шаг:** согласованное обновление web/API и native build; схема и provider config
  прежние. Изменения пока локальные. Cold PushKit может не поднять Expo scene/WebKit;
  безопасные lifecycle logs помогают проверить эту отдельную границу, но не доказывают её.


## R14: обновление установлено на iPhone (2026-10-06)

- Общий web/API 2.4.3 с PR123 проверен на обоих production origins. Native Release
  собрана от того же тега с исправлением подписи NSE: Communication Notifications
  остаётся у приложения, расширение использует обычный профиль (ADR-0072).
- Проверено: 110 mobile unit и 5 plugin tests, mobile typecheck, root `make lint`,
  два независимых review без blocker/major, signed Release без drift исходников.
  Подпись и профили приложения и обоих расширений действительны для устройства.
- На устройстве: обновление установлено поверх прежнего приложения без удаления;
  запуск подтверждён, процесс Calab остаётся активным после запуска.
- Осталось проверить на устройстве: отправитель/текст/аватар и группировка push,
  личный предпросмотр и настройки iOS, системный ответ/mute, locked/cold audio,
  входящий звонок при активном голосовом подключении на компьютере. Установка
  не является подтверждением этих сценариев. Новые серверные настройки не нужны.

## R13: один личный предпросмотр (2026-10-06)

- Последнее решение: [PR123](https://github.com/itrcz/calab/pull/123#issuecomment-6018296941).
  Один общий переключатель «Предпросмотр сообщений», включён по умолчанию. Выключение
  скрывает только текст; имя, аватар и название комнаты остаются. Звонки сохраняют
  имя и аватар звонящего. Видимость на экране блокировки регулирует iOS.
- Убраны принудительная настройка пространства, её API/UI, столбец из ещё не выпущенной
  миграции 00070 и запрос общего пространства. Сохранены серверное применение личного
  выбора на каждой отправке/повторе и совместимость со старыми настройками звука.
- Проверено локально: root make lint (Go vet/integration vet, golangci, workspace ESLint),
  make gen без drift, desktop typecheck, 40 locale/search tests, push unit/race
  и все PG17 TestPush* integration/race (24.897 с). Два независимых security/protocol
  review без blocker/major. Полный серверный набор выполняет CI на обновлённом PR.
- На устройстве: не проверено. Остаются подписанная сборка с Communication Notifications,
  avatars/grouping, iOS When Unlocked/Never, системный ответ/mute и locked/cold audio.
  Эта правка не означает готовность к merge или новый deploy/install.

## R12: замечания к PR (2026-10-06, политика заменена R13)

- Реализовано: общий переключатель скрытия текста push и принудительное правило
  пространства. Сервер проверяет настройки перед каждой отправкой/повтором; имена и
  аватары остаются. Старые клиенты не сбрасывают выбор при замене настроек звука.
  Для личных сообщений действует самое строгое правило общего пространства.
- Исправлено: переход из доставленного сообщения после включения DND/отключения
  уведомлений комнаты. Текущие права, сессия, удаление и срок остаются обязательными.
- Проверено локально: PG17 push integration с race, повтор privacy-кейсов после
  исправления тестового маршрута, push unit/race, desktop typecheck и locale/search
  unit, root make lint. Два независимых security/protocol review без blocker/major.
  Ручной QA общего интерфейса на 390/960 px: docs/mobile/qa (mock data, не устройство).
  Требуется миграция 00070 и общий web/API release; итоговый PR CI отдельный gate.
- На устройстве: новая версия пока не проверена. Требуются web/API release,
  новые native signing profiles и контролируемая установка для проверки звонков/аватарок.

## R11: аватарки и соседние сценарии уведомлений (2026-10-06)

- Реализовано: avatar JPEG только текущего отправителя после проверки доступа; ограничение
  размера и fallback на текст. Communication Notifications extension без сети/credentials;
  группировка сообщений по чату, account-scoped person IDs. CallKit получает непустой handle
  и incoming intent с картинкой, без ожидания загрузки или изменения звонка. Logout удаляет
  donated interactions этого приложения.
- Локально проверено: push unit/race и PG17 push integration, mobile unit/plugin tests,
  typecheck, Swift payload tests. iOS Release собрана; NSE executable, entry point и
  intent activity types присутствуют, native inputs без drift. Два независимых ревью
  без blocker/major. Эта сборка ещё не подписана новым профилем и не установлена.
- Проверка на телефоне: пока не выполнена. CallKit не предоставляет поле аватарки звонящего;
  передача INPerson image не гарантирует фото на каждом системном экране iOS.
- Осталось перед установкой: новая native сборка с Communication Notifications и отдельным
  extension/profile, затем реальные previews/grouping, звонок и locked/cold audio.
- Ограниченная ревизия: routing/expiry, отключённые уведомления/Focus, foreground без второго
  звука, logout, accept/end/mute и старые payloads покрыты существующими и целевыми checks.
  Badge unread counter, быстрый ответ из push и callback из системной истории ещё не реализованы;
  отдельный API/состояние не добавлялись ради видимости готовности. Native Android incoming/push
  и SSO остаются прежними отдельными gates полного продукта.

## R10: стандартные сценарии после ревизии (2026-10-06)

- **Реализовано:** системный mute/unmute через общий voice service и обратная синхронизация
  с CallKit; действия ограничены текущим принятым звонком, сессией и document. Moderator mute
  сохраняется, timeout одной команды не завершает разговор. Capability добавлена к bridge v1:
  прежние host/web сохраняют answer/end, старый web не получает неизвестных mute actions.
- **Реализовано:** новые message tap routes живут до семи дней после пяти минут dispatch,
  только после подтверждения приёма provider; transport deadline не продлён. Retention
  ограничен 2048 обычными receipts, старейшие завершённые сообщения уступают место новым.
  Logout очищает доставленные уведомления приложения; reload не очищает. APNs registration
  retry после ошибки разрешён на foreground/user trigger с cooldown 15 с, без polling.
- **Проверено локально:** workspace tests (desktop 2610, mobile 110, protocol 439, bot 30,
  два plugin tests), отдельные тесты совместимости; push unit/integration с race;
  Swift retry policy, typecheck, web build без Electron, generation без drift.
  Physical-iOS Release скомпилирована без ошибок и изменения native inputs.
  Два независимых review приняли исправленную дельту без blocker/major.
- **Осталось:** PR CI и согласованный web/API release, затем новая установка и одна device
  проверка сценариев из `incoming-calls-testing.md` / `message-notifications-testing.md`.
  Cold locked answer, системный mute и двустороннее audio на этой версии ещё не проверены.
  Новых migrations, ключей или provider env для R09/R10 не требуется.

## R09: исправления после первого push-теста (2026-10-06)

- **Проверено владельцем на iPhone:** сообщения push доставляются, системный экран
  входящего звонка появляется. Обнаружены generic text/name, сброс через 10–15 с после
  системного ответа при desktop в комнате, возможный повторный ответ в приложении.
  Это обновляет исторические R05–R07 отметки ниже; успешный locked answer ещё не доказан.
- **Реализовано локально:** имя/текст APNs после текущей проверки доступа, имя CallKit;
  независимые факты web connection / accept / audio activation; настройка voice audio
  session перед CallKit fulfil; request budget начинается при выполнении очередного action; обе кнопки ответа используют
  один общий запрос, ACTIVE требует подтверждённого ответа на accept текущего web document;
  native deadline действует и при начатом из веба запросе.
  Контракт: [ADR-0072](../adr/0072-phone-notification-previews.md). Без нового UI/auth/RTC.
- **Проверено локально:** regression очереди воспроизведена на прежнем коде и проходит
  после исправления; 49 targeted web/call unit; Swift readiness во всех шести порядках;
  push provider units и PG17 push/identity + call integration; отдельный desktop-room →
  phone-call handover, late desktop leave и прежние other-device сценарии проходят.
  Physical-iOS Release собирается с APS development, PushKit и WidgetKit без input drift.
- **Reviews:** два независимых security/protocol review; найденные major исправлены,
  финальная дельта принята без blocker/major. Весь desktop unit: 2591; mobile 109,
  protocol 439, bot SDK 30 и два plugin tests; targeted Go push/identity с race проходят.
  `make lint`, typecheck и web build/bundle check проходят. Native сборка подписана
  и проверена, 63 входных файла совпадают с текущими исходниками; пока не установлена.
- **Осталось:** web/API release и установка новой native сборки; затем превью после
  Face ID, системный answer без второго нажатия,
  desktop-room handover, повторная блокировка и двусторонний звук дольше 30 с.
  Cold terminated/locked web bootstrap остаётся отдельным непроверенным случаем.
  Local build и server tests не заменяют device evidence.


## R07: интеграция с текущим main (2026-10-05)

Ветка включает pinned main `969bd18fb873218e53518b09c6059c1e6c1c4630`.
Общий web остаётся источником UI/auth/RTC; Expo добавляет только OS capabilities.
Unpublished mobile migration перенумерована в `00068_mobile_push.sql`, mobile ADR
в `0067`–`0071`, чтобы сохранить main identity/boards историю `00055`–`00067` и ADR `0054`–`0064`.

Push endpoints классифицированы в новой identity/bot route inventory. Registry
разрешён только local-account сессии. Фоновая доставка и tap проверяют точную
session authority, актуальный workspace SSO assurance и managed directory через
общий identity evaluator под canonical source locks. Proof другой сессии того же
пользователя не разрешает push. Disabled transport остаётся недоступным.

Внешний SSO/login/step-up/link/test в phone host пока возвращает unavailable до
создания flow: строгий origin WebView и Safari не разделяют callback/cookie context,
готового native handoff adapter нет. Это открытый full-parity/release gate для
SSO-enforced пространств; allowlist и iframe/session безопасность не ослаблены.
Обычный password login, web SSO и desktop handoff сохраняют общий код.

Проверки исходников R07: `make gen` без drift, `make lint`, workspace typecheck/tests
прошли. Vitest: desktop 2529, mobile 109, protocol 439, bot SDK 30; два mobile plugin
теста. Targeted push + mutation census `-race` и 27 web bridge/identity тестов прошли.
Web build и проверка отсутствия Electron, bot SDK build и static landing build прошли.
R07 physical-iOS arm64 Release локально скомпилирована и подписана; проверены
signature, APS `development`, WidgetKit, UIScene и background `audio, voip`, без drift
нативных входов. Новая сборка не установлена: телефон остаётся на прежней версии.
Go unit `-race` прошёл. PostgreSQL 17 integration checkpoint завершён с recovery:
последовательный `internal/app` получил default timeout 10 минут после 241 теста,
на начале `TestUserNotes` (0 с), без предшествующих assertion failures. По тому же
`go -list` порядку, без shuffle и `t.Parallel`, выполнены только 109 оставшихся тестов:
PASS за 238.359 с; завершённый prefix не повторялся. Остальные server packages PASS.
Исходная полная команда имеет exit 1 (timeout); это не замаскировано как зелёный
монолитный прогон. Обязательный GitHub CI использует отдельные app shards.
Два независимых security/protocol review не нашли blocker/major.
R01–R06 ниже — исторические результаты своих исходников, не доказательство сборки
после main merge.
Production publish/migration, установка R07, APNs send, locked answer и
двусторонний звук R07 **UNVERIFIED**. Статус: локальный integration checkpoint для
review и согласованных тестов, не release approval. Операторский путь и gates:
[push-deployment.md](push-deployment.md).


Обновлено 2026-10-02 (R04 собрана и установлена; R05/R06: Release скомпилирована и
подписана; установка R06 требует разрешения владельца; реальная доставка и разговор ещё
не проверены). Решения:
[ADR-0067](../adr/0067-phone-shared-web-host.md), [ADR-0068](../adr/0068-phone-file-downloads.md),
[ADR-0070](../adr/0070-phone-message-notifications.md),
[ADR-0071](../adr/0071-phone-incoming-calls.md).

## Контракт общего UI

- Экраны, навигация, переводы и бизнес-правила живут только в `apps/desktop/src/renderer`:
  браузер, Electron и телефон работают на одном коде. На телефоне это тот же MobileShell.
- Обычной фиче не нужны нативный код и пересборка телефона, если возможности оболочки не
  меняются: она появляется после перезагрузки страницы.
- Feature-код не обращается к нативному слою. Общие платформенные операции идут
  через слой `platform`.
- R04 добавляет только опциональный status-only канал для основного документа точного origin
  ([ADR-0069](../adr/0069-phone-session-activity.md)). Сторонние iframe не получают authority;
  Android channel выключен. Передачу файла из `<a download>` своего blob: в лист «Поделиться»
  на iOS по-прежнему решает натив по признакам WebKit (ADR-0068).

## Реализовано (исходники)

| Что | Где |
|---|---|
| Expo 57 / RN 0.86.3 / React 19.2.3 + `react-native-webview` 13.16.1 (с патчем, ниже). Без expo-router, dev-client и LiveKit/WebRTC; один локальный Expo pod для ActivityKit/UserNotifications/PushKit/CallKit | `apps/mobile/package.json` |
| Origin из `EXPO_PUBLIC_CALAB_URL`: только https, без пути и учётных данных. Некорректный роняет `expo config`/prebuild, отсутствующий даёт экран конфигурации в приложении | `src/config.js`, `app.config.ts` |
| Постоянная сессия: не incognito, cookie и хранилище не очищаются. «Повторить» пересоздаёт WebView поверх той же сессии | `src/App.tsx` |
| Экран «Повторить» при ошибке сети, 5xx, уходе с origin и смерти процесса страницы. После загрузки потерю сети обрабатывает сам веб-клиент | `src/hostState.ts` |
| Политика навигации: точный origin; сторонний https только в доказанном iframe приложения (iOS), без идентичности фрейма (Android) — только наружу; внешние ссылки; блокировка схем, включая blob: | `src/navigation.ts` |
| Android «назад» листает историю WebView, без неё срабатывает системное поведение | `src/App.tsx` |
| iOS: usage strings микрофона, камеры и добавления в Фото («Сохранить изображение» в листе). Без них приложение аварийно завершается. Android: `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA` | `app.config.ts` |
| iOS: жизненный цикл сцен (без него на SDK Xcode 27 приложение падает при запуске на iOS 27). Штатный опт-ин SDK 57: `expo-build-properties` 57.0.22, `ios.enableSceneSupport` | `app.config.ts` |
| iOS: скачивание (ADR-0068). `<a download>` blob: из основного фрейма точного origin превращается в WKDownload: файл пишется потоком в `tmp` приложения, затем открывается лист «Поделиться», после закрытия файл удаляется. iframe, http(s) и прочее идут прежним путём (блок). Веб не менялся: чат (файл, лайтбокс, плеер), CSV досок и расшифровка записи используют тот же путь | `patches/react-native-webview@13.16.1.patch` |
| iOS: `UIBackgroundModes: [audio]` — только объявление. Без него WKWebView глушит микрофон приложения вне переднего плана (WebKit bug 226620). Ранняя активация AVAudioSession, «тихий» звук для удержания и нативное медиа не добавлялись. R06 явно включает PushKit/CallKit и `voip` только в calls-опт-ин | `app.config.ts` |
| Общий веб: движок без `setSinkId` (WebKit без выбора вывода у элемента) — звук идёт на выход, выбранный ОС. Смена устройства и `devicechange` больше не дают отказ промиса, mute/deafen переприменяются. Удалённый звук — по-прежнему `<audio>` | `apps/desktop/src/renderer/lib/media/remoteAudioOut.ts` |
| R05: уведомления о сообщениях через тот же native-проверенный канал, независимо от разрешения Live Activities. APNs token/permission остаются в нативном capability; регистрация и разрешение opaque tap — под существующей web-сессией. Без настройки подписи/provider capability недоступна | `src/notifications.ts`, `CalabMessageNotificationsModule.swift`, `renderer/services/hostNotifications.ts`, `internal/push` |
| Metro привязывает React к 19.2.3 из `apps/mobile` (в корне воркспейса 19.3 для десктопа) | `metro.config.js` |

Проверки исходников (не устройство):

- `vitest`, `tsc`, `eslint` в `apps/mobile`; `expo config`; `expo export` для iOS и Android
  (одна копия React 19.2.3, origin подставлен).
- По исходникам react-native-webview 13.16.1 сверено: `onHttpError` срабатывает только для
  основного фрейма; `originWhitelist` работает только в JS; жест для новых окон проверяет только
  блокировщик движка; WKDownload нет. На Android `DownloadListener` отклоняет blob:.
- По исходникам WebKit: blob-загрузка пишется в файл в сетевом процессе блоками по 512 КБ
  (`NetworkDataTaskBlob`).
- Нативный патч скачивания скомпилирован в локальной Release R03; реальные действия с файлами ещё не наблюдались.
- `RemoteAudioOut`: unit-тесты на элемент без `setSinkId` (`setSink('')` и выбранный id, новый
  элемент, смесь с поддерживающим элементом). На прежнем коде они падают с `TypeError`.
  Поддерживает ли WKWebView iOS 27 `setSinkId`, не проверялось.
- `expo prebuild --no-clean`: в `Info.plist` есть `UIBackgroundModes = [audio]`, манифест сцен с
  `EXExpoAppSceneDelegate` и `NSPhotoLibraryAddUsageDescription`.

## Проверено на устройстве

- iPhone, iOS 27, SDK Xcode 27, Release, локальная подпись:
  - R01 собран, подписан и установлен. Первая сборка падала при запуске до JS: не был принят
    жизненный цикл сцен. Исправлено конфигом.
  - Пересобранная R01 запускается, процесс после старта не падает.
  - Со слов владельца (iPhone, iOS 27.0, исправленная R01): открывается привычный интерфейс
    Calab, вход выполнен, все разделы работают. Это наблюдение владельца, не прогон по сценарию.
  - Со слов владельца: шумоподавление в целом работает. Это наблюдение владельца, не контролируемая акустическая проверка.
  - Уведомления о сообщениях и индикатор комнаты на блокировке ещё не наблюдались: общий веб R04/R05/R06 не опубликован, реальная APNs-доставка ещё не проверена.
- Не проверено: сессия после принудительного завершения; двусторонний звук, громкая связь и
  звук в фоне. Release с R02/R03 собран, подписан, установлен и запущен; процесс после запуска остаётся жив. Реальные скачивания и фоновый разговор ещё не наблюдались.
- Исправление `RemoteAudioOut` есть только в репозитории. Установленная сборка грузит
  развёрнутый сайт: исправление дойдёт до телефона после деплоя веба, без пересборки.
  `UIBackgroundModes = [audio]` уже присутствует в установленной R03; поведение аудио в фоне ещё не наблюдалось.

## Осталось

- **iOS, устройство:**
  - сессия после принудительного завершения процесса;
  - комнаты и ЛС, текст, фото и файл через `<input type=file>`;
  - клавиатура, safe areas;
  - сторонняя ссылка в верхнем фрейме уходит в Safari, iframe стороннего приложения грузится на
    месте.
- **iOS, скачивание (R02):**
  - файл из чата → лист → «Сохранить в Файлы»;
  - картинка из лайтбокса → «Сохранить изображение»;
  - закрытие листа без действия;
  - CSV доски;
  - большой файл (сотни МБ);
  - двойной тап — открывается один лист;
  - `<a download>` из стороннего iframe ничего не открывает.

  Тост веба «скачано» появляется до выбора в листе: так же, как в браузере.
- **Android — ворота открыты, к релизу не готов.**
  - Библиотека не передаёт фрейм и через 250 мс без ответа JS разрешает загрузку.
    POST-переходы не проходят через решение.
  - Нужны нативная проверка origin основного фрейма (fail-closed при тайм-ауте и для POST) и
    проверка на устройстве, в том числе со сторонним приложением пространства в iframe.
  - Скачивание blob: на Android не работает (ADR-0068).
  - Edge-to-edge может не сообщать `env(safe-area-inset-*)`.
  - Объём Android сохраняется.
- **R02 + R03:** реальные действия с файлами и фоновый разговор на устройстве; сборка/установка уже выполнены.
- **Звук на iOS — не доказан.** Объявление фонового аудио — необходимое условие, не
  доказательство. Нужны на двух устройствах: двусторонний разговор, громкая связь и
  эхоподавление, RNNoise, mute/deafen, Bluetooth, звук и микрофон при блокировке и в фоне.
  Затем выбор владельца медиа.
- **Реализовано в исходниках:** CallKit/PushKit R06, Live Activity R04 и сообщения push R05; открытые ворота указаны ниже. Android Telecom не реализован.
- Вложение задачи доски (`/api/files/{id}` в новом окне) не открывается нигде, в том числе в
  браузере: маршрут требует Bearer (docs/09 #161).
- Статус-бар зафиксирован светлым (веб по умолчанию тёмный). Под светлую тему его переключит
  будущий адаптер `setTheme`.
- «Назад» на Android не закрывает шторки веба: веб не пишет history. Нужен адаптер.
- Иконка 1024 px, splash, версия и номер сборки для магазинов.

## R04: нативная сборка установлена, фактическая Live Activity ещё не наблюдалась

- Опциональная `platform.sessionActivity` получает статус из существующих web voice/session stores;
  экранов, auth refresh и медиа-контроллера в host не добавлено. Контракт: [ADR-0069](../adr/0069-phone-session-activity.md).
- iOS native проверяет основной фрейм, точный origin и текущий document ID до RN; версии,
  размеры, sequence и поколения проверяются дополнительно. Logout меняет document ID.
  Android не получает канал. Native consumer игнорирует поздний teardown другого WebView.
- Локальный Expo module и текстовый WidgetKit extension: общий Calab status, mute, ru/en,
  без комнат/участников/кнопок и без App Groups/APNs. В активной сессии heartbeat 30 с;
  staleDate/deadline 90 с, idle таймеров нет. ActivityKit не удерживает аудио.
- Проверки: mobile protocol/lifecycle unit tests, общая projection/fallback unit tests,
  typecheck/lint и prebuild. Extension создан один раз, два Swift source, без entitlements;
  local module обнаружен Expo autolinking. Полная Release R04 скомпилирована без ошибок,
  приложение и встроенный WidgetKit extension подписаны и установлены. После запуска на iPhone
  процессы приложения и extension остаются живы. Это подтверждает запуск, а не видимую Live Activity;
  frame/generation изоляция на реальном WebKit ещё не проверена.
- Нативная R04 установлена; для фактической activity нужен обновлённый общий размещённый веб.
  Сейчас веб R04 не опубликован. [Сценарий устройства](session-activity-testing.md).
- Нормальный locked-screen звонок предполагает поступление snapshots от WKWebView/RN.
  Если ОС приостановит JS, статус станет stale через 90 с; фоновое обновление lease и восстановление
  после возврата требуют наблюдения. Не считать это проверкой background audio или push.

## R05: сообщения push в исходниках

- **Implemented:** переиспользован серверный session-bound registry и ограниченная доставка через
  APNs/FCM. R05 отдельно обслуживает сообщения; R06 добавляет выключенный по умолчанию VOIP опт-ин. На отправке
  заново проверяются сессия, доступ, DND, блокировки, room/workspace mute/levels и существующие
  `notifyMentions`/`notifyAll`. Provider без полного конфига отсутствует.
- **Implemented:** iOS сообщает permission/token через общий R04 channel. Только основной фрейм
  точного origin и текущий document; Android capability выключена. Натив не хранит Calab auth.
  Обычный веб и старый host сохраняют прежнее поведение. Foreground APNs alert подавлен, звук
  остаётся у общего renderer. Tap содержит opaque binding/event/expiry; текущая web-сессия
  разрешает его сервером и открывает существующую комнату. Reload сохраняет pending tap до
  успешного resolve/ack; logout очищает его и серверные endpoints, поздние callbacks отвергаются.
- **Source checks:** focused mobile/web lifecycle и серверные push integration с race, типы,
  обязательный `make lint`, proto/SQL codegen. Реальных provider sends не было.
- **Compiled:** R05 Swift/APNs hooks и WidgetKit скомпилированы в Release без ошибок;
  source hashes не изменились во время сборки. **Device verified:** доставка R05 не проверена;
  прежние наблюдения UI/шумоподавления не являются проверкой push.
- **Todo:** применить R06 WebView patch при будущей сборке, проверить native frame/old-document
  isolation, cold tap, logout/account switch и реальную доставку
  по [сценарию](message-notifications-testing.md). Сборку/подпись/установку ведёт стенд-агент.
- **External:** подтверждены действительный corporate APS development profile и локальная
  Apple Development identity для устройства. Default build без env всё равно unsupported.
  Matching APNs provider key/config, миграция и публикация web/server ещё нужны; ключ другой
  Apple team не подходит. Production authorization отсутствует; реальных provider sends не было.

## R06: Release собрана и подписана, установка ожидает разрешения владельца

- Native receiver стартует через Expo subscriber до React scene; немедленный CallKit report,
  immutable report tickets, bounded ring/action/audio deadlines, duplicate UUID, opaque binding.
  Общий web auth/calls/voice остаётся единственным владельцем бизнес-состояния и RTC.
- VOIP endpoint требует native capability и серверный `PUSH_VOIP_ENABLED`; default/Android
  unavailable. Message preferences независимы, текущие session/access/DND/call state проверяются
  заново. Delivered receipt race повторяется bounded resolve под тем же auth, без ослабления gates.
- Source regressions: native-channel parser/expiry/queue, READY wait, revoked session, late accept,
  account switch, delayed provider receipt, cancellation/answered elsewhere/DND и локальный
  provider opt-in. Проверки R06 и обязательные проверки из корня прошли. Общая web-сборка прошла,
  включая проверку отсутствия Electron в bundle. Независимое security review не нашло blocker/major.
- **Compiled:** native iPhone Release `web-r06-01` завершилась с exit 0, без ошибок;
  хеши исходников не изменились во время сборки. Подтверждена corporate development подпись
  основного приложения и встроенного WidgetKit extension; APS environment приложения `development`.
  В собранном приложении проверены `ExpoUIScene`, `UIBackgroundModes = [audio, voip]`,
  встроенный WidgetKit extension и включённые push development/calls capabilities.
- **Installation:** установка поверх прежнего приложения отклонена из-за различия
  application-identifier prefix прежней personal team и новой corporate подписи. Прежнее
  приложение на iPhone сохранено. Замена или удаление требуют явного разрешения владельца.
- **Device unverified:** реальная APNs-доставка, CallKit ring, answer на заблокированном
  телефоне и двусторонний звук ещё не проверены.
- Cold locked PushKit launch может не создать Expo scene/единственный Host: этого исходники
  не доказывают. Если Host/READY не появятся до deadline, answer завершится неуспешно.
  Второй WebView или native auth/media не добавлены. Нужен точечный device spike и затем
  двусторонний звук/CallKit activation на блокировке, [сценарий](incoming-calls-testing.md).
- Добавлен read-only [push compose overlay](push-deployment.md), обычный deployment выключен.
  Публикация web/server/migration ещё не выполнена и ожидает явного разрешения владельца.

## Внешние зависимости

- Подпись Apple, устройство, `pod install`, сборка и установка — у владельца и стенд-агента,
  локально и вне репозитория.
- Привязка к проекту EAS — через локальный `.env` (`CALAB_EXPO_OWNER`, `CALAB_EAS_PROJECT_ID`).
  Платные облачные сборки не используются.
- `X-Frame-Options`/CSP сайта не мешают: WebView грузит сайт как верхний документ.
- Патч react-native-webview применяет `pnpm install` (`pnpm.patchedDependencies`). При
  обновлении библиотеки его нужно пересмотреть.

## Локальная сборка

```
corepack pnpm install                      # применяет patches/react-native-webview@13.16.1.patch
cd apps/mobile && cp .env.example .env     # заполнить origin и идентификаторы
npx expo prebuild --platform ios --no-clean --no-install   # SDK 57 без --no-clean пересоздаёт ios/
npx expo run:ios --configuration Release --device
```
