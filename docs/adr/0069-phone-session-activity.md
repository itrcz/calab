# ADR-0069. iOS: статус текущей голосовой сессии через ActivityKit

Статус: принято для локальной реализации (2026-10-02). Дополняет ADR-0067, п. 5.

## Решение

- Общий renderer остаётся единственным UI и владельцем голосовой/auth-сессии. Сервис
  `hostActivity` проецирует существующие `useVoice` и `useSession`; он не управляет медиа.
  Опциональная `platform.sessionActivity` отсутствует в браузере, Electron и старых host.
- Контракт v1 (`shared/hostActivity.ts`): локальная генерация, connected/reconnecting/ended,
  mute и ru/en фактического языка UI (остальные языки пока en). Никаких токенов, Calab ID,
  названий комнат/участников, путей или содержимого. Неизвестные поля/версии и сообщения
  свыше 2048 символов отвергаются; native также ограничивает UTF-8 размер 2048 байт.
- До передачи в RN патч WebView требует `WKScriptMessage.frameInfo.isMainFrame`, точный https
  origin `securityOrigin`, request URL и текущего WKWebView URL относительно `source.uri`.
  URL из RN event не является доказательством. Hello дополнительно проверяет случайный ID
  текущего основного документа через native `evaluateJavaScript`; завершение сверяет native
  эпоху и объект WebView. Навигация, смена source, смерть процесса и удаление WebView отзывают
  полномочия до RN. Native ActivityKit consumer привязан слабой ссылкой к объекту выдающего
  WebView и игнорирует поздний отзыв другого экземпляра.
- RN проверяет схему, поколение remount, порядок сообщений и поколение голосовой сессии.
  Logout/revocation отзывает authority и меняет случайный document ID даже без перезагрузки
  страницы: старые hello/ack/snapshot не могут вернуть её. Android channel выключен полностью
  до реализации эквивалентной native границы. Main-frame-only injection лишь объявляет
  возможность, безопасность обеспечивает native проверка.
- Локальный Expo module + текстовый WidgetKit extension используют одну Swift Attributes
  декларацию, которую plugin копирует в extension. `expo-widgets` 57 требует App Group для
  своего shared-storage runtime, поэтому здесь он не используется. App Groups, APNs, push
  token, новые signing grants и нативное auth-хранилище не нужны. Extension ID выводится из
  настроенного bundle ID; подпись extension проверяется отдельно при сборке.
- На Lock Screen / Dynamic Island только общий Calab voice status и mute, без кнопок.
  Подключение показывается только при connected; reconnecting обозначено явно. Выход,
  disconnect/blocked, logout/revocation и teardown завершают activity. Восстановление host
  удаляет оставшиеся activity прежнего процесса.
- Только во время connected/reconnecting отправляется снимок раз в 30 с и при изменении
  значимых полей. Level/speaking ticks не создают снимков. Idle таймеров нет. Каждый снимок
  задаёт `ActivityContent.staleDate` через 90 с; stale view просит открыть Calab для проверки
  связи. Native имеет один отменяемый deadline на тот же срок и завершает activity, когда
  процесс может исполниться. При убийстве/приостановке stale display обеспечивает ОС;
  немедленное удаление процессом тогда невозможно. Это не удержание аудио в фоне.

## Ворота проверки

- Обновление обычного размещённого веба обязательно: текущий сайт ещё не публикует snapshots,
  один новый бинарник не создаст activity. Нужен контролируемый preview и отдельный web deploy.
- JS/projection тесты и prebuild не доказывают native изоляцию или работу на устройстве.
  Нужны сборка/подпись extension, iframe/old-document/remount пробы и сценарий ниже.
- В нормальном заблокированном звонке обновления предполагают работающие WKWebView и RN.
  Если ОС остановит JS, через 90 с статус станет устаревшим. Фоновое обновление lease нужно
  наблюдать в живом звонке; возврат в приложение должен восстановить актуальный статус.
  ActivityKit не доказывает background audio, AEC, push или CallKit.

Источники: [Apple ActivityKit](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities),
[Expo config plugins](https://docs.expo.dev/config-plugins/plugins/).
