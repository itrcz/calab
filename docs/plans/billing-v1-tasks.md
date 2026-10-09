# Billing v1 — задачи и границы

Контракт: [ADR-0080 §0 «Срез v1»](../adr/0080-seat-billing.md). Каждая задача — свой агент,
свой worktree/ветка/БД, правит только свои пути; чужой путь — через лида.

## T0 — фундамент (сделано)

Единственный автор схемы, контракта и интерфейсов; после мержа это заморожено.

- Схема: `apps/server/internal/db/migrations/00074_billing.sql`; базовые запросы
  `internal/db/queries/billing.sql` (не править — свои запросы в своём файле, см. ниже).
- Proto: `proto/calaba/v1/billing.proto`; `Workspace.billing = 17` (`WorkspaceBillingStatus`,
  без сумм, всем участникам); `DispatchEvent.billing_update = 96` (`BillingUpdate`, только
  владельцу, gateway: workspace-scoped).
- Go: `internal/billing` (`Clock`/`DBClock`/`FakeClock`/`SwitchClock`, `Seats` + `NoSeats`,
  ошибки и reasons), `billing/money`, `billing/provider` (интерфейсы, `Registry`, матрица),
  `billing/provider/fake`, `billing/http/routes.go` (все маршруты → 501), `config/billing.go`.
- Маршруты внесены в `internal/app/botroutes.go` и `identityroutes.go` (scope `scopeBilling`
  для владельца, `scopeAdmin` для админки, public для webhook/return). Новые маршруты —
  только через лида.

## Параллельно после T0

| Задача | Модель | Пути (владеет) | Что |
|---|---|---|---|
| T1 core | Opus | `internal/billing/core/`, `internal/billing/worker/`, `queries/billing_core.sql` | ledger, FIFO lots, seat charges, долг/эпизод, quotes, activate/stop/change-plan/resume, реализация `billing.Seats`, суточное продление, приостановка в дедлайн, ночная сверка |
| T2 Stripe | Opus | `internal/billing/providers/stripe/`, `queries/billing_stripe.sql` | адаптер `provider.Provider` + `OffSessionCharger`, фикстуры `testdata/` без ключей, отказ от live |
| T3 admission + enforcement | Opus | `internal/workspaces/`, `internal/auth/service.go`, `internal/auth/identity.go`, `internal/guests/`, `internal/identitypolicy/`, `internal/plans/`, `internal/rtc/sync.go`, `internal/moderation/` | вызовы `Seats` во всех путях приёма, `CountBillableMembers`, `BillingSuspended` без read-исключения (кроме `scopeBilling` владельца), боты, RTC, 409 ручного плана при `source=billing`, отзыв согласия при передаче владения |
| T4 renderer | Sonnet/Opus | `apps/desktop/src/renderer/features/workspace/billing/`, `features/admin/billing/`, `services/stores` (billing), i18n | кабинет владельца, paywall/заглушка сотрудника, админка |

## После T1/T2

| Задача | Модель | Пути | Что |
|---|---|---|---|
| T5 HTTP + inbox + mail | Opus | `internal/billing/http/`, `internal/billing/inbox/`, wiring в `internal/app/app.go`, шаблоны писем, `queries/billing_http.sql` | обработчики owner/public, webhook inbox, pull-sync checkout, `billing_notifications`, `WORKSPACE_UPDATE`/`BILLING_UPDATE` |
| T6 admin API | Opus | `internal/billing/admin/`, `queries/billing_admin.sql` | `/api/admin/billing/*`: preview, reason, request_id, аудит, recent auth |
| T7 auto-topup | Opus | `internal/billing/autotopup/`, `queries/billing_autotopup.sql` | согласие, попытки, unknown-recovery, восстановление после restore |
| T8 E2E | Sonnet | тесты | сквозные сценарии M1–M23 на fake provider и Stripe test mode |
| T9 ревью денег/безопасности | Opus | — | независимое ревью перед включением флагов |

## Решения T0, которые надо знать

- Время — только из `billing.Clock`, в запросы передаётся `now`; `DBClock` = `clock_timestamp()`
  после блокировки аккаунта.
- Баланс меняется только `AppendBillingLedgerEntry` (одна инструкция двигает кэш и `entry_seq`);
  дубликат `business_key` проверять заранее (`GetBillingLedgerEntryByKey`) — иначе
  unique_violation откатывает транзакцию.
- Знак суммы в ledger фиксирован видом (CHECK); SKU — `seat.team.day`, `seat.enterprise.day`
  (Business = `enterprise`, как `PLAN_ENTERPRISE`).
- `billing_funding_lots.source`: `payment` | `admin_credit` (провайдер-нейтрально); один лот на платёж.
- Off-session `requires_action` → `OffSessionCharger.CancelPayment` (добавлен к плану).
- Owner refund requests — отдельная таблица `billing_refund_requests`; исполняются суперадмином как `billing_refunds`.
- Приостановка за неоплату: `403 WORKSPACE_SUSPENDED` + `reason WORKSPACE_BILLING_SUSPENDED`.
- `BILLING_UPDATE` лизится workspace-доступом: при приостановке владелец его может не получить —
  клиент перечитывает `GET …/billing` (решает T3/T5).
- Запись — через `db.Tx`/`db.GuardValue`; прямые мутации `d.Q.*` и `Pool` ловит
  `TestIdentityMutationQueryAndPoolInventory`.

## Решения T3 (приём и приостановка)

- Вход в пространство — `plans.Service`: `AdmitSeat` (приглашение, открытое, регистрация,
  добавление по аккаунту, email-приглашение после подтверждения — в savepoint, отказ оставляет
  приглашение висеть), `PromoteSeat` (гость → участник), `SeatRemoved` (выход, удаление, бан,
  понижение до гостя). Вызов `billing.Seats` — в той же транзакции после записи членства; гости
  и боты не вызывают. `BILLING_ENABLED=false` — ни одного лишнего запроса.
- Отказ `Seats` за деньги: `409 BILLING_SEAT_GROWTH_REQUIRES_FUNDS`, текст для владельца
  («пополните баланс») или остальных («попросите владельца»); клиент различает по reason.
- Приостановка: `identitypolicy.State.BillingSuspended` (из `billing_accounts.status='suspended'`
  в снимке `GetIdentityGateState`, при `BILLING_ENFORCEMENT_ENABLED`). Закрыто всё, чтение тоже;
  владельцу открыты `BillingRead/BillingWrite`: маршруты `scopeBilling` и `GET
  /api/workspaces/{id}`. Боты, входы (ссылки, регистрация, гостевые ссылки), RTC закрыты; шлюз
  убирает пространство (`IdentityAccess` reason `SUSPENDED`), владельцу доходит только
  `BILLING_UPDATE`. Модерация и биллинг друг друга не снимают; владелец платит и под модерацией.
- После изменения статуса/плана аккаунта ядро вызывает `plans.Service.BillingChanged` (сброс
  кэша + `WORKSPACE_UPDATE` с `Workspace.billing`). Ручной план при `source='billing'` — `409
  BILLING_PLAN_MANAGED` (условный upsert).

## Решения T7 (автопополнение)

- `internal/billing/autotopup.Job` (запускается в `billingwiring.go` при `BILLING_ENABLED`; новые
  попытки — только при `BILLING_AUTO_TOPUP_ENABLED`, разбор открытых — всегда). Порог, фазы,
  unknown и restore — ADR-0080 §7 «Дополнение v1 (T7)».
- Зачисление — только через `inbox.SyncPayment` + хук `inbox.AttemptSettled` (попытка
  становится `succeeded` в транзакции зачисления; поздний успех после `failed` не скрывается).
- Письма: `billing_autotopup_failed` (каждый отказ), `billing_autotopup_action_required`
  (банк просит подтверждение, PI отменён); ключ дедупликации `auto_topup:{attempt}`.
- `PUT …/auto-topup`: `consent_version` = `autotopup.ConsentVersion` (текст —
  `autotopup.ConsentTexts`), потолок в [минимум метода, $5000].
- Новый маршрут `POST /api/admin/billing/auto-topup/reconcile` (scope admin, боты запрещены).
