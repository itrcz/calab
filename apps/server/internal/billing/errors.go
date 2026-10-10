package billing

import (
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// ApiError.reason values of billing (ADR-0080 §13). Clients switch on the reason; the code is
// the generic one of the status (CONFLICT, FORBIDDEN, …), except billing suspension, which
// keeps code WORKSPACE_SUSPENDED so older clients treat it like a suspended workspace.
const (
	// 409
	ReasonInsufficientFunds          = "BILLING_INSUFFICIENT_FUNDS"
	ReasonQuoteExpired               = "BILLING_QUOTE_EXPIRED"
	ReasonRevisionConflict           = "BILLING_REVISION_CONFLICT"
	ReasonReconciling                = "BILLING_RECONCILING"
	ReasonPaymentPending             = "BILLING_PAYMENT_PENDING" // an open checkout / attempt exists
	ReasonPaymentUnknown             = "BILLING_PAYMENT_UNKNOWN"
	ReasonChangeIncompatible         = "BILLING_CHANGE_INCOMPATIBLE" // e.g. upgrade with debt
	ReasonPriceConfirmationRequired  = "BILLING_PRICE_CONFIRMATION_REQUIRED"
	ReasonSeatGrowthRequiresFunds    = "BILLING_SEAT_GROWTH_REQUIRES_FUNDS"
	ReasonRequestReused              = "BILLING_REQUEST_REUSED"       // same request_id, another body
	ReasonPlanManagedByBilling       = "BILLING_PLAN_MANAGED"         // manual plan change of a billing workspace
	ReasonPlanAdminAssigned          = "BILLING_PLAN_ADMIN_ASSIGNED"  // 409: a superadmin assigned the plan (ADR-0086)
	ReasonAccountExists              = "BILLING_ACCOUNT_EXISTS"       // superadmin enable twice
	ReasonMethodUnavailable          = "BILLING_METHOD_UNAVAILABLE"   // 422: method_id not offered to this account
	ReasonPermissionRequired         = "BILLING_PERMISSION_REQUIRED"  // 403: the caller lacks the route's billing bit (ADR-0087)
	ReasonWorkspaceBillingSuspended  = "WORKSPACE_BILLING_SUSPENDED"  // 403
	ReasonWorkspacePlanInactive      = "WORKSPACE_PLAN_INACTIVE"      // 403 (409 ROOM_FULL in voice): restricted mode «тариф не активен» (ADR-0086 amendment)
	ReasonDisabled                   = "BILLING_DISABLED"             // 501: BILLING_ENABLED=false or the flag of the feature is off
	ReasonNotImplemented             = "BILLING_NOT_IMPLEMENTED"      // 501: route registered, handler not built yet
	ReasonProviderUnavailable        = "BILLING_PROVIDER_UNAVAILABLE" // 503
	ReasonAutoTopupLimit             = "BILLING_AUTO_TOPUP_LIMIT"     // 422: cap outside default..max
	ReasonAutoTopupUnavailable       = "BILLING_AUTO_TOPUP_UNAVAILABLE"
	ReasonRefundExceedsRefundable    = "BILLING_REFUND_EXCEEDS_REFUNDABLE"
	ReasonAccountNotFound            = "BILLING_ACCOUNT_NOT_FOUND" // 404 for the owner of a workspace without billing
	ReasonDisputeHold                = "BILLING_DISPUTE_HOLD"
	ReasonInvalidCurrencyForAccount  = "BILLING_CURRENCY_MISMATCH"
	ReasonTestClockDisabled          = "BILLING_TEST_CLOCK_DISABLED"
	ReasonAmountOutOfRange           = "BILLING_AMOUNT_OUT_OF_RANGE" // 422: top-up outside min..max
	ReasonPriceEffectiveTooSoon      = "BILLING_PRICE_EFFECTIVE_TOO_SOON"
	ReasonManualCreditAlreadyReverse = "BILLING_CREDIT_ALREADY_REVERSED"
	ReasonRefundNotReleasable        = "BILLING_REFUND_NOT_RELEASABLE" // 409: not a needs-review refund, or the provider has a refund it may be
	ReasonMarketFixed                = "BILLING_MARKET_FIXED"          // 409: the market is fixed by the first credit (ADR-0083)
	ReasonMarketUnavailable          = "BILLING_MARKET_UNAVAILABLE"    // 422: no enabled provider serves the market
)

func coded(status int, code v1.ErrorCode, reason, msg string) *httpx.Error {
	return httpx.Coded(status, code, msg).WithDetails(reason, 0, 0)
}

func conflict(reason, msg string) *httpx.Error {
	return coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT, reason, msg)
}

// API errors shared by the billing packages and by admission (Seats). Compare with errors.Is.
var (
	ErrInsufficientFunds         = conflict(ReasonInsufficientFunds, "insufficient balance")
	ErrQuoteExpired              = conflict(ReasonQuoteExpired, "quote expired")
	ErrRevisionConflict          = conflict(ReasonRevisionConflict, "billing changed meanwhile")
	ErrReconciling               = conflict(ReasonReconciling, "billing is being reconciled")
	ErrPaymentPending            = conflict(ReasonPaymentPending, "a payment is pending")
	ErrPaymentUnknown            = conflict(ReasonPaymentUnknown, "payment outcome is not known yet")
	ErrChangeIncompatible        = conflict(ReasonChangeIncompatible, "change not possible now")
	ErrPriceConfirmationRequired = conflict(ReasonPriceConfirmationRequired, "new price needs confirmation")
	// ErrSeatGrowthRequiresFunds: a new paid seat beyond the covered capacity needs money on the
	// balance for its first day (M22/M23); membership is not changed.
	ErrSeatGrowthRequiresFunds = conflict(ReasonSeatGrowthRequiresFunds, "adding a paid member needs a positive balance")
	ErrRequestReused           = conflict(ReasonRequestReused, "request_id was used with another body")
	ErrPlanManagedByBilling    = conflict(ReasonPlanManagedByBilling, "the plan is managed by billing")
	// ErrPlanAdminAssigned: the plan was assigned by a superadmin (a manual plan other than Free,
	// not expired); self-serve never overrides it — the owner contacts support (ADR-0086).
	ErrPlanAdminAssigned       = conflict(ReasonPlanAdminAssigned, "the plan was assigned by an administrator: contact support")
	ErrAccountExists           = conflict(ReasonAccountExists, "billing is already enabled")
	ErrDisputeHold             = conflict(ReasonDisputeHold, "an open dispute holds the account")
	ErrRefundExceedsRefundable = conflict(ReasonRefundExceedsRefundable, "amount exceeds the refundable amount")
	ErrRefundNotReleasable     = conflict(ReasonRefundNotReleasable, "the refund cannot be released")
	// ErrMarketFixed: another market for an account that has money history or a pending payment
	// (ADR-0083: the market is fixed by the first credit; afterwards close + new account).
	ErrMarketFixed = conflict(ReasonMarketFixed, "the account's market is fixed by its payments")

	// ErrPermissionRequired: the route needs BILLING_VIEW / TOPUP / MANAGE (ADR-0087; the owner
	// has all three). It replaced BILLING_OWNER_REQUIRED of the owner-only billing.
	ErrPermissionRequired = coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_FORBIDDEN, ReasonPermissionRequired, "billing permission required")
	// ErrWorkspaceBillingSuspended: the debt deadline passed; the workspace is closed except
	// the billing routes of the owner and of BILLING_TOPUP / MANAGE holders (ADR-0087). Never lifted by payment of a moderation suspension.
	ErrWorkspaceBillingSuspended = coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, ReasonWorkspaceBillingSuspended, "workspace suspended for unpaid billing")

	ErrMethodUnavailable     = coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_VALIDATION, ReasonMethodUnavailable, "payment method not available")
	ErrMarketUnavailable     = coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_VALIDATION, ReasonMarketUnavailable, "market not available")
	ErrAmountOutOfRange      = coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_VALIDATION, ReasonAmountOutOfRange, "amount out of range")
	ErrAutoTopupLimit        = coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_VALIDATION, ReasonAutoTopupLimit, "auto-topup limit out of range")
	ErrAutoTopupUnavailable  = coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_VALIDATION, ReasonAutoTopupUnavailable, "auto-topup not available")
	ErrCurrencyMismatch      = coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_VALIDATION, ReasonInvalidCurrencyForAccount, "currency of the account required")
	ErrPriceEffectiveTooSoon = coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_VALIDATION, ReasonPriceEffectiveTooSoon, "a new price takes effect at least 10 days ahead")

	ErrAccountNotFound = coded(http.StatusNotFound, v1.ErrorCode_ERROR_CODE_NOT_FOUND, ReasonAccountNotFound, "billing account not found")

	ErrDisabled       = coded(http.StatusNotImplemented, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, ReasonDisabled, "billing is not enabled")
	ErrNotImplemented = coded(http.StatusNotImplemented, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, ReasonNotImplemented, "not implemented yet")
	ErrTestClockOff   = coded(http.StatusNotFound, v1.ErrorCode_ERROR_CODE_NOT_FOUND, ReasonTestClockDisabled, "route not found")

	ErrProviderUnavailable = coded(http.StatusServiceUnavailable, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, ReasonProviderUnavailable, "payment provider unavailable")
)
