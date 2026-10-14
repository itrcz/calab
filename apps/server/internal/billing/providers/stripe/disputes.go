package stripe

import (
	"context"
	"fmt"
	"time"

	stripego "github.com/stripe/stripe-go/v86"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

var (
	_ provider.DisputeReader    = (*Provider)(nil)
	_ provider.RefundLister     = (*Provider)(nil)
	_ provider.LivemodeReporter = (*Provider)(nil)
)

// GetDispute reads a dispute: amount and status (the webhook inbox needs both; the event is
// only a hint). Inquiries (warning_*) stay open until they close; warning_closed and
// prevented end without a chargeback (withdrawn).
func (p *Provider) GetDispute(ctx context.Context, disputeID string) (provider.DisputeFact, error) {
	if disputeID == "" {
		return provider.DisputeFact{}, fmt.Errorf("%w: empty dispute id", ErrInvalidRequest)
	}
	acct, err := p.Account(ctx)
	if err != nil {
		return provider.DisputeFact{}, err
	}
	d, err := p.sc.V1Disputes.Retrieve(ctx, disputeID, &stripego.DisputeRetrieveParams{})
	if err != nil {
		return provider.DisputeFact{}, mapErr("get dispute", err)
	}
	if err := p.checkLive("get dispute", d.Livemode); err != nil {
		return provider.DisputeFact{}, err
	}
	amt, err := moneyOf(d.Amount, d.Currency)
	if err != nil {
		return provider.DisputeFact{}, err
	}
	f := provider.DisputeFact{ID: d.ID, ProviderAccount: acct, Livemode: d.Livemode, Amount: amt,
		Created: time.Unix(d.Created, 0).UTC(), Status: provider.DisputeOpen}
	if d.PaymentIntent != nil {
		f.PaymentID = d.PaymentIntent.ID
	}
	switch d.Status {
	case stripego.DisputeStatusWon:
		f.Status = provider.DisputeWon
	case stripego.DisputeStatusLost:
		f.Status = provider.DisputeLost
	case stripego.DisputeStatusWarningClosed, stripego.DisputeStatusPrevented:
		f.Status = provider.DisputeWithdrawn
	}
	return f, nil
}
