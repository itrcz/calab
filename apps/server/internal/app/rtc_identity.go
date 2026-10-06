package app

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/voice"
)

// rtcIdentityGate verifies exact device principals of one voice room at the DB source.
// Every kind of row is read once for the whole room (users, sessions, the room, identity
// states, room access), so a room costs the same few statements whatever its size. A
// single check (join, webhook, move) is a room of one: the same reads, the same decision.
type rtcIdentityGate struct {
	db   *db.DB
	auth *auth.Service
}

// roomReads: one room's rows. A failed read is the error of every person at the step that
// needs it, exactly where a per-person read would have failed.
type roomReads struct {
	users       map[uuid.UUID]sqlc.User
	usersErr    error
	sessions    map[uuid.UUID]sqlc.Session
	sessionsErr error
	room        sqlc.Room
	roomErr     error
	states      map[identitypolicy.SessionKey]identitypolicy.State
	statesErr   error
	dbNow       time.Time
	dbNowErr    error
	access      *perm.Resolver
}

// check returns one verdict per person, in order.
func (g rtcIdentityGate) check(ctx context.Context, ws, room uuid.UUID, people []rtc.IdentityKey) []error {
	userIDs := make([]uuid.UUID, len(people))
	sessionIDs := make([]uuid.UUID, len(people))
	keys := make([]identitypolicy.SessionKey, len(people))
	for i, p := range people {
		userIDs[i], sessionIDs[i] = p.User, p.Session
		keys[i] = identitypolicy.SessionKey{SessionID: p.Session, UserID: p.User}
	}
	var r roomReads
	users, err := g.db.Q.ListUsersByIDs(ctx, userIDs)
	r.users, r.usersErr = make(map[uuid.UUID]sqlc.User, len(users)), err
	for _, u := range users {
		r.users[u.ID] = u
	}
	sessions, err := g.db.Q.ListSessionsByIDs(ctx, sessionIDs)
	r.sessions, r.sessionsErr = make(map[uuid.UUID]sqlc.Session, len(sessions)), err
	for _, s := range sessions {
		r.sessions[s.ID] = s
	}
	r.room, r.roomErr = g.db.Q.GetRoom(ctx, room)
	if !voice.IsDM(ws, room) {
		r.states, r.statesErr = g.auth.IdentityStates(ctx, ws, keys)
		r.dbNow, r.dbNowErr = g.db.Q.IdentityDatabaseNow(ctx)
	}
	r.access = perm.NewResolver(g.db.Q)
	// A failed prime caches nothing: ReadRoom then loads each person itself.
	_ = r.access.PrimeRoom(ctx, room, userIDs)
	out := make([]error, len(people))
	for i, p := range people {
		out[i] = g.person(ctx, ws, room, p, &r)
	}
	return out
}

// person is the decision for one device; the order of its steps is the order of the
// per-person gate it replaced.
func (g rtcIdentityGate) person(ctx context.Context, ws, room uuid.UUID, p rtc.IdentityKey, r *roomReads) error {
	u, err := r.user(p.User)
	if err != nil {
		return httpx.Unavailable(err)
	}
	id := auth.Identity{UserID: p.User, SessionID: p.Session, IsBot: u.IsBot}
	if u.IsBot {
		bot, err := g.db.Q.GetBotAuth(ctx, p.User)
		if err != nil || bot.TokenID == nil || *bot.TokenID != p.Session || len(bot.TokenHash) == 0 {
			return httpx.Forbidden("bot session revoked")
		}
	}
	if !u.IsBot {
		session, sessionErr := r.session(p.Session)
		principal, err := g.auth.ResolvePrincipalFrom(id, session, sessionErr, u, nil)
		if err != nil {
			return httpx.Unavailable(err)
		}
		id.Principal = principal
	}
	if r.roomErr != nil {
		return httpx.Unavailable(r.roomErr)
	}
	if u.DisabledAt != nil {
		return httpx.Forbidden("account disabled")
	}
	if voice.IsDM(ws, room) {
		if r.room.WorkspaceID != nil || r.room.Type != "dm" {
			return httpx.Forbidden("voice scope mismatch")
		}
		if err := g.auth.CheckGlobal(ctx, id, identitypolicy.GlobalRead); err != nil {
			return err
		}
	} else {
		if r.room.WorkspaceID == nil || *r.room.WorkspaceID != ws {
			return httpx.Forbidden("voice scope mismatch")
		}
		if err := auth.RecordMutationWorkspace(ctx, ws); err != nil {
			return err
		}
		if u.IsBot {
			err = g.auth.CheckWorkspace(ctx, id, ws, identitypolicy.RTC)
		} else {
			state, stateErr := r.state(identitypolicy.SessionKey{SessionID: p.Session, UserID: p.User})
			err = g.auth.CheckWorkspaceState(ctx, id, ws, identitypolicy.RTC, state, stateErr, r.dbNow, r.dbNowErr)
		}
		if err != nil {
			return err
		}
	}
	access, err := r.access.ReadRoom(ctx, room, p.User)
	if err != nil {
		return err
	}
	required := perm.ViewRoom
	if !voice.IsDM(ws, room) {
		required |= perm.Connect
	}
	if !access.Bits.Has(required) {
		return httpx.Forbidden("missing voice access")
	}
	return nil
}

// user, session and state answer as the single-row queries would: pgx.ErrNoRows when absent.
func (r *roomReads) user(id uuid.UUID) (sqlc.User, error) {
	if r.usersErr != nil {
		return sqlc.User{}, r.usersErr
	}
	if u, ok := r.users[id]; ok {
		return u, nil
	}
	return sqlc.User{}, pgx.ErrNoRows
}

func (r *roomReads) session(id uuid.UUID) (sqlc.Session, error) {
	if r.sessionsErr != nil {
		return sqlc.Session{}, r.sessionsErr
	}
	if s, ok := r.sessions[id]; ok {
		return s, nil
	}
	return sqlc.Session{}, pgx.ErrNoRows
}

func (r *roomReads) state(k identitypolicy.SessionKey) (identitypolicy.State, error) {
	if r.statesErr != nil {
		return identitypolicy.State{}, r.statesErr
	}
	if s, ok := r.states[k]; ok {
		return s, nil
	}
	return identitypolicy.State{}, pgx.ErrNoRows
}
