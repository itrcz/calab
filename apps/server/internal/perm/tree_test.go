package perm

import (
	"math/rand/v2"
	"slices"
	"testing"
)

// TestDetachedKeepsAccess: a node detached to the top of its tree (Detached) gives the members
// the bits its chain gave — whoever saw it still does, nobody else starts to: exactly for the
// pinned people (named by the chain) and for anyone with one role. The Disk (personal MANAGE,
// owners with all three; ADR-0161) and the Wiki (VIEW / WRITE only, MANAGE in a row ignored).
func TestDetachedKeepsAccess(t *testing.T) {
	for _, b := range []TreeBits{DiskTree, WikiTree} {
		detachedKeepsAccess(t, b)
	}
}

func detachedKeepsAccess(t *testing.T, b TreeBits) {
	t.Helper()
	ov := b.Override()
	users := []string{"u1", "u2", "u3", "u4", "u5", "u6"}
	roles := []string{"r1", "r2"}
	rnd := rand.New(rand.NewPCG(1, 2)) //nolint:gosec // test data
	bitsOf := func() Bits { return []Bits{0, b.View, b.Write, ov}[rnd.IntN(4)] }
	// A person's row may be «Управление» too where the section has it (ADR-0161; MANAGE allowed
	// only with VIEW | WRITE, as stored), or deny MANAGE.
	pv := b.Personal()
	userAllowOf := func() Bits { return []Bits{0, b.View, b.Write, ov, pv}[rnd.IntN(5)] }
	userDenyOf := func() Bits { return []Bits{0, b.View, b.Write, ov, pv, b.Manage & pv}[rnd.IntN(6)] }
	wsOf := func() Bits { return []Bits{0, b.View, ov, Administrator, b.Manage}[rnd.IntN(5)] }
	for range 20000 {
		chain := make([]TreeNode, 1+rnd.IntN(4))
		for i := range chain {
			n := &chain[i]
			n.Restricted = rnd.IntN(3) == 0
			if rnd.IntN(3) == 0 {
				n.OwnerID = users[rnd.IntN(4)]
			}
			for _, id := range roles {
				if rnd.IntN(3) == 0 {
					a := bitsOf()
					n.Overrides = append(n.Overrides, OverrideTarget{TargetType: "role", TargetID: id, Override: Override{Allow: a, Deny: bitsOf() &^ a}})
				}
			}
			for _, id := range users[:4] {
				if rnd.IntN(4) == 0 {
					a := userAllowOf()
					n.Overrides = append(n.Overrides, OverrideTarget{TargetType: "user", TargetID: id, Override: Override{Allow: a, Deny: userDenyOf() &^ a}})
				}
			}
		}
		// u1..u4 may be named; u5 and u6 never are. Everyone has one or two roles.
		members := make([]Member, len(users))
		for i, u := range users {
			role := RoleMember
			if rnd.IntN(4) == 0 {
				role = RoleGuest
			}
			rs := []RoleBits{{ID: roles[rnd.IntN(2)], Position: 1, Permissions: wsOf()}}
			if rnd.IntN(2) == 0 && rs[0].ID == "r1" {
				rs = append(rs, RoleBits{ID: "r2", Position: 2, Permissions: wsOf()})
			}
			members[i] = NewMember(u, role, rs)
		}
		named := Named(chain)
		var pin []Member
		for _, m := range members {
			if slices.Contains(named, m.UserID) {
				pin = append(pin, m)
			}
		}
		d := Detached(b, chain, pin)
		// Every row it writes passes the table's CHECK (a folded «Управление» under a deny of
		// VIEW or WRITE must not leave MANAGE allowed alone).
		for _, o := range d.Overrides {
			valid := ValidTreeOverride(b, o.Allow, o.Deny)
			if o.TargetType == "user" {
				valid = ValidTreePersonalOverride(b, o.Allow, o.Deny)
			}
			if !valid {
				t.Fatalf("detached %+v of chain %+v: row %+v is not storable", d, chain, o)
			}
		}
		for _, m := range members {
			if len(m.Roles) > 1 && !slices.Contains(named, m.UserID) {
				continue // roles disagreeing across levels: approximate (docs/12)
			}
			was, now := ComputeTreeIn(b, m, chain), ComputeTreeIn(b, m, []TreeNode{d})
			if was != now {
				t.Fatalf("member %+v: chain %+v gave %b, detached %+v gives %b", m, chain, was, d, now)
			}
		}
	}
}
