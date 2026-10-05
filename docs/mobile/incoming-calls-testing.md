# R06: реальные входящие на iPhone, ещё не проверено

1. Default build: calls unsupported; обычные web звонки и message push по R05 сохраняют поведение.
2. Опт-ин `CALAB_IOS_INCOMING_CALLS=1`, matching APS development profile/env/provider; Swift compile и установка.
3. Согласованный web/server/migration и [push deployment](push-deployment.md); VOIP capability только при полном config.
4. Main document работает; iframe/external/old document/remount не могут bind/settle/sync или читать token/actions.
5. Два устройства: фон и блокировка, один CallKit ring, answer, двусторонний звук, end с обоих устройств.
6. Завершённый процесс: native report до auth, scene/Host/READY timestamps; locked answer до 10 с, без второй auth/media системы.
7. No-auth/offline/slow bootstrap: deadline заканчивает CallKit, не показывает connected; возврат в app восстанавливает обычный UI.
8. Повторный payload: тот же UUID, один звонок, completion один раз, легитимный текущий звонок не завершается.
9. Cancel/answer elsewhere/expired/DND/disabled/no workspace/no DM access после ring не дают принять или повторно звонить.
10. Late accept после timeout/logout/account switch: нет RTC join; cleanup не затрагивает новый аккаунт/новый звонок.
11. Logout/revocation/cold anonymous page очищают binding; reload сохраняет ring, старые document callbacks отвергаются.
12. CallKit audio activation, mute/deafen, speaker/Bluetooth, возврат/повторная блокировка; затем message cold tap и скачивание.
