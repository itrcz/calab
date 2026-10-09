# План реализации: USD-баланс и Stripe, затем RUB / Точка

Дата: 2026-10-09. Контракт: [ADR-0080 v4.0](../adr/0080-seat-billing.md).
База кода: `8fdf1b9d907de88173dd8e6c82950bb75bc082df`; исходное ревью: `e7c825ca`.
Ветка: `codex/seat-billing`. Работает лид без субагентов. Текущая поставка — документация;
реализация, обновление публичных условий и live payments выполняются отдельными этапами.
Приложения: [Stripe](billing-stripe-v1.md), [счета/плательщики](billing-invoices-and-payers.md),
[FIFO/нагрузка/restore](billing-fifo-and-scale.md), [налоги/документы](billing-tax-and-documents.md).

## P0 — продавец, условия и внешний контракт Stripe

Решение владельца: Global/USD первый, Team 10 / Business 30 cents за 24h; продавец
Unne L.L.C-FZ, UAE (Dubai), выплаты в AED. Цены USD без применимого налога. RUB 600/1800 копеек и Точка позже.
Auto-topup = долг + 30 суток текущей команды, не чаще одной новой попытки в 24h.
Семь дней в минусе для текущей команды; рост платных мест требует аванса, карантина нет.

Разрешено: ADR, этот план и приложения, индекс ADR, `docs/legal/README.md`.
Не публиковать неподтверждённые условия и не заполнять секреты/merchant ID выдуманными данными.
Открыты licence/registration number, VAT-статус Unne, налоговый момент аванса/долга и шаблоны
Global terms/invoice/refund/privacy. TRN 105410888900001 из выписки сохранён непроверенным;
его формат не соответствует VAT ID (окончание 01 вместо 03), не использовать как VAT TRN.
Шаблоны RU/АУСН относятся только к ООО «Громтех» и не заменяют документы Global seller.

Для Stripe проверить account/API version/test mode, USD card и min/max top-up,
Checkout→PI→Charge identity, idempotency/unknown recovery, SCA/off-session/отзыв,
refund/dispute events, источники success timestamp, fees и AED settlement отдельно.
UAE отсутствует в текущей опубликованной eligibility-таблице USD bank transfer: этот
метод выключен, пока не подтверждён конкретный supported route. Local invoice с ссылкой
на card checkout возможен после утверждения юридического шаблона; это не bank transfer.

Готовность: capability matrix seller/country/payer/method, документы/налоговый контракт,
обезличенные fixtures в `internal/billing/providers/stripe/testdata/`, продуктовые решения
в ADR. Незакрытый live gate не запрещает ядро и test adapter; production flags остаются off.

## P1 — денежное ядро и единый wire contract

Зависимость: ADR v4.0. Разрешено: `apps/server/internal/billing/`, SQL migrations/queries/
generated, `proto/calaba/v1/billing.proto`, additive workspace/event proto, generated protocol,
конфигурация и тесты. Запрещено: live keys/charges, включение flags, перенос ручных планов
в платные обязательства и FX-конвертация старых RUB balances.

Результат: accounts с currency/seller, immutable journals/postings, funding source slices,
allocations/reservations, отдельные tax liabilities/receivables и net/tax/gross breakdown,
prices, seat cohorts/events, payer versions, fake provider/clock,
FIFO commands/head/schedule, control epoch, repair records и authoritative balance projection.
Один автор SQL/proto/interfaces до подключения зависимых потребителей. Зафиксировать
migration/field numbers, guards/revisions, idempotency и порядок workspace→account→dependent locks.

Обязательны: атомарность денег+membership, deterministic mixed refund (ADR §9), normalization
возврата в старый долг, maintenance repair вне сломанного head, фиксированный catch-up
watermark, admission без роста в кредит, отдельные confirmed receipt/barrier и Free recovery.
Multi-transaction money saga в v1 отсутствует. Нет float64, прямого PATCH balance и проверки
прав по replica; SKIP LOCKED выбирает accounts, а не пропускает старые funding lots.

Готовность: unit/property/fake-clock + targeted PG17 integration/race, `make gen` и drift,
constraint-level duplicates, rollback целой команды, currency/payer ownership rejection.
Математические и конфликтные сценарии ниже проходят на точном SHA.

## P2 — ручная Stripe-карта и документы на оплату

Зависимость: P1 + test merchant/capabilities. Разрешено: Stripe adapter, inbox/reconcile,
app wiring/routes, tax/document adapter, outbox и contract tests. Auto-topup/live flags off.

Результат: hosted Checkout mode=payment, Customer per billing account, PI canonical credit,
raw-body signature verification, versioned webhook DTO, pagination/cursors, pending/unknown
и refund/dispute. Completed redirect не выдаёт деньги; funded/cash balance/PI/Charge/payout
различаются. Сохраняем service net + tax = gross USD customer amount; wallet credit только
net, отдельно AED settlement/fees. Встроенный Checkout Tax и custom Tax/PI flow имеют
одну tax transaction на продажу, без повторного налога при расходовании аванса.
Invoice и квитанция привязаны к seller/payer version, сроку и способу, который доступен.

Готовность: duplicate/reordered Checkout/PI/Charge events дают один credit; обработаны timeout,
requires_action, late success, wrong Customer/seller/currency/test-mode, orphan и refunds.
Рассылка/налоговый документ не кредитуют платёж повторно при своих сбоях.

### P2b — USD bank transfer, только после подтверждения доступности

Это независимый capability, **не гарантирован для UAE** и не обязательный gate USD card pilot.
Подтвердить supported receiving route, buyer/payer type, partial payments/refunds и юридический
invoice. Для Stripe customer_balance — manual reconciliation и collection фактической суммы
через PI (Stripe-приложение §4); credit только после succeeded. Микропереводы ниже minimum
показываются pending collection, не исчезают. Прямой банковский счёт продавца потребует
отдельного адаптера выписки и ADR; нельзя подменить его данными Точки или картой.

## P3 — места, долг, восстановление и сквозной доступ

Зависимость: P1; funding может быть fake. Разрешено: workspaces/auth/roles/invites/guests/
bots/directory admission, plans, DB boundaries, RTC/gateway/files/messages/boards/recordings/
integrations. Не менять computePermissions ради выдачи платных прав; не блокировать identity
пользователя/его другие spaces/DMs, не снимать admin suspension успешным платежом.

Результат: все membership mutations проходят billing, сутки rolling24h, замена в покрытой
capacity без debit, renewal текущего состава в долг до deadline, новые места только за аванс.
Первая операция роста не может сама уйти в минус. Downgrade/stop не сбрасывают deadline.
Stop фиксирует время приёма и прекращает future dispatch сразу через control state.

Перед suspension — receipt barrier; оплаченный вовремя клиент не блокируется из-за очереди.
После оплаты долга resume_free открывает Free без покупки суток; resume_paid покупает новые
сутки. Нужна полная route inventory: старый клиент, OAuth/bot/API, public link, exports,
upload/finalize, открытый RTC/WS token и data delivery не обходят policy.

Готовность: два API instances, DB/Redis/cache failures, deadlines по DB time, отзыв RTC/WS,
admin/identity restrictions сохраняются, сумма не начисляется за suspended interval.

## P4 — кабинет, админка и Global terms

Зависимость: P1–P3, wire contract, данные Global seller. Разрешено: renderer services/stores,
PlanTab/AdminWindow/i18n, landing/legal content и профильные docs. Не встраивать card form
в renderer и не выдавать non-owner финансовые реквизиты.

Результат: USD по умолчанию для новых Global accounts, цены $0.10/$0.30 за человека за сутки
без применимого налога; до оплаты и в receipt/invoice — net/tax/gross,
доступные способы пополнения, баланс/debt/reserved/refundable, forecast/history/documents,
owner paywall и employee stub. Private Person/Organization — страновые схемы реквизитов.
Админка: все payments/credits/invoices, matching/split, void, detach/reverse credit,
verified manual funding/admin adjustment, refunds/disputes и maintenance repair. Preview,
reason/revision/request_id/step-up/audit обязательны. «Остановить тариф» и «Отключить auto»
различаются; resume_free и resume_paid имеют разные котировки.

Публичные месячные/годовые тексты 3.0.3 архивируются по version/hash. Новые Global terms
содержат правильного продавца Unne, USD, суточный аванс/кредит, семь дней, запрет роста
в долг, налоги, способы оплаты/возврата и Stripe data processing. Их публикация — отдельный
этап, не побочный эффект merge текущего ADR.
Готовность: targeted typecheck/lint и один manual screenshot QA desktop/mobile; visual suites off.

## P5 — optional auto-topup и безопасное восстановление

Зависимость: P2 + owner consent, подтверждённый off-session flow, внешний dispatch fence/
manifest. Разрешено: setup/mandate/consents/settings/jobs/provider/UI и профильные тесты.

A_net = max(0, -balance) + 30 × N × effective_daily_price; tax engine добавляет только
подлежащий оплате налог долга/аванса. Лимит owner проверяется по A_gross; новый charge
не чаще 24h. Сохранённая карта не включает auto. Unknown сначала сверяется; requires_action
продолжается в том же PI. На каждый реальный отказ — письмо. Ручное пополнение отменяет
unsent повтор, но не скрывает возможный late success уже отправленного intent.

До live внедрить FIFO §6: manifest вне восстанавливаемой БД, deployment/control epoch,
provider writes off после restore, восстановление consent/stop, сверка потерянного окна.
Drill с backup до HTTP и bank success после него не создаёт второй charge/refund.
Готовность: consent race, stale worker, same amount attempts, unknown >24h, restore и
инварианты реестра подтверждены evidence; ключи/карточные данные не попадают в fixtures/logs.

## P6 — приёмка, shadow и пилот USD

Без нового поручения владельца субагенты не запускаются. Независимые security/protocol
reviews до реальных денег — отдельный gate, не подменяются самостоятельной проверкой.

1. Exact SHA: `make gen` + drift, `make lint` из корня, targeted unit/race/integration;
   полный server integration на PG17 один раз перед merge. Поддержка PG18 сохраняется.
2. Shadow fake funding без денег/писем/ограничений; отдельные test DB/Redis/порты/Stripe mode.
3. Load по FIFO-приложению: 100k accounts/5m people/10m historical journals, 200 ops/s,
   burst100k, hot-account fairness, EXPLAIN. Фиксировать стенд, SHA, команды/результаты.
4. Проверить recovery/restore/repair, mixed refund, receipt barrier, no-credit-growth,
   resume_free, signer/owner boundaries и failure provider/fiscal/mail без повторного charge.
5. Согласованные Global terms доступны до checkout; отдельный разрешённый live pilot с
   суммой/инструментом, refund, документом и evidence. Card и auto/transfer flags раздельные.
6. Rollback использует совместимый binary/flags, сохраняет inbox/refunds/repair. Старый
   binary без billing policy не выкатывать. Gates RUB не блокируют проверенный USD scope.

## Денежные сценарии: основной USD, суммы в cents

M1–M23 — net money fixtures с явно заданным tax=0, не налоговый режим Unne.
Отдельные налоговые сценарии — в налоговом приложении: $100+$5=$105, auto $32+$1.60=$33.60,
original-source refund, отсутствие повторного налога и непогашенный tax_due.

| № | Сценарий | Ожидание |
|---|---|---|
| M1 | Team, balance1000, 10 людей, activate | Debit100, balance900, 24h |
| M2 | Добавить ещё2 через6h после M1 | Debit20, balance880; их expiry на6h позже |
| M3 | Удалить человека и заменить в покрытой capacity | Debit0, первоначальный expiry |
| M4 | N=10, из них2 места живут дольше первой границы | Renewal8, debit80 при достаточном авансе |
| M5 | 1 Team, balance10, activate | Balance0, полные оплаченные сутки |
| M6 | Renewal10 Team, balance1 | Debit100, balance−99, начало episode, deadline+7d |
| M7 | 5 Business | Daily150, reserve30d4500 ($45) |
| M8 | Team discount10%, 3 места | Unit9, debit27; top-up1000 зачисляет1000 |
| M9 | Скидка закончилась | Старые lots неизменны, повышение требует notice/consent |
| M10 | Отказ от2 полностью оплаченных Team за половину суток | Компенсация10, без повторной отмены capacity |
| M11 | 10 Team, долг200 | Auto A=200+3000=3200 ($32) |
| M12 | Funding1000+2000, debit1200 | FIFO1000+200, остаток1800 |
| M13 | Вторичный RUB: 10 Team/Business | Daily6000/18000 копеек, reserve180000/540000; без FX |
| M14 | Debt1000, top-up400 | Balance−600, исходный deadline |
| M15 | Debt1000, top-up1100 | 1000 на старые charges, 100 аванс; episode после due catch-up |
| M16 | Balance−1 на deadline | Full suspension, нет новых service intervals/auto dispatch |
| M17 | Debt1000, resume_paid10 Team | Quote1100; долг1000 + первые сутки100 |
| M18 | 1 Team, до deadline6h | Пропорция10×6/24=2.5 → debit3 cents half-up |
| M19 | Возврат части lot целиком в долг | Уменьшить receivable, cash refund0 |
| M20 | Charge10=5cash+3admin+2debt, вернуть5 | Отменить2debt+3admin, cash0; повторные части дают тот же итог |
| M21 | Stop, debt1000, оплатить1000, resume_free | Free без покупки Team/Business и снятия admin/identity restrictions |
| M22 | Оплачен1 Team, balance0, join ещё499 | 409, ни membership, ни credit debit; первый уход в минус через growth запрещён |
| M23 | Debt есть, одно свободное покрытое место | Замена без debit разрешена; новое место сверх capacity запрещено |

Все времена fake clock, интервалы half-open. Proration/отмена привязаны к исходному charge:
SQL batching не меняет его quantity, цену или округление. RUB сценарии — совместимость
ядра, не требование запускать Точку до USD.

Конфликтные сценарии из трёх приложений обязательны: дубли источников, stale leases,
broken head/repair, durable receipt before deadline, late/partial/overpayment, payout,
manual reversal, pending refund, crash/restore, strict FIFO и большие очереди. Изменения
членства rollback вместе с debit. Количество кейсов не заменяет route/transition coverage.

## R1 — RUB / Точка после USD

Зависимость: общее ядро и проверенный Stripe scope; собственные merchant/документы/фискальный
партнёр RU. Разрешено: `providers/tochka`, RUB card/SBP/invoice capabilities, fixtures,
русская редакция условий под баланс. Не менять существующие USD accounts, не делать FX
или отправлять USD клиента на Точку без нового договора/явного выбора.

Проверить stable external IDs, incomingPayment/Init/Get Statement, различение settlement,
partial/overpayment/late invoice, payer type support (особенно person), recurring correlation,
timeout recovery, возвраты и чеки АУСН/без НДС. Сверка incremental с небольшим overlap;
исторические7/90 дней — отдельные разнесённые jobs, не перечитывание всей недели каждые5min.
Чеки аванса/зачёта/постоплаты/возврата подтверждает фискальный партнёр, не Stripe receipt.

## Evidence

Версия ADR + exact SHA, разрешённые пути, команды/среда/результат, skipped/unavailable,
provider fixtures и внешние ответы. Docs-only: ссылки, арифметика, согласованность решений,
`git diff --check`. Application/load/live/независимое review не считаются пройденными по тексту.
