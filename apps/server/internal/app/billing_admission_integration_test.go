//go:build integration

package app_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// fakeSeats records the billing hooks of admission (ADR-0080, billing.Seats) and refuses the
// workspaces in refuse with ErrSeatGrowthRequiresFunds (no money for the new seat's first day).
// Each call checks that it runs inside the membership transaction: the membership it is about is
// already visible through q (after the write), and gone for Removed.
type fakeSeats struct {
	mu     sync.Mutex
	refuse map[uuid.UUID]bool
	calls  []seatCall
}

type seatCall struct {
	op       string
	ws, user uuid.UUID
	role     string // the membership's role as q saw it ("" = none)
}

func newFakeSeats() *fakeSeats { return &fakeSeats{refuse: map[uuid.UUID]bool{}} }

func (f *fakeSeats) record(ctx context.Context, q *sqlc.Queries, op string, ws, user uuid.UUID) error {
	role := ""
	if m, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: ws, UserID: user}); err == nil {
		role = m.Role
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, seatCall{op, ws, user, role})
	if op != "removed" && f.refuse[ws] {
		return billing.ErrSeatGrowthRequiresFunds
	}
	return nil
}

func (f *fakeSeats) Admit(ctx context.Context, q *sqlc.Queries, ws, user, _ uuid.UUID) error {
	return f.record(ctx, q, "admit", ws, user)
}

func (f *fakeSeats) Promote(ctx context.Context, q *sqlc.Queries, ws, user, _ uuid.UUID) error {
	return f.record(ctx, q, "promote", ws, user)
}

func (f *fakeSeats) Removed(ctx context.Context, q *sqlc.Queries, ws, user uuid.UUID) error {
	return f.record(ctx, q, "removed", ws, user)
}

func (f *fakeSeats) of(ws string) []seatCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []seatCall
	for _, c := range f.calls {
		if c.ws.String() == ws {
			out = append(out, c)
		}
	}
	return out
}

func (f *fakeSeats) setRefuse(ws string) {
	f.mu.Lock()
	f.refuse[uuid.MustParse(ws)] = true
	f.mu.Unlock()
}

// withBilling turns billing on for the test (BILLING_ENABLED, and enforcement if asked) with
// seats as the paid-seat hook; the shared server goes back to billing off afterwards.
func withBilling(t *testing.T, seats billing.Seats, enforced bool) {
	t.Helper()
	testApp.SetBilling(seats, true, enforced)
	t.Cleanup(func() { testApp.SetBilling(nil, false, false) })
}

func memberRole(t *testing.T, ws, user string) (string, bool) {
	t.Helper()
	m, err := testDB.Q.GetMember(context.Background(), sqlc.GetMemberParams{WorkspaceID: uuid.MustParse(ws), UserID: uuid.MustParse(user)})
	if err != nil {
		return "", false
	}
	return m.Role, true
}

// joinPath performs one way into the workspace ws for a person who is not a member and returns
// the HTTP outcome and the person's user id (known even when the join was refused).
type joinPath struct {
	name string
	// open: ws must be an open workspace (open join).
	open bool
	// background: the join happens after the response (email verification); a refusal keeps the
	// invitation pending instead of answering 409.
	background bool
	// ownerActs: the owner makes the change (the refusal says «top up»), else the joining person.
	ownerActs bool
	run       func(t *testing.T, o *user, ws string) (status int, e *v1.ApiError, userID string)
}

// joinPaths: base owns scratch, where the outsiders come from (members of another workspace).
func joinPaths(base *user, scratch string) []joinPath {
	outsider := func(t *testing.T, _ *user) *user { return register(t, invite(t, base.withT(t), scratch)) }
	return []joinPath{
		{name: "invite link", run: func(t *testing.T, o *user, ws string) (int, *v1.ApiError, string) {
			code := invite(t, o, ws)
			u := outsider(t, o)
			st, e := u.apiErrBody("POST", "/api/invites/"+code+"/join", nil)
			return st, e, u.id
		}},
		{name: "open join", open: true, run: func(t *testing.T, o *user, ws string) (int, *v1.ApiError, string) {
			u := outsider(t, o)
			st, e := u.apiErrBody("POST", "/api/workspaces/"+ws+"/join", nil)
			return st, e, u.id
		}},
		{name: "register by invite", run: func(t *testing.T, o *user, ws string) (int, *v1.ApiError, string) {
			code := invite(t, o, ws)
			c := newClient(t)
			email := uniq("bill") + "@example.com"
			var resp v1.RegisterResponse
			st := c.do("POST", "/api/auth/register", &v1.RegisterRequest{Email: email, Password: "password123", DisplayName: "Seat", InviteCode: code, DeviceName: "test"}, &resp)
			var e v1.ApiError
			_ = protojson.Unmarshal(c.lastBody, &e)
			id := resp.GetMe().GetUser().GetId()
			if id == "" { // refused: no account was created either
				u, err := testDB.Q.GetUserByEmail(context.Background(), &email)
				if err == nil {
					t.Fatalf("refused registration left the account %s", u.ID)
				}
				id = uuid.NewString()
			}
			return st, &e, id
		}},
		{name: "add member", ownerActs: true, run: func(t *testing.T, o *user, ws string) (int, *v1.ApiError, string) {
			u := outsider(t, o)
			st, e := o.apiErrBody("POST", "/api/workspaces/"+ws+"/members", &v1.AddMemberRequest{UserId: u.id})
			return st, e, u.id
		}},
		{name: "email invitation", background: true, run: func(t *testing.T, o *user, ws string) (int, *v1.ApiError, string) {
			addr := uniq("billmail") + "@example.com"
			code := emailInviteCode(t, o, ws, addr)
			u, _ := registerRaw(t, addr, code, "")
			u.email = addr
			vr := verifyAddr(t, u)
			joined := false
			for _, id := range vr.GetJoinedWorkspaceIds() {
				joined = joined || id == ws
			}
			if _, member := memberRole(t, ws, u.id); member != joined {
				t.Fatalf("joined %v, member %v", vr.GetJoinedWorkspaceIds(), member)
			}
			return 200, &v1.ApiError{}, u.id
		}},
		{name: "guest promotion", ownerActs: true, run: func(t *testing.T, o *user, ws string) (int, *v1.ApiError, string) {
			link := roomLink(t, o, textRoom(t, o, ws, "Guests", false), &v1.CreateRoomInviteRequest{})
			g, _ := anonGuest(t, link.GetCode(), "Guest")
			if role, ok := memberRole(t, ws, g.id); !ok || role != "guest" {
				t.Fatalf("guest membership: %q %v", role, ok)
			}
			st, e := o.apiErrBody("POST", "/api/workspaces/"+ws+"/members/"+g.id+"/promote", nil)
			return st, e, g.id
		}},
	}
}

// Every way a billable person joins (or a guest becomes a member) calls Seats inside the join's
// transaction, after the membership row: with capacity the join goes through, without money for
// the first day it is refused with 409 BILLING_SEAT_GROWTH_REQUIRES_FUNDS and nothing is written,
// and with billing off nothing calls Seats at all (today's behavior).
func TestBillingAdmissionPaths(t *testing.T) {
	base := owner(t)
	scratch := createWorkspace(t, base, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	// A fresh owner of the workspaces under test: its own invitation-mail budget.
	o := register(t, invite(t, base, scratch))
	seats := newFakeSeats()
	for _, p := range joinPaths(base, scratch) {
		for _, mode := range []string{"capacity", "needs funds", "disabled"} {
			t.Run(p.name+"/"+mode, func(t *testing.T) {
				if mode == "disabled" {
					testApp.SetBilling(seats, false, false)
				} else {
					withBilling(t, seats, true)
				}
				vis := v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE
				if p.open {
					vis = v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_OPEN
				}
				ws := createWorkspace(t, o, vis).GetId()
				if mode == "needs funds" {
					seats.setRefuse(ws)
				}
				o.t = t
				st, e, uid := p.run(t, o, ws)
				calls := seats.of(ws)
				role, member := memberRole(t, ws, uid)
				want := "admit"
				if p.name == "guest promotion" {
					want = "promote"
				}
				switch mode {
				case "disabled":
					if st >= 300 || !member || len(calls) != 0 {
						t.Fatalf("billing off: %d %v, member %v, seats %v", st, e, member, calls)
					}
				case "capacity":
					if st >= 300 || !member || role == "guest" {
						t.Fatalf("join with capacity: %d %v, member %v %q", st, e, member, role)
					}
					if len(calls) != 1 || calls[0].op != want || calls[0].user.String() != uid || calls[0].role != role {
						t.Fatalf("seats: %+v, want one %s of %s seen inside the transaction", calls, want, uid)
					}
				case "needs funds":
					if len(calls) != 1 || calls[0].op != want || calls[0].role == "" {
						t.Fatalf("seats: %+v", calls)
					}
					if p.background {
						if member {
							t.Fatal("refused seat joined in the background")
						}
						if _, err := testDB.Q.GetPendingEmailInvite(context.Background(), sqlc.GetPendingEmailInviteParams{WorkspaceID: uuid.MustParse(ws), Email: strings.ToLower(emailOf(t, uid))}); err != nil {
							t.Fatalf("the invitation must stay pending: %v", err)
						}
						return
					}
					if st != 409 || e.GetReason() != billing.ReasonSeatGrowthRequiresFunds || e.GetCode() != v1.ErrorCode_ERROR_CODE_CONFLICT {
						t.Fatalf("refused seat: %d %v", st, e)
					}
					if owner := strings.Contains(e.GetMessage(), "top up the balance") && !strings.Contains(e.GetMessage(), "owner"); owner != p.ownerActs {
						t.Fatalf("message for the owner %v: %q", p.ownerActs, e.GetMessage())
					}
					if p.name == "guest promotion" {
						if role != "guest" {
							t.Fatalf("refused promotion changed the role: %q", role)
						}
					} else if member {
						t.Fatal("refused seat left a membership")
					}
				}
			})
		}
	}
}

func emailOf(t *testing.T, uid string) string {
	t.Helper()
	u, err := testDB.Q.GetUser(context.Background(), uuid.MustParse(uid))
	if err != nil || u.Email == nil {
		t.Fatalf("user %s: %v", uid, err)
	}
	return *u.Email
}

// Bots and guests never take a paid seat; leaving, removal, a ban and the demotion to a guest
// free one (Seats.Removed in the same transaction, the membership already gone or changed).
func TestBillingSeatsBotsGuestsAndRemoval(t *testing.T) {
	seats := newFakeSeats()
	withBilling(t, seats, true)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	b := createBot(t, o, ws, "seatbot")
	link := roomLink(t, o, textRoom(t, o, ws, "Guests", false), &v1.CreateRoomInviteRequest{})
	g, _ := anonGuest(t, link.GetCode(), "Guest")
	if calls := seats.of(ws); len(calls) != 0 {
		t.Fatalf("bot / guest took a seat: %+v", calls)
	}
	code := invite(t, o, ws)
	leaver, kicked, banned, demoted := register(t, code), register(t, code), register(t, code), register(t, code)
	if calls := seats.of(ws); len(calls) != 4 {
		t.Fatalf("four admissions: %+v", calls)
	}
	leaver.must(204, "DELETE", "/api/workspaces/"+ws+"/members/"+leaver.id, nil, nil)
	o.must(204, "DELETE", "/api/workspaces/"+ws+"/members/"+kicked.id, nil, nil)
	o.must(201, "POST", "/api/workspaces/"+ws+"/bans", &v1.CreateBanRequest{UserId: banned.id, Reason: "test"}, nil)
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+ws+"/members/"+demoted.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	// Not billable: removing the guest or the bot frees nothing.
	o.must(204, "DELETE", "/api/workspaces/"+ws+"/members/"+g.id, nil, nil)
	o.must(204, "DELETE", "/api/workspaces/"+ws+"/members/"+b.id, nil, nil)
	var removed []seatCall
	for _, c := range seats.of(ws) {
		if c.op == "removed" {
			removed = append(removed, c)
		}
	}
	want := map[string]string{leaver.id: "", kicked.id: "", banned.id: "", demoted.id: "guest"}
	if len(removed) != len(want) {
		t.Fatalf("removed: %+v", removed)
	}
	for _, c := range removed {
		role, ok := want[c.user.String()]
		if !ok || c.role != role {
			t.Fatalf("removed %+v, want role inside the transaction %q", c, role)
		}
	}
	// Promoting the demoted guest again is a promotion (a paid seat again).
	o.must(200, "POST", "/api/workspaces/"+ws+"/members/"+demoted.id+"/promote", nil, nil)
	if calls := seats.of(ws); calls[len(calls)-1].op != "promote" {
		t.Fatalf("promotion: %+v", calls[len(calls)-1])
	}
}

func (u *user) withT(t *testing.T) *user { u.t = t; return u }
