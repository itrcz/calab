# Контракт биллинга: плательщик, банковские счета и админка

Дата: 2026-10-09. Приложение v1.0 к [ADR-0080 v3.1](../adr/0080-seat-billing.md).
Это спецификация до реализации. Требования владельца: Private Person / Organization,
реквизиты по стране, автоматическая сверка поступлений, все платежи и ручные операции
в суперадминке. Конкретные алгоритмы ниже — решения лида. Деньги ещё не включены.

## 1. Профиль плательщика и национальные реквизиты

Owner выбирает страну и **Private Person** / **Organization**. У Organization есть
подтип `company` / `sole_proprietor` (ИП в RU). Эти значения определяют серверную схему
полей, но не валюту, рынок или юридическое лицо продавца: их фиксирует billing account.
Схема имеет `schema_version`, условия обязательности полей и серверную валидацию;
клиент отображает её, но не назначает правила валидации.

| Страна / тип | Поля в первом поддерживаемом контракте |
|---|---|
| RU / person | ФИО, email для документов, страна; адрес/налоговый ID только при необходимости конкретного способа оплаты или документа |
| RU / company | Полное наименование, ИНН (10 цифр), КПП при применимости, ОГРН (13 цифр), юридический адрес, email для документов |
| RU / sole_proprietor | ФИО/наименование ИП, ИНН (12 цифр), ОГРНИП (15 цифр), адрес, email; КПП не требуется |
| Global / person | Имя, email, страна; billing address и иные поля по проверенной схеме страны/платежа |
| Global / organization | Legal name, company/sole proprietor, registration IDs, tax IDs, registered/billing address, email; обязательность и формат по стране |

Это выбранный контракт продукта, а не утверждение, что любое поле обязательно по закону
для каждого платежа. Каталог стран Global открывается только после настройки продавца,
налогов и документов этой страны. Неподдерживаемая комбинация возвращает
`BILLING_PAYER_COUNTRY_UNSUPPORTED`, а не пустую форму или российские поля по умолчанию.
Паспорт, СНИЛС, дата рождения и банковская карта в профиль по умолчанию не собираются.

Данные профиля:

- `payer_id`, `billing_account_id`, `country`, `entity_type`, `legal_name`, `email`,
  структурированные `registered_address` / `billing_address`: country, region,
  city, postal_code, address_lines. Поля адреса обязательны по схеме страны.
- `tax_ids[] {country, scheme, value}` отдельно от
  `registration_ids[] {country, scheme, value}`. RU: `ru_inn`, `ru_kpp`,
  `ru_ogrn` / `ru_ogrnip`; Global — типизированный реестр схем, не строка «ОГРН» для всех.
- Значения — строки с сохранением ведущих нулей. Храним исходное и нормализованное
  значение; проверяем длину/формат/checksum там, где он определён. Отдельно сохраняем
  `validation_status`, `verification_source`, `verified_at`: формат не доказывает
  существование компании и право пользователя выступать от неё.
- Банковские реквизиты плательщика храним только для применимого способа/возврата.
  Редактируемое пользователем поле счёта не является подтверждённой банковской связкой.

Весь профиль ограничен account. Одинаковый ИНН у разных accounts допустим; lookup по ИНН
не открывает владельцу чужие документы и balances. Для сопоставления банк→плательщик
есть внутренний индекс, доступный только процессу сверки и суперадмину.

Каждое изменение создаёт immutable `billing_payer_version` с `schema_version`.
Invoice/PDF, funding intent, consent, fiscal task фиксируют `payer_version_id` и snapshot
использованных полей. Исправление адреса не меняет старый PDF или получателя старого refund.
Смена самого юридического плательщика требует нового договора/account и урегулирования
остатка, не незаметного переноса аванса между лицами. Техническая коррекция опечатки
сохраняет доказательство и историю. Согласие представителя записывается отдельно.

В Stripe передаём только поддерживаемые provider tax ID types, прочие регистрационные
реквизиты остаются в нашем профиле. Список Stripe tax IDs не заменяет модель юридического
лица: [официальный каталог tax IDs](https://docs.stripe.com/billing/customer/tax-ids).

## 2. Счёт и его денежное состояние

`POST /invoices`: owner передаёт `payer_version_id`, сумму в валюте account и request_id.
Сервер фиксирует свой номер и уникальную reference, продавца/счёт получателя, плательщика,
назначение «пополнение баланса / погашение задолженности», сумму, валюту, срок оплаты,
версию условий и PDF. Reference входит в назначение платежа, копируется одной кнопкой.
Bank `documentId` хранится отдельно от нашего invoice ID/reference и payment ID.

Срок оплаты счёта не является сроком действия внесённого аванса. Оплата не запускает
месячный период и сама по себе не разрешает автоматические списания карты.

Состояния разделены:

| Объект | Состояние / смысл |
|---|---|
| Invoice document | `draft`, `issued`, `expired`, `void`; история причин и версии документа |
| Invoice payment coverage | `unpaid`, `partial`, `paid`, `overpaid`; проекция действующих payment allocations |
| Bank transaction | Подтверждённое движение денег, неизменяемые observations и canonical ID |
| Wallet credit | Journal зачисления; source и сумма, отдельно от invoice coverage |
| Refund / correction | Свои операции и компенсирующие записи; не перезапись bank transaction |

`allocated_amount`, `refunded_amount`, `reversed_amount` показываются отдельно. Отвязка
оплаты от invoice не означает возврат из банка, а возврат не удаляет факт исходной оплаты.
Сумма wallet credits за вычетом corrections связана с конкретными transfer allocations,
но `invoice.paid_amount` сам никогда не является командой «зачислить ещё раз».

Частичная оплата с точной reference зачисляет фактически пришедшую сумму и оставляет счёт
частично оплаченным. Переплата того же плательщика поступает на тот же баланс с отдельной
строкой превышения invoice amount. Поздняя оплата expired invoice допустима после проверки
его неизменных реквизитов и отсутствия конфликта. Платёж на `void` invoice попадает в review:
деньги сохраняются в реестре, документ не восстанавливается молча. Один перевод можно
распределить на несколько счетов только с явными суммами распределения; иначе review.

## 3. Checker банка и защита от повторного зачисления

### 3.1. Получение и нормализация поступлений

Один логический checker на receiving account банка, не по запросу на каждый invoice.
Период — 5 минут; incomingPayment ускоряет сверку через durable inbox. Проверяем подпись,
сохраняем event и быстро отвечаем банку; сеть банка/письма не входят в ledger transaction.
Шаги Init Statement → ожидание готовности → Get Statement учитывают асинхронность API.

В локально изученной официальной документации incomingPayment содержит paymentId,
совпадающий с выпиской; у выписки paymentId/transactionId могут отсутствовать в схеме.
Поэтому автоматический credit требует подтверждённого устойчивого ID и его scope.
Отсутствие ID отправляет запись на сверку с банком, а не включает слабый дедуп по сумме/дате.
Bank documentNumber не считаем нашей invoice reference без проверки назначения.

Сохраняем исходный защищённый payload/hash и нормализованную observation: provider,
merchant/receiving account, paymentId, transactionId, направление, booked status,
amount/currency, bank booking time, received time, sender name/INN/KPP/account/BIC,
receiver, purpose и извлечённые references. Raw банковские данные не пишем в обычные логи.
Доступ, шифрование и retention входят в P0/P2; неизменность финансовой истории не означает
бессрочное хранение всех PII/raw payloads.

Все страницы/диапазоны окна импортируются до продвижения cursor. Окна перекрываются:
обычно последние 7 календарных дней, суточная расширенная сверка — последние 90 дней,
пакетами в пределах bank rate limits. После долгого простоя начинаем с последнего
завершённого cursor, не просто «сегодня минус 7»: разрыв не должен пропасть. Для исправлений
старше 90 дней доступны explicit range reconciliation и банковские уведомления.

Запуски имеют lease/fencing token; повтор или падение процесса не пропускают страницу.
HTTP retry/backoff/jitter разрешён для безопасного чтения. Повтор создания банковской
операции после timeout требует provider-specific recovery. Сохраняем sync run, границы,
количество записей, ошибки, completed cursor и lag; недоступность банка вызывает alert.

Сначала классифицируем `direct_transfer`, `acquiring_settlement`, `internal_transfer`,
`reversal`, `unknown`. Только подтверждённый Booked credit нужной валюты на правильный
счёт, относящийся к клиентскому пополнению, допускается к matching. Settlement card/SBP
сверяется с acquiring payments отдельно: его нельзя повторно зачислить клиентам.

### 3.2. Сопоставление и зачисление

1. Ищем точную invoice reference. Проверяем account продавца, валюту, профиль покупателя
   и доступные реквизиты отправителя. Для RU company/ИП — ИНН и применимый КПП; для person
   без налогового ID — reference и подтверждённые банковские сведения о плательщике.
   Несовпадение либо недостаточность сведений, оплата третьим лицом — review, не fuzzy match.
2. Без reference разрешён только fallback по ранее подтверждённой банковской связке
   sender INN + sender account и ровно одному открытому invoice подходящей валюты/receiver
   во всех accounts этого плательщика, с точным совпадением remaining amount. Введённые
   пользователем реквизиты не создают такую связку. Частичная оплата без reference,
   несколько кандидатов, одинаковые суммы и несколько пространств — review.
3. Перевод без подходящего invoice хранится как unallocated с доступным оператору остатком.
   Не угадываем account по одному ИНН, имени или последнему созданному workspace.
4. Match plan сохраняет version алгоритма, основания, actor и распределение сумм.
   Проверяем остаток перевода, locks и revision; совокупные allocations не превышают
   его доступную сумму. В одной транзакции allocation + wallet journal + FIFO settlement
   + account cache + invoice projection + audit/outbox. При большом backlog выполнение
   ожидает своей очереди account; банку повторно оплатить ничего не предлагаем.

Unique `(provider, merchant_receiving_account, canonical_payment_id)` объединяет webhook,
polling, statement и ручное подтверждение. Событие из нового источника добавляет observation,
не второе пополнение. Credit business key привязан к allocation, а остаток bank transaction
защищён row lock и invariant суммы. Статус счета «оплачен» без ID движения не зачисляет деньги.
При изменении банковской записи не редактируем старую проводку: reversal/review по явному событию.

Ручное решение не отменяется следующим checker. После unapply/correction сохраняем
`auto_match_blocked` и decision revision для затронутого перевода/распределения. Повторный
матч возможен только после явного решения оператора; похожий поздний webhook его не сбрасывает.
Неопознанные деньги не исчезают по TTL и не становятся доходом автоматически.

Основания протокола: [incomingPayment](https://developers.tochka.com/docs/tochka-api/opisanie-metodov/vebhuki/incomingPayment),
[Get Statement](https://developers.tochka.com/docs/tochka-api/api/get-statement-open-banking-v-1-0-accounts-account-id-statements-statement-id-get),
[Create Invoice](https://developers.tochka.com/docs/tochka-api/api/create-invoice-invoice-v-1-0-bills-post).
Изучена копия [официального полного описания](https://developers.tochka.com/llms-full.txt)
от 09.10.2026; bank sandbox должен подтвердить scope ID, статусы и лимиты до включения.

## 4. Суперадмин: отдельные действия с разными последствиями

Реестр показывает все accounts: invoices, bank payments/transfers, wallet credits/debits,
manual credits, refunds, disputes и очередь unmatched. Фильтры: workspace, payer, страна,
тип, ИНН/ОГРН/другой ID, invoice reference, provider/payment ID, дата, статус, сумма/валюта.
Детали связывают банк → allocation → invoice → journal → расход/refund, включая исправления.
Итоги разделены по валюте; постраничные списки/экспорт не сканируют всю историю синхронно.

| Действие | Что происходит |
|---|---|
| Отменить неоплаченный счёт | `void` + reason/audit; balance не меняется |
| Снять привязку оплаты к счёту | Компенсируется invoice allocation, invoice снова имеет unpaid remainder; корректно зачисленный аванс остаётся в том же account |
| Исправить ошибочное зачисление | Компенсирующий wallet debit, освобождение/перераспределение transfer allocation, auto-match block; банковское поступление не исчезает |
| Вернуть деньги | Refund с резервом реального доступного остатка и исполнением банком/оператором; финальный статус только по подтверждённому внешнему факту |
| Вручную зачислить найденный перевод | Проверенный bank ID + доказательство; общий pipeline, последующий checker не добавит второй credit |
| Ручная компенсация за счёт сервиса | `admin_adjustment` с reason, суммой/валютой/source; отдельный небанковский funding lot и journal |
| Исправить ручную компенсацию | Обратная проводка со ссылкой на исходную; не удаление записи |
| Обработать chargeback | Входящий подтверждённый dispute банка, сумма/стадии/обратные движения по отдельному процессу |

В merchant UI кнопка **«Возврат»** не обещает инициировать chargeback: карточный dispute
приходит через банк, это иной процесс. Для будущего Stripe это различие описано в
[официальной документации о disputes](https://docs.stripe.com/disputes/how-disputes-work).

Paid/partial invoice нельзя просто сделать void и обнулить деньги: сначала явное решение
по связанным оплатам, затем отмена документа, если она ещё уместна. При unapply выбираем
однозначный режим `detach_invoice` либо `reverse_credit`; preview показывает, останутся ли
деньги на балансе. Возврат исполняется отдельной командой, не скрытым побочным эффектом.
`detach_invoice` оставляет bank funds allocated тому же account и не освобождает их для
второго wallet credit; к другому invoice их можно привязать без нового зачисления.

Коррекция ошибочно выбранного account компенсирует старый credit и зачисляет правильный
атомарно, с проверкой одного плательщика/валюты/продавца. Это исправление доказанной ошибки,
не пользовательский перевод между балансами. Для другого плательщика нужен отдельный
разбор возврата/новой оплаты; произвольный перенос запрещён. Расходованные ошибочно деньги
могут привести к отрицательному balance: preview показывает сумму и срок блокировки.
Новый negative episode начинается в момент коррекции, существующий deadline не сдвигается;
при fraud/dispute действует отдельный hold, а не автоматическая семидневная отсрочка.

Компенсация `admin_adjustment` по умолчанию не выводится пользователю как банковский refund.
Она может погасить долг/оплатить услуги за счёт сервиса, но не создаёт фиктивный платёж или
чек получения внешних денег. Фискальное отображение компенсации утверждается в P0.
Если оператор ещё не знает устойчивый ID перевода, нельзя назвать компенсацию «оплатой
банка»: отмечаем её provisional, привязываем review claim, и совпадающие будущие поступления
этого payer/account до разбора не автозачисляются. Позднее подтверждение источника заменяет
компенсацию банковским funding source через проводки с нулевым чистым изменением balance.
Обычная goodwill-компенсация не претендует на будущий bank transfer.

Refund ограничен подтверждённой исходной оплатой за вычетом уже возвращённого/зарезервированного
и доступным реальным остатком account. Если нужно вернуть использованную оплату, сначала
явно оформляется применимая корректировка услуги, а не обход лимита refund отрицательным
балансом. Не переводим деньги на произвольные реквизиты из редактируемого профиля.
Если банк не предоставляет подтверждённый API для метода, создаём операторскую задачу:
кнопка не ставит `succeeded` без evidence исполнения. `unknown` сверяем, не повторяем POST.

Все команды: действующая superadmin authorisation + step-up, reason, request_id,
expected_revision, preview последствий и immutable audit actor/time/source/result.
Preview не является разрешением сам по себе; под lock повторно проверяются права,
остатки, revision, in-flight refunds/disputes и ownership. Несовпадение требует нового preview.
Повтор request_id с тем же body возвращает прежний результат, с другим — 409.
Нельзя DELETE financial history или PATCH balance/paid_status. Audit содержит ссылки/маски,
не полные банковские payloads или секреты. События исправления видны owner в истории.

## 5. API и сущности до зависимой реализации

Owner API и права — ADR §13. Профиль редактирует owner; обычный администратор участников
не получает доступа к финансовым реквизитам. Provider/webhook не принимает payer_version
из неподписанного клиентского redirect.

Префикс суперадмина `/api/admin/billing`:

| Метод | Результат |
|---|---|
| `GET /payments`, `/credits`, `/invoices`, `/bank-transfers`, `/sync-runs`, `/refunds`, `/disputes` | Cursor pages и детали с явным account/currency |
| `POST /bank-sync` | Ограниченный диапазон/receiving account, job ID; один проверяемый run |
| `POST /actions/preview` | action + target + amount → версия, изменения balance/invoice/deadline, quote ID/TTL |
| `POST /bank-transfers/{id}/allocations` | Подтверждённый match/split с amounts и expected revisions |
| `POST /invoices/{id}/void` | Отмена неоплаченного документа |
| `POST /invoice-payments/{id}/unapply` | Явный `detach_invoice` / `reverse_credit`, preview обязателен |
| `POST /manual-credits` | source `verified_transfer` / `admin_adjustment`, amount/currency/reason/evidence |
| `POST /manual-credits/{id}/reverse` | Компенсирующая запись с сохранением исходной |
| `POST /payments/{id}/refunds` | Refund request/reservation, дальнейшее асинхронное исполнение |

Подтверждение/снятие review и dispute resolution используют такой же command/audit контракт;
разрешённые переходы перечисляются в provider capabilities, не generic «set status».
Ошибки дополняют ADR: `BILLING_PAYER_INVALID` (422), country unsupported (422),
`BILLING_TRANSFER_AMBIGUOUS`, `BILLING_TRANSFER_ALREADY_ALLOCATED`,
`BILLING_INVOICE_HAS_PAYMENTS`, `BILLING_REFUND_AMOUNT_EXCEEDED` (409).

Схема дополняет ADR §10: payer/version/identifiers; invoice document/coverage;
bank sync runs/observations, canonical transactions, transfer/invoice allocations;
verified sender bindings; manual credits/claims; disputes и audit. Любая денежная связь
имеет original amount, remaining/projection revision и append-only movements.
Порядок locks: workspace boundaries по ID → accounts по ID → bank transactions → allocations/
lots/invoices. Нельзя предварительно держать bank row lock и затем запрашивать account lock.
Checker сначала читает кандидатов, после захвата locks повторно валидирует match plan.

## 6. Проверяемая приёмка

1. RU person/company/ИП: разные required fields, checksum, сохранённые ведущие нули;
   неизвестная страна/тип rejected. Global не требует ОГРН, tax ID не заменяет registration ID.
2. Смена адреса не меняет invoice PDF; одинаковый ИНН не открывает другой account.
3. Webhook, две страницы выписки, повтор checker и ручной credit одного bank ID дают
   одно пополнение; две реальные оплаты одинаковой суммы дают два поступления.
4. Одинаковый ИНН/сумма в двух spaces → review; точная reference выбирает правильное;
   fallback работает только с проверенной связкой и единственным кандидатом.
5. Partial, overpayment, expired, void, платёж третьего лица, split нескольких invoice:
   каждый рубль либо allocated, либо unallocated/refunded, без исчезновения и двойного credit.
6. Crash на последней странице не продвигает cursor; restart/перекрытие окон восстанавливают
   все записи. Простой 20 дней не ограничивает импорт последними 7 днями.
7. Settlement, pending, debit, неверная валюта/receiver и missing stable ID не пополняют баланс.
8. Detach оставляет balance, reverse credit уменьшает его, void unpaid не меняет денег;
   очередной checker не восстанавливает исправленное зачисление.
9. Correction уже потраченного credit сохраняет обе проводки и старый debt deadline;
   false-positive нового минуса задним числом нет. Dispute применяет отдельный hold.
10. Manual bank credit позже найден в выписке → без дубля; provisional claim задерживает
    автоматический match до переноса источника с нулевым чистым зачислением.
11. Admin adjustment нельзя вывести как банковский refund; double refund/credit race,
    чужой target ID, stale preview, потеря superadmin/step-up → отказ без partial journal.
12. Bank refund timeout остаётся unknown; ни кнопка, ни повтор job не делают второй POST
    без доказанной bank idempotency/recovery. Audit и owner history сохраняют результат.

Порядок операций, индексы и нагрузочная приёмка —
[FIFO и масштабирование](billing-fifo-and-scale.md). План этапов —
[balance-billing-v1](balance-billing-v1.md); внедрение API/SQL здесь ещё не выполнено.
