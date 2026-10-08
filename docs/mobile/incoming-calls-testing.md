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
12. CallKit audio activation и двусторонний звук ≥60 с под блокировкой; speaker/Bluetooth и обычный телефонный звонок/возврат. Системный mute/unmute меняет общий микрофон, кнопка в app обновляет системный экран; отказ/timeout mute не завершает разговор, moderator mute не снимается. Старые host/web сохраняют answer/end; system mute доступен после sync от нового web.


## Caller presentation (R11)

Check caller name, system screen and avatar on the target iOS version, while foreground,
background and terminated/locked. The native host reports CallKit immediately with a
nonempty generic person handle, then donates an incoming INStartCallIntent with the optional
avatar. No Contacts access, duplicate notification, downloaded image or second call UI.
CXCallUpdate has no per-caller image field: the donation is not proof that iOS displays the
profile picture on its full-screen call UI. Record actual rendering separately from ringing,
one-tap answer and locked bidirectional audio. Check that the system's Calab/open-app button
works after Answer, including an old-server payload without a person identifier.

## Audio-session registration regression (R17)

On iOS, test a locked incoming call after a fresh process launch, then another call
without relaunching. Answer on the system screen. Require CallKit audio activation,
media connection and at least 60 seconds of bidirectional sound; a running call timer
alone is not a pass. Repeat with the app visible and with desktop voice connected.

The pre-fix device failure was an accepted answer followed by a 15-second readiness
timeout, with `audiomxd` reporting `session lookup failure for SessionID 0x0`.
The native report path now refreshes the existing provider configuration immediately
before reporting each incoming call, following
[Apple DTS guidance](https://developer.apple.com/forums/thread/783870).
It initializes the shared audio session but never activates it itself. Verify that
the lookup error and timeout disappear, `CallKit audio activated` occurs, and sound
actually works in both directions. If a timeout remains, record its accepted,
connected and audioActive flags to identify the failed boundary.

Also check cancellation, duplicate delivery and a subsequent successful call;
configuration refresh must not create another call or lose its completion callback.
This native-only change requires a new phone build, not a web/API deployment.
Device acceptance of the new build is pending; local compilation does not prove it.
