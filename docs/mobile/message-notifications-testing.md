# Сообщения push: будущая проверка устройства

1. Default build без APS: вход/комнаты/звук работают, notifications unsupported, OS prompt/token отсутствуют.
2. Будущая APNs-сборка: matching team/bundle/profile/env и обновлённый WebView patch; Swift compile проходит.
3. Опубликовать согласованные web/server, применить migration, настроить matching APNs provider.
4. Live Activities выключены: permission и message push всё равно доступны.
5. Основной документ может запросить permission/token; iframe/external/old-document/remount не могут.
6. Grant/deny и изменение OS permission после возврата в app отражаются в существующих настройках.
7. Доставка в фоне/на блокировке: только сообщения, общий ru/en текст, без private contents; foreground без второго alert/sound.
8. DND, блокировка, mute/levels, mentions-only/all/off соблюдаются, включая отключение во время регистрации.
9. Cold tap до login/handshake и reload сохраняется; после текущей auth открывается существующая комната один раз.
10. Offline resolve повторяется после восстановления, ack только после успеха; expired/foreign/no-access tap не маршрутизируется.
11. Logout/revocation/account switch очищает endpoint/tap; задержанные callbacks прежней сессии не открывают экран.
12. Token rotation идемпотентна; затем повторить обычный звонок/скачивание в установленном host.
