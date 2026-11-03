# Телефон: черновики для App Store и Google Play (доска #124, #125, #127, #128)

Черновик для утверждения владельцем. Ничего не отправлено в App Store Connect / Play Console, правовые страницы лендинга не менялись. Сняты тексты и ответы анкет; каждый пункт помечен:

- **[код]** — проверено в коде или документе, путь указан;
- **[?]** — нужно подтверждение владельца или проверка на сборке.

Контекст: bundle/package `dev.calab.mobile`, оболочка = один WebView с веб-клиентом (ADR-0067), релиз — [release.md](release.md), статус — [shared-web-status.md](shared-web-status.md). Скриншоты — задача #111, ветка `feat/111-store-shots` (здесь только ссылка).

## 0. Главное: блокеры публикации

| # | Что | Почему важно | Статус |
|---|-----|--------------|--------|
| B1 | **Нет удаления аккаунта в приложении** и нет URL удаления. Регистрация есть (`POST /api/auth/register`), а `DELETE /api/me`/аналога нет, в i18n нет «Удалить аккаунт» (поиск по `apps/server/internal`, `apps/desktop/src/renderer/i18n`). | Apple 5.1.1(v): приложение с созданием аккаунта обязано давать удаление внутри приложения. Google Play: то же + обязательный «URL удаления аккаунта» в Data safety. Вероятный отказ в обоих магазинах. | [код] нужна задача: экран «Настройки → Аккаунт → Удалить аккаунт» + эндпоинт + страница-инструкция для Play |
| B2 | **В приложении нет ссылок на Политику конфиденциальности и Условия.** `AuthLegalFooter` (`apps/desktop/src/renderer/features/legal/Legal.tsx`) показывает только «© GPTunneL · Powered by», «Лицензия» (BUSL) и «Сторонние компоненты» — модальные окна с лицензионным текстом. | Apple 5.1.1(i) и Play: ссылка на политику внутри приложения и в карточке магазина. | [код] добавить две ссылки в футер входа и в «Настройки → О программе» (см. §2.4) |
| B3 | ~~**Нет пользовательской жалобы/блокировки пользователя.**~~ Сделано (ADR-0154, #140): «Пожаловаться» на сообщение и человека → администраторам пространства (вкладка «Жалобы»), блокировка человека (DM и звонки запрещены, сообщения скрыты), «Заблокированные» в настройках. | Apple 1.2 (UGC): механизм жалобы, блокировка, контакт. Для закрытых рабочих пространств ревьюер может принять объяснение, но при открытой регистрации (`REGISTRATION_MODE=open`) это риск. | [?] решить: объяснение в Review Notes или минимальная «Пожаловаться» → письмо на support@ |
| B4 | **Android: платёжный UI скрыт** (ADR-0148), но если когда-нибудь вернётся — Play требует Play Billing для цифровых услуг. Пока скрыто — риска нет. | Play Payments policy | [код] `apps/desktop/src/renderer/platform/nativeShell.ts`, `services/plan.ts` |
| B5 | Android: FCM-push и звонки **не проверены на устройстве**, нужен Firebase-проект и `PUSH_FCM_*` на сервере. В описании Play не обещаем звонки на Android. | Честность листинга | [код] shared-web-status 2026-10-30 |

## 1. #124 Листинг

### 1.1 Метаданные

| Поле | Значение | Лимит |
|------|----------|-------|
| Название (iOS и Play) | `Calab: Team Chat` (16) | 30 |
| Subtitle iOS, en-US | `Voice rooms, chat and tasks` (27) | 30 |
| Subtitle iOS, ru-RU | `Голос, чат и задачи команды` (27) | 30 |
| Short description Play, en-US | `Team messenger: voice rooms, chat, task boards and a shared calendar.` (69) | 80 |
| Short description Play, ru-RU | `Мессенджер для команды: голосовые комнаты, чат, задачи и календарь.` (67) | 80 |
| Keywords iOS, en-US | `team,messenger,voice,chat,meeting,tasks,kanban,calendar,workspace,video call,collaboration,remote` (97) | 100 |
| Keywords iOS, ru-RU | `команда,мессенджер,голос,чат,встречи,задачи,канбан,календарь,созвон,видеозвонок,коллеги,работа` (94) | 100 |
| Категория | Business (iOS primary; вторая — Productivity [?]); Play: Business | |
| Support URL | `https://calab.io/en/legal/contacts/` / `https://calab.io/ru/legal/contacts/` (страница «Контакты», документ `contacts` в `apps/landing/src/content/legal*.json`) — [?] отдельная `calab.io/support` лучше, но её нет | |
| Marketing URL | `https://calab.io` | |
| Privacy URL | en: `https://calab.io/en/legal/privacy/`, ru: `https://calab.io/ru/legal/privacy/` [код] `apps/landing/src/components/footer.tsx`; en = редакция Unne L.L.C-FZ, ru = ООО «Громтех» (`docs/legal/README.md`) | |
| Контакт | `support@calab.io` | |
| Copyright | `2026 GPTunneL` (как в `Attribution`, `Legal.tsx`) [?] какое юрлицо продавец | |

Ключевые слова: слова из названия и subtitle в поле keywords не повторяем (Apple их индексирует сам); чужих брендов нет.

### 1.2 Полное описание en-US (≈2100 знаков, лимит 4000)

```
Calab brings your team's day into one app: voice rooms you can join with one tap, chat, tasks and a shared calendar. It is the phone companion of Calab on desktop and the web, so everything you start at your desk is waiting in your pocket.

VOICE ROOMS
• Join a team voice room in one tap and hear colleagues right away; see who is in the room and who is speaking.
• Video in calls, with the camera switched on only when you choose.
• Direct calls to a teammate with ringing and a system call screen on iPhone.

CHAT
• Rooms and direct messages with replies, reactions, pinned messages and files.
• Take a photo or pick one from your library and send it; save images you receive to Photos.
• Push notifications for mentions, messages and calls, with per-room levels and a personal opt-out for message previews.

TASKS AND CALENDAR
• Task boards: cards, assignees, due dates, checklists and comments, as board, list or timeline.
• A team calendar with meetings that open a voice room in one tap.
• iPhone widgets for the Home Screen and Lock Screen show your next meetings.

STAYS WITH YOU
• An ongoing voice room is shown as a Live Activity on iPhone, so you can see it and leave from the Lock Screen.
• Your session stays signed in; you can review and end other sessions in Settings.
• Open links to Calab tasks, rooms and invitations straight in the app.

GOOD TO KNOW
• You need a Calab account. Create a workspace or join one by invitation from your team.
• Some features, such as the mail client and starting a screen share, live in the desktop app.
• Plans and billing are managed in the desktop app and on the web, not in this app.
• Calab can run in the cloud or on your own server. Voice is processed with echo cancellation and noise suppression.

Questions? support@calab.io
```

Заметки к тексту: «Live Activity» и «системный экран звонка» — только iOS (на Android их убираем, см. 1.4); «Starting a screen share» — в shared-web-status экранная трансляция в оболочке не реализована [код: release.md «Известные ограничения»]; «per-room levels и opt-out превью» [код: ADR-0072, `push_devices.mentions_enabled/all_enabled`, `docs/mobile/message-notifications-testing.md`]; «review and end sessions» [код: `sessions.revoke` в i18n, `DELETE /api/me/sessions/{id}`]; «Leave from Lock Screen» — [?] проверить на устройстве кнопки Live Activity (`widgets/CalabVoiceActivity.swift`); виджеты календаря [код: `docs/mobile/calendar-widgets.md`, нужен `CALAB_IOS_APP_GROUP` в боевой сборке — [?] подтвердить, что в билде для стора он включён]. Wiki, холст, диск не упоминаем: раздел есть в вебе, но на телефоне его не проверяли в рамках этой задачи — [?].

### 1.3 Полное описание ru-RU

```
Calab собирает рабочий день команды в одном приложении: голосовые комнаты, куда заходят одним касанием, чат, задачи и общий календарь. Это телефон-спутник Calab на компьютере и в вебе: начатое за столом ждёт вас в кармане.

ГОЛОСОВЫЕ КОМНАТЫ
• Зайдите в голосовую комнату команды одним касанием и сразу слышите коллег; видно, кто в комнате и кто говорит.
• Видео в звонках: камера включается только по вашему выбору.
• Личные звонки коллеге: на iPhone с гудками и системным экраном вызова.

ЧАТ
• Комнаты и личные сообщения с ответами, реакциями, закреплёнными сообщениями и файлами.
• Сфотографируйте или выберите фото из галереи и отправьте; полученные картинки сохраняются в «Фото».
• Push-уведомления об упоминаниях, сообщениях и звонках: уровни по комнатам и личное отключение превью сообщений.

ЗАДАЧИ И КАЛЕНДАРЬ
• Доски задач: карточки, исполнители, сроки, чек-листы и комментарии; доска, список или таймлайн.
• Календарь команды: встреча открывает голосовую комнату одним касанием.
• Виджеты на iPhone (экран «Домой» и экран блокировки) показывают ближайшие встречи.

ВСЕГДА ПОД РУКОЙ
• Идущая голосовая комната отображается как Live Activity на iPhone: видно её и можно выйти с экрана блокировки.
• Вход сохраняется; другие сеансы можно посмотреть и завершить в настройках.
• Ссылки на задачи, комнаты и приглашения Calab открываются прямо в приложении.

ВАЖНО ЗНАТЬ
• Нужен аккаунт Calab: создайте пространство или присоединитесь по приглашению команды.
• Часть возможностей, например почтовый клиент и запуск трансляции экрана, есть только в приложении для компьютера.
• Тарифами и оплатой управляют в приложении для компьютера и в вебе, не в этом приложении.
• Calab работает в облаке или на вашем сервере. Голос обрабатывается с эхоподавлением и шумоподавлением.

Вопросы: support@calab.io
```

### 1.4 Различия для Android (Play, пока FCM не проверен на устройстве)

Убрать из описаний: «system call screen» / «системный экран вызова», блок про виджеты, блок Live Activity. Заменить строку про звонки на «Direct calls to a teammate» / «Личные звонки коллеге». Когда FCM-звонки будут проверены на устройстве (B5) — вернуть «ringing».

### 1.5 Скриншоты и графика

Пять сцен (источник — `apps/desktop/e2e-marketing/store/scenes.ts`, ветка `feat/111-store-shots`; оформление — рамка с заголовком на ru/en):

| № | Сцена | Заголовок en / ru |
|---|-------|-------------------|
| 1 | `01-voice` — комната «Переговорка»: кто в звонке, чат комнаты | Voice rooms / Голосовые комнаты |
| 2 | `02-chat` — комната «общий», утренний тред | Team chat / Чат команды |
| 3 | `03-rooms` — список комнат с последними сообщениями | All rooms in one place / Все комнаты рядом |
| 4 | `04-tasks` — доска «Продукт», канбан | Tasks and boards / Задачи и доски |
| 5 | `05-calendar` — календарь на сегодня | Team calendar / Календарь встреч |

| Площадка | Размер | Где готово (ветка #111) |
|----------|--------|-------------------------|
| iPhone 6.9" (обязателен) | 1320×2868 | `apps/mobile/store/ios-6.9/{en,ru}/` |
| iPhone 6.5" | 1284×2778 | `apps/mobile/store/ios-6.5/{en,ru}/` |
| Android phone | 1080×1920 (в рамке Android, снято в Chromium на Pixel 7) | `apps/mobile/store/android/{en,ru}/` |
| Play feature graphic | 1024×500 | `apps/mobile/store/feature/{en,ru}/feature-graphic.png` |
| Play icon | 512×512 | `apps/mobile/store/icons/icon-512.png` (из `apps/mobile/assets/icon-1024.png`) |
| App Store icon | 1024×1024 без прозрачности | `apps/mobile/assets/icon-1024.png` [код: `app.config.ts`, «full-bleed RGB»] |

iPad-скриншоты не нужны: `supportsTablet: false` [код: `app.config.ts`].

## 2. #125 Политика и условия против реального поведения приложения

Источник: `apps/landing/src/content/legal.json` (ru, ООО «Громтех»), `legal-global.json` (en, Unne L.L.C-FZ), редакция `LEGAL_VERSION = 2026-10-09` (`apps/landing/src/lib/legal.ts`). Правовые страницы не менялись; ниже — что и как добавить (решение и публикация за владельцем и юристом).

### 2.1 Что приложение делает (код) и покрыто ли политикой

| Что делает приложение | Где в коде | В политике сегодня | Вывод |
|-----------------------|-----------|--------------------|-------|
| Микрофон (голос, звонки, голосовые сообщения) | `NSMicrophoneUsageDescription`, Android `RECORD_AUDIO` (`apps/mobile/app.config.ts`) | Раздел «Голос, видео и записи» описывает данные, но не доступ к микрофону устройства | частично |
| Камера (видео в звонках, фото для сообщений) | `NSCameraUsageDescription`, Android `CAMERA` | то же | частично |
| Фото/файлы: выбор системным пикером, сохранение полученных картинок | `NSPhotoLibraryAddUsageDescription`; ADR-0068 (лист «Поделиться») | Файлы упомянуты как контент пространства; сохранение в «Фото» и права не упомянуты | частично |
| Push-токены APNs / VoIP (PushKit) / FCM, превью текста | `push_devices` (`apps/server/internal/db/migrations/00068_mobile_push.sql`: token, installation_id, provider, настройки уведомлений), ADR-0072 (Apple/Google получают имя и превью) | Есть: «push-токены при включении уведомлений», «платформенные push-сервисы… превью» | покрыто, но без названий APNs/FCM и без опции выключить превью |
| Звонки CallKit | `CalabIncomingCallsModule.swift`, `UIBackgroundModes: audio, voip` | не упомянуты | пробел (мелкий) |
| Журнал звонков/телефония | Журнал звонков устройства приложение **не читает**; SIP-журнал — серверный (ADR-0137), `docs/12-tech-backlog.md` | Телефония SIP упомянута (поставщики SIP) | покрыто |
| Идентификаторы устройства | `sessions.device_name, ip, user_agent`; `push_devices.installation_id` | «IP-адрес, тип клиента, идентификаторы устройства/сессии» | покрыто |
| Виджеты календаря и Live Activity | App Group-файл и Keychain-группа на устройстве, виджет сам ходит на сервер (`docs/mobile/calendar-widgets.md`) | не упомянуты | пробел (мелкий) |
| Краш-репорты / аналитика третьих сторон | В `apps/mobile/package.json` и модулях нет SDK аналитики/краш-репортов; на Android — Firebase Messaging (`firebase-bom:35.1.0`, только push) | «диагностические события» без уточнения | пробел: сказать явно «нет рекламных и аналитических SDK» |
| Яндекс Метрика | Только лендинг, по согласию; ClientID приходит ссылкой `ym_cid`, серверная конверсия только если ID есть (`apps/server/internal/metrika/metrika.go`, `apps/desktop/src/renderer/lib/attribution.ts`) | Описана в разд. «Получатели» и «Cookie» | покрыто; см. риск для «tracking» в §3.1 |
| Хранение/срок | Данные аккаунта: уничтожение ≤30 дней после запроса (разд. 6 ru, «Retention» en) | Есть | покрыто |
| Удаление аккаунта | Самообслуживания нет (B1); путь — письмо на support@ | «Запрос направляется на support@calab.io» | **пробел** |
| Возраст | Условия: «совершеннолетних дееспособных лиц» (ru, п. 1) | В политике нет заявления о детях | пробел |

### 2.2 Пробелы и предлагаемые формулировки

**G1. Удаление аккаунта (обязательно, B1).** Добавить в раздел «Права»/«Your choices» после появления функции:

- ru: «Аккаунт можно удалить самостоятельно в приложении: Настройки → Аккаунт → Удалить аккаунт, либо запросом на support@calab.io. Данные аккаунта уничтожаются в срок до 30 дней, за исключением сведений, которые мы обязаны хранить по закону (например, документы об оплате), и сообщений и файлов в пространствах других участников, где ваше имя заменяется на «Удалённый пользователь» [?].»
- en: “You can delete your account in the app (Settings → Account → Delete account) or by writing to support@calab.io. We delete account data within 30 days, except records we must keep by law (for example payment records) and content in other members' workspaces, where your name is replaced with “Deleted user” [?].”

Для Play нужна отдельная страница с этим текстом и адресом (URL удаления): предложение `https://calab.io/en/legal/contacts/` + абзац «Удаление аккаунта» либо новая страница `legal/account-deletion`. [?] поведение с чужими сообщениями (в схеме `users` — `ON DELETE CASCADE`; решение по анонимизации за владельцем).

**G2. Мобильное приложение и разрешения.** Новый подпункт в разделе «Цели, данные…» (ru) / «Information, purposes…» (en):

- ru: «Мобильные приложения Calab для iOS и Android запрашивают разрешения устройства только для выбранных вами функций: микрофон — для голосовых комнат, звонков и голосовых сообщений; камера — для видео и фото в сообщениях; уведомления — для сообщений, упоминаний и звонков. Фото и файлы передаются только те, что вы выбрали или получили и сохраняете сами. Приложение не читает ваши контакты, журнал звонков, местоположение и содержимое галереи целиком. Разрешения можно отозвать в настройках телефона.»
- en: “The Calab apps for iOS and Android ask for device permissions only for features you use: microphone for voice rooms, calls and voice messages; camera for video and photos in messages; notifications for messages, mentions and calls. Only photos and files you choose or choose to save are handled. The apps do not read your contacts, call history, location or your whole photo library. You can revoke permissions in the phone settings.”

(Проверено в коде: нет `NSContacts*`, `NSLocation*`, `READ_CONTACTS`, `READ_CALL_LOG`, `ACCESS_*_LOCATION` в `apps/mobile/app.config.ts` и плагинах.)

**G3. Push и звонки по названиям.**
- ru: «Уведомления доставляются через Apple Push Notification service (APNs, в том числе VoIP для входящих звонков) и Firebase Cloud Messaging (Google). Им передаются токен устройства и текст уведомления (имя отправителя и превью сообщения). Превью можно отключить в настройках уведомлений.»
- en: “Notifications are delivered through Apple Push Notification service (including VoIP for incoming calls) and Firebase Cloud Messaging (Google). They receive the device token and the notification text (sender name and message preview). You can turn previews off in notification settings.”

**G4. Диагностика и SDK.**
- ru: «Мобильные приложения Calab не содержат рекламных и аналитических SDK третьих сторон и не отправляют отчёты о сбоях сторонним сервисам. Диагностику сбоев, если вы её включили, собирают Apple и Google по правилам платформы.»
- en: “The Calab mobile apps contain no third-party advertising or analytics SDKs and do not send crash reports to third parties. Apple and Google may collect crash diagnostics under their own platform settings if you enable them.”

**G5. Виджеты и данные на устройстве.**
- ru: «Виджеты календаря и Live Activity хранят на устройстве краткую повестку (названия встреч на экране «Домой», на экране блокировки показывается «Встреча» и время) в защищённом хранилище приложения; при выходе из аккаунта эти данные стираются.»
- en: “Calendar widgets and Live Activities keep a short agenda on your device in protected app storage (meeting titles on the Home Screen; the Lock Screen shows “Meeting” and the time). Signing out removes this data.”
[код] `docs/mobile/calendar-widgets.md`.

**G6. Возраст.**
- ru: «Сервис не предназначен для лиц младше 18 лет. Мы сознательно не собираем данные несовершеннолетних; если вам известно о таком аккаунте, напишите на support@calab.io.»
- en: “The service is not intended for people under 18. We do not knowingly collect data from minors; if you know of such an account, write to support@calab.io.”

**G7. Срок хранения токенов и сеансов** (мелкое). Добавить: «Токен push удаляется при выходе из аккаунта или завершении сеанса» [код: `push_devices.session_id … ON DELETE CASCADE`, миграция 00068; `DELETE /api/me/push-devices/{id}`] — [?] подтвердить, что выход вызывает удаление.

**G8. Два продавца, две редакции.** en-карточка ссылается на редакцию Unne (ОАЭ), ru — на ООО «Громтех» (РФ). Apple/Play показывают одного разработчика: [?] какое юрлицо в аккаунте разработчика; ссылки локализовать по каталогу (Apple позволяет Privacy URL на каждый язык). В политике Unne написано «хостинг в РФ» (`docs/legal/README.md`) — это видно проверяющим, согласовать формулировку с владельцем.

### 2.3 Условия (Terms)

Условия (`terms`) покрывают аккаунт, пространства, правомерное использование, звонки/записи, прекращение. Мобильных положений нет и не обязательны. Добавить [?]: (а) одну строку «Мобильные приложения подчиняются этим же условиям; Apple и Google не являются стороной соглашения» (Apple EULA-требование, если не используется стандартный EULA Apple); (б) в правилах контента — запрет оскорбительного контента и способ жалобы (связано с B3).

### 2.4 Ссылки в `AuthLegalFooter`

Чтение кода: `AuthLegalFooter` — `Legal.tsx`, строки около «Login screen footer»: кнопки открывают `LegalViewer` (модальное окно с лицензиями), ссылок на calab.io нет. Единственный внешний переход — `Attribution` → `platform.app.openExternal('https://gptunnel.ai')`.

Путь такой ссылки в оболочке (проверено чтением):
1. веб `platform.app.openExternal` делает `window.open(url, '_blank', 'noopener,noreferrer')` (`apps/desktop/src/renderer/platform/web.ts`);
2. оболочка: `onOpenWindow` → `decideNewWindow` → для https вне origin приложения → `external` → `openExternal` (`apps/mobile/src/navigation.ts`, `App.tsx`). `calab.io` не равно `app.calab.io`, поэтому не откроется внутри WebView;
3. обычная `<a href>` без `target` тоже уходит в `onShouldStartLoadWithRequest` → `external`. Результат: **ссылки на политику откроются в системном браузере** на iOS и Android; на Android главный фрейм дополнительно режет `CalabOriginGuard`.

Предложение: в `AuthLegalFooter` и в «Настройки → О программе» добавить «Политика конфиденциальности» и «Условия использования» через `platform.app.openExternal` на `https://calab.io/<locale>/legal/privacy/` и `…/terms/` (хост из env/конфига клиента, не в коде — правило проекта «хостов в коде нет»). Это UI-правка, значит нужна визуальная проверка (CLAUDE.md).

## 3. #127 App Store

### 3.1 App Privacy (анкета «Nutrition label»)

Общий вывод: данные собираем (аккаунт на нашем сервере), связаны с пользователем, для отслеживания (ATT) не используем. `NSUserTrackingUsageDescription` нет [код: `app.config.ts`].

| Тип данных Apple | Собираем | Связано с пользователем | Tracking | Цель | Основание |
|------------------|----------|-------------------------|----------|------|-----------|
| Contact info: email | да | да | нет | App functionality (вход, восстановление пароля) | [код] `users`, `POST /api/auth/register` |
| Contact info: name | да | да | нет | App functionality | [код] `displayName` в register |
| Contact info: phone | нет (SIP-номера — данные пространства, не поле профиля) | — | — | — | [?] подтвердить, что поле «телефон» в профиле не обязательно/не собирается |
| User content: messages, files | да | да | нет | App functionality | [код] сообщения/файлы на сервере |
| User content: photos or videos | да (то, что пользователь отправил) | да | нет | App functionality | [код] загрузка файлов; камера/фото — `NSCameraUsageDescription` |
| User content: audio data | да (голосовые сообщения, записи встреч по включению; живой звонок идёт через наш LiveKit в реальном времени) | да | нет | App functionality | [код] README «Meeting recordings»; [?] подтвердить, как Apple трактует потоковый звонок (считаем «не собирается», пока не записан) |
| User content: other user content (задачи, календарь, заметки) | да | да | нет | App functionality | [код] |
| Identifiers: user ID | да | да | нет | App functionality | [код] |
| Identifiers: device ID | да (push-токены APNs/VoIP, `installation_id`, `device_name`) | да | нет | App functionality (push, звонки) | [код] `push_devices`, `sessions` |
| Diagnostics / Usage data | нет собственной аналитики; сервер пишет IP и user agent сеанса для безопасности | да (сеанс привязан к аккаунту) | нет | App functionality / безопасность | [код] `sessions.ip, user_agent`; [?] отметить «Other diagnostic data»: консервативно «да, App functionality» |
| Purchases / Financial info | нет: платёжный UI скрыт в оболочке, карты не вводятся (ADR-0148, ADR-0087 §10) | — | — | — | [код] `nativeShell.ts`, `services/plan.ts` |
| Location (точная и грубая) | нет | — | — | — | [код] нет `NSLocation*`; IP не используется для геолокации [?] |
| Contacts, Health, Browsing history, Search history, Sensitive info | нет | — | — | — | [код] нет соответствующих usage-ключей и SDK |

Риск «Tracking» — **устранён (CBF-143, 2026-11-02, ADR-0135 addendum)**: сервер отправляет Яндекс Метрике конверсии регистрации и оплаты **только** при наличии ClientID, который лендинг передаёт после согласия посетителя на аналитику (`metrika.go`: «Only accounts with a Metrika ClientID take part»). Пользователь из App Store приходит без ссылки с лендинга, ClientID у него нет. Остававшийся риск — установленное приложение открывает ссылку с `ym_cid` на `/t/`, `/join/`, `/r/`, и регистрация в приложении отправляет конверсию — закрыт: нативная оболочка (`inNativeShell()`, `apps/desktop/src/renderer/lib/attribution.ts`) не берёт и не хранит `ym_cid`/`utm_*`, а сервер (`internal/auth/service.go`) независимо отбрасывает `attribution` для любого запроса регистрации с маркером оболочки в User-Agent (`SHELL_UA_MARKER`). Ответ «Tracking: No» — подтверждён.

### 3.2 Возрастной рейтинг (новая анкета Apple, 4+/9+/13+/16+/18+)

| Вопрос | Ответ | Основание |
|--------|-------|-----------|
| Насилие, секс, нагота, азартные игры, лутбоксы, алкоголь/табак/наркотики, ужасы, медицинские темы | Нет / None | [код] у приложения нет такого собственного контента |
| Неограниченный веб-доступ | Нет: WebView открывает только `app.calab.io`, остальные ссылки уходят в системный браузер (`navigation.ts`) | [код] |
| Пользовательский контент и общение (messaging/chat, user-generated content) | **Да** | [код] чаты, файлы |
| Модерация/жалобы | Есть: жалоба на сообщение/человека и блокировка (ADR-0154) | [код] |
| Родительский контроль, возрастные ограничения | Нет | — |

Ожидание из задачи — 4+. [?] Реальный итог считает сама консоль: из-за пункта «пользовательский контент/чат» Apple может выставить выше 4+ (чаще 13+ или 16+). Условия Calab — для совершеннолетних (п. 1 Terms), поэтому допустим осознанный выбор 17+/18+ вместо подбора минимума. Подтвердить после заполнения анкеты.

### 3.3 Export compliance

`ios.config.usesNonExemptEncryption: false` задано в `app.config.ts`; обоснование: только HTTPS и WebRTC DTLS-SRTP (стандартное, `docs/mobile/release.md`). Ответ в консоли: «Uses encryption: Yes, exempt» (стандартное шифрование ОС/протоколов) — декларация во Франции не нужна. [код] [?] подтвердить, что собственных криптоалгоритмов нет (в `apps/mobile` и модулях их нет; LiveKit WebRTC — стандартные).

### 3.4 App Review Notes (en, черновик)

```
Calab is a team messenger. This app is a native iOS host for our web client and adds native
features that a browser cannot provide.

HOW TO SIGN IN
Demo account (workspace "Calab Review"):
  Email:    <DEMO_EMAIL>
  Password: <DEMO_PASSWORD>
The workspace has a few rooms, a task board, and a calendar with sample data.
Sign-in is email and password. There is no third-party or social sign-in.

NATIVE FEATURES
- Incoming calls: PushKit VoIP push + CallKit system call screen (answer/decline from the
  lock screen). To test, a second account in the same workspace calls the demo user; contact us
  and we will place the call during review.
- Push notifications (APNs) for messages and mentions with Communication Notifications
  (sender avatar and name); a notification service extension prepares them.
- Voice rooms: native audio session and background audio so a call keeps going when the app
  leaves the foreground.
- Live Activity (ActivityKit) for an ongoing voice room, shown on the Lock Screen and Dynamic Island.
- Home Screen and Lock Screen widgets (WidgetKit) with upcoming meetings.
- Native share sheet to save or share files downloaded from chats; save images to Photos.
- Permissions requested only when used: microphone (voice rooms, calls), camera (video, photos for
  messages), notifications.

GUIDELINE NOTES
- 4.2 (minimum functionality): the app is not a bookmark of a website. It needs a team account,
  and provides CallKit/PushKit calling, push, Live Activity, widgets, background audio and
  system share integration, none of which exist in Safari.
- 4.8 (login services): the app uses only its own email/password account and does not use any
  third-party or social login, so Sign in with Apple is not required.
- 3.1.1 (payments): the app has no purchases, prices, plans, payment buttons or links to pay
  elsewhere. Plan and billing screens are hidden in the app (a read-only note says billing is
  managed on web/desktop). Teams buy Calab as a business service on our website.
- 5.1.1(v) (account deletion): <describe the delete-account path once it exists: Settings >
  Account > Delete account>.
- 1.2 (user-generated content): content is created inside private team workspaces by invited
  members. Any message or person can be reported (message menu / member menu > Report: reason +
  comment); reports go to the workspace admins (Workspace settings > Reports) and are logged.
  Any person can be blocked (member menu / chat menu > Block): they can no longer message or
  call you and their messages in shared rooms are hidden; unblock in Settings > Blocked users.
  Contact: support@calab.io.

Contact: support@calab.io, <OWNER_PHONE>
```

Основание каждого пункта:

| Утверждение в notes | Статус |
|---------------------|--------|
| CallKit/PushKit | [код] `UIBackgroundModes audio, voip`, `CalabIncomingCallsModule.swift`, `CALAB_IOS_INCOMING_CALLS=1` в сборке (release.md) |
| Push + Communication Notifications + NSE | [код] `withCommunicationNotifications.js` (`com.apple.developer.usernotifications.communication`, `CalabNotificationService`) |
| Native audio/background audio | [код] `app.config.ts` (`UIBackgroundModes`), `CalabCallAudio.swift`, `CALAB_IOS_NATIVE_CALL_AUDIO=1` |
| Live Activity | [код] `widgets/CalabVoiceActivity.swift`, `withSessionActivity.js`; [?] Dynamic Island на устройстве |
| Widgets календаря | [код] `widgets/CalabCalendarWidgets.swift`; [?] включены ли в стор-сборке (`CALAB_IOS_APP_GROUP`) |
| Share sheet / Photos | [код] ADR-0068, `NSPhotoLibraryAddUsageDescription` (это лист «Поделиться» для скачанных файлов, не Share Extension) |
| 4.8: нет сторонних входов | [код] `AuthScreen.tsx`: только email+пароль, регистрация, «забыли пароль»; SSO есть только как корпоративный вход пространства (`/api/auth/sso/*`, не поддерживается в оболочке — release.md «Известные ограничения»), это собственная корпоративная система учётных записей, под 4.8 не подпадает [?] |
| 3.1.1: платежи скрыты | [код] `platform/nativeShell.ts` (`inNativeShell()`), `services/plan.ts` `planOffersAllowed()`, ADR-0087 §10, ADR-0148; вместо UI — нейтральная строка без ссылки. Отметить [?]: BILLING_VIEW-держатель видит суммы баланса (read-only) — Apple это допускает, но ревьюеру показать в notes |
| Demo account | [?] нужен: создать пространство «Calab Review», пароль не из .env, указать в консоли, не коммитить |

## 4. #128 Google Play

### 4.1 Data safety

Общая часть: данные шифруются при передаче (HTTPS/WSS, WebRTC DTLS-SRTP) [код: ADR-0067 origin только https, `release.md`]; пользователь может запросить удаление — **после B1**; есть метод удаления — письмо [?]. Сторонним лицам данные «не передаём» (поставщики обработки по поручению — не «sharing» в терминах Google [?]).

| Категория Google | Собираем | Передаём третьим лицам | Обязательно/по желанию | Цель | Основание |
|------------------|----------|------------------------|-----------------------|------|-----------|
| Personal info: name, email | да | нет | обязательно | App functionality, Account management | [код] register |
| Personal info: user IDs | да | нет | обязательно | App functionality | [код] |
| Photos and videos | да (отправленные) | нет | по желанию | App functionality | [код] камера/выбор файла |
| Audio files / Voice or sound recordings | да (голосовые сообщения, записи встреч по включению) | нет (GPTunneL получает записи, если администратор включил транскрипцию, по поручению пространства [?]) | по желанию | App functionality | [код] политика «Голос, видео и записи» |
| Messages (other in-app messages) | да | нет | обязательно для чата | App functionality | [код] |
| Files and docs | да | нет | по желанию | App functionality | [код] |
| Calendar events | да (календарь пространства, CalDAV по подключению) | нет | по желанию | App functionality | [код] ADR-0045, calendar-widgets.md |
| App activity (other user-generated content: задачи) | да | нет | по желанию | App functionality | [код] |
| Device or other IDs | да: FCM-токен, Firebase Installation ID (Google FCM), `installation_id`, `device_name`, IP/UA сеанса | нет (Google FCM как транспорт push) | обязательно, если включены уведомления | App functionality | [код] `CalabMessagingService.kt`, `firebase-messaging`, `push_devices`, `sessions` |
| Financial info | нет (платёж скрыт) | — | — | — | [код] ADR-0148 |
| Location, Contacts, Health, Web browsing, App info/performance (crashes, diagnostics) | нет собственных сборов | — | — | — | [код] нет разрешений и SDK; [?] Google Play собирает crash/ANR сама — это не декларируется |
| Account deletion URL | **пока нет** (B1) | | | | [?] |

### 4.2 IARC (опросник возрастного рейтинга Play)

| Вопрос | Ответ |
|--------|-------|
| Категория | Utility, Productivity, Communication or other (не игра) |
| Насилие, кровь, страх, секс/нагота, ненормативная лексика, азартные игры, алкоголь/табак/наркотики | Нет |
| Пользователи взаимодействуют/обмениваются контентом | **Да** (чаты, файлы) |
| Делится геопозицией | Нет |
| Цифровые покупки/платный контент в приложении | Нет (скрыты, ADR-0148) |
| Неограниченный веб-доступ | Нет (только `app.calab.io`; внешние ссылки — в системном браузере) |
| Новости | Нет |

Ожидание: Everyone / 3+ с пометкой «Users Interact». [?] итог считает IARC; при выбранной политике «только взрослые» (Terms п. 1) можно задать целевую аудиторию 18+.

### 4.3 App access

Нужен вход: [?] демо-аккаунт `<DEMO_EMAIL>` / `<DEMO_PASSWORD>`, пространство «Calab Review» с комнатами, доской и календарём; инструкция: «Войдите по email и паролю; других шагов нет, SMS/2FA нет» [?] подтвердить, что у демо нет 2FA и подтверждения email (`EMAIL_VERIFICATION`, ADR-0065, `docs/adr/0065-optional-email-verification.md`).

### 4.4 Реклама и аудитория

- Реклама: **нет** (SDK рекламы отсутствуют) [код: `apps/mobile/package.json`; `docs/legal/README.md` «Никаких рекламных SDK»].
- Целевая аудитория: 18+; приложение не для детей, Families Policy не применяется [код: Terms п. 1] [?].
- Правительственное, финансовое, медицинское, новостное приложение — нет.

### 4.5 Разрешения

Из `app.config.ts`:
`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA`, `POST_NOTIFICATIONS`; из модуля `calab-session-activity/android/src/main/AndroidManifest.xml`: `POST_NOTIFICATIONS` (дубль), `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE` и сервис `CalabMediaSessionService` с `foregroundServiceType="microphone"` (доска #141). `FOREGROUND_SERVICE_PHONE_CALL` и `USE_FULL_SCREEN_INTENT` не объявлены: Telecom/ConnectionService нет.

| Разрешение | Зачем (текст для Play и пользователя) | Декларация в Play Console | Основание |
|------------|----------------------------------------|---------------------------|-----------|
| `RECORD_AUDIO` | Голосовые комнаты, звонки, голосовые сообщения. Runtime-запрос, WebView не получает микрофон без него (`src/mediaPermissions.ts`) | отдельная форма не нужна (не из «чувствительных» списков); указать в Data safety (аудио) | [код] |
| `CAMERA` | Видео в звонках и фото для сообщений | форма не нужна | [код] |
| `MODIFY_AUDIO_SETTINGS` | Маршрутизация аудио в звонке (динамик/гарнитура) | обычное разрешение, форма не нужна | [код] |
| `POST_NOTIFICATIONS` | Android 13+: уведомления о сообщениях и звонках; запрашивается только через запрос веб-клиента | форма не нужна | [код] `CalabPush.kt` (`SDK_INT < 33` отсекает) |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE` | Микрофон остаётся у приложения, пока пользователь в голосовой комнате или звонке и приложение свёрнуто. Сервис стартует только при входе (приложение на экране), показывает постоянное уведомление и останавливается при выходе | **Да**: Play Console → App content → Foreground service permissions, тип Microphone (текст и видео ниже) | [код] `CalabMediaSession.kt`, доска #141 |
| `FOREGROUND_SERVICE_PHONE_CALL` | не объявлен: нет Telecom/ConnectionService (ADR-0071 Android, v2) | — | [код] |
| `VIBRATE` (из шаблона Expo) | Тактильный отклик веб-клиента (`navigator.vibrate`) | форма не нужна | [код] `lib/haptics.ts` |
| `WRITE_EXTERNAL_STORAGE` (шаблон, `maxSdkVersion=32`) | Только Android ≤ 9: скачивание файла из чата (react-native-webview просит его на ≤ API 28) | форма не нужна | [код] библиотека WebView |
| `READ_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW` (шаблон Expo) | **Убраны** `android.blockedPermissions` (`tools:node="remove"`): загрузка файлов идёт через системный выбор, поверх других приложений ничего не рисуем | — | [код] `app.config.ts`; [?] сверить итоговый manifest сборки (`aapt2 dump permissions`/`bundletool dump manifest`) |

**Декларация foreground service для Play Console (тип Microphone, черновик, en).**

- *Feature:* «Voice rooms and one-to-one calls. While the user is in a voice room or a call and
  switches to another app or locks the screen, Calab keeps capturing the microphone so the
  conversation continues.»
- *Why it must start immediately and cannot be paused or deferred:* «The user is in a live
  conversation; stopping capture would mute them for the other participants. The service runs only
  between joining and leaving, starts only when the user joins while the app is on screen, shows an
  ongoing notification («You are in a voice room» / «Call in progress») with a Leave/End action, and
  stops on leave, sign-out or when the app is closed.»
- *User impact if deferred or interrupted by the system:* «Other participants stop hearing the user
  mid-conversation without any indication.»
- *Video (≤ 30 s, unlisted YouTube link):* войти демо-аккаунтом → открыть голосовую комнату →
  нажать «Войти» (разрешить микрофон) → свернуть приложение: видно уведомление «Calab — вы в
  голосовой комнате» → второе устройство слышит говорящего → «Выйти» в уведомлении → уведомление
  исчезло, участник вышел. Снимать после проверки по чек-листу shared-web-status.md (доска #141).

### 4.6 Target SDK

В репозитории не зафиксирован: `app.config.ts` не задаёт `targetSdkVersion`, берётся дефолт Expo SDK 57 (`expo` 57.0.31, `react-native` 0.86.3 в `apps/mobile/package.json`), зависимости в этом дереве не установлены, `android/` не сгенерирован. Ожидаемо API 36 (Android 16), что соответствует требованию Play «таргет на текущий и предыдущий год». [?] проверить на готовом aab: `bundletool dump manifest --bundle app-release.aab | grep targetSdkVersion` (или в Play Console «App bundle explorer»); если ниже, задать через `expo-build-properties` (`android.targetSdkVersion`). Play App Signing подключён (release.md); первый Android internal-билд уже загружен (`versionCode` в release.md).

## 5. Вопросы к владельцу

1. Блокеры B1 (удаление аккаунта) и B2 (ссылки на политику/условия в приложении) — заводим задачи до отправки в ревью?
2. Жалоба/блокировка пользователей (B3): делаем минимальную или объясняем в notes?
3. Демо-аккаунт: создать пространство «Calab Review» и пароль (в репозиторий не кладём); телефон для контакта в App Review.
4. Продавец в сторах: ООО «Громтех» или Unne L.L.C-FZ; какие редакции политики подставлять в какую локаль.
5. Возрастная аудитория: сознательный выбор 18+ или минимум, который выдаст анкета.
6. ~~Метрика: отключать ли `attribution` для регистраций из нативной оболочки, чтобы честно ответить «Tracking: No».~~ Решено (CBF-143, 2026-11-02): отключено на клиенте и на сервере, см. §3.1.
7. Виджеты календаря и incoming calls в стор-сборке: включены ли `CALAB_IOS_APP_GROUP`, `CALAB_IOS_INCOMING_CALLS` (влияет на текст описания и review notes).
8. Android: звонки/foreground service и FCM-проверка на устройстве — до публикации в production или оставляем «только сообщения»?
9. Утвердить тексты политики G1–G7 (юрист) и URL: support (`legal/contacts` или новая `calab.io/support`), удаление аккаунта (Play).
