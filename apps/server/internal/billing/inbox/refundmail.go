package inbox

import (
	"context"
	"log/slog"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// NotifyRefundDone queues the owner's «refund done» mail of a refund executed outside the inbox
// (the superadmin's synchronous refund; once per refund).
func (in *Inbox) NotifyRefundDone(ctx context.Context, ref sqlc.BillingRefund) {
	err := in.db.Tx(ctx, func(q *sqlc.Queries) error {
		acc, err := q.GetBillingAccount(ctx, ref.AccountID)
		if err != nil {
			return err
		}
		return in.Mail.Notify(ctx, q, acc, "refund:"+ref.ID.String(), mail.TemplateBillingRefundDone, mail.Params{
			"amount": amountText(ref.AmountMinor, ref.Currency),
		})
	})
	if err != nil {
		slog.WarnContext(ctx, "billing: refund mail", "refund", ref.ID, "err", err)
	}
}
