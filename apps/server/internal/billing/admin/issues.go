package admin

import (
	"context"
	"net/http"
	"strings"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// «Требует внимания» (ADR-0083 amendment, owner 2026-10-10): refunds the provider executed
// without Calab (billing_provider_issues). Booked at once by the refund polling — such rows are
// information (status imported: why the balance moved, possibly into debt). Open rows are the
// ones it could not book (another currency, more than every payment can return): the superadmin
// books one («Записать как долг», once the account's payments can hold it) or closes it
// («Отметить разобранным»). Both are audited.

const (
	actionIssueImport  = "issue.import"
	actionIssueDismiss = "issue.dismiss"
)

func (h *Handlers) issueProto(ctx context.Context, q *sqlc.Queries, row sqlc.BillingProviderIssue, mask refMask) *v1.AdminBillingIssue {
	out := &v1.AdminBillingIssue{
		Id: row.ID.String(), AccountId: row.AccountID.String(), PaymentId: idString(row.PaymentID), Provider: row.Provider,
		ProviderRef: mask.apply(row.ProviderRef), Amount: money(row.AmountMinor, row.Currency), Reason: row.Reason, Status: row.Status,
		OccurredAt: ts(row.OccurredAt), CreatedAt: timestamppb.New(row.CreatedAt), ResolvedAt: ts(row.ResolvedAt),
	}
	if acc, err := q.GetBillingAccount(ctx, row.AccountID); err == nil && acc.WorkspaceID != nil {
		out.WorkspaceId = acc.WorkspaceID.String()
		if ws, err := q.GetWorkspace(ctx, *acc.WorkspaceID); err == nil {
			out.WorkspaceName = ws.Name
		}
	}
	return out
}

// issues: GET /api/admin/billing/issues?account_id=&status=&cursor=&limit= (default: every status).
func (h *Handlers) issues(w http.ResponseWriter, r *http.Request) error {
	lim, before, err := page(r)
	if err != nil {
		return err
	}
	acc, err := optUUID(r, "account_id")
	if err != nil {
		return err
	}
	status, err := oneOf(r, "status", "open", "imported", "dismissed")
	if err != nil {
		return err
	}
	var st *string
	if status != "" {
		st = &status
	}
	ctx := r.Context()
	rows, err := h.d.DB.Q.ListBillingProviderIssues(ctx, sqlc.ListBillingProviderIssuesParams{AccountID: acc, Status: st, BeforeID: before, Lim: lim})
	if err != nil {
		return err
	}
	refs := make([]string, 0, len(rows))
	for _, row := range rows {
		refs = append(refs, row.ProviderRef)
	}
	mask, err := savedRefs(ctx, h.d.DB.Q, refs)
	if err != nil {
		return err
	}
	total, err := h.d.DB.Q.CountOpenBillingProviderIssues(ctx)
	if err != nil {
		return err
	}
	out := &v1.AdminBillingIssues{Issues: make([]*v1.AdminBillingIssue, 0, len(rows)), OpenTotal: total}
	for _, row := range rows {
		out.Issues = append(out.Issues, h.issueProto(ctx, h.d.DB.Q, row, mask))
	}
	if len(rows) > 0 {
		out.NextCursor = next(len(rows), lim, rows[len(rows)-1].ID)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// importIssue: POST /api/admin/billing/issues/{id}/import — «Записать как долг»: the provider
// refund is booked as a dashboard refund (succeeded, its provider id), on the issue's payment
// first, then the subscription's payments, then the account's other payments with room (paid
// minus refunded); the spent part of each becomes debt, the balance may go negative. 409 when
// the account's payments cannot hold it or the currency differs (dismiss it then).
func (h *Handlers) importIssue(w http.ResponseWriter, r *http.Request) error {
	return h.resolveIssue(w, r, actionIssueImport)
}

// dismissIssue: POST /api/admin/billing/issues/{id}/dismiss — «Отметить разобранным»: no money moves.
func (h *Handlers) dismissIssue(w http.ResponseWriter, r *http.Request) error {
	return h.resolveIssue(w, r, actionIssueDismiss)
}

func (h *Handlers) resolveIssue(w http.ResponseWriter, r *http.Request, action string) error {
	id, err := httpx.PathUUID(r, "id", "issue")
	if err != nil {
		return err
	}
	var req v1.AdminResolveIssueRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	c, err := newCmd(r, action, &req, id.String())
	if err != nil {
		return err
	}
	ctx := r.Context()
	issue0, err := h.d.DB.Q.GetBillingProviderIssue(ctx, id)
	if db.IsNotFound(err) {
		return httpx.NotFound("issue")
	}
	if err != nil {
		return err
	}
	res, _, err := h.inTx(ctx, c, func(q *sqlc.Queries) (*effect, error) {
		acc, err := lockAccount(ctx, q, issue0.AccountID)
		if err != nil {
			return nil, err
		}
		issue, err := q.LockBillingProviderIssue(ctx, id)
		if err != nil {
			return nil, err
		}
		if issue.Status != "open" {
			return nil, conflict("issue is " + issue.Status + " already")
		}
		eff := &effect{before: &acc, acc: &acc, target: map[string]string{
			"account_id": acc.ID.String(), "issue_id": issue.ID.String(), "provider": issue.Provider, "provider_ref": issue.ProviderRef,
		}}
		status := "dismissed"
		if action == actionIssueImport {
			after, refunds, err := h.bookIssue(ctx, q, acc, issue, c)
			if err != nil {
				return nil, err
			}
			eff.acc, status = &after, "imported"
			eff.res = &v1.AdminBillingMutationResult{Amount: money(issue.AmountMinor, issue.Currency)}
			for _, ref := range refunds {
				eff.res.Refunds = append(eff.res.Refunds, refundProto(ref))
			}
		}
		now, err := h.now(ctx, q)
		if err != nil {
			return nil, err
		}
		done, err := q.ResolveBillingProviderIssue(ctx, sqlc.ResolveBillingProviderIssueParams{Status: status, Now: now, ResolvedBy: &c.actor, ID: issue.ID})
		if err != nil {
			return nil, err
		}
		if eff.res == nil {
			eff.res = &v1.AdminBillingMutationResult{}
		}
		eff.res.Issue = h.issueProto(ctx, q, done, refMask{})
		return eff, nil
	})
	if err != nil {
		return err
	}
	return h.respond(w, r, res, issue0.AccountID)
}

// bookIssue books the provider refund of an open issue (core.BookBankRefund).
func (h *Handlers) bookIssue(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, issue sqlc.BillingProviderIssue, c *cmd) (sqlc.BillingAccount, []sqlc.BillingRefund, error) {
	if issue.Currency != acc.Currency {
		return acc, nil, conflict("the refund is not in the account's currency: dismiss it and settle by hand")
	}
	group, _, _ := strings.Cut(issue.ProviderRef, ":")
	refs, after, err := h.d.Core.BookBankRefund(ctx, q, acc.ID, issue.PaymentID, group, issue.ProviderRef, issue.AmountMinor, c.reason, &c.actor)
	if err != nil {
		return acc, nil, err
	}
	return after, refs, nil
}
