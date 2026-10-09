# Налоги и документы USD-биллинга

Дата: 2026-10-09. Приложение v1.0 к [ADR-0080 v4.0](../adr/0080-seat-billing.md).
Это технический контракт и перечень условий запуска, не налоговое заключение.

## 1. Подтверждённые решения и статус продавца

Владелец утвердил базовые цены **Team $0.10 / Business $0.30 за человека за 24 часа,
без применимого налога**. На сайте показываем базовую цену с понятной пометкой о налоге;
в checkout **до оплаты**, receipt и invoice — база, применимый налог и итог. Для рынков,
где обязательна итоговая потребительская цена, локальный показ должен соблюдать это
требование; одна общая надпись «без налога» не подтверждает соответствие всем странам.

Продавец **Unne L.L.C-FZ**, Limited Liability Company (Free Zone), UAE (Dubai).
Registered office: **Meydan Grandstand, 6th Floor, Meydan Road, Nad Al Sheba, Dubai, UAE**.
Stripe account — AE, выплаты — AED, цены/баланс покупателей — USD. Владелец предоставил
TRN **105410888900001** из выписки, но пока не уверен, относится ли он к VAT или Corporate Tax.
Храним его как предоставленный налоговый реквизит с `verification_status=pending`;
не объявляем действующей VAT-регистрацией и не включаем сбор VAT по этому номеру без
проверки свидетельства FTA/даты регистрации. Номер licence/registration ещё не предоставлен.
Контакт проекта support@calab.io подтвердить для Global перед публикацией условий.

Проверка открытых источников: конкретный номер не найден в публичной поисковой выдаче,
принадлежность Unne не подтверждена. Окончание **01** не соответствует VAT identifier
в PINT-AE (окончание **03**). FTA указывает, что Corporate Tax TRN отличается от VAT TRN
последней цифрой. Предположение о Corporate Tax — только вывод по формату, не результат
проверки регистрации; нельзя менять цифру и объявлять полученный VAT number действующим.
[Правило IBR-132-AE](https://docs.peppol.eu/poac/ae/v1.0.3/pint-ae/trn-invoice/rule/PINT-jurisdiction-aligned-rules/),
[FTA: юридические лица, §4.1.1](https://tax.gov.ae/Datafolder/Files/Guides/CT/CT%20Registration%20of%20Juridical%20Persons%20-%20EN%20-%2030%2008%202023%20final.pdf).
Нужно сверить имя/тип налога/статус/дату в свидетельстве EmaraTax; поле TRN в банковской
выписке также может относиться к самому банку. Пока номер — reference для проверки.

Free Zone не означает автоматическое освобождение услуг от VAT: даже в Designated Zones
для услуг применяются обычные правила. У электронных услуг в UAE существенны место
использования и потребления: вне UAE возможен `outside_scope`, а не автоматически ставка 0%.
Классификацию Calab (в том числе SaaS/коммуникационные функции), доказательства места
использования и правила аванса должен подтвердить налоговый специалист до live.
[FTA: зоны](https://tax.gov.ae/DownloadOpenTextFile?fileUrl=en%2FVAT_VAT_Guides%2FDesignated_Zones_VAT_Guide%2FDesignated_Zones_VAT_Guide_EN.pdf),
[FTA: электронные услуги, §4](https://tax.gov.ae/DataFolder/Files/Pdf/E-Commerce%20-%20VAT%20Guide%20-%20EN%20-%2009%2008%202020.pdf).

Регистрация только в UAE не отменяет обязательств в странах покупателей. Например,
электронные B2C-услуги от продавца вне EU могут облагаться VAT страны потребителя с первой
продажи; применимость non-Union OSS и B2B reverse charge рассматриваются отдельно.
Наличие Organization в форме само по себе не даёт освобождение.
[European Commission: VAT in the Digital Age, vol.3](https://taxation-customs.ec.europa.eu/system/files/2022-12/VAT%20in%20the%20Digital%20Age_Final%20Report%20Volume%203.pdf),
[EU: cross-border VAT](https://europa.eu/youreurope/business/finance-and-tax/vat/cross-border-vat/index_en.htm).

## 2. Stripe Tax и доступность checkout

Используем Stripe Tax как движок расчёта после настройки tax code продукта, места продавца,
реальных регистраций/дат и billing location/статуса покупателя. Обычный Stripe payment
не добавляет налог автоматически. Настройка регистрации в Stripe не заменяет регистрацию
у налогового органа; расчёт/сбор также не доказывает подачу декларации и уплату налога.
[Stripe Tax registrations](https://docs.stripe.com/tax/registering).

Country/payer matrix хранит утверждённое основание `taxable`, `zero_rated`, `exempt`,
`reverse_charge`, `outside_scope` или `not_required_to_register` с evidence/version/dates.
`unknown`, неподтверждённая обязательная регистрация или неподдерживаемый tax flow
блокируют checkout этой комбинации до настройки, а не превращаются в tax=0.
Нулевой ответ Stripe из-за отсутствия регистрации не является достаточным основанием.
Регистрационные пороги мониторятся; действующая матрица пересматривается при изменениях.

Checkout использует встроенный `automatic_tax` и exclusive tax behavior. Для off-session
PaymentIntent нужен отдельный Tax calculation flow: настройки Checkout не наследуются
произвольным PI. Выбираем custom Tax/PI flow, когда необходимы связанные построчные
reversals; API version и конкретные поля проверяются contract fixtures. Один факт продажи
имеет одну tax transaction: встроенная Checkout Tax transaction не создаётся второй раз
нашим обработчиком. Tax calculate/record/reverse выполняются вне DB locks, через durable
jobs, стабильные keys и reconciliation. Ошибка записи документа/налога не повторяет charge.
[Checkout Tax](https://docs.stripe.com/tax/checkout),
[PaymentIntent + Tax](https://docs.stripe.com/tax/payment-intent),
[custom flow](https://docs.stripe.com/tax/payment-intent/custom).

## 3. База услуги, налог и деньги банка

Решение лида: баланс Calab учитывает **стоимость услуг без налога**. Quote/intent фиксируют
integer minor units `service_amount_net`, `tax_amount`, `provider_total_gross`, валюту,
разбивку debt/advance, payer/seller versions, tax calculation/transaction IDs, основание,
срок действия и строки расчёта. `provider_total_gross = service_amount_net + tax_amount`.
Налог не является доступным авансом для покупки мест. Комиссии Stripe и AED settlement
учитываются ещё отдельно и не уменьшают обещанное зачисление.

Например, при условной применимой ставке 5%: покупатель выбирает $100 на услуги, платит
$105; $100 идут на долг/аванс, $5 — на отдельный налоговый счёт subledger. Если законное
основание даёт tax=0, платёж $100 и аванс $100. Это примеры арифметики, **не ставка Unne**.
Суточное начисление Team остаётся 10 cents net. Налог, уже учтённый при получении аванса,
не начисляется повторно при его расходовании. Юридический момент налогообложения аванса,
кредитных услуг и корректировок — обязательный live gate; при несовместимости схема
меняется до запуска, не маскируется универсальным tax code «пополнение кошелька».

Налоговое обязательство/уплаченный налог хранятся отдельно от net funding lots. Если
услуга в долг уже создала tax receivable, погашение ссылается на этот документ, не облагать
её как новую продажу. Если налог ещё не был начислен, расчёт debt line следует утверждённой
политике. Смешанные advance/debt строки без определённого mapping не отправляются в банк.
При смене billing location/статуса покупателя новые расчёты получают новую версию; остаток
аванса сохраняет налоговое происхождение. Перезачёт/доначисление оформляется корректировкой
по утверждённым правилам, а не повторным полным налогом на уже оплаченный аванс.

Auto-topup сначала рассчитывает net долг + net запас на 30 суток, затем добавляет только
подлежащий оплате налог с учётом уже начисленного/уплаченного. Owner limit применяется к
**итогу gross**, который фиксируется до dispatch. Для $2 net долга + $30 net запаса и
условных 5% на обе ещё не обложенные строки: net $32, tax $1.60, charge $33.60.

`balance` — signed net service balance; `tax_due` и общий долг показываются отдельно.
Episode закрывается и рост/resume допускаются после погашения **всего подлежащего оплате
долга**, включая налог, и due catch-up. Налоговый долг по просроченной услуге наследует её
deadline; его выделение/корректировка не запускает новые семь дней. Изменение только tax_due
не создаёт незаметную кредитную линию. Receipt barrier проверяет net/tax coverage, не только
gross сумму или положительный service balance. Спорные налоговые корректировки идут в
review, а не задним числом создают новые интервалы оказанных услуг.

## 4. Invoice, receipt, возврат и сверка

Invoice хранит неизменяемые net/tax/gross строки и основание, seller/payer/registration
snapshots, дату/номер, валюту и ссылку на оплату; истёкший tax quote требует новой версии,
а не тихого изменения выданного документа. Receipt отражает реально полученный gross.
Stripe receipt не объявляется автоматически соответствующим любому местному tax invoice.
Checkout one-off invoice может быть документом к тому же PI, **не вторым требованием оплаты**.
Формат, нумерация, credit note, обязательные AED-эквиваленты/курс для UAE документов и сроки
хранения/декларации определяются подтверждённой учётной политикой до live.

Refund net части использует исходные funding allocations по ADR §9. Налоговый возврат —
отдельная связанная коррекция исходной tax transaction с её основанием/ставкой и лимитом;
не текущий процент от произвольного остатка. Резервируются net и refundable tax отдельно,
банку передаётся их gross итог. Admin credit и неоплаченный долг не создают cash/tax refund.
При разрешённом возврате половины исходного $100+$5: net $50, tax $2.50, gross $52.50.
Tax reversal, credit note и банковский refund имеют отдельные статусы; их retry не вызывает
второй денежный возврат. Dispute/reversal также не списывает gross с net баланса.

Bank import/matching/partial payments сверяют gross; wallet зачисляет net после сохранения
разбивки. У частичного поступления нужна однозначная tax/debt/advance allocation по
исходному invoice и правилам округления; неизвестная разбивка означает review/pending,
не gross кредит в кошелёк. Это отдельный gate будущего USD transfer. Для RUB «без НДС»
налоговый компонент нулевой по собственной RU policy, USD режим к нему не применяется.

Acceptance: net+tax=gross; подтверждённые taxable/0%/outside-scope/reverse-charge кейсы;
неверные tax IDs/location и отсутствие регистрации; duplicate tax/PI events; tax outage;
$100/$5/$105; auto $32/$1.60/$33.60 и gross consent limit; исходный partial refund;
долг с уже начисленным налогом без повторного обложения; смена tax context; restore всех
calculation/transaction/reversal IDs. Базовые денежные fixtures без налога явно помечаются
как tax=0. Эти сценарии заданы для реализации, ещё не пройдены в Stripe sandbox.
