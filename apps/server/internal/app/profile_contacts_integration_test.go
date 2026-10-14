//go:build integration

// ADR-0077: email / phone of colleagues, global nicknames, literal @nick mentions.
package app_test

import (
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func strp(s string) *string { return &s }

// apiErr decodes the last error body of c.
func apiErr(c *client) *v1.ApiError {
	var e v1.ApiError
	_ = protojson.Unmarshal(c.lastBody, &e)
	return &e
}

// memberUser returns the user of id among members (nil = absent).
func memberIn(ms []*v1.WorkspaceMember, id string) *v1.User {
	for _, m := range ms {
		if m.GetUser().GetId() == id {
			return m.GetUser()
		}
	}
	return nil
}

func listMembers(t *testing.T, c *client, wid string) []*v1.WorkspaceMember {
	t.Helper()
	var ms v1.ListMembersResponse
	c.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, &ms)
	return ms.GetMembers()
}

func noContacts(t *testing.T, what string, u *v1.User) {
	t.Helper()
	if u.GetEmail() != "" || u.GetPhone() != "" || u.GetEmailVerified() {
		t.Fatalf("%s: contacts leaked: %v", what, u)
	}
}

func TestProfileContactsVisibility(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	alice, bob := register(t, code), register(t, code)
	rid := textRoom(t, o, wid, "general", false)

	var me v1.UpdateMeResponse
	alice.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Phone: strp("  +7  (999) 123-45-67 "), Username: strp(uniqNick("alice"))}, &me)
	if me.GetMe().GetUser().GetPhone() != "+7 (999) 123-45-67" || me.GetMe().GetUser().GetEmail() != alice.email {
		t.Fatalf("own contacts in Me: %v", me.GetMe().GetUser())
	}

	// A colleague sees email (verified mark) and phone: REST list, REST member, READY.
	a := memberIn(listMembers(t, bob.client, wid), alice.id)
	if a.GetEmail() != alice.email || !a.GetEmailVerified() || a.GetPhone() != "+7 (999) 123-45-67" || a.GetUsername() == "" {
		t.Fatalf("colleague view: %v", a)
	}
	var gm v1.GetMemberResponse
	bob.must(200, "GET", "/api/workspaces/"+wid+"/members/"+alice.id, nil, &gm)
	if gm.GetMember().GetUser().GetPhone() == "" {
		t.Fatalf("GET member without phone: %v", gm.GetMember().GetUser())
	}
	bg := dialGW(t)
	if u := memberIn(guestSnapshot(t, bg.identify(bob.token), wid).GetMembers(), alice.id); u.GetEmail() != alice.email {
		t.Fatalf("READY colleague view: %v", u)
	}

	// An unverified address is shown with the mark (ADR-0065).
	if _, err := testDB.Pool.Exec(t.Context(), "UPDATE users SET email_verified_at = NULL WHERE id = $1", bob.id); err != nil {
		t.Fatal(err)
	}
	if b := memberIn(listMembers(t, alice.client, wid), bob.id); b.GetEmail() != bob.email || b.GetEmailVerified() {
		t.Fatalf("unverified colleague: %v", b)
	}

	// A registered user who is a guest here (room link): sees no contacts, shows none.
	link := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	carol := register(t, invite(t, o, other.GetId()))
	carol.must(200, "POST", "/api/room-invites/"+link.GetCode()+"/join", nil, nil)
	send(t, alice, rid, "привет", "") // alice becomes visible to the guest
	for _, m := range listMembers(t, carol.client, wid) {
		noContacts(t, "guest's member list", m.GetUser())
	}
	cg := dialGW(t)
	for _, m := range guestSnapshot(t, cg.identify(carol.token), wid).GetMembers() {
		noContacts(t, "guest's READY", m.GetUser())
	}
	if c := memberIn(listMembers(t, bob.client, wid), carol.id); c == nil || c.GetEmail() != "" || c.GetPhone() != "" {
		t.Fatalf("a guest's contacts shown to a member: %v", c)
	}
	// An anonymous guest neither.
	anon, _ := anonGuest(t, link.GetCode(), "Клиент")
	for _, m := range listMembers(t, anon.client, wid) {
		noContacts(t, "anonymous guest's list", m.GetUser())
	}

	// A bot: no contacts through REST or its gateway; its username is its bot username.
	b := createBot(t, o, wid, "Helper")
	for _, m := range listMembers(t, b.client, wid) {
		noContacts(t, "bot's member list", m.GetUser())
	}
	var bm v1.GetMemberResponse
	b.must(200, "GET", "/api/workspaces/"+wid+"/members/"+alice.id, nil, &bm)
	noContacts(t, "bot's GET member", bm.GetMember().GetUser())
	if u := memberIn(listMembers(t, bob.client, wid), b.id); u.GetUsername() != b.username || u.GetEmail() != "" {
		t.Fatalf("bot user: %v", u)
	}
	botGW := dialGW(t)
	for _, m := range guestSnapshot(t, botGW.identify(b.token), wid).GetMembers() {
		noContacts(t, "bot's READY", m.GetUser())
	}

	// USER_UPDATE: the colleague gets the new phone, the guest and the bot do not.
	alice.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Phone: strp("+7 999 000-00-01")}, nil)
	bg.wait("USER_UPDATE with phone", func(e *v1.DispatchEvent) bool {
		u := e.GetUserUpdate().GetUser()
		return u.GetId() == alice.id && u.GetPhone() == "+7 999 000-00-01" && u.GetEmail() == alice.email
	})
	stripped := func(g *gw, what string) {
		t.Helper()
		e := g.wait(what, func(e *v1.DispatchEvent) bool { return e.GetUserUpdate().GetUser().GetId() == alice.id })
		noContacts(t, what, e.GetUserUpdate().GetUser())
		g.quiet(what+": no copy with contacts", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
			return e.GetUserUpdate().GetUser().GetId() == alice.id && e.GetUserUpdate().GetUser().GetPhone() != ""
		})
	}
	stripped(cg, "guest's USER_UPDATE")
	stripped(botGW, "bot's USER_UPDATE")

	// The guest here is alice's colleague in another workspace: there it gets the contacts,
	// in this one's READY snapshot not (clients keep what a workspace gave them).
	shared := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	sc := invite(t, o, shared.GetId())
	for _, u := range []*user{alice, carol} {
		u.must(200, "POST", "/api/invites/"+sc+"/join", nil, nil)
	}
	r := dialGW(t).identify(carol.token)
	if u := memberIn(guestSnapshot(t, r, shared.GetId()).GetMembers(), alice.id); u.GetPhone() != "+7 999 000-00-01" {
		t.Fatalf("shared workspace view: %v", u)
	}
	noContacts(t, "guest workspace view", memberIn(guestSnapshot(t, r, wid).GetMembers(), alice.id))
	cg2 := dialGW(t)
	cg2.identify(carol.token)
	alice.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Phone: strp("+7 999 000-00-02")}, nil)
	cg2.wait("USER_UPDATE with phone through the shared workspace", func(e *v1.DispatchEvent) bool {
		return e.GetUserUpdate().GetUser().GetPhone() == "+7 999 000-00-02"
	})

	// Clearing the phone.
	alice.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Phone: strp("")}, &me)
	if me.GetMe().GetUser().GetPhone() != "" {
		t.Fatalf("phone not cleared: %v", me.GetMe().GetUser())
	}
}

var nickSeq int

// uniqNick returns a fresh valid nickname.
func uniqNick(prefix string) string {
	nickSeq++
	return strings.ToLower(prefix) + "_" + strings.ReplaceAll(uniq(""), "-", "_") + "_" + string(rune('a'+nickSeq%26))
}

func TestPhoneValidation(t *testing.T) {
	o := owner(t)
	u := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	for _, bad := range []string{"abc", "+7+8 999", "12", "+7 999 123 45 67 89 01 23 45 67 89 0", "8 (999) 1a3", "+7 999 123"} {
		u.must(422, "PATCH", "/api/me", &v1.UpdateMeRequest{Phone: &bad}, nil)
		if e := apiErr(u.client); e.GetField() != "phone" {
			t.Fatalf("phone %q: %v", bad, e)
		}
	}
	var me v1.UpdateMeResponse
	u.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Phone: strp("8 (999) 123-45-67")}, &me)
	if me.GetMe().GetUser().GetPhone() != "8 (999) 123-45-67" {
		t.Fatalf("phone: %v", me.GetMe().GetUser())
	}
}

func TestUsernames(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	a, b := register(t, code), register(t, code)
	nick := uniqNick("ivan")
	var me v1.UpdateMeResponse
	a.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp("@" + strings.ToUpper(nick))}, &me)
	if me.GetMe().GetUser().GetUsername() != nick {
		t.Fatalf("username %q, want %q", me.GetMe().GetUser().GetUsername(), nick)
	}
	// Case-insensitive uniqueness.
	b.must(409, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(strings.ToUpper(nick))}, nil)
	if e := apiErr(b.client); e.GetCode() != v1.ErrorCode_ERROR_CODE_USERNAME_TAKEN {
		t.Fatalf("taken: %v", e)
	}
	// Format and reserved names.
	for _, bad := range []string{"ab", "1abc", "a-b-c", "_abc", "ivan.petrov", strings.Repeat("a", 33), "admin", "Everyone", "here", "calab", "bot"} {
		b.must(422, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(bad)}, nil)
		if e := apiErr(b.client); e.GetCode() != v1.ErrorCode_ERROR_CODE_USERNAME_INVALID {
			t.Fatalf("%q: %v", bad, e)
		}
	}

	// Availability: own name is available, someone else's is taken, bad names are invalid.
	check := func(c *client, name string) *v1.UsernameAvailabilityResponse {
		t.Helper()
		var r v1.UsernameAvailabilityResponse
		c.must(200, "GET", "/api/usernames/"+name+"/available", nil, &r)
		return &r
	}
	if r := check(a.client, nick); !r.GetAvailable() {
		t.Fatalf("own nick: %v", r)
	}
	if r := check(b.client, strings.ToUpper(nick)); r.GetAvailable() || r.GetReason() != v1.ErrorCode_ERROR_CODE_USERNAME_TAKEN || r.GetUsername() != nick {
		t.Fatalf("taken nick: %v", r)
	}
	if r := check(b.client, "admin"); r.GetAvailable() || r.GetReason() != v1.ErrorCode_ERROR_CODE_USERNAME_INVALID {
		t.Fatalf("reserved nick: %v", r)
	}
	if r := check(b.client, uniqNick("free")); !r.GetAvailable() {
		t.Fatalf("free nick: %v", r)
	}

	// Changing frees the old name; "" clears.
	a.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(uniqNick("ivan2"))}, nil)
	b.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(nick)}, nil)
	b.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp("")}, &me)
	if me.GetMe().GetUser().GetUsername() != "" {
		t.Fatalf("not cleared: %v", me.GetMe().GetUser())
	}

	// Bots share the namespace both ways.
	bt := createBot(t, o, ws.GetId(), "Nickbot")
	a.must(409, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(bt.username)}, nil)
	taken := uniqNick("person")
	a.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(taken)}, nil)
	o.must(409, "POST", "/api/workspaces/"+ws.GetId()+"/bots", &v1.CreateBotRequest{DisplayName: "Clash", Username: taken}, nil)
	// Guests and bots cannot set a nickname or phone.
	bt.must(403, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(uniqNick("botself"))}, nil)
	bt.must(403, "PATCH", "/api/me", &v1.UpdateMeRequest{Phone: strp("+1 555 0100")}, nil)
	bt.must(403, "GET", "/api/usernames/"+uniqNick("x")+"/available", nil, nil)
	rid := textRoom(t, o, ws.GetId(), "room", false)
	g, _ := anonGuest(t, roomLink(t, o, rid, &v1.CreateRoomInviteRequest{}).GetCode(), "Гость")
	g.must(403, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(uniqNick("guest"))}, nil)
	g.must(403, "PATCH", "/api/me", &v1.UpdateMeRequest{Phone: strp("+1 555 0100")}, nil)
	// A deleted bot frees its username.
	o.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/bots/"+bt.id, nil, nil)
	a.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(bt.username)}, nil)

	// Race: two people take the same free name at once — the unique index lets one win.
	race := uniqNick("race")
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, u := range []*user{b, register(t, code)} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = u.do("PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(race)}, nil)
		}()
	}
	wg.Wait()
	if codes[0]+codes[1] != 609 || codes[0] != 200 && codes[1] != 200 { // one 200, one 409
		t.Fatalf("race: %v", codes)
	}

	// The availability check is rate limited per user.
	limited := false
	for range 40 {
		if b.do("GET", "/api/usernames/"+uniqNick("rl")+"/available", nil, nil) == 429 {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("availability check not rate limited")
	}
}

func TestNickMentions(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	alice, bob, carol := register(t, code), register(t, code), register(t, code)
	outsider := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	nicks := map[*user]string{}
	for _, u := range []*user{alice, bob, carol, outsider} {
		nicks[u] = uniqNick("n")
		u.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Username: strp(nicks[u])}, nil)
	}
	rid := textRoom(t, o, wid, "general", false)

	// A member: converted; an outsider, an unknown name, code and an email address stay text.
	text := "hi @" + strings.ToUpper(nicks[alice]) + ", @" + nicks[outsider] + " @nobody_" + nicks[bob] +
		" `@" + nicks[alice] + "` mail@" + nicks[alice] + " @" + nicks[alice] + "x"
	m := send(t, bob, rid, text, "")
	want := "hi @" + alice.id + ", @" + nicks[outsider] + " @nobody_" + nicks[bob] +
		" `@" + nicks[alice] + "` mail@" + nicks[alice] + " @" + nicks[alice] + "x"
	if m.GetContent() != want {
		t.Fatalf("content:\n got %q\nwant %q", m.GetContent(), want)
	}
	var mentions v1.ListMessagesResponse
	alice.must(200, "GET", "/api/me/mentions", nil, &mentions)
	if len(mentions.GetMessages()) == 0 || mentions.GetMessages()[0].GetId() != m.GetId() {
		t.Fatalf("alice's mentions: %v", mentions.GetMessages())
	}
	// An edit converts too.
	var up v1.UpdateMessageResponse
	bob.must(200, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{Content: "@" + nicks[carol] + " look"}, &up)
	if up.GetMessage().GetContent() != "@"+carol.id+" look" {
		t.Fatalf("edit: %q", up.GetMessage().GetContent())
	}

	// A guest converts only the people it sees.
	g, _ := anonGuest(t, roomLink(t, o, rid, &v1.CreateRoomInviteRequest{}).GetCode(), "Гость")
	hidden := send(t, g, rid, "@"+nicks[carol]+" hello", "")
	if hidden.GetContent() != "@"+nicks[carol]+" hello" {
		t.Fatalf("guest named a hidden member: %q", hidden.GetContent())
	}
	if got := send(t, g, rid, "@"+nicks[bob]+" hello", "").GetContent(); got != "@"+bob.id+" hello" {
		t.Fatalf("guest mention of a visible author: %q", got)
	}

	// A DM: its participants only.
	var dm v1.CreateDmResponse
	bob.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: alice.id}, &dm)
	got := send(t, bob, dm.GetDm().GetRoom().GetId(), "@"+nicks[alice]+" @"+nicks[carol], "").GetContent()
	if got != "@"+alice.id+" @"+nicks[carol] {
		t.Fatalf("DM: %q", got)
	}
}
