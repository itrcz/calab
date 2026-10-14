package inbox

import (
	"context"
	"log/slog"
	"maps"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
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

	// Enforced: BILLING_ENFORCEMENT_ENABLED. Without it a lapsed account acts as plain Free
	// (plans.Info), so «the plan is not active» mails would be false: none are sent.
	Enforced bool
	// FreeBlockers lists what keeps a workspace from fitting Free (plans.Service.FreeViolations),
	// worded for the mail. nil = the mail goes without the list.
	FreeBlockers func(ctx context.Context, ws uuid.UUID) ([]*v1.PlanLimitViolation, error)
}

// NewNotifier creates the notifier; nil when mail is disabled (every method is a no-op on nil).
func NewNotifier(d *db.DB, m Mailer, appURL string) *Notifier {
	if m == nil || !m.Enabled() || appURL == "" {
		return nil
	}
	return &Notifier{db: d, mail: m, appURL: appURL}
}

// ManagersCopied reports the warnings that need someone to act — a debt started, the suspension near or
// done, the plan not active (or about to be), a failed or blocked auto-topup — go to the BILLING_MANAGE holders too (ADR-0087); the
// rest (payment received, refund, dispute) stays the owner's.
func ManagersCopied(t mail.Template) bool {
	switch t {
	case mail.TemplateBillingDebtStarted, mail.TemplateBillingSuspendSoon, mail.TemplateBillingSuspended,
		mail.TemplateBillingLapsed, mail.TemplateBillingLapseSoon, mail.TemplateBillingAutoTopupFailed, mail.TemplateBillingAutoTopupActionRequired:
		return true
	}
	return false
}

// Notify queues template for the owner of acc's workspace in q unless key was mailed already;
// ManagersCopied templates also for the BILLING_MANAGE holders (one dedup row per key).
// The caller's transaction must hold the account lock (so two notifications of one key cannot
// race); the mail commits or rolls back with it.
func (n *Notifier) Notify(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, key string, t mail.Template, p mail.Params) error {
	return n.notify(ctx, q, acc, key, t, p, nil)
}

// notify is Notify with per: extra params worded for each recipient's locale (nil = none).
func (n *Notifier) notify(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, key string, t mail.Template, p mail.Params, per func(locale string) mail.Params) error {
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
	var to []sqlc.ListBillingManagerRecipientsRow
	if owner.Email != nil && *owner.Email != "" {
		locale := ""
		if owner.Locale != nil {
			locale = *owner.Locale
		}
		to = append(to, sqlc.ListBillingManagerRecipientsRow{Email: *owner.Email, Locale: locale})
	}
	if ManagersCopied(t) {
		managers, err := q.ListBillingManagerRecipients(ctx, ws.ID)
		if err != nil {
			return err
		}
		to = append(to, managers...)
	}
	if len(to) == 0 {
		return nil
	}
	params := mail.Params{"workspace": ws.Name, "url": n.appURL}
	for k, v := range p {
		if v != "" {
			params[k] = v
		}
	}
	var first uuid.UUID // billing_notifications points at the first mail (the owner's when they have an e-mail)
	for _, r := range to {
		rp := params
		if per != nil {
			rp = maps.Clone(params)
			maps.Copy(rp, per(r.Locale))
		}
		id, err := n.mail.EnqueueFinancial(ctx, q, mail.Mail{To: r.Email, Template: t, Locale: r.Locale, Params: rp, TTL: mail.FinancialTTL})
		if err != nil {
			return err
		}
		if first == uuid.Nil {
			first = id
		}
	}
	_, err = q.InsertBillingNotification(ctx, sqlc.InsertBillingNotificationParams{AccountID: acc.ID, Key: key, Template: string(t), MailID: &first})
	if db.IsNotFound(err) {
		return nil
	}
	return err
}

// NotifyTx is Notify in its own transaction (locks the account).
func (n *Notifier) NotifyTx(ctx context.Context, accountID uuid.UUID, key string, t mail.Template, p mail.Params) error {
	return n.notifyTx(ctx, accountID, key, t, p, nil)
}

func (n *Notifier) notifyTx(ctx context.Context, accountID uuid.UUID, key string, t mail.Template, p mail.Params, per func(locale string) mail.Params) error {
	if n == nil {
		return nil
	}
	err := n.db.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.LockBillingAccount(ctx, accountID)
		if err != nil {
			return err
		}
		return n.notify(ctx, q, acc, key, t, p, per)
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
	if core.Lapsed(acc) && n.Enforced && acc.WorkspaceID != nil {
		// The restricted mode started (once per episode: the key is the moment it began).
		if err := n.notifyTx(ctx, acc.ID, "lapsed:"+stamp(*acc.LapsedAt), mail.TemplateBillingLapsed, nil, n.blockers(ctx, *acc.WorkspaceID)); err != nil {
			return err
		}
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

// blockers words what does not fit Free per recipient locale; nil when unknown (the mail then
// goes without the list: it still says what happened).
func (n *Notifier) blockers(ctx context.Context, ws uuid.UUID) func(locale string) mail.Params {
	if n.FreeBlockers == nil {
		return nil
	}
	vs, err := n.FreeBlockers(ctx, ws)
	if err != nil {
		slog.WarnContext(ctx, "billing mail: what does not fit Free", "workspace", ws, "err", err)
		return nil
	}
	return func(locale string) mail.Params { return mail.Params{"reasons": mail.FreeBlockers(locale, vs)} }
}

// LapseSoon mails the heads-up a day before the last paid day of a stopped account ends, when
// the workspace does not fit Free (ADR-0086 amendment 1): once per end of the paid days. A
// workspace that fits Free just moves to Free then, and nothing is said.
func (n *Notifier) LapseSoon(ctx context.Context, acc sqlc.BillingAccount) error {
	if n == nil || !n.Enforced || n.FreeBlockers == nil || acc.WorkspaceID == nil || acc.NextDueAt == nil ||
		acc.Status != core.StatusStopped || acc.LapsedAt != nil {
		return nil
	}
	vs, err := n.FreeBlockers(ctx, *acc.WorkspaceID)
	if err != nil || len(vs) == 0 {
		return err
	}
	return n.notifyTx(ctx, acc.ID, "lapse_soon:"+stamp(*acc.NextDueAt), mail.TemplateBillingLapseSoon, mail.Params{"deadline": deadline(*acc.NextDueAt)},
		func(locale string) mail.Params { return mail.Params{"reasons": mail.FreeBlockers(locale, vs)} })
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
