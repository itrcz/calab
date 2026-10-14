# 19 — Bot API (переехал)

Документация для разработчиков ботов переехала на сайт (ADR-0099): раздел «Боты и интеграционный API» —
`/ru/docs/bots` (English: `/en/docs/bots`), справочник маршрутов — `/ru/docs/reference/routes`.

Исходники — в репозитории, правьте их, а не этот файл:

- `apps/landing/src/content/docs/ru/bots/*.md` и `apps/landing/src/content/docs/en/bots/*.md` — главы (быстрый старт,
  токен и права, REST по группам, gateway, команды и кнопки, вебхуки, уведомления о задачах, SDK, ошибки и лимиты,
  журнал изменений);
- `apps/landing/src/content/docs/{ru,en}/reference/*.md` — маршруты, события gateway, коды ошибок, лимиты, токены, версия;
- `apps/landing/src/content/docs/nav.ts` — навигация.

Источник правды по-прежнему код: `apps/server/internal/app/botroutes.go` (решение для ботов по каждому маршруту) и
`proto/calaba/v1/*.proto` (поля и события).
