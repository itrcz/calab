# R04: точечная проверка на iPhone

1. Собрать host с module и WidgetKit extension; подписать обоих существующим профилем, без новых grants.
2. Открыть контролируемую HTTPS preview общего веба; обычный браузер и старый host работают без capability.
3. Войти в комнату: connecting не показывает connected; после фактического connect появляется общий статус Calab.
4. Mute/deafen/moderator mute меняют индикатор; в UI нет названия комнаты, участников, токенов или dead controls.
5. Отключить сеть: reconnecting обозначен явно; вернуть сеть, выйти/войти в другую комнату.
6. Выйти, logout/revocation, reload, «Повторить» и native teardown удаляют activity.
7. Сторонний и same-origin iframe отправляют hello/snapshot напрямую в WebKit handler: authority не выдаётся.
8. Задержанные hello/ack/snapshot старого документа после navigation/logout/remount не оживляют activity.
9. Позднее удаление старого WebView после нового hello не отбирает authority у нового WebView.
10. В живой комнате заблокировать телефон > 2 минут: наблюдать lease, двусторонний звук и возврат.
11. Остановить/убить процесс без end: через 90 с activity не должна утверждать connected; запуск удаляет остатки.
12. Записать реальные исходы отдельно от unit/prebuild; push и CallKit в этот сценарий не входят.
