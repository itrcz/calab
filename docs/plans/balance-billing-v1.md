# План реализации: баланс, суточные места и Точка

Дата: 2026-10-09. Контракт: [ADR-0080 v3.1](../adr/0080-seat-billing.md).
База кода: `8fdf1b9d907de88173dd8e6c82950bb75bc082df`; ветка `codex/seat-billing`.
Работает лид без субагентов. Только документация в текущей поставке; включение денег и
публикация новой оферты не являются побочным эффектом принятия ADR.

## P0 — зафиксировать договор и внешние контракты

Результат: дневные цены 600/1800 копеек, 24h, auto-topup на 30 суток,
7-дневный долг и ежедневные auto-попытки, receipt/provider capability matrix,
Global USD 10/30 cents и будущий Stripe adapter. Детальные контракты:
[счета, реквизиты и админка](billing-invoices-and-payers.md), [FIFO и масштабирование](billing-fifo-and-scale.md).
Источники — ADR и владелец, не предположения исполнителя. До завершения можно реализовать
чистое ядро/fake provider; bank autocharge и enforcement запрещены.

Разрешённые пути: `docs/adr/0080-seat-billing.md`, этот план, два приложения выше,
`docs/legal/README.md`, индекс ADR.
Не менять юридический текст production, env, secret stores, grants и схемы денег вслепую.
После ответа банка сохранить обезличенные request/response fixtures в будущий
`apps/server/internal/billing/providers/tochka/testdata/` без токенов/PII.

Банку нужен конкретный запрос на проверку, **здесь подготовка, не отправка**:

1. Авансовое пополнение сервиса картой/СБП/счётом и дальнейшая оплата суток: какой
   фискальный партнёр оформляет и получение аванса, и зачёт, и возврат? Как связать
   зачёты с несколькими исходными пополнениями, допустима ли группировка? АУСН, без НДС.
2. CreatePayment: формат уникального paymentLinkId, TTL/cancel, повторная оплата ссылки,
   восстановление после timeout create; canonical payment ID в webhook/status/выписке.
3. Invoice: частичная/повторная/избыточная/поздняя оплата; связь documentId с каждым
   входящим paymentId; как отличить settlement эквайринга от прямого платежа клиента?
4. Optional ChargeSubscription: идентификатор **каждой** попытки, idempotency, timeout
   recovery, decline event/status/time, различение двух платежей с одинаковой суммой.
5. Первая привязка, смена/отмена mandate; `Cancelled` и ещё живая ссылка; минимумы/лимиты,
   sandbox coverage card/sbp/invoice/recurring/refund, доступные тесты отказов.
6. Возврат частями на карту/СБП/расчётный счёт: API или оператор, устойчивый id исполнения,
   отражение в выписке/чеках. Не использовать общий refund API для recurring без подтверждения.

## P1 — денежное ядро, schema/proto, fake clock

Зависимость: ADR v3.1, реальные платежи остаются под флагами до provider/fiscal acceptance.
Разрешено: `apps/server/internal/billing/`, SQL migrations/queries/generated,
`proto/calaba/v1/billing.proto`, additive workspace/event proto, generated protocol,
конфигурация, тесты. Запрещено: live provider/credentials, включение flags, изменение
прежних ручных планов, новая миграция из текущего числа людей в платные обязательства.

Результат: account, immutable balanced journal/postings, funding/allocations, reservations,
price/discount history, дневные lots/events, request idempotency, fake provider, clock.
Добавить версионируемые payer schemas/IDs, command FIFO на account, schedule/head/cursor,
leases/fencing, индексы due/open lots/debts. Нельзя обходить head посредством SKIP LOCKED
внутри account; сетевые pending/unknown не держат денежную очередь.
Один автор всех SQL/proto/interfaces. Записать номера миграций/полей и порядок locks до
подключения зависимых handlers. `make gen`, drift, целевые unit/integration PG17/race.

Готовность: математические сценарии ниже, constraint-level uniqueness, concurrency debit/
refund/credit, rollback составного действия. Документировать API DTO и error reasons из ADR,
никаких `float64` для денег и «balance += amount» без journal; валюта/market не берутся из locale клиента.

## P2 — ручное пополнение и счёт

Зависимость: P1 + bank gates для manual card/sbp/invoice/fiscalization.
Разрешено: billing provider adapter, inbox/reconcile jobs, app wiring/routes, receipt adapter,
mail templates/outbox и contract tests. Запрещено: автоматические charge и production flags.

Результат: hosted card/SBP, invoice PDF, incoming transfers/status reconciliation, manual
review для неоднозначных переводов, отдельная обработка settlement. Checker каждые 5 минут
на receiving account, overlap 7 дней, ежедневная сверка 90 дней, durable cursor после полного
импорта; матчинг reference+плательщик, fallback только verified sender и единственный invoice. Credit подтверждённой
операции атомарен с journal/outbox. Чек и email имеют свой статус, не переоплачивают intent.
Refund v1 может исполнять оператор, но reservation/reconciliation обязательны.

Готовность: webhook+polling+statement дают один credit; partial invoice точно отражается;
нет credit от redirect, paid status без денежной идентичности, платёжки пользователя или
bank settlement. Crash/timeout/late payment покрыты. Sandbox evidence не заменяет live pilot.

## P3 — места, тариф и сквозные запреты

Зависимость: P1, 7-дневная debt policy; P2 может проверяться fake funding.
Разрешено: workspaces/auth/roles/email invites/guests/bots/directory admission, plans,
DB admission, RTC/gateway/files/messages/boards/recording/integrations и их тесты.
Запрещено: менять `computePermissions` ради выдачи платных прав, списывать деньги за ботов,
глобально блокировать user/DM, очищать административную suspension успешной оплатой.

Результат: every member mutation участвует в seat accounting; продление 24h, повторное
занятие купленного места, отрицательный баланс, неизменный negative_since, suspension/recovery. Классификация
всех маршрутов с тестом полноты, shared server gate и проверка выдачи/доставки данных.

Готовность: старая версия клиента, bot/OAuth/API/public link и живой SFU token не обходят
запрет. При race paid capacity/списание и membership согласованы; снятие запрета после
оплаты не снимает модерацию/identity. Проверены уже открытый голос и два API instances.

## P4 — кабинет, админка, новая редакция публичных документов

Зависимость: P1–P3, завершённый wire contract. Разрешено: общие renderer services/stores,
PlanTab/admin UI/i18n, landing/legal content, профильные docs. Запрещено: card form в
renderer, доступ non-owner к деньгам, публикация неверифицированных банковских обещаний.

Результат: баланс/расход/прогноз, 3 метода пополнения, history/receipts/refunds, stop/change,
owner paywall/employee stub; формы Private Person / Organization по стране с ИП/ОГРН.
Админка: все payments/credits/invoices/disputes, matching/split, void, detach/reverse invoice
payment, manual verified bank credit/admin adjustment, refund; preview/reason/revision/audit.
Ручная коррекция не отменяется следующим checker; bank refund и chargeback разделены. Отдельные действия
«выключить автопополнение» и «остановить платный тариф». Цена 6/18 ₽ за человека за 24h.
Юридические страницы 3.0.3 архивируются по version/hash и обновляются под аванс, не monthly/yearly.

Готовность: typecheck/lint затронутых слоёв, один manual screenshot QA desktop/mobile,
явные pending/unknown/debt/suspended states, old client server denial. Visual suites выключены.

## P5 — необязательное автопополнение

Зависимость: P2 + отдельно подтверждённая безопасная recurrent correlation/timeout recovery.
Разрешено: mandates/consents/autotopup settings/jobs/provider/UI и тесты. Если bank gate
не закрыт, этот этап остаётся выключенным независимо от готовности ручных методов.

Результат: запас 30×N×day_price (+ долг, если подтверждено), owner max amount,
одна попытка раз в 24h при продолжающейся потребности до suspension, отказ/отзыв/race
с ручным пополнением. Unknown сначала сверяется, даже если сутки прошли. Неявного
расширения лимита после роста команды нет. Первое списание при подключении подтверждается
пользователем и полностью зачисляется на баланс.

Готовность: unknown не повторяет charge; manual funding отменяет unsent retries, late
success не теряется; consent withdrawal сериализован с dispatch; второй новый charge
внутри 24h невозможен даже после restart. На каждый настоящий отказ — отдельное письмо.

## P6 — приёмка и пилот

Без нового поручения владельца агенты не запускаются. Независимые security/protocol reviews
перед включением денег остаются gate, не объявляются выполненными самостоятельной проверкой.

1. Собрать связный diff и exact SHA: `make gen` + drift, `make lint` из корня,
   targeted unit/race/integration и один полный server integration на PG17 перед merge.
   PG18 support сохраняется, второй полный прогон не требуется.
2. Shadow с fake funding: никаких реальных задолженностей, банковских запросов/писем/
   ограничений. Проверить остатки, расходы и будущие due jobs на нескольких составах.
3. Раздельные sandbox credentials/DB/Redis/порты. Fixtures не печатают секреты. Chaos:
   DB/Redis/provider down, webhook reordered, lease expiry, mixed API versions.
   Нагрузочная приёмка по приложению FIFO: 100k accounts/5m people/10m historical journals,
   200 account ops/s, burst 100k due, hot account/fairness и EXPLAIN рабочих запросов.
   Зафиксировать стенд и измерения; до такого прогона не заявлять ёмкость подтверждённой.
4. Верифицированный live pilot с явно разрешёнными суммой/инструментом и тестовым workspace:
   по одному каждой включаемой операции, возврат и fiscal evidence. Реальный charge не
   запускается автоматически только потому, что fake тесты прошли.
5. Опубликовать согласованные документы перед доступностью checkout; включить manual
   methods/debits/enforcement только для allowlist. Auto-topup отдельным gate/flag.
6. Наблюдать reconciliation/ledger/receipt/mail/policy metrics. Rollback выключает новые
   writers совместимым binary, сохраняет inbox/refunds; старый binary не использовать.

## Проверяемые сценарии (fixture: без скидки, Team 600 / Business 1800 копеек)

| № | Сценарий | Ожидание |
|---|---|---|
| M1 | Team, баланс 10 000, 10 людей, первая активация | Debit 6 000, available 4 000, 10 мест ровно на 24h |
| M2 | Добавить 2 человека через 6h | Debit 1 200, available 2 800; их expiry на 6h позже исходных |
| M3 | Удалить 1, принять замену до expiry | Debit 0, ёмкость и исходное expiry сохраняются |
| M4 | Удалить 2 до первого expiry: N=10, более поздних мест 2 | На первой границе нужно продлить 8, debit 4 800 при достаточном балансе |
| M5 | Баланс 600, активировать 1 Team | Available 0; оплаченные сутки доступны полностью |
| M6 | Активированный account, баланс 1, следующие 10 Team | Debit 6 000, balance −5 999, negative_since впервые зафиксирован, срок +7d |
| M7 | 5 человек Business RU на сутки | Debit 9 000; запас на 30 суток 270 000 копеек плюс долг по утверждённой формуле |
| M8 | Скидка Team 10%, покупка 3 суток-мест | Unit 540, debit 1 620; topup 10 000 кредитует 10 000 |
| M9 | Скидка истекла после покупки | Уже оплаченные lots без изменений; следующий debit проверяет уведомление/согласие |
| M10 | Отказ от 2 Team мест за половину оплаченных суток | Возврат неиспользованной стоимости 600 копеек, без двойного возврата |
| M11 | Auto-topup 10 Team RU без долга | A=180 000 копеек; один credit; дальше отдельные daily debits |
| M12 | Два пополнения 1 000 и 2 000, расход 1 200 | Allocations FIFO: первое 1 000, второе 200; остаток второго 1 800 |
| M13 | Global, 10 Team / 10 Business | Daily debit 100 / 300 cents; запас 30d $30 / $90, без FX |
| M14 | Долг 10 000, пополнение 4 000 | Balance −6 000, negative_since не меняется |
| M15 | Долг 10 000, пополнение 16 000 | 10 000 погашает старые услуги, 6 000 становится авансом; episode закрывается после due catch-up |
| M16 | На исходном suspend_at остаётся −1 | Полная suspension, новые daily debits и auto-topups остановлены |
| M17 | Долг 10 000 и recovery 10 Team | Quote 16 000; после оплаты 10 000 на долг и 6 000 на первые новые сутки |
| M18 | Осталось 6h до suspend_at, lot на 1 Team | Начислить 150 копеек за 6h, не полные 600 за недоступные 24h |
| M19 | Отказ от половины lot, купленного полностью в долг | Уменьшить receivable, не вернуть клиенту деньги, которых не получали |

M4 — самостоятельная fixture с достаточным пополнением, не продолжение недостаточного
остатка M2. Все времена fake clock; на границе ровно `t=covered_until` old lot уже истёк.

| № | Гонка/сбой | Ожидание |
|---|---|---|
| R1 | Два worker пытаются продлить один interval | Один journal и один entitlement |
| R2 | Два simultaneous join на одно свободное место | Один занимает резерв; второй покупает сутки, при запрещённой отсрочке отказ |
| R3 | Join/payment succeeds locally, membership SQL fails | Откат debit и lots вместе с membership |
| R4 | Card webhook + status poll + statement | Один canonical transaction и один credit |
| R5 | Settlement приобретённого эквайринга в выписке | Не новый пользовательский credit |
| R6 | Invoice оплачен двумя переводами / переплачен / оплачен после expiry | Фактические подтверждённые суммы учтены один раз; invoice aggregate корректен |
| R7 | Одинаковые суммы двух workspace одного ИНН | Reference определяет account; иначе review, не угадывание |
| R8 | Timeout auto-charge, restart, retry job | Unknown; повтор банковского POST не отправляется |
| R9 | Успех SBP при ожидающем auto-retry | Unsent отменяется; in-flight сверяется и late credit учитывается |
| R10 | Concurrent reserve refund + daily debit | Резерв уменьшает свободный balance; capture не списывает второй раз, release гасит долг; минус только для мест |
| R11 | Пришёл bank success, fiscal/SMTP упал | Баланс зачислен, receipt/mail retry, повтор charge отсутствует |
| R12 | Отключили auto-topup | Нет новых charge; daily debit внесённого аванса продолжается до отдельного stop |
| R13 | Повторные отказы auto-topup и рестарты | Между новыми dispatch ≥24h; на каждый реальный отказ письмо; unknown не порождает retry |
| R14 | Малое пополнение, которое оставляет минус | Negative_since и suspend_at не сдвигаются |
| R15 | Удалили людей при долге | Будущий расход меньше; уже оказанная услуга/negative_since остаются |
| R16 | Цена/состав выросли выше max_auto_topup | Нужен owner confirmation, не молчаливое превышение |
| R17 | Остановка/смена плана при разно-временных lots | Нет двойной платы и потерянного неиспользованного остатка |
| R18 | Удалён workspace, пришёл late payment | Ledger не потерян, operator refund; новые права не создаются |
| R19 | Поддельный/повторный/неизвестный webhook | Reject / один credit / review соответственно |
| R20 | Worker опоздал на несколько дней с изменениями членов | Расчёт по историческим событиям; negative_since исторический, остановка расходов точно на suspend_at |
| R21 | Stop/Free/смена owner/карты при долге | Исходный debt deadline остаётся, admin suspension тоже |
| R22 | Создать Global intent для RUB account | Отказ; валюта, merchant и provider не подменяются |
| R23 | Добавление людей в период разрешённого минуса | Суточное начисление в долг атомарно с membership; scope/plan caps соблюдены |
| R24 | Add-on/refund пытается уйти в минус | Отказ: разрешение отсрочки только для мест |

Дополнительно обязательны все 12 сценариев приложения счетов и 7 FIFO/invariant сценариев
приложения масштабирования: профиль/snapshot, cursor outage, ручные corrections, partial/
overpayment, duplicates, порядок head, stale worker и поздние банковские события.

Security acceptance: owner vs admin/bot/guest/OAuth, межпространственные id, admin suspension,
identity step-up, upload/finalize/reuse, media reconnect/token replay, suspended public
links/notifications/exports, cache/Redis failure и измеренное окно отзыва RTC/WS.

## G1 — Global / Stripe после RU

Зависимость: единое ядро с currency/market с P1, merchant/юрлицо Global, налоги/документы,
отдельный Stripe sandbox. Цены owner: Team 10 / Business 30 cents за 24h; общая policy долга.
Разрешено: новый provider adapter/capabilities, Global catalogue/terms/privacy, UI валюты,
contract fixtures/test clock. Запрещено: FX перенос RUB→USD, переключение рынка по locale,
автоматический fallback RU денег на Stripe, перенос RU реквизитов без решения продавца.

Результат: Checkout/PaymentIntent/manual topup; optional off-session consent/SetupIntent,
raw-body webhook verification, idempotency + durable reconciliation, refunds, tax mapping.
Stripe Subscription на месяц не используется как второй scheduler суточных мест.
Готовность: duplicate/reordered events, requires_action, unknown после >24h idempotency
retention, одинаковые суммы, cross-account/currency rejection, live evidence/возврат.

## Evidence на каждом этапе

Версия ADR + base/implementation SHA, разрешённые пути, выполненные команды/среда/результат,
отдельно skipped/unavailable и внешние ответы. Docs-only не требует полного Go/renderer
прогона: проверить ссылки, согласованность цифр/сценариев, `git diff --check`.
Не помечать bank live/чеки/reviews passed по наличию scaffolding или fake provider.
