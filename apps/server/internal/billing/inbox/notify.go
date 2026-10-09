package inbox

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/core"
	billingmoney "github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Mailer is the part of mail.Service the notifier uses.
type Mailer interface {
	Enabled() bool
	EnqueueFinancial(ctx context.Context, q *sqlc.Queries, m mail.Mail) (uuid.UUID, error)
	Wake()
}

// Notifier queues billing mails to the workspace owner, once per (account, business key):
// billing_notifications is the dedup table and points at the mail_outbox row.
type Notifier struct {
	db     *db.DB
	mail   Mailer
	appURL string // the link of every billing mail (PUBLIC_APP_URL)
}

// NewNotifier creates the notifier; nil when mail is disabled (every method is a no-op on nil).
func NewNotifier(d *db.DB, m Mailer, appURL string) *Notifier {
	if m == nil || !m.Enabled() || appURL == "" {
		return nil
	}
	return &Notifier{db: d, mail: m, appURL: appURL}
}

// Notify queues template for the owner of acc's workspace in q unless key was mailed already.
// The caller's transaction must hold the account lock (so two notifications of one key cannot
// race); the mail commits or rolls back with it.
func (n *Notifier) Notify(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, key string, t mail.Template, p mail.Params) error {
	if n == nil || acc.WorkspaceID == nil {
		return nil
	}
	if _, err := q.GetBillingNotification(ctx, sqlc.GetBillingNotificationParams{AccountID: acc.ID, Key: key}); err == nil {
		return nil
	} else if !db.IsNotFound(err) {
		return err
	}
	ws, err := q.GetWorkspace(ctx, *acc.WorkspaceID)
	if err != nil {
		return err
	}
	owner, err := q.GetUser(ctx, ws.OwnerID)
	if err != nil {
		return err
	}
	if owner.Email == nil || *owner.Email == "" {
		return nil
	}
	params := mail.Params{"workspace": ws.Name, "url": n.appURL}
	for k, v := range p {
		if v != "" {
			params[k] = v
		}
	}
	locale := ""
	if owner.Locale != nil {
		locale = *owner.Locale
	}
	id, err := n.mail.EnqueueFinancial(ctx, q, mail.Mail{To: *owner.Email, Template: t, Locale: locale, Params: params, TTL: mail.FinancialTTL})
	if err != nil {
		return err
	}
	_, err = q.InsertBillingNotification(ctx, sqlc.InsertBillingNotificationParams{AccountID: acc.ID, Key: key, Template: string(t), MailID: &id})
	if db.IsNotFound(err) {
		return nil
	}
	return err
}

// NotifyTx is Notify in its own transaction (locks the account).
func (n *Notifier) NotifyTx(ctx context.Context, accountID uuid.UUID, key string, t mail.Template, p mail.Params) error {
	if n == nil {
		return nil
	}
	err := n.db.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.LockBillingAccount(ctx, accountID)
		if err != nil {
			return err
		}
		return n.Notify(ctx, q, acc, key, t, p)
	})
	if err == nil {
		n.mail.Wake()
	}
	return err
}

// StateChanged mails what an account state means for the owner after a commit (Hooks.Committed):
// the start of a debt episode (once per episode) and a suspension (once per deadline).
func (n *Notifier) StateChanged(ctx context.Context, acc sqlc.BillingAccount) error {
	if n == nil {
		return nil
	}
	debt := ""
	if acc.BalanceMinor < 0 {
		debt = amountText(-acc.BalanceMinor, acc.Currency)
	}
	switch {
	case acc.Status == core.StatusSuspended && acc.SuspendAt != nil:
		return n.NotifyTx(ctx, acc.ID, "suspended:"+stamp(*acc.SuspendAt), mail.TemplateBillingSuspended, mail.Params{"amount": debt})
	case acc.NegativeSince != nil && acc.SuspendAt != nil && (acc.Status == core.StatusActive || acc.Status == core.StatusStopped):
		return n.NotifyTx(ctx, acc.ID, "debt:"+stamp(*acc.NegativeSince), mail.TemplateBillingDebtStarted, mail.Params{
			"amount": debt, "deadline": deadline(*acc.SuspendAt),
		})
	}
	return nil
}

// Wake makes the mail worker send now.
func (n *Notifier) Wake() {
	if n != nil {
		n.mail.Wake()
	}
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func deadline(t time.Time) string { return t.UTC().Format("2006-01-02 15:04 UTC") }

func amountText(minor int64, currency string) string {
	return billingmoney.New(minor, billingmoney.Currency(currency)).String()
}
