//go:build integration

package app_test

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/redisx"
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

// achievementForm sends a multipart superadmin request; image nil = no image part.
func achievementForm(t *testing.T, u *user, method, path string, fields map[string]string, img []byte) (int, *v1.Achievement, *v1.ApiError) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	if img != nil {
		fw, _ := mw.CreateFormFile("image", "medal.png")
		_, _ = fw.Write(img)
	}
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), method, srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+u.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		var e v1.ApiError
		_ = protojson.Unmarshal(raw, &e)
		return resp.StatusCode, nil, &e
	}
	var a v1.Achievement
	if err := protojson.Unmarshal(raw, &a); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, &a, nil
}

// getRaw performs an authenticated GET and returns the response (body read).
func getRaw(t *testing.T, token, path string, header map[string]string) (*http.Response, []byte) {
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
	return resp, raw
}

// TestAchievements (ADR-0061): the superadmin catalog (404 to others, IMAGE_NEEDS_ALPHA, 409 on
// delete with grants, archive, image replace), the public catalog with ETag and the cached
// picture, grants (MANAGE_MEMBERS; 403 without, 422 to self / guest / bot / archived, note
// required, bot token 403), the card in the announcement room and its absence without a text
// room, the recipient's mention, achievement_count with WORKSPACE_MEMBER_UPDATE, revoke, the
// list for guests by the profile rule and for bots.
func TestAchievements(t *testing.T) {
	sa := superadminUser(t)
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:admin:"+sa.id)).Build()).Error()
	o, bob, ws, voice := setupTeam(t)
	wid := ws.GetId()

	// Superadmin catalog: others get 404; the picture needs a transparent background.
	o.must(404, "GET", "/api/admin/achievements", nil, nil)
	if st, _, _ := achievementForm(t, o, "POST", "/api/admin/achievements", map[string]string{"title": "x"}, achievementPNG(t, false)); st != 404 {
		t.Fatalf("owner creates: %d", st)
	}
	st, _, e := achievementForm(t, sa, "POST", "/api/admin/achievements", map[string]string{"title": "Opaque"}, achievementPNG(t, true))
	if st != 422 || e.GetReason() != "IMAGE_NEEDS_ALPHA" {
		t.Fatalf("opaque image: %d %v", st, e)
	}
	if st, _, _ := achievementForm(t, sa, "POST", "/api/admin/achievements", map[string]string{"title": ""}, achievementPNG(t, false)); st != 422 {
		t.Fatalf("empty title: %d", st)
	}
	st, medal, _ := achievementForm(t, sa, "POST", "/api/admin/achievements",
		map[string]string{"title": "Больше года", "description": "Год в команде"}, achievementPNG(t, false))
	if st != 201 || medal.GetWidth() != 512 || medal.GetImageSize() == 0 || !strings.HasPrefix(medal.GetImageUrl(), "/api/achievements/images/") {
		t.Fatalf("create: %d %v", st, medal)
	}
	_, old, _ := achievementForm(t, sa, "POST", "/api/admin/achievements", map[string]string{"title": "Старая"}, achievementPNG(t, false))

	// Public catalog (bob, a plain member) with an ETag; the picture is cached for good.
	resp, raw := getRaw(t, bob.token, "/api/achievements", nil)
	var cat v1.ListAchievementsResponse
	if resp.StatusCode != 200 || protojson.Unmarshal(raw, &cat) != nil || resp.Header.Get("ETag") == "" {
		t.Fatalf("catalog: %d %s", resp.StatusCode, raw)
	}
	found := false
	for _, a := range cat.GetAchievements() {
		found = found || a.GetId() == medal.GetId()
	}
	if !found {
		t.Fatal("catalog misses the new achievement")
	}
	if r, _ := getRaw(t, bob.token, "/api/achievements", map[string]string{"If-None-Match": resp.Header.Get("ETag")}); r.StatusCode != 304 {
		t.Fatalf("If-None-Match: %d", r.StatusCode)
	}
	img, body := getRaw(t, bob.token, medal.GetImageUrl(), nil)
	if img.StatusCode != 200 || img.Header.Get("Content-Type") != "image/webp" || !strings.Contains(img.Header.Get("Cache-Control"), "immutable") ||
		img.Header.Get("X-Content-Type-Options") != "nosniff" || len(body) != int(medal.GetImageSize()) {
		t.Fatalf("image: %d %v", img.StatusCode, img.Header)
	}

	// Archive one: 422 on grant; the catalog keeps it flagged and its ETag changes.
	st, archived, _ := achievementForm(t, sa, "PATCH", "/api/admin/achievements/"+old.GetId(), map[string]string{"archived": "true"}, nil)
	if st != 200 || archived.GetArchivedAt() == nil {
		t.Fatalf("archive: %d %v", st, archived)
	}
	if r, _ := getRaw(t, bob.token, "/api/achievements", map[string]string{"If-None-Match": resp.Header.Get("ETag")}); r.StatusCode != 200 {
		t.Fatalf("ETag after a change: %d", r.StatusCode)
	}

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
	b := createBot(t, o, wid, "Helper")
	grant(o, b.id, medal.GetId(), "Боту", true, 422)
	b.must(403, "POST", base+bob.id+"/achievements", &v1.GrantAchievementRequest{AchievementId: medal.GetId(), Note: "От бота", Announce: true}, nil)
	if r, _ := errReason(b.client); r != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot grant reason %q", r)
	}
	link := roomLink(t, o, voice.GetId(), &v1.CreateRoomInviteRequest{})
	guest, _ := anonGuest(t, link.GetCode(), "Гость")
	grant(o, guest.id, medal.GetId(), "Гостю", true, 422)
	grant(guest, bob.id, medal.GetId(), "От гостя", true, 403)

	// The list: newest first; a bot reads it; a guest only for the members it sees.
	var list v1.ListMemberAchievementsResponse
	o.must(200, "GET", base+bob.id+"/achievements", nil, &list)
	if len(list.GetItems()) != 3 || list.GetItems()[1].GetId() != g2.GetId() || list.GetItems()[1].GetRoomId() != general ||
		list.GetItems()[2].GetId() != g1.GetId() {
		t.Fatalf("list: %v", list.GetItems())
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

	// Superadmin view: live grants and workspaces; no delete with grants; replace the picture.
	var al v1.AdminListAchievementsResponse
	sa.must(200, "GET", "/api/admin/achievements", nil, &al)
	for _, a := range al.GetAchievements() {
		if a.GetAchievement().GetId() == medal.GetId() && (a.GetGrantedCount() != 2 || a.GetWorkspacesCount() != 1) {
			t.Fatalf("admin stats: %v", a)
		}
	}
	sa.must(409, "DELETE", "/api/admin/achievements/"+medal.GetId(), nil, nil)
	if r, _ := errReason(sa.client); r != "ACHIEVEMENT_IN_USE" {
		t.Fatalf("delete in use reason %q", r)
	}
	st, replaced, _ := achievementForm(t, sa, "PATCH", "/api/admin/achievements/"+medal.GetId(), map[string]string{"title": "Год+", "position": "7"}, achievementPNG(t, false))
	if st != 200 || replaced.GetImageUrl() == medal.GetImageUrl() || replaced.GetTitle() != "Год+" || replaced.GetPosition() != 7 {
		t.Fatalf("replace: %d %v", st, replaced)
	}
	if r, _ := getRaw(t, bob.token, medal.GetImageUrl(), nil); r.StatusCode != 404 {
		t.Fatalf("old picture after replace: %d", r.StatusCode)
	}
	if r, _ := getRaw(t, guest.token, replaced.GetImageUrl(), nil); r.StatusCode != 200 {
		t.Fatalf("new picture for a guest: %d", r.StatusCode)
	}
	// Never granted: deleted with its picture.
	sa.must(204, "DELETE", "/api/admin/achievements/"+old.GetId(), nil, nil)
	if r, _ := getRaw(t, bob.token, old.GetImageUrl(), nil); r.StatusCode != 404 {
		t.Fatalf("picture after delete: %d", r.StatusCode)
	}
	sa.must(404, "DELETE", "/api/admin/achievements/"+old.GetId(), nil, nil)
}
