package perm

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/google/uuid"
)

type vectorRole struct {
	ID          string `json:"id"`
	Position    int32  `json:"position"`
	Permissions Bits   `json:"permissions"`
}

type vector struct {
	Name         string    `json:"name"`
	Role         Role      `json:"role"`
	RoleOverride *Override `json:"roleOverride"`
	UserOverride *Override `json:"userOverride"`
	// ADR-0026 vectors: the member's roles and the room's overrides by role id.
	Roles             []vectorRole        `json:"roles"`
	RoleOverrides     map[string]Override `json:"roleOverrides"`
	ExpectedWorkspace *Bits               `json:"expectedWorkspace"`
	// DM vectors (ADR-0020): roomType "dm" ignores role and overrides.
	RoomType string `json:"roomType"`
	// ADR-0029: a restricted room and whether the member is the workspace owner. Since the
	// ADR-0078 addendum 2026-10-14 restricted is any private room; ownerSeesPrivate is the
	// workspace's «Владелец видит приватное».
	Restricted       bool `json:"restricted"`
	Owner            bool `json:"owner"`
	OwnerSeesPrivate bool `json:"ownerSeesPrivate"`
	Participant      bool `json:"participant"`
	// ADR-0078: a private temporary room and whether the member created it.
	PrivateTemp bool `json:"privateTemp"`
	Creator     bool `json:"creator"`
	// ADR-0042: a board vector (ComputeBoard with the board's overrides).
	// ADR-0048: restricted / owner on a board.
	// ADR-0058 addendum 2026-10-14: restricted is an alias of private; ownerSeesPrivate, creator.
	Board *struct {
		Private          bool `json:"private"`
		Guest            bool `json:"guest"`
		Restricted       bool `json:"restricted"`
		Owner            bool `json:"owner"`
		OwnerSeesPrivate bool `json:"ownerSeesPrivate"`
		Creator          bool `json:"creator"`
	} `json:"board"`
	// ADR-0042 / ADR-0058 §3: a task room vector (TaskRoom from the board bits).
	TaskRoom *struct {
		Board       Bits `json:"board"`
		Archived    bool `json:"archived"`
		CommentsOff bool `json:"commentsOff"`
	} `json:"taskRoom"`
	// ADR-0087: a billing vector (BillingOf over the roles' raw bits).
	Billing *struct {
		Owner bool `json:"owner"`
		Guest bool `json:"guest"`
	} `json:"billing"`
	// ADR-0086 amendment: a restricted-mode vector (PlanInactive over computed bits).
	PlanInactive *struct {
		Bits Bits `json:"bits"`
	} `json:"planInactive"`
	// ADR-0094: a disk item vector (ComputeDiskItem over the chain, root's child first).
	Disk *treeVector `json:"disk"`
	// ADR-0096: a wiki page vector (ComputeWikiPage over the chain, the top-level page first;
	// structure: the expected WikiStructureAllowed for the owner flag of the last level).
	Wiki *treeVector `json:"wiki"`
	// ADR-0126: a canvas item vector (ComputeCanvasItem over the chain, the top-level item first;
	// structure as for the wiki).
	Canvas   *treeVector `json:"canvas"`
	Expected Bits        `json:"expected"`
}

// treeVector is a chain of the shared tree rule (ComputeTree).
type treeVector struct {
	Guest bool `json:"guest"`
	// Addendum 2026-10-14: the member is the workspace owner with «Владелец видит приватное».
	Owner            bool `json:"owner"`
	OwnerSeesPrivate bool `json:"ownerSeesPrivate"`
	Chain            []struct {
		Restricted    bool                `json:"restricted"`
		Owner         bool                `json:"owner"`
		RoleOverrides map[string]Override `json:"roleOverrides"`
		UserOverride  *Override           `json:"userOverride"`
	} `json:"chain"`
	Structure *bool `json:"structure"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("../../../../proto/testdata/permissions.json")
	if err != nil {
		t.Fatal(err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	return vs
}

func TestComputeVectors(t *testing.T) {
	n, boards, taskRooms, billing, inactive, disk, wiki, canvas := 0, 0, 0, 0, 0, 0, 0, 0
	for _, v := range loadVectors(t) {
		switch {
		case v.Disk != nil:
			disk++
			testTreeVector(t, v, v.Disk, sectionDisk)
		case v.Wiki != nil:
			wiki++
			testTreeVector(t, v, v.Wiki, sectionWiki)
		case v.Canvas != nil:
			canvas++
			testTreeVector(t, v, v.Canvas, sectionCanvas)
		case v.PlanInactive != nil:
			inactive++
			if got := PlanInactive(v.PlanInactive.Bits); got != v.Expected {
				t.Errorf("%s: PlanInactive got %d want %d", v.Name, got, v.Expected)
			}
		case v.Billing != nil:
			billing++
			roles := make([]RoleBits, len(v.Roles))
			for i, r := range v.Roles {
				roles[i] = RoleBits(r)
			}
			if got := BillingOf(RawBits(roles), v.Billing.Owner, v.Billing.Guest); got != v.Expected {
				t.Errorf("%s: BillingOf got %d want %d", v.Name, got, v.Expected)
			}
		case v.TaskRoom != nil:
			taskRooms++
			if got := TaskRoom(v.TaskRoom.Board, v.TaskRoom.Archived, v.TaskRoom.CommentsOff); got != v.Expected {
				t.Errorf("%s: TaskRoom got %d want %d", v.Name, got, v.Expected)
			}
		case v.Board != nil:
			boards++
			roles := make([]RoleBits, len(v.Roles))
			for i, r := range v.Roles {
				roles[i] = RoleBits(r)
			}
			sc := BoardScope{Private: v.Board.Private || v.Board.Restricted, Guest: v.Board.Guest, Owner: v.Board.Owner, OwnerSeesPrivate: v.Board.OwnerSeesPrivate, Creator: v.Board.Creator}
			if got := ComputeBoardRoles(roles, sc, v.RoleOverrides, v.UserOverride); got != v.Expected {
				t.Errorf("%s: ComputeBoardRoles got %d want %d", v.Name, got, v.Expected)
			}
			const uid = "00000000-0000-0000-0000-0000000000a1"
			var ovs []OverrideTarget
			for id, o := range v.RoleOverrides {
				ovs = append(ovs, OverrideTarget{TargetType: "role", TargetID: id, Override: o})
			}
			if v.UserOverride != nil {
				ovs = append(ovs, OverrideTarget{TargetType: "user", TargetID: uid, Override: *v.UserOverride})
			}
			role := RoleMember
			switch {
			case v.Board.Guest:
				role = RoleGuest
			case v.Board.Owner:
				role = RoleOwner
			}
			bm := NewMember(uid, role, roles)
			bm.OwnerSeesPrivate = v.Board.OwnerSeesPrivate
			by := uuid.MustParse("00000000-0000-0000-0000-0000000000b2")
			if v.Board.Creator {
				by = uuid.MustParse(uid)
			}
			if got := ComputeBoardIn(bm, BoardFlagsOf(v.Board.Private, v.Board.Restricted, &by), ovs); got != v.Expected {
				t.Errorf("%s: ComputeBoardIn got %d want %d", v.Name, got, v.Expected)
			}
		case v.RoomType == "dm":
			if got := ComputeDM(v.Participant); got != v.Expected {
				t.Errorf("%s: got %d want %d", v.Name, got, v.Expected)
			}
		case v.Roles != nil:
			n++
			roles := make([]RoleBits, len(v.Roles))
			for i, r := range v.Roles {
				roles[i] = RoleBits(r)
			}
			sc := Scope{Private: v.Restricted || v.PrivateTemp, PrivateTemp: v.PrivateTemp, Owner: v.Owner, OwnerSeesPrivate: v.OwnerSeesPrivate, Creator: v.Creator}
			if got := ComputeRoles(roles, sc, v.RoleOverrides, v.UserOverride); got != v.Expected {
				t.Errorf("%s: ComputeRoles got %d want %d", v.Name, got, v.Expected)
			}
			// The same rule through a member and the room's override list (gateway, snapshots).
			const uid = "00000000-0000-0000-0000-0000000000a1"
			flags := RoomFlags{Private: v.Restricted || v.PrivateTemp, PrivateTemp: v.PrivateTemp, CreatedBy: uuid.MustParse("00000000-0000-0000-0000-0000000000b2")}
			if v.Creator {
				flags.CreatedBy = uuid.MustParse(uid)
			}
			var ovs []OverrideTarget
			for id, o := range v.RoleOverrides {
				ovs = append(ovs, OverrideTarget{TargetType: "role", TargetID: id, Override: o})
			}
			if v.UserOverride != nil {
				ovs = append(ovs, OverrideTarget{TargetType: "user", TargetID: uid, Override: *v.UserOverride})
			}
			role := RoleMember
			if v.Owner {
				role = RoleOwner
			}
			m := NewMember(uid, role, roles)
			m.OwnerSeesPrivate = v.OwnerSeesPrivate
			if got := ComputeIn(m, flags, ovs); got != v.Expected {
				t.Errorf("%s: ComputeIn got %d want %d", v.Name, got, v.Expected)
			}
			if v.ExpectedWorkspace != nil && m.Workspace() != *v.ExpectedWorkspace {
				t.Errorf("%s: workspace got %d want %d", v.Name, m.Workspace(), *v.ExpectedWorkspace)
			}
		default:
			if got := Compute(v.Role, v.RoleOverride, v.UserOverride); got != v.Expected {
				t.Errorf("%s: got %d want %d", v.Name, got, v.Expected)
			}
		}
	}
	if n < 12 || boards < 15 || taskRooms < 8 || billing < 8 || inactive < 4 || disk < 25 || wiki < 20 || canvas < 20 {
		t.Fatalf("only %d multi-role vectors, %d board vectors, %d task room vectors, %d billing vectors, %d restricted-mode vectors, %d disk vectors, %d wiki vectors, %d canvas vectors",
			n, boards, taskRooms, billing, inactive, disk, wiki, canvas)
	}
}

type treeSection int

const (
	sectionDisk treeSection = iota
	sectionWiki
	sectionCanvas
)

// testTreeVector checks a disk, wiki or canvas vector through the section's wrapper (levels built
// from the sorted roles), its stored form (override lists, owner ids) and the generic
// ComputeTree; a wiki or canvas vector also checks the section's structure rule.
func testTreeVector(t *testing.T, v vector, tv *treeVector, section treeSection) {
	t.Helper()
	roles := make([]RoleBits, len(v.Roles))
	for i, r := range v.Roles {
		roles[i] = RoleBits(r)
	}
	const uid = "00000000-0000-0000-0000-0000000000a1"
	role := RoleMember
	switch {
	case tv.Guest:
		role = RoleGuest
	case tv.Owner:
		role = RoleOwner
	}
	m := NewMember(uid, role, roles)
	m.OwnerSeesPrivate = tv.OwnerSeesPrivate
	plain := !tv.Owner || !tv.OwnerSeesPrivate // the section wrappers know no owner
	levels := make([]TreeLevel, len(tv.Chain))
	nodes := make([]TreeNode, len(tv.Chain))
	for i, c := range tv.Chain {
		l := TreeLevel{Restricted: c.Restricted, Owner: c.Owner, UserOv: c.UserOverride}
		n := TreeNode{Restricted: c.Restricted, OwnerID: "00000000-0000-0000-0000-0000000000b2"}
		if c.Owner {
			n.OwnerID = uid
		}
		for _, r := range m.Roles {
			if o, ok := c.RoleOverrides[r.ID]; ok {
				l.RoleOvs = append(l.RoleOvs, o)
			}
		}
		for id, o := range c.RoleOverrides {
			n.Overrides = append(n.Overrides, OverrideTarget{TargetType: "role", TargetID: id, Override: o})
		}
		if c.UserOverride != nil {
			n.Overrides = append(n.Overrides, OverrideTarget{TargetType: "user", TargetID: uid, Override: *c.UserOverride})
		}
		levels[i], nodes[i] = l, n
	}
	tree, name := DiskTree, "ComputeDiskItem"
	var got, gotIn Bits
	switch section {
	case sectionWiki:
		tree, name = WikiTree, "ComputeWikiPage"
		got, gotIn = ComputeWikiPage(m.Raw(), tv.Guest, levels), ComputeWikiPageIn(m, nodes)
	case sectionCanvas:
		tree, name = CanvasTree, "ComputeCanvasItem"
		got, gotIn = ComputeCanvasItem(m.Raw(), tv.Guest, levels), ComputeCanvasItemIn(m, nodes)
	default:
		got, gotIn = ComputeDiskItem(m.Raw(), tv.Guest, levels), ComputeDiskItemIn(m, nodes)
	}
	if plain && got != v.Expected {
		t.Errorf("%s: %s got %d want %d", v.Name, name, got, v.Expected)
	}
	if gotIn != v.Expected {
		t.Errorf("%s: %sIn got %d want %d", v.Name, name, gotIn, v.Expected)
	}
	if g := ComputeTree(tree, TreeInput{Raw: m.Raw(), Guest: tv.Guest, Chain: levels, Owner: tv.Owner, OwnerSeesPrivate: tv.OwnerSeesPrivate}); g != v.Expected {
		t.Errorf("%s: ComputeTree got %d want %d", v.Name, g, v.Expected)
	}
	if section != sectionDisk {
		if tv.Structure == nil {
			t.Errorf("%s: a wiki or canvas vector states structure", v.Name)
			return
		}
		owner := len(tv.Chain) > 0 && tv.Chain[len(tv.Chain)-1].Owner
		allowed := WikiStructureAllowed
		if section == sectionCanvas {
			allowed = CanvasStructureAllowed
		}
		if g := allowed(gotIn, owner); g != *tv.Structure {
			t.Errorf("%s: structure rule got %v want %v", v.Name, g, *tv.Structure)
		}
	}
}

func TestMemberTopAndRoomOnly(t *testing.T) {
	m := NewMember("u", RoleAdmin, []RoleBits{{ID: "a", Position: PosAdmin}, {ID: "m", Position: PosMember}, {ID: "c", Position: 5}})
	if m.Top() != PosAdmin || m.Roles[0].ID != "m" || !m.Has("c") || m.Has("x") {
		t.Fatalf("member %+v top %d", m, m.Top())
	}
	if (Member{}).Top() != -1 {
		t.Fatal("no roles: top -1")
	}
	if RoomOnly&(ManageRoles|ManageWorkspace|Administrator|ManageNicknames|ManageStickers) != 0 || All != 1<<32-1 || RoomOnly&RolesV2 != 0 || BoardOnly&RolesV2 != 0 || GuestMax&RolesV2 != 0 || RoleDefaults[RoleMember]&RolesV2 != 0 || RolesV2 != 0xFE000000 || RoomOnly&PlaceCalls == 0 || GuestMax&PlaceCalls != 0 || RoleDefaults[RoleMember].Has(PlaceCalls) || RoomOnly&CreateTempRooms != 0 || GuestMax&CreateTempRooms != 0 || !RoleDefaults[RoleMember].Has(CreateTempRooms) || RoomOnly&BoardOnly != 0 || RoomOnly&(InviteMembers|InviteGuests) != InviteMembers|InviteGuests || GuestMax&(InviteMembers|InviteGuests) != 0 {
		t.Fatal("workspace-level bits must not be settable per room")
	}
	if All&Billing != 0 || RoomOnly&Billing != 0 || BoardOnly&Billing != 0 || GuestMax&Billing != 0 || RoleDefaults[RoleMember]&Billing != 0 || RoleDefaults[RoleAdmin]&Billing != 0 || Known != 1<<44-1 {
		t.Fatal("billing bits stand apart: not in All, overrides, guest bounds or the defaults")
	}
	if All&Disk != 0 || GuestMax&Disk != 0 || RoleDefaults[RoleMember]&Disk != DiskView|DiskWrite || Disk != 7<<35 || Billing&Disk != 0 {
		t.Fatal("disk bits: outside All and the guest bounds, VIEW | WRITE in the member default")
	}
	if !ValidDiskOverride(DiskView, DiskWrite) || ValidDiskOverride(DiskManage, 0) || ValidDiskOverride(BillingView, 0) || ValidDiskOverride(0, ViewRoom) || ValidDiskOverride(DiskView, DiskView) {
		t.Fatal("disk role overrides carry DISK_VIEW and DISK_WRITE only")
	}
	// A person's override may also carry DISK_MANAGE («Управление», ADR-0161): allowed only with
	// VIEW | WRITE, denied freely; never another section's bits.
	if !ValidDiskPersonalOverride(Disk, 0) || !ValidDiskPersonalOverride(DiskView|DiskWrite, DiskManage) || !ValidDiskPersonalOverride(DiskView, DiskWrite|DiskManage) ||
		ValidDiskPersonalOverride(DiskManage, 0) || ValidDiskPersonalOverride(DiskView|DiskManage, 0) || ValidDiskPersonalOverride(Disk, DiskManage) ||
		ValidDiskPersonalOverride(WikiView, 0) || ValidDiskPersonalOverride(0, ViewRoom) {
		t.Fatal("disk personal overrides: «Управление» = VIEW | WRITE | MANAGE")
	}
	if WikiTree.Personal() != WikiOverride || CanvasTree.Personal() != CanvasOverride || DiskTree.Personal() != DiskPersonal {
		t.Fatal("only the Disk's personal overrides carry MANAGE")
	}
	if All&Wiki != 0 || GuestMax&Wiki != 0 || RoleDefaults[RoleMember]&Wiki != WikiView|WikiWrite || Wiki != 7<<38 || (Billing|Disk)&Wiki != 0 {
		t.Fatal("wiki bits: outside All and the guest bounds, VIEW | WRITE in the member default")
	}
	if !ValidWikiOverride(WikiView, WikiWrite) || ValidWikiOverride(WikiManage, 0) || ValidWikiOverride(DiskView, 0) || ValidWikiOverride(0, ViewRoom) || ValidWikiOverride(WikiView, WikiView) || ValidDiskOverride(WikiView, 0) {
		t.Fatal("wiki overrides carry WIKI_VIEW and WIKI_WRITE only")
	}
	if WikiOf(Administrator, false) != Wiki || WikiOf(WikiManage, false) != Wiki || WikiOf(Wiki, true) != 0 || WikiOf(RoleDefaults[RoleMember], false) != WikiOverride || WikiOf(Disk, false) != 0 {
		t.Fatal("WikiOf")
	}
	if All&Canvas != 0 || GuestMax&Canvas != 0 || RoleDefaults[RoleMember]&Canvas != CanvasView|CanvasWrite || Canvas != 7<<41 || (Billing|Disk|Wiki)&Canvas != 0 {
		t.Fatal("canvas bits: outside All and the guest bounds, VIEW | WRITE in the member default")
	}
	if !ValidCanvasOverride(CanvasView, CanvasWrite) || ValidCanvasOverride(CanvasManage, 0) || ValidCanvasOverride(WikiView, 0) || ValidCanvasOverride(0, ViewRoom) || ValidCanvasOverride(CanvasView, CanvasView) || ValidWikiOverride(CanvasView, 0) || ValidDiskOverride(CanvasView, 0) {
		t.Fatal("canvas overrides carry CANVAS_VIEW and CANVAS_WRITE only")
	}
	if CanvasOf(Administrator, false) != Canvas || CanvasOf(CanvasManage, false) != Canvas || CanvasOf(Canvas, true) != 0 || CanvasOf(RoleDefaults[RoleMember], false) != CanvasOverride || CanvasOf(Wiki|Disk, false) != 0 {
		t.Fatal("CanvasOf")
	}
	if GuestMax&^RoleDefaults[RoleMember] != 0 || RoleDefaults[RoleGuest]&^GuestMax != 0 {
		t.Fatal("guest bounds")
	}
}

// BenchmarkComputeIn50Roles100Rooms: a member holding all 50 roles, 100 rooms with an
// override for every role and a user override (the worst case of a READY snapshot).
func BenchmarkComputeIn50Roles100Rooms(b *testing.B) {
	roles := make([]RoleBits, 50)
	for i := range roles {
		roles[i] = RoleBits{ID: fmt.Sprintf("r%02d", i), Position: int32(i), Permissions: Bits(1) << (i % 10)} //nolint:gosec // < 50
	}
	m := NewMember("u", RoleMember, roles)
	rooms := make([][]OverrideTarget, 100)
	for i := range rooms {
		for j, r := range roles {
			rooms[i] = append(rooms[i], OverrideTarget{TargetType: "role", TargetID: r.ID, Override: Override{Allow: Bits(1) << (j % 9), Deny: ViewRoom * Bits(j%2)}})
		}
		rooms[i] = append(rooms[i], OverrideTarget{TargetType: "user", TargetID: "u", Override: Override{Allow: ViewRoom}})
	}
	b.ResetTimer()
	for range b.N {
		for _, ovs := range rooms {
			_ = ComputeIn(m, RoomFlags{}, ovs)
		}
	}
}

// ADR-0059 §2, ADR-0076 §3: the shared case table of taskPermissions in packages/protocol
// (permissions.test.ts reads the same file).
func TestTaskBits(t *testing.T) {
	raw, err := os.ReadFile("../../../../proto/testdata/task_bits.json")
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []struct {
			Name                                string
			Bits                                Bits
			Scoped                              bool
			Assignee, Approver, Watcher, Author bool
			Creator                             string // ADR-0151: "my_bot" | "other_bot"
			Want                                Bits
		}
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Cases) < 20 {
		t.Fatalf("task_bits.json: %d cases", len(table.Cases))
	}
	me, bot, other := uuid.New(), uuid.New(), uuid.New()
	for _, c := range table.Cases {
		acc := BoardAccess{Bits: c.Bits, TaskScoped: c.Scoped}
		author := c.Author
		switch c.Creator {
		case "my_bot":
			author = TaskAuthor(&bot, &me, me)
		case "other_bot":
			author = TaskAuthor(&bot, &other, me)
		case "":
		default:
			t.Fatalf("%s: creator %q", c.Name, c.Creator)
		}
		if got := TaskBits(acc, c.Assignee, c.Approver, c.Watcher, author); got != c.Want {
			t.Errorf("%s: TaskBits = %d, want %d", c.Name, got, c.Want)
		}
	}
}

// ADR-0151: the author of a task is who created it or the current owner of the bot that did.
func TestTaskAuthor(t *testing.T) {
	me, bot, other := uuid.New(), uuid.New(), uuid.New()
	nobody := uuid.Nil
	for _, c := range []struct {
		name             string
		createdBy, owner *uuid.UUID
		user             uuid.UUID
		want             bool
	}{
		{"created it", &me, nil, me, true},
		{"someone else did", &other, nil, me, false},
		{"my bot did", &bot, &me, me, true},
		{"someone else's bot did", &bot, &other, me, false},
		{"the bot itself", &bot, &me, bot, true},
		{"unknown creator", nil, nil, me, false},
		{"nobody (uuid.Nil) is no author", &nobody, &nobody, uuid.Nil, false},
	} {
		if got := TaskAuthor(c.createdBy, c.owner, c.user); got != c.want {
			t.Errorf("%s: TaskAuthor = %v, want %v", c.name, got, c.want)
		}
	}
}

// ADR-0115: the resolver's card-level access — create-only makes a board task-scoped without a
// card, only for an eligible member (a human, not a guest, a live board); otherwise the
// CREATE_TASKS bits are dropped, so a bot never creates on a board it does not see.
func TestTaskScoped(t *testing.T) {
	full := ViewBoard | CreateTasks
	for _, c := range []struct {
		name              string
		bits              Bits
		invited, eligible bool
		wantScoped        bool
		wantBits          Bits
	}{
		{"viewer", full, true, true, false, full},
		{"viewer, not eligible (bot with VIEW_BOARD)", full, false, false, false, full},
		{"invitee", 0, true, true, true, 0},
		{"stranger", 0, false, true, false, 0},
		{"create-only without a card", CreateTasks, false, true, true, CreateTasks},
		{"create-only and invited", CreateTasks, true, true, true, CreateTasks},
		{"create-only bot / guest / archived board", CreateTasks, false, false, false, 0},
		{"invited bot / guest / archived board", 0, true, false, false, 0},
	} {
		scoped, bits := taskScoped(c.bits, c.invited, c.eligible)
		if scoped != c.wantScoped || bits != c.wantBits {
			t.Errorf("%s: taskScoped = %v, %d; want %v, %d", c.name, scoped, bits, c.wantScoped, c.wantBits)
		}
	}
	if !CreateOnly(CreateTasks) || CreateOnly(full) || CreateOnly(0) || CreateOnly(CreateTasks|EditTasks) {
		t.Error("CreateOnly: only CREATE_TASKS alone")
	}
}
