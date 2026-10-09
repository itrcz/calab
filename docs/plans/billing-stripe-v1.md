# Stripe v1: основной USD-биллинг Calab

Дата: 2026-10-09. Контракт v1.0 к [ADR-0080 v4.1](../adr/0080-seat-billing.md).
Решение владельца: **USD — основной рынок; Stripe интегрируется первым**. Team — $0.10,
Business — $0.30 за человека за 86400 секунд, без применимого налога. RUB 6/18 ₽ и Точка — следующий этап.
Это проект реализации; live payments и публичные условия этой поставкой не включаются.

## 1. Продавец, методы и единицы денег

Один billing account фиксирует market, currency, seller и payer. Для новых поддерживаемых
Global contracts default USD; язык интерфейса не выбирает продавца/валюту. Stripe settlement
currency и конвертация самим банком покупателя не меняют USD-баланс Calab. Не переводим
старый RUB account в USD и не подключаем ООО «Громтех» к Stripe по умолчанию.

Владелец подтвердил Unne L.L.C-FZ, UAE (Dubai), Stripe AE, settlement AED и продажи в USD.
VAT TRN 105410888900001 подтверждён владельцем как действующая регистрация Unne;
источник подтверждения и налоговый scope — в [налоговом контракте](billing-tax-and-documents.md).
USD bank transfer выключен: AE отсутствует в опубликованной таблице business locations
этого метода. Основной USD card flow проверяется отдельно.
[Stripe UAE: методы и валюты](https://support.stripe.com/questions/which-payments-methods-and-products-are-available-in-the-uae),
[bank-transfer eligibility](https://docs.stripe.com/payments/bank-transfers).

До live нужны проверка приёма реквизитов/настроек регистрации в Stripe account, поддерживаемые
страны покупателей и методы, налоговая классификация, документы и уведомление о передаче данных
Stripe. Секреты находятся в secret store, не в ADR. Страну регистрации нельзя придумать:
[поддерживаемые Stripe страны](https://stripe.com/global).

| Рынок / метод | Первая поставка | Условие |
|---|---|---|
| USD / ручная карта | Основной путь, Stripe-hosted Checkout | Активный merchant, supported buyer country, метод прошёл sandbox/live pilot |
| USD / auto-topup карты | Отдельный flag после ручной карты | Согласие, SetupIntent/payment method, согласованная формула/лимит, off-session acceptance |
| USD / счёт и bank transfer | Отдельный capability первой интеграции | Подтверждена доступность USD transfer для страны merchant/покупателя; поток ниже прошёл приёмку |
| USD / СБП | Недоступно | Не подменяем СБП банковским переводом Stripe |
| RUB / карта, СБП, счёт | Следующий этап, Точка | Собственные merchant/fiscal/method gates |

UI показывает только реально включённые методы для комбинации seller/country/payer type.
Для Private Person и Organization проверяем возможности отдельно. Global schema содержит
национальные registration/tax IDs; обязательный ИНН/ОГРН для всех стран не используется.
Владелец утвердил **tax_exclusive** и затем **отложил VAT**: в первой интеграции
`automatic_tax.enabled=false`, tax rates/Tax API не используются, `tax_status=not_calculated`.
Сайт показывает цену без налога, checkout/invoice/receipt — фактическую сумму без надбавки.
Net=gross, $100 оплачено → $100 на баланс; customer tax_exempt не подделывается.
Stripe Tax и налоговые проводки — отложенный этап из налогового приложения, не требование
v1. Это продуктовый scope, не подтверждение освобождения всех продаж от налогов.

Цены каталога — integer cents 10/30. Минимум/максимум внешнего top-up определяется отдельно
по валюте/методу и merchant settings. Маленькое суточное начисление не превращается в
отдельный банковский charge. Cash balance Stripe, invoice credit balance Stripe и наш
balance — разные сущности, с отдельными полями UI/учёта.

## 2. Ручное пополнение картой

Используем стабильный Customers API и Checkout `mode=payment` с
`invoice_creation.enabled=true`: по решению владельца выдаём Stripe invoice/receipt.
Сохраняем provider document IDs/ссылки, показываем net/tax/gross; invoice относится к
тому же PI и не создаёт вторую оплату или credit. Приёмка включает получение документа
и его реквизиты: [Create Checkout Session](https://docs.stripe.com/api/checkout/sessions/create).
Версия Stripe API закреплена
в adapter (все запросы и перечитывание объектов), смена версии проходит contract fixtures.
События webhook принимаются любой версии (версия аккаунта по умолчанию, `stripe listen`):
читается только конверт (id, type, account, livemode, created, id/metadata/payment_intent
объекта), сам объект перечитывается закреплённой версией; чужая версия — warning один раз и
метрика `calaba_billing_stripe_foreign_version_events_total`. Подпись проверяется строго. Preview API и
Connect marketplace не требуются. Один Stripe Customer привязан к одному billing account
и продавцу: одинаковый ИНН в нескольких пространствах не объединяет balances/средства оплаты.

Локальный intent фиксирует net/tax/gross (v1: tax=0, net=gross), tax policy version,
currency/payer version/seller/request_id до внешнего
вызова. Metadata содержит непривилегированные IDs intent/account/attempt, не секреты/реквизиты.
Stripe ID никогда не принимается от клиента как доказательство принадлежности account.
Create Checkout использует стабильный idempotency key; сеть вне DB tx.

Один acquiring checkout на account; expiry/cancel подтверждаются провайдером. Hosted URL
открывается системным браузером. Success redirect только обновляет UI. Обрабатываем
Checkout completion/async notifications как сигналы для проверки связанного PaymentIntent:
он должен принадлежать нашему Customer/merchant/live-or-test mode, иметь нужную валюту и
успешно полученную **gross** сумму и подтверждённую net/tax разбивку. `processing`, `requires_action`, `requires_capture` не кредитуют
Calab. Авторитетное событие подтверждения — succeeded PaymentIntent после сверки объекта.

Одна успешная оплата создаёт один funding credit по `(stripe_account_id, livemode,
payment_intent_id)`; Charge ID и balance transaction — дополнительные ссылки для сверки.
В wallet идёт net часть (в текущем режиме равна gross); налоговые проводки не создаются.
В отложенном налоговом режиме они будут связаны с тем же PI.
Webhook Checkout, PaymentIntent и Charge не являются тремя пополнениями. До этого credit
может иметь `provider_confirmed / pending_application`, но не spendable balance.

## 3. Необязательное автопополнение

Setup отдельно от ручной покупки: hosted setup flow с SetupIntent либо явное согласие
при платеже с `setup_future_usage=off_session`. Сохранение карты не включает auto-topup.
Согласие фиксирует seller/account, утверждённую формулу **долг + 30 суток текущей команды**,
max **gross** amount с налогом, частоту, version/time и отзыв.
В v1 net долг + net reserve30d = сумма PI, Tax API не вызывается. Для отложенного
налогового этапа нужен отдельный calculation по debt/advance без повторного налога;
настройки `automatic_tax` Checkout не наследуются standalone PI.
Привязка через [SetupIntent](https://docs.stripe.com/api/setup_intents) не выдаёт места
и не создаёт внутренний баланс; отказ/дополнительная аутентификация обрабатываются явно.

Каждая попытка — локальный attempt + один PaymentIntent; off-session confirmation разрешён
только после проверки актуального consent и 24h rate limit. Требование дополнительной
аутентификации возвращает owner в hosted flow для **того же** intent. Это не новый charge
и не разрешение автоматически повторять неудачную аутентификацию другим intent.
После окончательного отказа следующий новый attempt не раньше 24h; unknown сперва сверяется.
Отключение consent блокирует будущий dispatch, а уже отправленный intent доводится до факта.

Для каждого POST фиксируем idempotency key и request hash. Stripe может удалить ключ после
24h; после такого окна нельзя слепо повторять create. Получаем известный PI/refund либо
сверяем журнал отправки и provider objects; отсутствие объекта в одном поисковом ответе
не доказывает отсутствие списания. [Правила idempotency](https://docs.stripe.com/api/idempotent_requests).

## 4. Счёт и банковский перевод в USD

Для UAE этот метод **выключен до подтверждения supported route**. Локальный invoice
с card checkout доступен независимо: он показывает net/tax/gross и не даёт банковские
реквизиты для перевода. Ниже — контракт будущего transfer capability.

Это **локальный invoice Calab на аванс**, а не месячная Stripe Subscription и не обещание
готового налогового документа любой страны. Юридический шаблон утверждается по продавцу.
Реквизиты для перевода выдаёт Stripe в рамках конкретного Customer/currency. Доступность
USD transfer зависит от merchant/customer locations, подтверждается при подключении;
см. [bank transfer availability](https://docs.stripe.com/payments/bank-transfers).

Выбираем Customer `cash_balance.settings.reconciliation_mode=manual`, чтобы Stripe не
оплачивал случайный другой открытый invoice. Это означает управление сверкой нашим worker,
а не обязательный ручной труд администратора. Не подключаем к тому же Customer параллельную
Stripe Invoicing/Subscription, которая распоряжается теми же деньгами.
[Механизм reconciliation](https://docs.stripe.com/payments/customer-balance/reconciliation).

Поток:

1. Invoice фиксирует payer snapshot, net/tax/gross USD, reference, срок, инструкцию Stripe и
   согласие применить переведённые средства как аванс того же account. Внешний Customer
   определяет account; reference — invoice внутри account. Не ищем workspace по ИНН.
2. `cash balance transaction` / webhook / API reconcile сообщает о funded amount.
   Импортируем устойчивый ID, source, валюту и связанные observations; проверяем покупателя.
   Сам `funded` пока означает средства на стороне Stripe, **не второй wallet credit**.
3. Под локальным lock резервируем ещё не использованные funding sources для одного
   collection intent на фактическую доступную сумму. Создаём/подтверждаем PaymentIntent
   `customer_balance` и, когда требуется, применяем cash balance через provider API.
   Каждый внешний шаг имеет отдельный стабильный key и состояние unknown/recovery.
4. Только успешный PaymentIntent вызывает обычный unique wallet credit его net части.
   Gross полученного перевода включает налог; partial/debt/advance allocation должна быть
   определена по invoice/tax context. Неизвестная разбивка — pending/review, не credit gross. Связь funded
   transactions → collection → PI → invoice allocations сохраняется. Не кредитуем ещё раз
   `applied_to_payment`, `invoice.paid`, BalanceTransaction или Stripe payout.
5. Частичный перевод собирается в PI на реально доступную сумму, а не ждёт полной суммы
   исходного invoice. Несколько мелких переводов ниже provider minimum накапливаются как
   «получено Stripe, ожидает зачисления»; доступен применимый возврат, искусственно довносить
   за пользователя нельзя. Переплата идёт в аванс того же account по принятому условию.

Конкретный порядок create/confirm/apply проверяется fixtures выбранной API version:
[direct API](https://docs.stripe.com/payments/bank-transfers/accept-a-payment.md?payment-ui=direct-api),
[apply customer balance](https://docs.stripe.com/api/payment_intents/apply_customer_balance),
[cash balance transactions](https://docs.stripe.com/api/cash_balance_transactions).
Если контракт точной частичной суммы или связи источников не подтверждён, bank transfer
остаётся выключенным; hosted card можно включить независимо. Не называем pending cash
деньгами на доступном балансе и не отправляем повторный запрос оплатить тот же перевод.

Неоднозначная invoice reference не меняет Customer→account. Credit на account допустим
при подтверждённом payer и принятом согласии на аванс; invoice allocation ожидает review.
Третий плательщик, закрытый account, неожиданная валюта/источник — отдельный review/return.
Средства, оставшиеся в Stripe cash balance, могут возвращаться по правилам провайдера:
не обещаем бессрочное хранение и не смешиваем их с уже полученным авансом Calab.

## 5. Inbox, сверка, возвраты и disputes

Webhook `/api/billing/stripe/webhook`: raw body, ограничение размера, Stripe-Signature,
endpoint secret/rotation, SDK timestamp tolerance; ключ не берётся из тела запроса.
После durable insert ACK, затем обработка. Повтор event ID и разные события одного PI
не повторяют credit. Режим test/live, merchant, Customer и сумма проверяются по mapping.
Порядок доставки не предполагается. [Официальный webhook contract](https://docs.stripe.com/webhooks).

Локально (test mode): `stripe listen --api-key "$STRIPE_SECRET_KEY" --forward-to
http://127.0.0.1:3000/api/billing/stripe/webhook` — напечатанный `whsec_…` положить в
`STRIPE_WEBHOOK_SECRET` и перезапустить сервер; relay и отдельный endpoint с нужной версией не нужны.

Активные pending/unknown intents опрашиваются адресно с backoff. Новые события и cash
transactions импортируются по cursor с коротким overlap; глубокая сверка идёт отдельным
бюджетом. Нет запроса cash balance ко всем клиентам каждые пять минут: webhook делает
Customer dirty, worker обрабатывает dirty/pending и периодическую сегментированную сверку.
Events API не является вечным архивом: [List Events](https://docs.stripe.com/api/events/list)
ограничивает доступную историю. Для восстановления нужны наш inbox/dispatch manifest и
долгоживущие PI/Charge/Refund objects, а не только повтор недавних webhooks.

Refund расходует резерв Calab и ссылается на исходный Charge/PI. Создание refund не означает
исполнения; `pending/failed/succeeded` и provider ID сверяются отдельно. Отказ освобождает
резерв только после определённого исхода. Fees относятся к продавцу; customer credit
сверяется как net+tax=gross, payout/settlement — отдельное движение. Refund gross состоит
из зарезервированного net и допустимого возврата исходного налога, не текущей ставки. [Refund API](https://docs.stripe.com/api/refunds).

Для customer_balance явно различаем возврат на банковский счёт и возврат в Stripe cash
balance. Второе не показываем как «деньги возвращены в банк». Повторное применение уже
возвращённого cash balance требует новой связанной операции; незавершённый refund не
автозачисляется по funded event. [Bank transfer refunds](https://docs.stripe.com/payments/customer-balance/refunding).
Reversal/dispute обрабатываются по их реальному типу, включая поддерживаемые USD bank
reversals; нельзя считать любой bank transfer безотзывным. На аккаунте сохраняется
отдельный dispute hold и история исходов; fees спора не списываются с клиента молча.

## 6. Acceptance и незакрытые условия

- Card success + Checkout/PI/Charge duplicates → один credit; delayed/processing → ноль.
- Off-session success/decline/requires_action, отзыв согласия, два одинаковых top-up amounts,
  unknown после 24h, ручная оплата при pending auto — без повторного внешнего списания.
- Два spaces одного payer имеют разных Customer; неверный seller/currency/livemode/PI
  rejected. Stripe metadata без локальной связи не даёт финансовых прав.
- Invoice $100, переводы $30 + $70, переплата, микроперевод ниже minimum, void/late/unknown
  reference: каждый source учтён один раз, funded и wallet credit различимы.
- Refund в банк / cash balance, pending/failed, dispute/reversal; payout не пополняет wallet.
- Restore до dispatch при уже успешной оплате, истёкший idempotency key, недоступный Events
  archive: внешние writes закрыты до reconciliation. Общий runbook — приложение FIFO §6.
- Подтверждённый достаточный credit до deadline обрабатывается перед enforcement;
  неоплаченный/неприменённый Stripe cash balance сам не является succeeded PaymentIntent.

Открыты: проверка merchant/requisites в Stripe, licence number, налоговый момент
аванса/услуг/долга и country/payer matrix, приёмка Stripe документов. Unne/UAE/AED settlement,
USD exclusive цены и действующая VAT-регистрация с TRN 105410888900001 подтверждены
владельцем. Отсутствие дополнительных регистраций вне UAE — позиция владельца,
глобальное налоговое заключение не проверено. Последний scope — VAT отложен, первая
интеграция без надбавки; это не настройка освобождения или всеобщей ставки 0%. Формула auto-topup долг+30d и запрет новых платных мест в минусе утверждены
владельцем. Ответы по продавцу фиксируются в ADR, не выбираются исполнителем API. Интеграция разрабатывается с test keys; live — только после её gates.
