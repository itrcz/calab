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
