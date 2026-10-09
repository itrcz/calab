package auth

import (
	"context"
	"slices"
	"sync"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/superadmin"
	"github.com/google/uuid"
)

// MutationOptions comes only from the closed server route classification. Normal
// resource writes share source locks; source-row writers take exclusive locks up
// front so they never upgrade a lock while another writer is awaiting the same row.
type MutationOptions struct {
	Workspace                                        uuid.UUID
	ExclusiveWorkspace, ExclusiveUser, Global, Admin bool
	TargetUser                                       uuid.UUID
	Admission, OpenAdmission                         bool
	// Billing: the owner's billing recovery scope (identitypolicy.BillingWrite), open under a
	// billing suspension.
	Billing bool
}

type mutationKey struct{}
type mutationScopes struct {
	mu         sync.Mutex
	workspaces map[uuid.UUID]bool
	active     bool
}

// RecordMutationWorkspace records a resolved payload resource before transaction
// entry. Discovering a new workspace inside an already admitted transaction fails
// closed rather than acquiring source locks in an inconsistent order.
func RecordMutationWorkspace(ctx context.Context, ws uuid.UUID) error {
	state, _ := ctx.Value(mutationKey{}).(*mutationScopes)
	if state == nil || ws == uuid.Nil {
		return nil
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.active && !state.workspaces[ws] {
		return httpx.Forbidden("resource outside admitted transaction")
	}
	state.workspaces[ws] = true
	return nil
}

// WithMutation installs commit admission without wrapping HTTP or remote I/O in
// a transaction. All direct mutations must use db.GuardValue/GuardExec; existing
// multi-statement mutations use db.Tx/TxRaw.
func (s *Service) WithMutation(ctx context.Context, id Identity, opt MutationOptions) context.Context {
	state := &mutationScopes{workspaces: map[uuid.UUID]bool{}}
	if opt.Workspace != uuid.Nil {
		state.workspaces[opt.Workspace] = true
	}
	ctx = context.WithValue(ctx, mutationKey{}, state)
	return db.WithAdmission(ctx, func(ctx context.Context, q *sqlc.Queries) (func(), error) {
		state.mu.Lock()
		if state.active {
			state.mu.Unlock()
			return nil, httpx.Forbidden("nested mutation transaction")
		}
		state.active = true
		workspaces := make([]uuid.UUID, 0, len(state.workspaces))
		for ws := range state.workspaces {
			workspaces = append(workspaces, ws)
		}
		state.mu.Unlock()
		release := func() { state.mu.Lock(); state.active = false; state.mu.Unlock() }
		slices.SortFunc(workspaces, uuidOrder)
		for _, ws := range workspaces {
			var err error
			if opt.ExclusiveWorkspace {
				_, err = q.LockOAuthWorkspace(ctx, ws)
			} else {
				_, err = q.LockIdentityWorkspaceShared(ctx, ws)
			}
			if err != nil {
				return release, mutationSourceError(err)
			}
		}
		users := []uuid.UUID{id.UserID}
		if opt.TargetUser != uuid.Nil && opt.TargetUser != id.UserID {
			users = append(users, opt.TargetUser)
		}
		slices.SortFunc(users, uuidOrder)
		for _, user := range users {
			var err error
			if opt.ExclusiveUser || user == opt.TargetUser {
				_, err = q.LockIdentityUserExclusive(ctx, user)
			} else {
				_, err = q.LockIdentityUserShared(ctx, user)
			}
			if err != nil {
				return release, mutationSourceError(err)
			}
		}
		for _, ws := range workspaces {
			if opt.Admin || opt.Admission {
				continue
			}
			var err error
			if opt.ExclusiveWorkspace {
				_, err = q.LockIdentityMemberExclusive(ctx, sqlc.LockIdentityMemberExclusiveParams{WorkspaceID: ws, UserID: id.UserID})
			} else {
				_, err = q.LockIdentityMemberShared(ctx, sqlc.LockIdentityMemberSharedParams{WorkspaceID: ws, UserID: id.UserID})
			}
			if err != nil {
				return release, mutationSourceError(err)
			}
		}
		if !id.IsBot {
			var err error
			if opt.Global || opt.ExclusiveWorkspace {
				_, err = q.LockIdentitySessionExclusive(ctx, sqlc.LockIdentitySessionExclusiveParams{ID: id.SessionID, UserID: id.UserID})
			} else {
				_, err = q.LockIdentitySessionShared(ctx, sqlc.LockIdentitySessionSharedParams{ID: id.SessionID, UserID: id.UserID})
			}
			if err != nil {
				return release, mutationSourceError(err)
			}
		} else {
			var bot sqlc.Bot
			var err error
			if opt.Global {
				bot, err = q.GetBotForUpdate(ctx, id.UserID)
			} else {
				bot, err = q.LockIdentityBotShared(ctx, id.UserID)
			}
			if err != nil {
				return release, mutationSourceError(err)
			}
			if bot.TokenID == nil || *bot.TokenID != id.SessionID || bot.RevokedAt != nil {
				return release, httpx.Unauthenticated("session revoked")
			}
		}
		if opt.Admin {
			if _, err := q.LockProductAdminGrantShared(ctx, id.UserID); err != nil {
				return release, mutationSourceError(err)
			}
		}
		if opt.Global || opt.Admin || opt.Admission || len(workspaces) == 0 {
			if err := s.checkMutationGlobal(ctx, q, id, opt.Admin); err != nil {
				return release, err
			}
		}
		for _, ws := range workspaces {
			if opt.Admission {
				u, err := q.GetUser(ctx, id.UserID)
				if err != nil {
					return release, mutationSourceError(err)
				}
				if u.IsGuest || u.IsBot {
					return release, httpx.Forbidden("local human account required")
				}
				if opt.OpenAdmission {
					if err := CheckPublicCapability(ctx, q, ws); err != nil {
						return release, err
					}
				}
				if err := s.CheckBillingOpen(ctx, q, ws); err != nil {
					return release, err
				}
				continue
			}
			if id.IsBot {
				u, err := q.GetUser(ctx, id.UserID)
				if err != nil {
					return release, mutationSourceError(err)
				}
				if !u.IsBot || u.DisabledAt != nil {
					return release, ErrBotNotAllowed
				}
				suspended, err := q.WorkspaceSuspended(ctx, ws)
				if err != nil {
					return release, mutationSourceError(err)
				}
				if suspended {
					return release, httpx.Forbidden("workspace suspended")
				}
				if err := s.CheckBillingOpen(ctx, q, ws); err != nil {
					return release, err
				}
			} else if !opt.Admin {
				op := identitypolicy.WorkspaceWrite
				if opt.Billing {
					op = identitypolicy.BillingWrite
				}
				d, err := s.checkWorkspaceDecision(ctx, q, id, ws, op)
				if err != nil {
					return release, IdentityError(id.Principal, d, err)
				}
			}
		}
		return release, nil
	})
}

func uuidOrder(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) }
func mutationSourceError(err error) error {
	if db.IsNotFound(err) {
		return httpx.Unauthenticated("identity source no longer exists")
	}
	return httpx.Unavailable(err)
}

func (s *Service) checkMutationGlobal(ctx context.Context, q *sqlc.Queries, id Identity, admin bool) error {
	u, err := q.GetUser(ctx, id.UserID)
	if err != nil {
		return mutationSourceError(err)
	}
	if u.DisabledAt != nil {
		return httpx.Unauthenticated("session revoked")
	}
	if id.IsBot {
		if !u.IsBot || admin {
			return ErrBotNotAllowed
		}
		return nil
	}
	row, err := q.GetSession(ctx, id.SessionID)
	if err != nil {
		return mutationSourceError(err)
	}
	p := SessionPrincipal(row)
	p.Guest, p.Bot = u.IsGuest, u.IsBot
	if p.UserID != id.UserID {
		return httpx.Unauthenticated("session revoked")
	}
	now, err := q.IdentityDatabaseNow(ctx)
	if err != nil {
		return mutationSourceError(err)
	}
	if host := s.now(); host.After(now) {
		now = host
	}
	if u.IsGuest && u.GuestExpiresAt != nil && !now.Before(*u.GuestExpiresAt) {
		return httpx.Unauthenticated("session revoked")
	}
	op := identitypolicy.GlobalWrite
	granted := false
	if admin {
		op = identitypolicy.ProductAdmin
		grant, gerr := q.GetProductAdminGrant(ctx, id.UserID)
		if gerr != nil && !db.IsNotFound(gerr) {
			return mutationSourceError(gerr)
		}
		granted = !u.IsGuest && !u.IsBot && (gerr == nil && grant.RevokedAt == nil || u.EmailVerifiedAt != nil && superadmin.IsPtr(u.Email))
	}
	d := identitypolicy.CheckGlobal(now, p, op, granted)
	if admin && p.Authority == identitypolicy.LocalAccount && d.Reason == identitypolicy.RoleRequired {
		return httpx.NotFound("route")
	}
	if err := IdentityError(p, d, nil); err != nil {
		return err
	}
	return nil
}
