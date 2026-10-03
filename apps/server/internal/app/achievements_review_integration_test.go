//go:build integration

package app_test

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"math/rand/v2"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/redisx"
)

// newAchievement creates a catalog entry as the superadmin.
func newAchievement(t *testing.T, title string) *v1.Achievement {
	t.Helper()
	sa := superadminUser(t)
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:admin:"+sa.id)).Build()).Error()
	st, a, e := achievementForm(t, sa, "POST", "/api/admin/achievements", map[string]string{"title": title}, achievementPNG(t, false))
	if st != 201 {
		t.Fatalf("create %q: %d %v", title, st, e)
	}
	return a
}

// TestAchievementsCountConcurrent: parallel grants and revokes of one member never leave
// workspace_members.achievement_count different from the live grants (ADR-0061 §3).
func TestAchievementsCountConcurrent(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	a1, a2 := newAchievement(t, "Параллельно 1"), newAchievement(t, "Параллельно 2")
	base := "/api/workspaces/" + ws.GetId() + "/members/" + bob.id + "/achievements"
	for round := range 12 {
		var wg sync.WaitGroup
		statuses := make([]int, 4)
		for i := range statuses {
			wg.Add(1)
			go func() {
				defer wg.Done()
				c := &client{t: t, token: o.token}
				ach := a1.GetId()
				if i%2 == 1 {
					ach = a2.GetId()
				}
				statuses[i] = c.do("POST", base, &v1.GrantAchievementRequest{AchievementId: ach, Note: fmt.Sprintf("r%d-%d", round, i)}, nil)
			}()
		}
		wg.Wait()
		for i, st := range statuses {
			if st != 201 {
				t.Fatalf("round %d grant %d: %d", round, i, st)
			}
		}
		// Revoke two of them in parallel with two more grants.
		var list v1.ListMemberAchievementsResponse
		o.must(200, "GET", base, nil, &list)
		for i := range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				c := &client{t: t, token: o.token}
				if i < 2 {
					statuses[i] = c.do("DELETE", base+"/"+list.GetItems()[i].GetId(), nil, nil)
				} else {
					statuses[i] = c.do("POST", base, &v1.GrantAchievementRequest{AchievementId: a1.GetId(), Note: "ещё"}, nil)
				}
			}()
		}
		wg.Wait()
		if statuses[0] != 204 || statuses[1] != 204 || statuses[2] != 201 || statuses[3] != 201 {
			t.Fatalf("round %d revoke/grant: %v", round, statuses)
		}
	}
	var list v1.ListMemberAchievementsResponse
	o.must(200, "GET", base, nil, &list)
	if got := isMember(t, o, ws.GetId(), bob.id).GetAchievementCount(); int(got) != len(list.GetItems()) || got != 12*4 {
		t.Fatalf("achievement_count %d, live grants %d, want %d", got, len(list.GetItems()), 12*4)
	}
}

// TestAchievementsWorkspaceScope: grants and revokes are scoped to the workspace of the path;
// the count comes back when a former member joins again.
func TestAchievementsWorkspaceScope(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	a := newAchievement(t, "Границы")
	// A second workspace (the same owner) with bob in it too, and carol only there.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob.must(200, "POST", "/api/invites/"+invite(t, o, ws2.GetId())+"/join", nil, nil)
	carol := register(t, invite(t, o, ws2.GetId()))
	path := func(w, u string) string { return "/api/workspaces/" + w + "/members/" + u + "/achievements" }

	var g v1.MemberAchievement
	o.must(201, "POST", path(wid, bob.id), &v1.GrantAchievementRequest{AchievementId: a.GetId(), Note: "в первом"}, &g)
	// A member of the second workspace only sees nothing of the first.
	carol.must(404, "GET", path(wid, bob.id), nil, nil)
	carol.must(404, "POST", path(wid, bob.id), &v1.GrantAchievementRequest{AchievementId: a.GetId(), Note: "чужое"}, nil)
	// A grant id of the first workspace through the path of the second: 404, and it is kept.
	o.must(404, "DELETE", path(ws2.GetId(), bob.id)+"/"+g.GetId(), nil, nil)
	var l2 v1.ListMemberAchievementsResponse
	o.must(200, "GET", path(ws2.GetId(), bob.id), nil, &l2)
	if len(l2.GetItems()) != 0 {
		t.Fatalf("a grant of another workspace is listed: %v", l2.GetItems())
	}
	// Within the workspace: a grant id with another member in the path is 404.
	o.must(404, "DELETE", path(wid, o.id)+"/"+g.GetId(), nil, nil)
	// A non-member of the workspace cannot be granted.
	o.must(404, "POST", path(wid, carol.id), &v1.GrantAchievementRequest{AchievementId: a.GetId(), Note: "не участник"}, nil)

	// Kicked and back: the grants (kept) are counted again by the insert trigger.
	o.must(201, "POST", path(wid, bob.id), &v1.GrantAchievementRequest{AchievementId: a.GetId(), Note: "второй"}, nil)
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/members/"+bob.id, nil, nil)
	o.must(404, "DELETE", path(wid, bob.id)+"/"+g.GetId(), nil, nil) // not a member: nothing to revoke
	bob.must(200, "POST", "/api/invites/"+invite(t, o, wid)+"/join", nil, nil)
	if n := isMember(t, o, wid, bob.id).GetAchievementCount(); n != 2 {
		t.Fatalf("count after rejoin: %d", n)
	}
	if n := isMember(t, o, ws2.GetId(), bob.id).GetAchievementCount(); n != 0 {
		t.Fatalf("count in the other workspace: %d", n)
	}

	// A suspended workspace refuses grants (ADR-0056).
	suspend(t, wid, true, "review")
	o.must(403, "POST", path(wid, bob.id), &v1.GrantAchievementRequest{AchievementId: a.GetId(), Note: "приостановлено"}, nil)
	suspend(t, wid, false, "")
}

// TestAchievementsImageRoute: only canonical "<uuid>.webp" names, only authenticated callers.
func TestAchievementsImageRoute(t *testing.T) {
	o, _, _, _ := setupTeam(t)
	a := newAchievement(t, "Маршрут")
	anon := &client{t: t}
	if st := anon.do("GET", a.GetImageUrl(), nil, nil); st != 401 {
		t.Fatalf("anonymous picture: %d", st)
	}
	name := strings.TrimPrefix(a.GetImageUrl(), "/api/achievements/images/")
	for _, bad := range []string{
		strings.ToUpper(strings.TrimSuffix(name, ".webp")) + ".webp",
		strings.TrimSuffix(name, ".webp"),
		strings.TrimSuffix(name, ".webp") + ".png",
		"..%2F" + name,
		"%2e%2e%2fachievements%2f" + name,
		uuid.NewString() + ".webp",
	} {
		if st := o.do("GET", "/api/achievements/images/"+bad, nil, nil); st != 404 {
			t.Fatalf("picture name %q: %d", bad, st)
		}
	}
}

// TestAchievementsUploadRefusals: the decoder is the gate — not the file name or the part's
// Content-Type; the header dimensions are checked before the decode; the body is bounded.
func TestAchievementsUploadRefusals(t *testing.T) {
	sa := superadminUser(t)
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:admin:"+sa.id)).Build()).Error()
	post := func(img []byte) int {
		st, _, _ := achievementForm(t, sa, "POST", "/api/admin/achievements", map[string]string{"title": "Отказ"}, img)
		return st
	}
	// Not an image (named medal.png by achievementForm).
	if st := post([]byte("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")); st != 422 {
		t.Fatalf("svg: %d", st)
	}
	// A PNG header followed by HTML: DecodeConfig passes, the decode fails.
	pngHead := achievementPNG(t, false)[:33]
	if st := post(append(append([]byte{}, pngHead...), []byte("<html><script>alert(1)</script></html>")...)); st != 422 {
		t.Fatalf("polyglot: %d", st)
	}
	// Too large declared dimensions (a decompression bomb): refused from the header.
	var bomb bytes.Buffer
	if err := png.Encode(&bomb, image.NewNRGBA(image.Rect(0, 0, 8192, 8192))); err != nil {
		t.Fatal(err)
	}
	if st := post(bomb.Bytes()); st != 422 {
		t.Fatalf("8192 px: %d", st)
	}
	var small bytes.Buffer
	_ = png.Encode(&small, image.NewNRGBA(image.Rect(0, 0, 64, 64)))
	if st := post(small.Bytes()); st != 422 {
		t.Fatalf("64 px: %d", st)
	}
	// Over 4 MB.
	if st := post(bytes.Repeat([]byte{0x89}, 5<<20)); st != 413 && st != 422 {
		t.Fatalf("5 MB: %d", st)
	}
	// Not multipart.
	if st := sa.do("POST", "/api/admin/achievements", &v1.GrantAchievementRequest{}, nil); st != 400 {
		t.Fatalf("json body: %d", st)
	}
}

// TestAchievementsCard: the recipient (the card's author) cannot edit it; deleting it removes
// the recipient's mention.
func TestAchievementsCard(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	general := textRoom(t, o, ws.GetId(), "general", false)
	a := newAchievement(t, "Открытка")
	var g v1.MemberAchievement
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/members/"+bob.id+"/achievements",
		&v1.GrantAchievementRequest{AchievementId: a.GetId(), Note: "за открытку", Announce: true}, &g)
	if g.GetRoomId() != general {
		t.Fatalf("card room %q, want %q", g.GetRoomId(), general)
	}
	bob.must(403, "PATCH", "/api/messages/"+g.GetMessageId(), &v1.UpdateMessageRequest{Content: "переписал"}, nil)
	o.must(403, "PATCH", "/api/messages/"+g.GetMessageId(), &v1.UpdateMessageRequest{Content: "переписал"}, nil)
	o.must(204, "DELETE", "/api/messages/"+g.GetMessageId(), nil, nil)
	var mentions v1.ListMessagesResponse
	bob.must(200, "GET", "/api/me/mentions", nil, &mentions)
	for _, m := range mentions.GetMessages() {
		if m.GetId() == g.GetMessageId() {
			t.Fatal("the deleted card is still in the mentions")
		}
	}
	var n int
	if err := testDB.Pool.QueryRow(context.Background(), `SELECT count(*) FROM message_mentions WHERE message_id = $1`, g.GetMessageId()).Scan(&n); err != nil || n != 0 {
		t.Fatalf("mention rows after delete: %d %v", n, err)
	}
}

// legacyBirthdayRoom is the room query of ListBirthdayRooms before migration 00061.
const legacyBirthdayRoom = `SELECT r.id FROM rooms r
    LEFT JOIN room_categories c ON c.id = r.category_id
    WHERE r.workspace_id = $1 AND r.type = 'text' AND r.archived_at IS NULL
    ORDER BY r.is_private, (r.category_id IS NOT NULL), c.position, r.position, r.id
    LIMIT 1`

// TestAchievementsAnnouncementRoom: announcement_room() picks the room the birthday query
// picked before (private last, top level first, categories by position, room position, id),
// over random layouts (archived rooms and no text room included).
func TestAchievementsAnnouncementRoom(t *testing.T) {
	ctx := context.Background()
	o, _, ws, _ := setupTeam(t)
	wid := ws.GetId()
	var cats []string
	for i := range 3 {
		var c v1.CreateCategoryResponse
		o.must(201, "POST", "/api/workspaces/"+wid+"/categories", &v1.CreateCategoryRequest{Name: fmt.Sprintf("cat%d", i)}, &c)
		cats = append(cats, c.GetCategory().GetId())
	}
	var rooms []string
	for i := range 6 {
		rooms = append(rooms, textRoom(t, o, wid, fmt.Sprintf("t%d", i), i%3 == 0))
	}
	rng := rand.New(rand.NewPCG(61, 61)) //nolint:gosec // test layouts
	pick := func(id string) (string, error) {
		var got string
		err := testDB.Pool.QueryRow(ctx, `SELECT coalesce(announcement_room($1)::text, '')`, id).Scan(&got)
		return got, err
	}
	for iter := range 200 {
		for i, c := range cats {
			if _, err := testDB.Pool.Exec(ctx, `UPDATE room_categories SET position = $2 WHERE id = $1`, c, rng.IntN(3)+i%2); err != nil {
				t.Fatal(err)
			}
		}
		for _, r := range rooms {
			var cat *string
			if k := rng.IntN(len(cats) + 1); k < len(cats) {
				cat = &cats[k]
			}
			if _, err := testDB.Pool.Exec(ctx, `UPDATE rooms SET category_id = $2, position = $3, is_private = $4,
				archived_at = CASE WHEN $5 THEN now() END WHERE id = $1`, r, cat, rng.IntN(3), rng.IntN(3) == 0, rng.IntN(8) == 0); err != nil {
				t.Fatal(err)
			}
		}
		var want string
		err := testDB.Pool.QueryRow(ctx, legacyBirthdayRoom, wid).Scan(&want)
		if err != nil && !strings.Contains(err.Error(), "no rows") {
			t.Fatal(err)
		}
		got, err := pick(wid)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("layout %d: announcement_room %q, legacy %q", iter, got, want)
		}
	}
}
