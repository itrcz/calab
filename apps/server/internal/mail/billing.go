package mail

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Balance billing mails (ADR-0080 §13) to the workspace owner. Required params: workspace and
// url (the app); amount, deadline and receipt_url are shown when set. Financial mail is
// deduplicated by the caller (billing_notifications: one mail per account and business key),
// does not use the recipient's hourly budget of codes and lives up to FinancialTTL.
const (
	TemplateBillingPaymentReceived Template = "billing_payment_received" // amount, receipt_url
	TemplateBillingDebtStarted     Template = "billing_debt_started"     // amount (debt), deadline
	TemplateBillingSuspendSoon     Template = "billing_suspend_soon"     // amount (debt), deadline
	TemplateBillingSuspended       Template = "billing_suspended"        // amount (debt)
	TemplateBillingRefundDone      Template = "billing_refund_done"      // amount
	TemplateBillingDisputeOpened   Template = "billing_dispute_opened"   // amount
)

// FinancialTTL is how long a billing mail is retried: for up to a week (the 24 h of ordinary mail would
// silently drop a financial event when SMTP is down over a weekend).
const FinancialTTL = 7 * 24 * time.Hour

type billingLabels struct {
	Amount, Deadline, Receipt, Open string
	Paid, Debt, Soon, Suspended     [3]string // subject, title, line
	Refund, Dispute                 [3]string
	Note                            string
}

func billingTexts(l billingLabels) map[Template]texts {
	amount := []detail{{l.Amount, "amount"}}
	withDeadline := []detail{{l.Amount, "amount"}, {l.Deadline, "deadline"}}
	t := func(s [3]string, d []detail, a []action) texts {
		return texts{Subject: s[0], Title: s[1], Line: s[2], Button: l.Open, Note: l.Note, Details: d, Actions: a}
	}
	return map[Template]texts{
		TemplateBillingPaymentReceived: t(l.Paid, amount, []action{{l.Receipt, "receipt_url"}}),
		TemplateBillingDebtStarted:     t(l.Debt, withDeadline, nil),
		TemplateBillingSuspendSoon:     t(l.Soon, withDeadline, nil),
		TemplateBillingSuspended:       t(l.Suspended, amount, nil),
		TemplateBillingRefundDone:      t(l.Refund, amount, nil),
		TemplateBillingDisputeOpened:   t(l.Dispute, amount, nil),
	}
}

var billingDict = map[string]billingLabels{
	LocaleEN: {
		Amount: "Amount", Deadline: "Deadline", Receipt: "Receipt", Open: "Open billing",
		Paid:      [3]string{"Payment received — “{{.workspace}}”", "Payment received", "The balance of “{{.workspace}}” was topped up."},
		Debt:      [3]string{"Balance is negative — “{{.workspace}}”", "The balance is negative", "Top up the balance of “{{.workspace}}” before the deadline, or the workspace will be suspended."},
		Soon:      [3]string{"One day left — “{{.workspace}}”", "One day before suspension", "The debt of “{{.workspace}}” is not paid. Top up the balance to keep the workspace open."},
		Suspended: [3]string{"Workspace suspended — “{{.workspace}}”", "The workspace is suspended", "“{{.workspace}}” was suspended for an unpaid balance. Pay the debt to open it again."},
		Refund:    [3]string{"Refund made — “{{.workspace}}”", "Refund made", "Money was refunded to the card it was paid with."},
		Dispute:   [3]string{"Payment disputed — “{{.workspace}}”", "A payment was disputed", "The bank opened a dispute on a payment of “{{.workspace}}”. The disputed amount is held until it is resolved."},
		Note:      "Only the owner of the workspace gets billing mail.",
	},
	LocaleRU: {
		Amount: "Сумма", Deadline: "Срок", Receipt: "Чек", Open: "Открыть оплату",
		Paid:      [3]string{"Оплата получена — «{{.workspace}}»", "Оплата получена", "Баланс пространства «{{.workspace}}» пополнен."},
		Debt:      [3]string{"Баланс отрицательный — «{{.workspace}}»", "Баланс ушёл в минус", "Пополните баланс «{{.workspace}}» до срока, иначе пространство будет приостановлено."},
		Soon:      [3]string{"Остался один день — «{{.workspace}}»", "До приостановки один день", "Долг пространства «{{.workspace}}» не оплачен. Пополните баланс, чтобы пространство осталось открытым."},
		Suspended: [3]string{"Пространство приостановлено — «{{.workspace}}»", "Пространство приостановлено", "«{{.workspace}}» приостановлено из-за неоплаченного долга. Оплатите долг, чтобы открыть его снова."},
		Refund:    [3]string{"Возврат выполнен — «{{.workspace}}»", "Возврат выполнен", "Деньги вернулись на карту, которой была оплата."},
		Dispute:   [3]string{"Оспаривание платежа — «{{.workspace}}»", "Платёж оспорен", "Банк открыл спор по платежу пространства «{{.workspace}}». Спорная сумма удерживается до решения."},
		Note:      "Письма об оплате получает только владелец пространства.",
	},
	LocaleES: {
		Amount: "Importe", Deadline: "Plazo", Receipt: "Recibo", Open: "Abrir facturación",
		Paid:      [3]string{"Pago recibido — «{{.workspace}}»", "Pago recibido", "Se recargó el saldo de «{{.workspace}}»."},
		Debt:      [3]string{"Saldo negativo — «{{.workspace}}»", "El saldo es negativo", "Recarga el saldo de «{{.workspace}}» antes del plazo o el espacio se suspenderá."},
		Soon:      [3]string{"Queda un día — «{{.workspace}}»", "Un día para la suspensión", "La deuda de «{{.workspace}}» no está pagada. Recarga el saldo para mantener el espacio abierto."},
		Suspended: [3]string{"Espacio suspendido — «{{.workspace}}»", "El espacio está suspendido", "«{{.workspace}}» se suspendió por saldo impagado. Paga la deuda para abrirlo de nuevo."},
		Refund:    [3]string{"Reembolso realizado — «{{.workspace}}»", "Reembolso realizado", "El dinero se devolvió a la tarjeta con la que se pagó."},
		Dispute:   [3]string{"Pago disputado — «{{.workspace}}»", "Un pago fue disputado", "El banco abrió una disputa sobre un pago de «{{.workspace}}». El importe queda retenido hasta su resolución."},
		Note:      "Solo el propietario del espacio recibe correos de facturación.",
	},
	LocaleZhCN: {
		Amount: "金额", Deadline: "期限", Receipt: "收据", Open: "打开账单",
		Paid:      [3]string{"已收到付款 — “{{.workspace}}”", "已收到付款", "工作区“{{.workspace}}”的余额已充值。"},
		Debt:      [3]string{"余额为负 — “{{.workspace}}”", "余额为负", "请在期限前为“{{.workspace}}”充值，否则工作区将被暂停。"},
		Soon:      [3]string{"还剩一天 — “{{.workspace}}”", "距离暂停还有一天", "“{{.workspace}}”的欠款尚未支付。请充值以保持工作区开放。"},
		Suspended: [3]string{"工作区已暂停 — “{{.workspace}}”", "工作区已暂停", "“{{.workspace}}”因欠款被暂停。支付欠款即可重新开放。"},
		Refund:    [3]string{"已退款 — “{{.workspace}}”", "已退款", "款项已退回到付款所用的卡。"},
		Dispute:   [3]string{"付款争议 — “{{.workspace}}”", "一笔付款被提出争议", "银行对“{{.workspace}}”的一笔付款提出了争议。争议金额在解决前被冻结。"},
		Note:      "只有工作区所有者会收到账单邮件。",
	},
}

func init() {
	for loc, l := range billingDict {
		for t, tx := range billingTexts(l) {
			dict[loc][t] = tx
			templates[t] = []string{"workspace", "url"}
		}
	}
}

// IsBillingTemplate reports whether t is a billing mail.
func IsBillingTemplate(t Template) bool {
	_, ok := billingTexts(billingLabels{})[t]
	return ok
}

// EnqueueFinancial queues a billing mail in q (the caller's transaction, which also writes the
// billing_notifications dedup row) and returns the mail id. Unlike Enqueue it takes nothing
// from the recipient's hourly budget (financial mail must not compete with sign-in codes) and
// lives up to FinancialTTL. Call Wake after the commit.
func (s *Service) EnqueueFinancial(ctx context.Context, q *sqlc.Queries, m Mail) (uuid.UUID, error) {
	if !s.Enabled() {
		return uuid.Nil, ErrDisabled
	}
	if !IsBillingTemplate(m.Template) {
		return uuid.Nil, fmt.Errorf("mail: %q is not a billing template", m.Template)
	}
	if q == nil {
		return uuid.Nil, fmt.Errorf("mail: EnqueueFinancial needs the caller's transaction")
	}
	sealed, err := s.seal(m.Params)
	if err != nil {
		return uuid.Nil, err
	}
	ttl := m.TTL
	if ttl <= 0 || ttl > FinancialTTL {
		ttl = FinancialTTL
	}
	return q.EnqueueMail(ctx, sqlc.EnqueueMailParams{
		ToAddr: m.To, Template: string(m.Template), Locale: Locale(m.Locale), Params: sealed,
		Priority: PriorityNotice, ExpiresAt: time.Now().Add(ttl),
	})
}
