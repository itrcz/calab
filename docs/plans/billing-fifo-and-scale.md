# Контракт биллинга: FIFO, конкуренция и масштабирование

Дата: 2026-10-09. Приложение v1.0 к [ADR-0080 v3.1](../adr/0080-seat-billing.md).
Владелец потребовал FIFO и работу на большом количестве клиентов. Ниже — решение лида
и проверяемые цели до реализации, не результат уже проведённого нагрузочного теста.
База — PostgreSQL 17, общий Go billing module; отдельный брокер не требуется для v1.

## 1. Что именно выполняется по FIFO

| Поток | Порядок |
|---|---|
| Погашение долга | Старейшее начисление первым: `(service_effective_at, charge_sequence)` |
| Расход аванса | Старейшее доступное зачисление первым: `(credit_sequence, funding_lot_id)` |
| Готовые денежные команды account | Монотонный `command_sequence`, один выполняющийся head на account |
| Наступившие продления мест | `(due_at, seat_event_sequence)`; актуальные начисления учтены перед новым расходом/восстановлением |
| Разные accounts | Параллельно, без общего FIFO всех клиентов |
| Сеть банка, чеки, email | Отдельные durable jobs; ожидание внешнего ответа не держит денежную очередь/DB lock |

FIFO касается одного billing account и одной валюты. Плательщик с одним ИНН может иметь
несколько accounts — это не повод объединять их деньги или выполнять их последовательно.
RUB и USD не смешиваются. Refund/chargeback связан с исходным источником платежа:
его нельзя применить к произвольному «самому старому платежу» в нарушение этой связи.
Зарезервированный и невыводимый остаток не подходит для cash refund.

`command_sequence` назначается сервером под account lock; UNIQUE `(account_id, sequence)`.
Это порядок принятых в денежную обработку команд, не timestamp устройства, HTTP arrival
или глобальный sequence для всех клиентов. Для успешно применённой команды фиксируются
`journal_sequence`, `accepted_at`, `posted_at`, `effective_at`, source event и business key.
Одинаковое время разрешается sequence. Повтор business key не получает второй debit/credit.

Дата в банковской выписке сохраняется отдельно. Позднее подтверждение платежа получает
следующий sequence и не переписывает уже применённые allocations задним числом. Для спорной
даты оплаты предусмотрен разбор/компенсация. Восстановление пропущенных due intervals
использует исторические факты членства, тарифов и уже известных финансовых событий,
не сегодняшние balance/COUNT как якобы состояние в прошлом.

Возврат неиспользованной услуги освобождает её исходные funding allocations; это не новое
поступление денег. Восстановленный остаток сохраняет sequence источника. Ручная компенсация
имеет собственный source и участвует в расходе по своей очереди, но не становится внешним
платежом. Все исключения к доступности источника хранятся явно, без скрытого LIFO.

## 2. Последовательность account без общей блокирующей очереди

1. API, webhook consumer, checker и scheduler используют один command handler и правила
   locks из ADR. Единственный способ изменить balance — journal transaction с account lock.
2. Под lock материализуем известные наступившие due events до принимаемой команды;
   порядок их обработки детерминирован. Они не теряются из-за того, что scheduler опоздал.
   Для большого backlog есть durable catch-up cursor; нельзя вписать тысячи списаний
   в транзакцию принятия участника или молча перепрыгнуть старое обязательство.
3. Новая команда попадает после уже принятых готовых команд. Если очередь пуста и catch-up
   короткий, handler исполняет её сразу в текущей транзакции. Для membership при этом
   debit + seat lot + membership/event атомарны. Если быстро завершить нельзя, возвращает
   `BILLING_RECONCILING`; членство/расход не применены, повтор с тем же request_id безопасен.
4. Подтверждённый bank fact всегда сначала durably импортируется. Если account занят
   catch-up, его credit ожидает применения: UI различает «банк подтвердил» и «зачислено».
   Банковский факт не теряется и не требует повторной оплаты; зачисление проходит один раз.
5. Worker исполняет только head account. Следующая команда не обгоняет предыдущую из-за
   другого worker, рестарта, lease expiry или повтора. Проверяем head sequence и fencing
   token внутри транзакции; устаревший worker не может записать результат после нового.
6. Commit сохраняет journal, funding allocations, balance projection, command outcome,
   policy revision, следующий due/head и outbox вместе. При rollback ни одна часть
   операции не остаётся финансово применённой.

Создание payment intent и ожидание `pending/unknown` банка **не занимают head денежной
очереди**: деньги ещё не подтверждены. Daily debit и подтверждённый платёж по другому
методу продолжают обрабатываться. Retry bank POST регулируется отдельно; порядок
dispatch и consent revocation по конкретному mandate сериализованы. Письмо, ошибка
чека или медленный webhook response не блокируют уже возможное зачисление.

Детерминированный business reject завершает команду с отказом, очередь идёт дальше.
Транзиентная DB-ошибка повторяет ту же команду с backoff, не следующий номер. Неустранимое
нарушение денежного инварианта переводит **этот account** в reconciliation hold и вызывает
alert; нельзя отправить такую команду в dead letter и продолжить списания через пробел.
Новые банковские факты продолжают импортироваться независимо от hold account.

При непогашенном episode услуги с `effective_at >= negative_since + 7 * 86400`
не начисляются; запоздалый учёт ранее оказанных услуг сохраняется. Deadline проверяется
по DB time на write/admission путях, поэтому очередь не добавляет восьмой день в долг.
Очередь policy/отзыва RTC имеет отдельную квоту worker и не вытесняется массовым импортом.
При реальном инциденте обработки полученной оплаты применяется только явный incident hold
из ADR §8; это не новый этап карантина и не автоматическое продление кредитного срока.

## 3. Worker и границы транзакций

Очередь планирует **accounts с ближайшей работой**, а не раз в минуту сканирует всех
пользователей или создаёт отдельную банковскую задачу на каждого сотрудника.
`billing_account_work` хранит одну строку account: `next_run_at`, head/catch-up cursor,
lease owner/until, fencing token. Workers выбирают due rows небольшими пакетами
`ORDER BY next_run_at, account_id FOR UPDATE SKIP LOCKED LIMIT ...`.

Claim transaction короткая и заканчивается **до** захвата workspace/account locks.
Далее worker открывает business transaction: workspace → account → dependent rows,
проверяет lease/head, выполняет bounded work и обновляет schedule. Нельзя держать
schedule lock, ожидая workspace lock: mutation handler обновляет schedule в конце своей
транзакции, и обратный порядок создал бы deadlock. Recovery возвращает истёкшие leases. После ограниченного пакета `next_run_at`
назначается от текущего времени/backoff, чтобы древний backlog одного account не получал
вечный приоритет; его фактический oldest_due/effective_at хранятся отдельно и не сдвигаются.

`SKIP LOCKED` используется только для выбора независимых accounts/jobs. Внутри account
он не применяется для выбора funding lots/долгов: пропуск старейшей занятой строки нарушил
бы FIFO. Account row lock защищает все его lots; отдельные writers не обходят эту границу.
На свойства queue locking опираемся согласно
[PostgreSQL 17 SELECT](https://www.postgresql.org/docs/17/sql-select.html).

Начальные настраиваемые ограничения для измерения: claim до 100 accounts, до 100 due events
за проход account, целевой DB transaction budget 100 ms, ограниченный worker/connection pool.
Это не обещание точного времени и не повод оборвать commit посередине. Одна логическая
операция не публикует частичный entitlement. При патологически большом числе allocations
она переходит в bounded settlement job с cursor/reservations и последовательными
компенсируемыми шагами; доступ выдаётся только после завершения всей суммы. Следующий
денежный command account ждёт, а другие accounts получают CPU/DB время между пакетами.
Контракт этого редкого пути и recovery-тесты обязательны до его включения.

Пулы и квоты раздельные: local ledger/due, policy deadlines, bank reads, payment dispatch,
fiscal/mail. Bank rate limits действуют на merchant/endpoint, а не суммируются без контроля
по каждому worker. Backoff с jitter только для безопасных операций; unknown charge сначала
сверяем. Сеть всегда вне DB transaction. Один горячий account не занимает весь пул.

Не сдвигаем `covered_until` или финансовую дату ради распределения нагрузки. Можно менять
время пробуждения в пределах SLO, но effective_at/цена/дедлайн неизменны. После простоя
replay идёт ограниченными пакетами с точным курсором; новые расходы не обходят catch-up.
Остановка worker в любой точке воспроизводится тестом и не удваивает операции.

## 4. Индексы, стоимость записи и чтения

Миграции должны явно создать и проверить следующие access paths. Имена индексов назначаются
в P1; поля и predicates согласуются с итоговой схемой и реальными EXPLAIN-планами.

| Таблица / запрос | Индекс или инвариант |
|---|---|
| Account work, ожидающая работа | `(next_run_at, account_id)` для ready rows; отдельный `(lease_until, account_id)` для running |
| Commands | UNIQUE `(account_id, command_sequence)`; partial `(account_id, command_sequence)` для незавершённых; UNIQUE business/request key |
| Открытый аванс | `(account_id, credit_sequence, id) WHERE remaining_amount > 0`; eligibility/reserved проверяются под lock |
| Открытый долг | `(account_id, service_effective_at, charge_sequence) WHERE outstanding_amount > 0` |
| Активные seat lots | `(account_id, covered_until, id)` только для активных; количественная capacity, не journal на каждого человека |
| Journals / история account | UNIQUE `(account_id, journal_sequence)`; keyset pagination по sequence |
| Bank transaction | UNIQUE `(provider, merchant_receiving_account, canonical_payment_id)` независимо от источника события |
| Matching invoice | UNIQUE reference в scope продавца; индекс открытых invoice по payer/currency/receiver |
| Идентификаторы плательщика | `(country, scheme, normalized_value, payer_id)`; не глобальный UNIQUE ИНН |
| Allocations | Source transfer/funding ID, target charge/invoice ID, business key; контроль суммы остатков |
| Unmatched / unknown / outbox | Partial state + next_retry_at/created_at; отдельные курсорные очереди |

Ready-predicate индекса описывает состояние, не `next_run_at <= now()` в предикате:
текущее время передаётся в WHERE запроса. Условия запросов должны соответствовать partial
index; проверяем их применимость через EXPLAIN на объёме, а не по названию индекса.
Основание: [PostgreSQL 17 partial indexes](https://www.postgresql.org/docs/17/indexes-partial.html).

Цена debit зависит от **открытых** funding/debt lots, которые он реально затрагивает,
а не от возраста всей истории клиента. Closed lots остаются в аудите, но не в рабочем
индексе. Cached balance, billable count, covered capacity и next_due обновляются в той же
транзакции, что события; периодическая сверка проверяет их. Нет SUM всех postings и COUNT
всех members на каждое чтение баланса. Перед admission используется authoritative state.

Места с одинаковыми SKU, price version, interval и правилами объединяются в cohort с
quantity: 100 сотрудников с одной границей → один service charge на 100 мест. Разные
времена/цены не округляем и не объединяем с потерей источника. FIFO allocation между
funding lot и service charge хранит сумму диапазоном, не запись на каждую копейку/человека.
Исторические member events сохраняют персональную причинность отдельно от денежных строк.

Bank checker читает receiving accounts и новые/перекрывающиеся диапазоны пакетами,
не вызывает банк N раз для N invoice. Кандидаты ищутся индексно; нет полного fuzzy scan.
Админские фильтры имеют ограничения периода/page size, keyset cursor; тяжёлый экспорт
в отдельной job с snapshot watermark. Реплика годится для истории с индикатором lag,
но не для денежных проверок, preview commitment или разрешения доступа.

Журнал, необработанные команды и дедуп не очищаем ради уменьшения очереди. Завершённые
jobs/raw payloads имеют отдельную retention policy от финансового аудита. Следим за
autovacuum, bloat и write amplification. Partitioning/архивирование вводятся по замерам:
они не должны ослабить глобальные unique payment/request keys. При time partitioning
отдельный непартиционированный dedup registry сохраняет этот invariant.

## 5. Приёмка производительности и корректности

Начальные **предложенные лидом** нагрузочные цели для RU v1; перед запуском фиксируем
ожидаемый объём клиентов и стенд. Эти цифры — gate измерения, не гарантия продакшена.

| Профиль | Набор данных / критерий |
|---|---|
| Базовый объём | 100 000 active accounts, 5 млн billable people, не менее 10 млн исторических journals; смесь когорт и разнесённых по времени мест |
| Ровный поток | 200 account operations/s в течение часа: debits, joins, credits, refunds; p95 handler ≤500 ms без внешней сети, без растущего backlog |
| Всплеск продления | 100 000 одновременно due accounts обработаны ≤10 минут; новые payments/admissions сохраняют отдельный бюджет |
| Нормальный режим | p99 due lag ≤60 s, policy notification/RTC revoke lag ≤30 s; серверный deadline gate не зависит от этих задержек |
| Hot account | Конкурентные команды одному account и тысячи мелких funding lots не ухудшают p95 остальных более чем на 20% относительно baseline |
| Recovery | Падение worker/DB connection после claim/до/после commit, повтор событий и истёкший lease: ноль дублей, пропусков и расхождений ledger |

Все performance numbers подтверждаем на описанном PG17 стенде: CPU/RAM/диск, версии,
размер pool, workers, dataset/seed, длительность, SHA. Для миллиона accounts отдельно
считаем объём histories/IOPS и прогоняем увеличенный профиль до обещания такой ёмкости.
Не экстраполируем линейную масштабируемость по тесту на 100 строках. Средства банка fake;
реальные provider rate limits проверяются отдельным contract test без массовых списаний.

Проверки FIFO/инвариантов:

1. Credit 1000, credit 2000, debit 1200 → 1000 первого + 200 второго; одинаковые timestamps
   не меняют порядок sequence. Refund/return сохраняет происхождение средств.
2. Два старых долга и частичный top-up → старейший погашен первым; small credit не
   переносит семидневный deadline. Поздняя банковская observation не пересортировывает журнал.
3. N workers, параллельные invoice checker/admin/webhook/debit → один outcome business key,
   строго последовательные commands account и неизменяемая история corrections.
4. Stale lease worker, head с временной ошибкой и горячий account → нет обгона внутри,
   остальные accounts работают. Failed/unknown bank intent не блокирует incoming SBP.
5. Backlog перед join не создаёт member раньше debit; terminal reject освобождает очередь;
   broken invariant останавливает только свой account и вызывает alert.
6. Суммы postings journal = 0, balance projection совпадает с журналом, allocations не
   превышают источник, ни один service interval не списан дважды/после suspension.
7. Query plans на большой истории: рабочие запросы читают due/open subset, без полного
   сканирования/сортировки ledger; число SQL-запросов не растёт на одного сотрудника cohort.

Метрики: oldest head/due/inbox age, commands/s, tx/lock wait p95/p99, deadlocks/retries,
open lots touched, backlog по пулу, failed invariant, stale leases, provider quota/lag,
длительность reconciliation. Метрики агрегируются; account/payment IDs находятся в
структурированных диагностических событиях, не в labels с неограниченной cardinality.

Порядок работы — [план P1/P6](balance-billing-v1.md); банковские и административные
операции — [контракт счетов и плательщиков](billing-invoices-and-payers.md).
