---
title: События gateway
description: Все opcodes, коды закрытия и события DispatchEvent протокола gateway с пометкой, какие из них получают боты.
order: 2
---

Справочник протокола gateway версии `v=1`. Как подключаться и обрабатывать события — в главе [Gateway](../bots/gateway).

## Opcodes

Поле `op` кадра `GatewayFrame`. В JSON — полное имя, например `"GATEWAY_OPCODE_DISPATCH"`.

| Opcode | Номер | Направление | Поле кадра |
|---|---|---|---|
| `GATEWAY_OPCODE_HEARTBEAT` | 1 | бот → сервер | `heartbeat { lastSeq }` |
| `GATEWAY_OPCODE_IDENTIFY` | 2 | бот → сервер | `identify { token, device, capabilities }` |
| `GATEWAY_OPCODE_RESUME` | 3 | бот → сервер | `resume { token, sessionId, seq }` |
| `GATEWAY_OPCODE_PRESENCE_UPDATE` | 4 | бот → сервер | `setPresence { status, until }` |
| `GATEWAY_OPCODE_TYPING` | 5 | бот → сервер | `typing { roomId }` |
| `GATEWAY_OPCODE_SUBSCRIBE` | 6 | бот → сервер | `subscribe { roomIds }` |
| `GATEWAY_OPCODE_RECONNECT` | 7 | сервер → бот | `reconnect {}` |
| `GATEWAY_OPCODE_DISPATCH` | 8 | сервер → бот | `dispatch { <событие> }` |
| `GATEWAY_OPCODE_INVALID_SESSION` | 9 | сервер → бот | `invalidSession { resumable }` |
| `GATEWAY_OPCODE_HELLO` | 10 | сервер → бот | `hello { heartbeatIntervalMs }` |
| `GATEWAY_OPCODE_HEARTBEAT_ACK` | 11 | сервер → бот | `heartbeatAck {}` |

## Коды закрытия

| Код | Имя | Что делать боту |
|---|---|---|
| `4000` | `UNKNOWN_ERROR` | переподключиться, `RESUME`; с причиной `replaced by a new session` — не переподключаться |
| `4001` | `UNKNOWN_OPCODE` | переподключиться, `RESUME` |
| `4002` | `DECODE_ERROR` | переподключиться, `RESUME` |
| `4003` | `NOT_AUTHENTICATED` | переподключиться, новый `IDENTIFY` |
| `4004` | `AUTHENTICATION_FAILED` | не переподключаться: токен неверный |
| `4007` | `INVALID_SEQ` | переподключиться, новый `IDENTIFY` |
| `4008` | `RATE_LIMITED` | подождать, `RESUME` |
| `4009` | `SESSION_TIMED_OUT` | переподключиться, новый `IDENTIFY` |
| `4010` | `SESSION_REVOKED` | не переподключаться: токен отозван или бот удалён |
| `4011` | `SESSION_EVICTED` | касается вкладок браузера; боту не встречается |

## События

Событие — одно из полей `DispatchEvent`, в JSON — в lowerCamelCase. Колонка «Боту»: **да** — приходит боту по его правам; **по условию** — только при условии в описании; **нет** — боту не отправляется.

### Сессия

| Событие | Боту | Описание |
|---|---|---|
| `ready` | да | ответ на `IDENTIFY`: `sessionId`, `me`, `workspaces[]`, `dms[]`, `readStates` |
| `resumed` | да | ответ на успешный `RESUME`: `replayed` — сколько событий переслано |
| `readStateUpdate` | да | собственная отметка прочтения изменилась (с другого устройства или по `PUT /api/rooms/{id}/read`) |

### Пространства, участники, роли

| Событие | Боту | Описание |
|---|---|---|
| `workspaceCreate` · `workspaceUpdate` · `workspaceDelete` | да | бот вошёл в пространство · настройки изменились · пространство удалено или бот убран |
| `workspaceMemberAdd` · `workspaceMemberUpdate` · `workspaceMemberRemove` | да | участники: вступил, изменились роли или никнейм, ушёл |
| `workspaceBanAdd` · `workspaceBanRemove` | по условию | баны — только с `MANAGE_MEMBERS` |
| `roleCreate` · `roleUpdate` · `roleDelete` | да | роли пространства |
| `badgeCreate` · `badgeUpdate` · `badgeDelete` | да | библиотека бейджей |
| `workspaceAchievementsUpdate` | да | каталог ачивок пространства изменился |
| `userUpdate` · `presenceUpdate` | да | профиль и присутствие участника |
| `botCreate` · `botUpdate` · `botDelete` | по условию | боты пространства — только с `MANAGE_BOTS` (или владельцу бота) |
| `workspaceAppUpsert` · `workspaceAppDelete` | нет | веб-приложения пространства — только людям |
| `workspaceIdentityAccessUpdate` | — | служебное событие SSO для сессий людей; если придёт — игнорируйте |
| `billingUpdate` | нет | оплата — только владельцу пространства |

### Комнаты и сообщения

| Событие | Боту | Описание |
|---|---|---|
| `roomCreate` · `roomUpdate` · `roomDelete` · `roomPermissionsUpdate` | да | комнаты, которые бот видит (или перестал видеть) |
| `categoryCreate` · `categoryUpdate` · `categoryDelete` | да | категории комнат |
| `messageCreate` · `messageUpdate` · `messageDelete` | да | сообщения видимых комнат и DM бота; у команды бота — `message.command` |
| `messageReactionAdd` · `messageReactionRemove` | да | реакции |
| `typingStart` | по условию | «печатает» — только в комнатах из `SUBSCRIBE` |
| `botCallback` | по условию | нажатие кнопки — только боту-автору сообщения |
| `dmCreate` | да | новый DM с ботом |
| `stickerPackCreate` · `stickerPackUpdate` · `stickerPackDelete` | да | стикерпаки пространства |
| `readReceipt` | нет | отметки «прочитано» людей — ботам не отправляются |
| `roomNotificationUpdate` · `workspaceNotificationUpdate` · `dmStateUpdate` | нет | настройки уведомлений и архив DM — у ботов их нет |

### Голос и звонки

| Событие | Боту | Описание |
|---|---|---|
| `voiceStateUpdate` | да | кто в какой голосовой комнате; пустой `roomId` — вышел |
| `voiceStreamStart` · `voiceStreamStop` · `voiceCameraStop` · `voiceMoved` | да | стримы, камера, перенос участника |
| `voiceDisconnected` | да | бота отключили от голоса |
| `roomRecording` | да | запись встречи в комнате началась или закончилась |
| `soundCreate` · `soundUpdate` · `soundDelete` | да | звуки пространства |
| `soundPlay` | по условию | только пока бот в звонке комнаты |
| `sipCallUpdate` | да | телефонный звонок из комнаты набран или сменил статус |
| `roomAdmissionRequest` · `roomAdmissionDecided` | по условию | гость ждёт впуска · решение принято — тем, кто решает (`INVITE_GUESTS` в комнате) |
| `callRing` · `callState` | нет | звонки один на один — не для ботов |
| `backgroundCreate` · `backgroundUpdate` · `backgroundDelete` | нет* | фоны камеры; у ботов нет камеры — игнорируйте |

\* Событие рассылается всему пространству и может прийти, но боту оно ни к чему.

### Календарь

| Событие | Боту | Описание |
|---|---|---|
| `eventCreate` · `eventUpdate` · `eventDelete` · `eventRsvp` | да | встречи, где бот организатор, и встречи видимых комнат; внешние адреса — только если бот может менять встречу |
| `roomEventActive` · `roomEventEnded` | да | встреча в комнате началась · закончилась |
| `eventReminder` | нет | напоминание участнику — бот участником встреч не бывает |

### Доски и задачи

| Событие | Боту | Описание |
|---|---|---|
| `boardCreate` · `boardUpdate` · `boardDelete` | да | доски — по `VIEW_BOARD` |
| `boardCategoryCreate` · `boardCategoryUpdate` · `boardCategoryDelete` | да | категории досок |
| `taskCreate` · `taskUpdate` · `taskDelete` · `taskActivity` | да | задачи и записи их журнала |
| `taskChecklistUpdate` · `taskChecklistDelete` | да | чек-листы задач |
| `boardRuleUpdate` · `boardRuleDelete` | да | правила автоматизации доски |
| `taskGitLinksUpdate` | да | Git-связи задачи |
| `taskNotice` | по условию | уведомление человека о задаче — только боту, которого он выбрал |

### Прочее

| Событие | Боту | Описание |
|---|---|---|
| `notesCreate` · `notesUpdate` · `notesDelete` | нет | полки заметок — только людям |
| `diskItemUpsert` · `diskItemRemove` | нет | Диск — у ботов пока нет доступа |

> [!TIP]
> Новые события появляются без смены версии протокола. Неизвестное поле `dispatch` пропускайте — так бот не сломается при обновлении сервера.
