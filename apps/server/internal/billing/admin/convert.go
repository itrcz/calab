package admin

import (
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func money(minor int64, currency string) *v1.Money {
	return &v1.Money{Minor: minor, Currency: currency}
}

func ts(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}

func idString(id *uuid.UUID) string {
	if id == nil {
		return ""
	}
	return id.String()
}

func planProto(plan string) v1.Plan {
	switch plan {
	case core.PlanTeam:
		return v1.Plan_PLAN_TEAM
	case core.PlanEnterprise:
		return v1.Plan_PLAN_ENTERPRISE
	case core.PlanFree:
		return v1.Plan_PLAN_FREE
	case core.PlanCustom:
		return v1.Plan_PLAN_CUSTOM
	}
	return v1.Plan_PLAN_UNSPECIFIED
}

// planName maps a paid plan of a request; "" for anything else.
func planName(p v1.Plan) string {
	switch p {
	case v1.Plan_PLAN_TEAM:
		return core.PlanTeam
	case v1.Plan_PLAN_ENTERPRISE:
		return core.PlanEnterprise
	}
	return ""
}

var accountStatuses = map[string]v1.BillingAccountStatus{
	core.StatusInactive:  v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_INACTIVE,
	core.StatusActive:    v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_ACTIVE,
	core.StatusStopped:   v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_STOPPED,
	core.StatusSuspended: v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_SUSPENDED,
	core.StatusClosed:    v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_CLOSED,
}

var ledgerKinds = map[string]v1.LedgerEntryKind{
	core.KindTopup:           v1.LedgerEntryKind_LEDGER_ENTRY_KIND_TOPUP,
	core.KindSeatCharge:      v1.LedgerEntryKind_LEDGER_ENTRY_KIND_SEAT_CHARGE,
	core.KindCompensation:    v1.LedgerEntryKind_LEDGER_ENTRY_KIND_COMPENSATION,
	core.KindRefund:          v1.LedgerEntryKind_LEDGER_ENTRY_KIND_REFUND,
	core.KindRefundReversal:  v1.LedgerEntryKind_LEDGER_ENTRY_KIND_REFUND_REVERSAL,
	core.KindDispute:         v1.LedgerEntryKind_LEDGER_ENTRY_KIND_DISPUTE,
	core.KindDisputeReversal: v1.LedgerEntryKind_LEDGER_ENTRY_KIND_DISPUTE_REVERSAL,
	core.KindAdminCredit:     v1.LedgerEntryKind_LEDGER_ENTRY_KIND_ADMIN_CREDIT,
	core.KindAdminDebit:      v1.LedgerEntryKind_LEDGER_ENTRY_KIND_ADMIN_DEBIT,
}

var paymentStatuses = map[string]v1.PaymentStatus{
	"processing": v1.PaymentStatus_PAYMENT_STATUS_PROCESSING,
	"succeeded":  v1.PaymentStatus_PAYMENT_STATUS_SUCCEEDED,
	"failed":     v1.PaymentStatus_PAYMENT_STATUS_FAILED,
	"canceled":   v1.PaymentStatus_PAYMENT_STATUS_CANCELED,
}

var paymentOrigins = map[string]v1.PaymentOrigin{
	"checkout":     v1.PaymentOrigin_PAYMENT_ORIGIN_CHECKOUT,
	"auto_topup":   v1.PaymentOrigin_PAYMENT_ORIGIN_AUTO_TOPUP,
	"saved_method": v1.PaymentOrigin_PAYMENT_ORIGIN_SAVED_METHOD,
	"import":       v1.PaymentOrigin_PAYMENT_ORIGIN_IMPORT,
}

var refundStatuses = map[string]v1.RefundStatus{
	core.RefundPending:        v1.RefundStatus_REFUND_STATUS_PENDING,
	core.RefundRequiresAction: v1.RefundStatus_REFUND_STATUS_REQUIRES_ACTION,
	core.RefundSucceeded:      v1.RefundStatus_REFUND_STATUS_SUCCEEDED,
	core.RefundFailed:         v1.RefundStatus_REFUND_STATUS_FAILED,
	core.RefundCanceled:       v1.RefundStatus_REFUND_STATUS_CANCELED,
}

var refundOrigins = map[string]v1.RefundOrigin{
	core.RefundOriginCalab:     v1.RefundOrigin_REFUND_ORIGIN_CALAB,
	core.RefundOriginDashboard: v1.RefundOrigin_REFUND_ORIGIN_DASHBOARD,
}

var refundRequestStatuses = map[string]v1.RefundRequestStatus{
	"requested": v1.RefundRequestStatus_REFUND_REQUEST_STATUS_REQUESTED,
	"approved":  v1.RefundRequestStatus_REFUND_REQUEST_STATUS_APPROVED,
	"rejected":  v1.RefundRequestStatus_REFUND_REQUEST_STATUS_REJECTED,
	"withdrawn": v1.RefundRequestStatus_REFUND_REQUEST_STATUS_WITHDRAWN,
}

type accountRow struct {
	acc      sqlc.BillingAccount
	wsName   string
	email    string
	billable int32
	planName string
}

func accountProto(r accountRow) *v1.AdminBillingAccount {
	a := r.acc
	out := &v1.AdminBillingAccount{
		AccountId: a.ID.String(), WorkspaceId: idString(a.WorkspaceID), WorkspaceName: r.wsName, OwnerEmail: r.email,
		Market: a.Market, Status: accountStatuses[a.Status], Plan: planProto(a.Plan),
		Balance: money(a.BalanceMinor, a.Currency), Debt: money(max(0, -a.BalanceMinor), a.Currency),
		DiscountBps: uint32(a.DiscountBps), //nolint:gosec // CHECK 0..10000
		HoldUntil:   ts(a.HoldUntil), DisputeHold: a.DisputeHold, NegativeSince: ts(a.NegativeSince),
		SuspendAt: ts(a.SuspendAt), NextDueAt: ts(a.NextDueAt), CreatedAt: timestamppb.New(a.CreatedAt),
		Revision:        uint64(a.Revision), //nolint:gosec // CHECK revision >= 1
		BillableMembers: uint32(max(0, r.billable)),
		Provider:        a.Provider,
		Lapsed:          core.Lapsed(a), LapsedAt: ts(a.LapsedAt),
	}
	if a.Plan == core.PlanCustom {
		out.PlanDisplayName = r.planName
	}
	return out
}

func ledgerProto(r sqlc.AdminListBillingLedgerRow, currency string) *v1.LedgerEntry {
	l := r.BillingLedger
	e := &v1.LedgerEntry{
		Id: l.ID.String(), Seq: uint64(l.Seq), //nolint:gosec // CHECK seq >= 1
		Kind: ledgerKinds[l.Kind], Amount: money(l.AmountMinor, currency), BalanceAfter: money(l.BalanceAfter, currency),
		CreatedAt: timestamppb.New(l.CreatedAt), Reason: l.Reason, ActorId: idString(l.ActorID),
		StartsAt: ts(r.ChargeStartsAt), EndsAt: ts(r.ChargeEndsAt), PaymentId: idString(r.LotPaymentID),
		RefundId: idString(l.RefundID),
	}
	if r.ChargeSku != nil {
		e.Sku = *r.ChargeSku
	}
	if r.ChargeQty != nil {
		e.Quantity = uint32(max(0, *r.ChargeQty))
	}
	return e
}

func paymentProto(p sqlc.BillingPayment, ws *uuid.UUID) *v1.AdminBillingPayment {
	return &v1.AdminBillingPayment{
		Payment: &v1.BillingPayment{
			Id: p.ID.String(), Amount: money(p.AmountMinor, p.Currency), Status: paymentStatuses[p.Status],
			Origin: paymentOrigins[p.Origin], SucceededAt: ts(p.SucceededAt), ReceiptUrl: p.ReceiptUrl,
			Refunded: money(p.RefundedMinor, p.Currency), CreatedAt: timestamppb.New(p.CreatedAt),
		},
		AccountId: p.AccountID.String(), WorkspaceId: idString(ws), Provider: p.Provider,
		ProviderPaymentId: p.ProviderPaymentID, Livemode: p.Livemode,
	}
}

func refundProto(r sqlc.BillingRefund) *v1.AdminBillingRefund {
	out := &v1.AdminBillingRefund{
		Refund: &v1.BillingRefund{
			Id: r.ID.String(), PaymentId: r.PaymentID.String(), Amount: money(r.AmountMinor, r.Currency),
			Status: refundStatuses[r.Status], Origin: refundOrigins[r.Origin], Reason: r.Reason,
			CreatedAt: timestamppb.New(r.CreatedAt), SucceededAt: ts(r.SucceededAt),
		},
		AccountId: r.AccountID.String(),
	}
	if r.ProviderRefundID != nil {
		out.ProviderRefundId = *r.ProviderRefundID
	}
	if r.NeedsReviewAt != nil && (r.Status == core.RefundPending || r.Status == core.RefundRequiresAction) {
		out.NeedsReviewSince = timestamppb.New(*r.NeedsReviewAt)
	}
	return out
}

func disputeProto(d sqlc.BillingDispute) *v1.AdminBillingDispute {
	status := v1.DisputeStatus_DISPUTE_STATUS_OPEN
	if d.Status != "open" && d.Outcome != nil {
		switch *d.Outcome {
		case core.DisputeWon:
			status = v1.DisputeStatus_DISPUTE_STATUS_WON
		case core.DisputeLost:
			status = v1.DisputeStatus_DISPUTE_STATUS_LOST
		case core.DisputeWithdrawn:
			status = v1.DisputeStatus_DISPUTE_STATUS_WITHDRAWN
		}
	}
	return &v1.AdminBillingDispute{
		Dispute: &v1.BillingDispute{
			Id: d.ID.String(), PaymentId: d.PaymentID.String(), Amount: money(d.AmountMinor, d.Currency), Status: status,
			CreatedAt: timestamppb.New(d.CreatedAt), ClosedAt: ts(d.ClosedAt),
		},
		AccountId: d.AccountID.String(), ProviderDisputeId: d.ProviderDisputeID,
	}
}

func refundRequestProto(r sqlc.BillingRefundRequest, ws *uuid.UUID, currency string) *v1.AdminBillingRefundRequest {
	return &v1.AdminBillingRefundRequest{
		Request: &v1.BillingRefundRequest{
			Id: r.ID.String(), Amount: money(r.AmountMinor, currency), Status: refundRequestStatuses[r.Status],
			Reason: r.Reason, CreatedAt: timestamppb.New(r.CreatedAt), DecidedAt: ts(r.DecidedAt),
		},
		AccountId: r.AccountID.String(), WorkspaceId: idString(ws),
	}
}

func eventProto(e sqlc.BillingProviderEvent) *v1.AdminProviderEvent {
	return &v1.AdminProviderEvent{
		Id: e.ID.String(), Provider: e.Provider, EventId: e.EventID, Kind: e.Kind, ObjectId: e.ObjectID,
		Livemode: e.Livemode, ReceivedAt: timestamppb.New(e.ReceivedAt), ProcessedAt: ts(e.ProcessedAt),
		Attempts: uint32(max(0, e.Attempts)), Error: e.Error,
	}
}

func priceProto(p sqlc.BillingPrice) *v1.AdminPriceVersion {
	out := &v1.AdminPriceVersion{
		Id: p.ID.String(), Market: p.Market, Sku: p.Sku, Unit: money(p.UnitMinor, p.Currency),
		EffectiveFrom: timestamppb.New(p.EffectiveFrom), CreatedAt: timestamppb.New(p.CreatedAt),
		AccountId: idString(p.AccountID),
	}
	if p.Plan != nil {
		out.Plan = planProto(*p.Plan)
	}
	return out
}

func autoTopupProto(a sqlc.BillingAutotopup, currency string) *v1.AutoTopupSettings {
	return &v1.AutoTopupSettings{
		Enabled: a.RevokedAt == nil, PaymentMethodId: a.PmID.String(), MaxAmount: money(a.MaxMinor, currency),
		ConsentVersion: uint32(max(0, a.ConsentVersion)), ConsentAt: timestamppb.New(a.ConsentAt), NotBefore: ts(a.NotBefore),
	}
}

// savedMethodProto: a saved card as the account page shows it (provider, brand, last 4).
func savedMethodProto(m sqlc.BillingPaymentMethod) *v1.SavedPaymentMethod {
	out := &v1.SavedPaymentMethod{Id: m.ID.String(), Brand: m.Brand, Provider: m.Provider, CreatedAt: timestamppb.New(m.CreatedAt)}
	switch m.Kind {
	case "card":
		out.Kind = v1.PaymentMethodKind_PAYMENT_METHOD_KIND_CARD
	case "sbp":
		out.Kind = v1.PaymentMethodKind_PAYMENT_METHOD_KIND_SBP
	}
	if m.Last4 != nil {
		out.Last4 = *m.Last4
	}
	if m.ExpMonth != nil {
		out.ExpMonth = uint32(*m.ExpMonth) //nolint:gosec // 1..12 (CHECK)
	}
	if m.ExpYear != nil {
		out.ExpYear = uint32(*m.ExpYear) //nolint:gosec // 2000..2200 (CHECK)
	}
	return out
}
