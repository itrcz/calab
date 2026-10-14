# Глоссарий локализации (ADR-0022)

Единые термины для всех словарей (`apps/desktop/src/renderer/i18n/<locale>/*.ts`). Источник правды — `ru`; `en` — базовый для переводов на `es` и `zh-CN`. Колонки `es`/`zh-CN` — рекомендация для будущих переводчиков (проверка носителями — позже).

## Стиль

- **en**: продуктовый английский в духе Slack/Discord. *Sentence case* везде (кнопки, заголовки, пункты меню): «Create room», не «Create Room». Коротко, активный залог, без «please» в кнопках. Второе лицо («you»). Без точки в конце кнопок, пунктов меню, тостов из одной фразы; с точкой — в подсказках из полных предложений (как в `ru`).
- Кавычки-«ёлочки» `«…»` в `ru` → в `en` обычные двойные “…” (типографские), в `es` «…», в `zh-CN` “…”.
- Многоточие `…` в пункте меню/кнопке сохраняется (открывает диалог).
- Плейсхолдеры `{x}` — те же имена, что в `ru`, переставлять можно, удалять/переименовывать нельзя (проверяет `i18n.keys.test.ts`).
- Множественное число — только через ключи-объекты форм (`{ one, few, many, other }` для `ru`; `{ one, other }` для `en`/`es`; `{ other }` для `zh-CN`) и `plural(key, n)`. Склеивать число и слово в коде нельзя.
- Горячие клавиши, названия ОС-разделов (System Settings, Privacy & Security) — как в самой ОС на этом языке.
- Имя продукта — **Calab** (не переводится и не склоняется в `en`).

## Термины

| ru | en | es | zh-CN | Примечание |
|---|---|---|---|---|
| пространство | workspace | espacio | 工作区 | Верхний уровень (как Slack workspace / Discord server) |
| комната | room | sala | 房间 | Текстовая/голосовая; не «channel» |
| голосовая комната | voice room | sala de voz | 语音房间 | |
| категория | category | categoría | 分类 | |
| в голосе | in voice | en voz | 语音中 | «Вы в голосе» = “You're in voice” |
| подключиться к голосу | join voice | unirse a la voz | 加入语音 | |
| отключиться (от голоса) | disconnect / leave voice | desconectar | 断开 | |
| стрим, показ экрана | screen share (сущ.), share screen (глагол) | pantalla compartida / compartir pantalla | 屏幕共享 | «Стримить» = “Share”; «стример» = “presenter” |
| смотреть стрим | watch | ver | 观看 | «3 смотрят» = “3 watching” |
| камера | camera | cámara | 摄像头 | |
| микрофон выключен | muted | silenciado | 已静音 | Кнопка: “Mute” / “Unmute” |
| выключить звук (всех) | deafen | ensordecer | 关闭声音 | Кнопка: “Deafen” / “Undeafen” |
| заглушить для меня | mute for me | silenciar para mí | 对我静音 | Локально |
| не слышать | stop hearing / “Don't hear” | no escuchar | 不收听 | Локально, голос + звук стрима |
| push-to-talk (PTT) | push-to-talk | pulsar para hablar | 按键说话 | |
| порог активации | input sensitivity / activation threshold | umbral de activación | 激活阈值 | |
| шумодав | noise suppression | supresión de ruido | 降噪 | |
| эхоподавление | echo cancellation | cancelación de eco | 回声消除 | |
| устройство ввода / вывода | input / output device | dispositivo de entrada / salida | 输入 / 输出设备 | |
| участник | member | miembro | 成员 | В составе пространства; в комнате — “people in room” |
| владелец | owner | propietario | 所有者 | |
| администратор | admin | administrador | 管理员 | |
| модератор | moderator | moderador | 版主 | |
| гость | guest | invitado | 访客 | |
| приглашение | invite | invitación | 邀请 | Сущ. и глагол “Invite” |
| ссылка на комнату | room link | enlace de la sala | 房间链接 | |
| закрепить / закреплённые | pin / pinned | fijar / fijados | 置顶 / 已置顶 | |
| упоминание, упомянуть | mention | mención | 提及 | |
| личные сообщения (ЛС) | direct messages (DMs) | mensajes directos | 私信 | Одиночный — “direct message”, коротко “DM” |
| ответить | reply | responder | 回复 | |
| реакция | reaction | reacción | 表情回应 | |
| непрочитанные | unread | no leídos | 未读 | |
| в сети | online | en línea | 在线 | |
| отошёл | idle / away | ausente | 离开 | Статус: “Idle” |
| не беспокоить | do not disturb | no molestar | 请勿打扰 | |
| невидимка | invisible | invisible | 隐身 | |
| статус (текст) | status | estado | 状态 | |
| профиль | profile | perfil | 个人资料 | |
| никнейм (в пространстве) | nickname | apodo | 昵称 | |
| роль | role | rol | 角色 | |
| разрешения (права) | permissions | permisos | 权限 | |
| настройки | settings | ajustes | 设置 | |
| уведомления | notifications | notificaciones | 通知 | |
| звуки | sounds | sonidos | 提示音 | |
| онбординг | setup / onboarding (внутр.) | configuración inicial | 初始设置 | В UI — “Get started” |
| сервер | server | servidor | 服务器 | Адрес сервера команды |
| сессия, устройство | session, device | sesión, dispositivo | 会话、设备 | |
| битрейт | bitrate | tasa de bits | 码率 | |
| качество | quality | calidad | 质量 | |
| экономить трафик | data saver | ahorro de datos | 省流量 | |
| соединение | connection | conexión | 连接 | «Проверить соединение» = “Test connection” |
| переподключение | reconnecting | reconectando | 正在重新连接 | |
| обновление | update | actualización | 更新 | |
| загрузить (файл) | upload | subir | 上传 | Скачать — download / descargar / 下载 |
| вложение | attachment | adjunto | 附件 | |
| удалить | delete | eliminar | 删除 | Для участника из пространства — “remove” |
| выгнать / отключить от голоса | disconnect (from voice) | desconectar | 断开连接 | |
| переместить | move | mover | 移动 | |
| как в системе | system default / “Use system language” | según el sistema | 跟随系统 | |
| вики | Wiki | Wiki | 维基 | Раздел страниц рабочей области (ADR-0096) |
