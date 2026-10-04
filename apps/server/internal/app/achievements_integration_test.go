//go:build integration

package app_test

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// achievementPNG is a 256x256 PNG with a disc on a transparent background (opaque: on white).
func achievementPNG(t *testing.T, opaque bool) []byte {
	t.Helper()
	m := image.NewNRGBA(image.Rect(0, 0, 256, 256))
	for y := range 256 {
		for x := range 256 {
			dx, dy := x-128, y-128
			switch {
			case dx*dx+dy*dy < 80*80:
				m.SetNRGBA(x, y, color.NRGBA{230, 180, 40, 255})
			case opaque:
				m.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// achievementUpload uploads data to the workspace as u and returns the file id.
func achievementUpload(t *testing.T, u *user, wsID, name string, data []byte) string {
	t.Helper()
	st, f, _ := upload(t, u, "/api/workspaces/"+wsID+"/files", name, data)
	if st != 201 {
		t.Fatalf("upload %s: %d", name, st)
	}
	return f.GetId()
}

// newAchievement creates a catalog entry of the workspace as u (MANAGE_WORKSPACE).
func newAchievement(t *testing.T, u *user, wsID, title string) *v1.Achievement {
	t.Helper()
	var a v1.Achievement
	u.must(201, "POST", "/api/workspaces/"+wsID+"/achievements",
		&v1.CreateAchievementRequest{Title: title, FileId: achievementUpload(t, u, wsID, "medal.png", achievementPNG(t, false))}, &a)
	return &a
}

// rawResp is the status and headers of a response whose body getRaw has read and closed.
type rawResp struct {
	StatusCode int
	Header     http.Header
}

// getRaw performs an authenticated GET and returns the status, headers and body.
func getRaw(t *testing.T, token, path string, header map[string]string) (*rawResp, []byte) {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), "GET", srv.URL+path, http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	return &rawResp{StatusCode: resp.StatusCode, Header: resp.Header}, raw
}

// TestAchievements (ADR-0061, amendment 1): the workspace catalog — MANAGE_WORKSPACE for the
// owner and admins (a member 403, a bot token 403 BOT_NOT_ALLOWED), the picture from the caller's
// own upload made into a new workspace file (IMAGE_NEEDS_ALPHA; someone else's or another
// workspace's upload refused), read by every member and guest and not by outsiders, the
// WORKSPACE_ACHIEVEMENTS_UPDATE event, the list with ETag, archive, replace, 409 on delete with
// grants, the orphan cleanup keeping pictures; grants (MANAGE_MEMBERS; 403 without, 422 to self /
// guest / bot / archived / another workspace's achievement, note required, bot token 403), the
// card in the announcement room and its absence without a text room, the recipient's mention,
// achievement_count with WORKSPACE_MEMBER_UPDATE, revoke, the list for guests by the profile
// rule and for bots.
func TestAchievements(t *testing.T) {
	ctx := context.Background()
	o, bob, ws, voice := setupTeam(t)
	wid := ws.GetId()
	adminRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	adm := register(t, invite(t, o, wid))
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+adm.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	cat := "/api/workspaces/" + wid + "/achievements"

	bg := dialGW(t)
	bg.identify(bob.token)
	catalogEvent := func(what string) {
		t.Helper()
		bg.wait(what, func(e *v1.DispatchEvent) bool { return e.GetWorkspaceAchievementsUpdate().GetWorkspaceId() == wid })
	}

	// Management: a member without MANAGE_WORKSPACE is refused; the picture needs alpha and
	// must be the caller's own upload to this workspace.
	pic := achievementUpload(t, o, wid, "medal.png", achievementPNG(t, false))
	bob.must(403, "POST", cat, &v1.CreateAchievementRequest{Title: "x", FileId: achievementUpload(t, bob, wid, "b.png", achievementPNG(t, false))}, nil)
	o.must(422, "POST", cat, &v1.CreateAchievementRequest{Title: "Opaque", FileId: achievementUpload(t, o, wid, "o.png", achievementPNG(t, true))}, nil)
	if r, _ := errReason(o.client); r != "IMAGE_NEEDS_ALPHA" {
		t.Fatalf("opaque image reason %q", r)
	}
	o.must(422, "POST", cat, &v1.CreateAchievementRequest{Title: "", FileId: pic}, nil)
	o.must(422, "POST", cat, &v1.CreateAchievementRequest{Title: "Чужой", FileId: achievementUpload(t, bob, wid, "b2.png", achievementPNG(t, false))}, nil)
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	o.must(422, "POST", cat, &v1.CreateAchievementRequest{Title: "Не отсюда", FileId: achievementUpload(t, o, other.GetId(), "x.png", achievementPNG(t, false))}, nil)
	o.must(422, "POST", cat, &v1.CreateAchievementRequest{Title: "Без файла"}, nil)

	var medal v1.Achievement
	o.must(201, "POST", cat, &v1.CreateAchievementRequest{Title: " Больше года ", Description: "Год в команде", FileId: pic}, &medal)
	if medal.GetTitle() != "Больше года" || medal.GetWidth() != 512 || medal.GetImageSize() == 0 || medal.GetWorkspaceId() != wid ||
		medal.GetFileId() == "" || medal.GetFileId() == pic {
		t.Fatalf("create: %v", &medal)
	}
	catalogEvent("WORKSPACE_ACHIEVEMENTS_UPDATE after create")
	old := newAchievement(t, adm, wid, "Старая") // an admin manages the catalog too
	if old.GetPosition() <= medal.GetPosition() {
		t.Fatalf("positions: %d after %d", old.GetPosition(), medal.GetPosition())
	}

	// The list (bob, a plain member) with an ETag; the picture is a file every member reads.
	resp, raw := getRaw(t, bob.token, cat, nil)
	var list v1.ListAchievementsResponse
	if resp.StatusCode != 200 || protojson.Unmarshal(raw, &list) != nil || resp.Header.Get("ETag") == "" ||
		len(list.GetAchievements()) != 2 || list.GetAchievements()[0].GetId() != medal.GetId() {
		t.Fatalf("catalog: %d %s", resp.StatusCode, raw)
	}
	if r, _ := getRaw(t, bob.token, cat, map[string]string{"If-None-Match": resp.Header.Get("ETag")}); r.StatusCode != 304 {
		t.Fatalf("If-None-Match: %d", r.StatusCode)
	}
	if st := fileStatus(t, bob, medal.GetFileId()); st != 200 {
		t.Fatalf("picture for a member: %d", st)
	}
	outsider := register(t, invite(t, o, other.GetId()))
	if st := fileStatus(t, outsider, medal.GetFileId()); st != 404 {
		t.Fatalf("picture for an outsider: %d", st)
	}
	outsider.must(404, "GET", cat, nil, nil)
	outsider.must(404, "PATCH", "/api/achievements/"+medal.GetId(), &v1.UpdateAchievementRequest{}, nil)

	// Archive (admin): 422 on grant; the list keeps it flagged and its ETag changes.
	archived := true
	var arch v1.Achievement
	adm.must(200, "PATCH", "/api/achievements/"+old.GetId(), &v1.UpdateAchievementRequest{Archived: &archived}, &arch)
	if arch.GetArchivedAt() == nil {
		t.Fatalf("archive: %v", &arch)
	}
	if r, _ := getRaw(t, bob.token, cat, map[string]string{"If-None-Match": resp.Header.Get("ETag")}); r.StatusCode != 200 {
		t.Fatalf("ETag after a change: %d", r.StatusCode)
	}
	title := "x"
	bob.must(403, "PATCH", "/api/achievements/"+medal.GetId(), &v1.UpdateAchievementRequest{Title: &title}, nil)
	bob.must(403, "DELETE", "/api/achievements/"+old.GetId(), nil, nil)

	og := dialGW(t)
	og.identify(o.token)
	base := "/api/workspaces/" + wid + "/members/"
	grant := func(u *user, target, achievement, note string, announce bool, want int) *v1.MemberAchievement {
		t.Helper()
		var g v1.MemberAchievement
		u.must(want, "POST", base+target+"/achievements", &v1.GrantAchievementRequest{AchievementId: achievement, Note: note, Announce: announce}, &g)
		return &g
	}
	countEvent := func(userID string, n uint32) {
		t.Helper()
		og.wait("WORKSPACE_MEMBER_UPDATE with the achievement count", func(e *v1.DispatchEvent) bool {
			m := e.GetWorkspaceMemberUpdate().GetMember()
			return m.GetUser().GetId() == userID && m.GetAchievementCount() == n
		})
	}

	// No text room yet: the grant goes without a card.
	g1 := grant(o, bob.id, medal.GetId(), "  За первый релиз  ", true, 201)
	if g1.GetMessageId() != "" || g1.GetNote() != "За первый релиз" || g1.GetGrantedBy() != o.id || g1.GetUserId() != bob.id {
		t.Fatalf("grant without a text room: %v", g1)
	}
	countEvent(bob.id, 1)

	// With text rooms the card goes into the first public one and mentions bob.
	textRoom(t, o, wid, "secret", true)
	general := textRoom(t, o, wid, "general", false)
	g2 := grant(o, bob.id, medal.GetId(), "Ещё раз", true, 201)
	if g2.GetMessageId() == "" || g2.GetRoomId() != general {
		t.Fatalf("card: %v", g2)
	}
	ev := og.wait("MESSAGE_CREATE of the card", func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetId() == g2.GetMessageId()
	})
	m := ev.GetMessageCreate().GetMessage()
	card := m.GetSystem().GetAchievement()
	if m.GetKind() != v1.MessageKind_MESSAGE_KIND_SYSTEM || m.GetAuthorId() != bob.id || m.GetRoomId() != general ||
		card.GetAchievementId() != medal.GetId() || card.GetGrantId() != g2.GetId() || card.GetNote() != "Ещё раз" || card.GetGrantedBy() != o.id {
		t.Fatalf("card message: %v", m)
	}
	countEvent(bob.id, 2)
	var mentions v1.ListMessagesResponse
	bob.must(200, "GET", "/api/me/mentions", nil, &mentions)
	if len(mentions.GetMessages()) == 0 || mentions.GetMessages()[0].GetId() != g2.GetMessageId() {
		t.Fatalf("the card is not in bob's mentions: %v", mentions.GetMessages())
	}
	// announce = false: no card.
	if g := grant(o, bob.id, medal.GetId(), "Тихо", false, 201); g.GetMessageId() != "" {
		t.Fatalf("announce=false posted a card: %v", g)
	}
	countEvent(bob.id, 3)

	// Refusals.
	grant(bob, o.id, medal.GetId(), "Нет права", true, 403)
	grant(o, o.id, medal.GetId(), "Себе", true, 422)
	if r, _ := errReason(o.client); r != "SELF_GRANT" {
		t.Fatalf("self grant reason %q", r)
	}
	grant(o, bob.id, medal.GetId(), "   ", true, 422)
	grant(o, bob.id, medal.GetId(), strings.Repeat("я", 121), true, 422)
	grant(o, bob.id, old.GetId(), "Архивная", true, 422)
	if r, _ := errReason(o.client); r != "ACHIEVEMENT_ARCHIVED" {
		t.Fatalf("archived reason %q", r)
	}
	grant(o, bob.id, "00000000-0000-0000-0000-000000000000", "Нет такой", true, 422)
	foreign := newAchievement(t, o, other.GetId(), "Из другого пространства")
	grant(o, bob.id, foreign.GetId(), "Чужая", true, 422)
	b := createBot(t, o, wid, "Helper")
	grant(o, b.id, medal.GetId(), "Боту", true, 422)
	b.must(403, "POST", base+bob.id+"/achievements", &v1.GrantAchievementRequest{AchievementId: medal.GetId(), Note: "От бота", Announce: true}, nil)
	if r, _ := errReason(b.client); r != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot grant reason %q", r)
	}
	// Bots read the catalog, never change it.
	b.must(200, "GET", cat, nil, nil)
	b.must(403, "POST", cat, &v1.CreateAchievementRequest{Title: "Бот", FileId: pic}, nil)
	if r, _ := errReason(b.client); r != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot create reason %q", r)
	}
	b.must(403, "PATCH", "/api/achievements/"+medal.GetId(), &v1.UpdateAchievementRequest{Title: &title}, nil)
	b.must(403, "DELETE", "/api/achievements/"+old.GetId(), nil, nil)
	link := roomLink(t, o, voice.GetId(), &v1.CreateRoomInviteRequest{})
	guest, _ := anonGuest(t, link.GetCode(), "Гость")
	grant(o, guest.id, medal.GetId(), "Гостю", true, 422)
	grant(guest, bob.id, medal.GetId(), "От гостя", true, 403)
	// Guests read the catalog and its pictures (cards, profiles), never change it.
	guest.must(200, "GET", cat, nil, nil)
	if st := fileStatus(t, guest, medal.GetFileId()); st != 200 {
		t.Fatalf("picture for a guest: %d", st)
	}
	guest.must(403, "PATCH", "/api/achievements/"+medal.GetId(), &v1.UpdateAchievementRequest{Title: &title}, nil)

	// The member list: newest first; a bot reads it; a guest only for the members it sees.
	var mlist v1.ListMemberAchievementsResponse
	o.must(200, "GET", base+bob.id+"/achievements", nil, &mlist)
	if len(mlist.GetItems()) != 3 || mlist.GetItems()[1].GetId() != g2.GetId() || mlist.GetItems()[1].GetRoomId() != general ||
		mlist.GetItems()[2].GetId() != g1.GetId() {
		t.Fatalf("list: %v", mlist.GetItems())
	}
	b.must(200, "GET", base+bob.id+"/achievements", nil, nil)
	bob.must(200, "GET", base+"@me/achievements", nil, nil)
	guest.must(404, "GET", base+bob.id+"/achievements", nil, nil)
	guest.must(200, "GET", base+o.id+"/achievements", nil, nil)

	// Revoke: the count drops, the card stays; twice is 404; others cannot.
	bob.must(403, "DELETE", base+bob.id+"/achievements/"+g2.GetId(), nil, nil)
	b.must(403, "DELETE", base+bob.id+"/achievements/"+g2.GetId(), nil, nil)
	o.must(204, "DELETE", base+bob.id+"/achievements/"+g2.GetId(), nil, nil)
	countEvent(bob.id, 2)
	o.must(404, "DELETE", base+bob.id+"/achievements/"+g2.GetId(), nil, nil)
	if mm := isMember(t, o, wid, bob.id); mm.GetAchievementCount() != 2 {
		t.Fatalf("member count %d", mm.GetAchievementCount())
	}
	var hist v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+general+"/messages?limit=50", nil, &hist)
	kept := false
	for _, hm := range hist.GetMessages() {
		kept = kept || hm.GetSystem().GetAchievement().GetGrantId() == g2.GetId()
	}
	if !kept {
		t.Fatal("the card is gone after revoke")
	}

	// Stats in the list; no delete with grants; replace the picture.
	o.must(200, "GET", cat, nil, &list)
	for _, a := range list.GetAchievements() {
		if a.GetId() == medal.GetId() && (a.GetGrantedCount() != 2 || !a.GetInUse()) {
			t.Fatalf("stats: %v", a)
		}
		if a.GetId() == old.GetId() && (a.GetGrantedCount() != 0 || a.GetInUse()) {
			t.Fatalf("stats of the ungranted: %v", a)
		}
	}
	o.must(409, "DELETE", "/api/achievements/"+medal.GetId(), nil, nil)
	if r, _ := errReason(o.client); r != "ACHIEVEMENT_IN_USE" {
		t.Fatalf("delete in use reason %q", r)
	}
	newTitle, pos, newPic := "Год+", int32(7), achievementUpload(t, adm, wid, "new.png", achievementPNG(t, false))
	var replaced v1.Achievement
	adm.must(200, "PATCH", "/api/achievements/"+medal.GetId(), &v1.UpdateAchievementRequest{Title: &newTitle, Position: &pos, FileId: &newPic}, &replaced)
	if replaced.GetFileId() == medal.GetFileId() || replaced.GetFileId() == newPic || replaced.GetTitle() != "Год+" || replaced.GetPosition() != 7 ||
		replaced.GetGrantedCount() != 2 {
		t.Fatalf("replace: %v", &replaced)
	}
	catalogEvent("WORKSPACE_ACHIEVEMENTS_UPDATE after replace")

	// Orphan cleanup: live pictures stay; the replaced picture and the source uploads go.
	if _, err := testDB.Pool.Exec(ctx, "UPDATE files SET created_at = now() - interval '25 hours' WHERE workspace_id = $1", wid); err != nil {
		t.Fatal(err)
	}
	if _, err := testApp.Files.CleanupOrphans(ctx); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{replaced.GetFileId(), old.GetFileId()} {
		if st := fileStatus(t, bob, id); st != 200 {
			t.Fatalf("live picture %s after cleanup: %d", id, st)
		}
	}
	for _, id := range []string{medal.GetFileId(), pic, newPic} {
		if st := fileStatus(t, o, id); st != 404 {
			t.Fatalf("orphan %s after cleanup: %d", id, st)
		}
	}

	// Never granted: deleted (its picture goes with the cleanup).
	adm.must(204, "DELETE", "/api/achievements/"+old.GetId(), nil, nil)
	catalogEvent("WORKSPACE_ACHIEVEMENTS_UPDATE after delete")
	o.must(404, "DELETE", "/api/achievements/"+old.GetId(), nil, nil)
}
