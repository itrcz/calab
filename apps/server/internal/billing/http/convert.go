package billinghttp

import (
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func mon(minor int64, currency string) *v1.Money { return &v1.Money{Minor: minor, Currency: currency} }

func ts(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}

func idStr(id *uuid.UUID) string {
	if id == nil {
		return ""
	}
	return id.String()
}

// Status is the WorkspaceBillingStatus of an account in GET …/billing (nil account = no
// billing): the state every member may see, without amounts, mapped like Workspace.billing
// (plans.resolveBilling). source is workspace_plans.source ("" = no plan row).
func Status(acc *sqlc.BillingAccount, source string) *v1.WorkspaceBillingStatus {
	st := &v1.WorkspaceBillingStatus{Source: v1.PlanSource_PLAN_SOURCE_MANUAL}
	if source == "billing" {
		st.Source = v1.PlanSource_PLAN_SOURCE_BILLING
	}
	if acc == nil || acc.Status == core.StatusClosed {
		return st
	}
	switch acc.Status {
	case core.StatusInactive:
		st.State = v1.BillingState_BILLING_STATE_INACTIVE
	case core.StatusActive:
		st.State = v1.BillingState_BILLING_STATE_ACTIVE
		if acc.NegativeSince != nil {
			st.State, st.SuspendAt = v1.BillingState_BILLING_STATE_IN_ARREARS, ts(acc.SuspendAt)
		}
	case core.StatusStopped:
		st.State, st.SuspendAt = v1.BillingState_BILLING_STATE_STOPPED, ts(acc.SuspendAt)
	case core.StatusSuspended:
		st.State, st.SuspendAt = v1.BillingState_BILLING_STATE_SUSPENDED, ts(acc.SuspendAt)
	}
	return st
}

func accountStatus(s string) v1.BillingAccountStatus {
	switch s {
	case core.StatusInactive:
		return v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_INACTIVE
	case core.StatusActive:
		return v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_ACTIVE
	case core.StatusStopped:
		return v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_STOPPED
	case core.StatusSuspended:
		return v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_SUSPENDED
	case core.StatusClosed:
		return v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_CLOSED
	}
	return v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_UNSPECIFIED
}

func planProto(p string) v1.Plan {
	switch p {
	case core.PlanTeam:
		return v1.Plan_PLAN_TEAM
	case core.PlanEnterprise:
		return v1.Plan_PLAN_ENTERPRISE
	case core.PlanFree:
		return v1.Plan_PLAN_FREE
	}
	return v1.Plan_PLAN_UNSPECIFIED
}

// planName: "" for anything but a paid plan.
func planName(p v1.Plan) string {
	switch p {
	case v1.Plan_PLAN_TEAM:
		return core.PlanTeam
	case v1.Plan_PLAN_ENTERPRISE:
		return core.PlanEnterprise
	}
	return ""
}

func methodKind(m provider.Method) v1.PaymentMethodKind {
	switch m {
	case provider.MethodCard:
		return v1.PaymentMethodKind_PAYMENT_METHOD_KIND_CARD
	case provider.MethodSBP:
		return v1.PaymentMethodKind_PAYMENT_METHOD_KIND_SBP
	case provider.MethodBankTransfer:
		return v1.PaymentMethodKind_PAYMENT_METHOD_KIND_BANK_TRANSFER
	}
	return v1.PaymentMethodKind_PAYMENT_METHOD_KIND_UNSPECIFIED
}

func methodOption(o provider.MethodOption) *v1.PaymentMethodOption {
	return &v1.PaymentMethodOption{
		Id: o.ID, Provider: string(o.Provider), Kind: methodKind(o.Method),
		Min: mon(o.Min, string(o.Currency)), Max: mon(o.Max, string(o.Currency)), AutoTopupCapable: o.AutoTopupCapable,
	}
}

func payerType(t string) v1.PayerType {
	switch t {
	case provider.PayerPerson:
		return v1.PayerType_PAYER_TYPE_PERSON
	case provider.PayerCompany:
		return v1.PayerType_PAYER_TYPE_COMPANY
	}
	return v1.PayerType_PAYER_TYPE_UNSPECIFIED
}

func payerProto(p sqlc.BillingPayer) *v1.PayerProfile {
	out := &v1.PayerProfile{Type: payerType(p.Type), Name: p.Name, Country: p.Country, Email: p.Email}
	if p.TaxID != nil {
		out.TaxId = *p.TaxID
	}
	return out
}

func savedMethodProto(m sqlc.BillingPaymentMethod) *v1.SavedPaymentMethod {
	out := &v1.SavedPaymentMethod{Id: m.ID.String(), Kind: methodKind(provider.Method(m.Kind)), Brand: m.Brand, Provider: m.Provider, CreatedAt: timestamppb.New(m.CreatedAt)}
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

func attemptStatus(s string) v1.AutoTopupAttemptStatus {
	switch s {
	case "prepared":
		return v1.AutoTopupAttemptStatus_AUTO_TOPUP_ATTEMPT_STATUS_PREPARED
	case "dispatched":
		return v1.AutoTopupAttemptStatus_AUTO_TOPUP_ATTEMPT_STATUS_DISPATCHED
	case "succeeded":
		return v1.AutoTopupAttemptStatus_AUTO_TOPUP_ATTEMPT_STATUS_SUCCEEDED
	case "failed":
		return v1.AutoTopupAttemptStatus_AUTO_TOPUP_ATTEMPT_STATUS_FAILED
	case "unknown":
		return v1.AutoTopupAttemptStatus_AUTO_TOPUP_ATTEMPT_STATUS_UNKNOWN
	case "requires_action":
		return v1.AutoTopupAttemptStatus_AUTO_TOPUP_ATTEMPT_STATUS_REQUIRES_ACTION
	}
	return v1.AutoTopupAttemptStatus_AUTO_TOPUP_ATTEMPT_STATUS_UNSPECIFIED
}

func paymentStatus(s string) v1.PaymentStatus {
	switch s {
	case "processing":
		return v1.PaymentStatus_PAYMENT_STATUS_PROCESSING
	case "succeeded":
		return v1.PaymentStatus_PAYMENT_STATUS_SUCCEEDED
	case "failed":
		return v1.PaymentStatus_PAYMENT_STATUS_FAILED
	case "canceled":
		return v1.PaymentStatus_PAYMENT_STATUS_CANCELED
	}
	return v1.PaymentStatus_PAYMENT_STATUS_UNSPECIFIED
}

func paymentOrigin(s string) v1.PaymentOrigin {
	switch s {
	case "checkout":
		return v1.PaymentOrigin_PAYMENT_ORIGIN_CHECKOUT
	case "auto_topup":
		return v1.PaymentOrigin_PAYMENT_ORIGIN_AUTO_TOPUP
	case "saved_method":
		return v1.PaymentOrigin_PAYMENT_ORIGIN_SAVED_METHOD
	case "import":
		return v1.PaymentOrigin_PAYMENT_ORIGIN_IMPORT
	}
	return v1.PaymentOrigin_PAYMENT_ORIGIN_UNSPECIFIED
}

// PaymentProto is the owner view of a payment (T6 wraps it in AdminBillingPayment).
func PaymentProto(p sqlc.BillingPayment) *v1.BillingPayment {
	return &v1.BillingPayment{
		Id: p.ID.String(), Amount: mon(p.AmountMinor, p.Currency), Status: paymentStatus(p.Status), Origin: paymentOrigin(p.Origin),
		SucceededAt: ts(p.SucceededAt), ReceiptUrl: p.ReceiptUrl, Refunded: mon(p.RefundedMinor, p.Currency),
		CreatedAt: timestamppb.New(p.CreatedAt),
	}
}

func refundRequestStatus(s string) v1.RefundRequestStatus {
	switch s {
	case "requested":
		return v1.RefundRequestStatus_REFUND_REQUEST_STATUS_REQUESTED
	case "approved":
		return v1.RefundRequestStatus_REFUND_REQUEST_STATUS_APPROVED
	case "rejected":
		return v1.RefundRequestStatus_REFUND_REQUEST_STATUS_REJECTED
	case "withdrawn":
		return v1.RefundRequestStatus_REFUND_REQUEST_STATUS_WITHDRAWN
	}
	return v1.RefundRequestStatus_REFUND_REQUEST_STATUS_UNSPECIFIED
}

// RefundRequestProto is the owner view of a refund request (T6 wraps it).
func RefundRequestProto(r sqlc.BillingRefundRequest, currency string) *v1.BillingRefundRequest {
	return &v1.BillingRefundRequest{
		Id: r.ID.String(), Amount: mon(r.AmountMinor, currency), Status: refundRequestStatus(r.Status), Reason: r.Reason,
		CreatedAt: timestamppb.New(r.CreatedAt), DecidedAt: ts(r.DecidedAt),
	}
}

func ledgerKind(k string) v1.LedgerEntryKind {
	switch k {
	case core.KindTopup:
		return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_TOPUP
	case core.KindSeatCharge:
		return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_SEAT_CHARGE
	case core.KindCompensation:
		return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_COMPENSATION
	case core.KindRefund:
		return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_REFUND
	case core.KindRefundReversal:
		return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_REFUND_REVERSAL
	case core.KindDispute:
		return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_DISPUTE
	case core.KindDisputeReversal:
		return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_DISPUTE_REVERSAL
	case core.KindAdminCredit:
		return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_ADMIN_CREDIT
	case core.KindAdminDebit:
		return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_ADMIN_DEBIT
	}
	return v1.LedgerEntryKind_LEDGER_ENTRY_KIND_UNSPECIFIED
}

func ledgerEntry(e sqlc.ListBillingLedgerPageRow, currency string) *v1.LedgerEntry {
	out := &v1.LedgerEntry{
		Id: e.ID.String(), Seq: uint64(e.Seq), Kind: ledgerKind(e.Kind), //nolint:gosec // seq >= 1 (CHECK)
		Amount: mon(e.AmountMinor, currency), BalanceAfter: mon(e.BalanceAfter, currency),
		CreatedAt: timestamppb.New(e.CreatedAt), Reason: e.Reason, ActorId: idStr(e.ActorID),
		StartsAt: ts(e.ChargeStartsAt), EndsAt: ts(e.ChargeEndsAt), PaymentId: idStr(e.LotPaymentID), RefundId: idStr(e.RefundID),
	}
	if e.ChargeSku != nil {
		out.Sku = *e.ChargeSku
	}
	if e.ChargeQty != nil {
		out.Quantity = uint32(*e.ChargeQty) //nolint:gosec // qty > 0 (CHECK)
	}
	return out
}

func checkoutState(s string) v1.CheckoutState {
	switch s {
	case "open":
		return v1.CheckoutState_CHECKOUT_STATE_OPEN
	case "completed":
		return v1.CheckoutState_CHECKOUT_STATE_COMPLETED
	case "expired":
		return v1.CheckoutState_CHECKOUT_STATE_EXPIRED
	case "canceled":
		return v1.CheckoutState_CHECKOUT_STATE_CANCELED
	case "failed":
		return v1.CheckoutState_CHECKOUT_STATE_FAILED
	}
	return v1.CheckoutState_CHECKOUT_STATE_UNSPECIFIED
}
