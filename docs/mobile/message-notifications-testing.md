# Сообщения push: проверка устройства после обновления

1. Default build без APS: вход/комнаты/звук работают, notifications unsupported, OS prompt/token отсутствуют.
2. Будущая APNs-сборка: matching team/bundle/profile/env и обновлённый WebView patch; Swift compile проходит.
3. Опубликовать согласованные web/server, применить migration, настроить matching APNs provider.
4. Live Activities выключены: permission и message push всё равно доступны.
5. Основной документ может запросить permission/token; iframe/external/old-document/remount не могут.
6. Grant/deny и изменение OS permission после возврата в app отражаются в существующих настройках.
7. Доставка в фоне/на блокировке: имя/текст по настройкам превью iOS, понятная подпись вложения; foreground без второго alert/sound.
8. DND, блокировка, mute/levels, mentions-only/all/off соблюдаются, включая отключение во время регистрации.
9. Cold tap до login/handshake и reload сохраняется; после текущей auth открывается существующая комната один раз.
10. Tap через 10 минут открывает правильный чат; отправка старого сообщения ограничена 5 минутами. Route хранится до 7 дней после dispatch deadline, максимум 2048 обычных receipts; expired/deleted/foreign/no-access tap не маршрутизируется.
11. Logout/account switch очищает endpoint/tap и уже доставленные уведомления Calab; reload их сохраняет. Задержанные callbacks прежней сессии не открывают экран.
12. Временная ошибка регистрации APNs: возврат в app через 15 секунд повторяет попытку без нового permission prompt; частые status probes не запускают retry. Token rotation идемпотентна.


## Communication presentation (R11)

After installing a build containing CalabNotificationService and the Communication
Notifications entitlement, send a DM from a user with an avatar while the phone is locked.
After Face ID, verify the sender picture/name and preview; repeat with no avatar and after
changing the avatar. No-avatar/failing-thumbnail messages must still arrive with text.
Send several messages in one chat and another chat: Notification Center groups the two
conversations separately. Opening any entry must retain its original authenticated route.
Repeat with Show Previews = Never and with Focus enabled: respect the OS settings.
Logout removes app notifications and donated communication interactions; reload does not.
Do not claim that logout recalls an already in-flight APNs alert or donation.

The extension uses a bounded inline JPEG with no network, URLs or shared credentials.
Old app versions ignore communication fields and display the original text alert.
A new native target/profile is required; APNs server credentials do not change.

Preview privacy (PR review): default permits text. Enable personal “Hide message text
in notifications”, send a text and a captioned file: only New message / file kind remains,
with sender identity. Disable it and enable the workspace rule: it still hides text in
workspace rooms and DMs between members. Toggle from another device, check the next
notification; already in-flight/accepted pushes cannot be recalled. Repeat with iOS Show
Previews set to Never: device display privacy is separate from server payload privacy.
