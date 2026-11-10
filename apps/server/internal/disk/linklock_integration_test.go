//go:build integration

package disk

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

// pubAs is pub with the unlock cookie of a visitor ("" = none); method GET.
func (e *env) pubAs(cookie string, want int, path string, out proto.Message) http.Header {
	e.t.Helper()
	hdr := map[string]string{}
	if cookie != "" {
		hdr["Cookie"] = unlockCookie + "=" + cookie
	}
	w := e.call(uuid.Nil, "GET", "/api/public/disk/"+path, nil, hdr)
	if w.Code != want {
		e.t.Fatalf("GET %s: %d, want %d: %s", path, w.Code, want, w.Body.String())
	}
	if want == http.StatusForbidden && !strings.Contains(w.Body.String(), "LINK_PASSWORD_REQUIRED") && !strings.Contains(w.Body.String(), "view-only") {
		e.t.Fatalf("GET %s: 403 %s", path, w.Body.String())
	}
	if want == http.StatusOK && out != nil {
		if err := protojson.Unmarshal(w.Body.Bytes(), out); err != nil {
			e.t.Fatalf("GET %s: %v", path, err)
		}
	}
	return w.Header()
}

// unlock posts a password to the link and returns the cookie value of a 204 ("" otherwise).
func (e *env) unlock(code, password string, want int) string {
	e.t.Helper()
	w := e.call(uuid.Nil, "POST", "/api/public/disk/"+code+"/unlock", &v1.UnlockDiskLinkRequest{Password: password}, nil)
	if w.Code != want {
		e.t.Fatalf("unlock %s: %d, want %d: %s", code, w.Code, want, w.Body.String())
	}
	if want == http.StatusForbidden && !strings.Contains(w.Body.String(), "LINK_PASSWORD_REQUIRED") {
		e.t.Fatalf("unlock: not the generic answer: %s", w.Body.String())
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == unlockCookie {
			if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/api/public/disk/"+code || c.MaxAge <= 0 || c.MaxAge > int(UnlockTTL.Seconds()) {
				e.t.Fatalf("unlock cookie %+v", c)
			}
			return c.Value
		}
	}
	return ""
}

func (e *env) patchLink(user uuid.UUID, id string, want int, req *v1.UpdateDiskLinkRequest) *v1.DiskLinkResponse {
	e.t.Helper()
	w := e.call(user, "PATCH", item(id)+"/link", req, nil)
	if w.Code != want {
		e.t.Fatalf("PATCH link: %d %s, want %d", w.Code, w.Body.String(), want)
	}
	if strings.Contains(w.Body.String(), "argon2") {
		e.t.Fatalf("the hash left the server: %s", w.Body.String())
	}
	var out v1.DiskLinkResponse
	if want == http.StatusOK {
		if err := protojson.Unmarshal(w.Body.Bytes(), &out); err != nil {
			e.t.Fatal(err)
		}
	}
	return &out
}

// TestDiskLinkPassword (ADR-0167): a protected link tells nothing before the unlock on any
// route; a wrong password is the generic 403; the unlock cookie opens only its own link and only
// until the password is changed or removed or the link re-enabled; the rights are the link's;
// every change is in the history with the actor.
func TestDiskLinkPassword(t *testing.T) {
	e := newEnv(t)
	e.svc.UnlockKey = DeriveUnlockKey([]byte("test-secret-test-secret-test-secret"))
	root := e.folder(e.alice, "", "Contract")
	sub := e.folder(e.alice, root.GetId(), "Drafts")
	readme := e.upload(e.alice, root.GetId(), "readme.txt", 12)
	e.must(200, e.alice, "PUT", item(root.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Entries: []*v1.DiskPermissionEntry{{
		TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: e.bob.String(), Allow: uint64(perm.DiskView | perm.DiskWrite),
	}}}, nil)
	var link v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(root.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	code := link.GetLink().GetCode()

	// Rights: «Правка» may not set it (403), a bad length is 422, the owner sets it.
	e.patchLink(e.bob, root.GetId(), http.StatusForbidden, &v1.UpdateDiskLinkRequest{Password: proto.String("letmein-1")})
	e.patchLink(e.alice, root.GetId(), http.StatusUnprocessableEntity, &v1.UpdateDiskLinkRequest{Password: proto.String("abc")})
	got := e.patchLink(e.alice, root.GetId(), http.StatusOK, &v1.UpdateDiskLinkRequest{Password: proto.String("letmein-1")})
	if !got.GetLink().GetHasPassword() || got.GetLink().GetCode() != code {
		t.Fatalf("link after the password %v", got)
	}

	// Locked: the meta says only locked; every other route answers 403.
	var meta v1.PublicDiskFile
	e.pubAs("", 200, code, &meta)
	if !meta.GetLocked() || meta.GetName() != "" || meta.GetId() != "" || meta.GetKind() != v1.DiskItemKind_DISK_ITEM_KIND_UNSPECIFIED {
		t.Fatalf("locked meta leaks %v", &meta)
	}
	locked := []string{"/items", "/items?parent=" + sub.GetId(), "/items/" + readme.GetId() + "/content", "/items/" + readme.GetId() + "/thumbnail?w=512",
		"/archive", "/archive?check=1", "/office?item=" + readme.GetId()}
	for _, p := range locked {
		e.pubAs("", http.StatusForbidden, code+p, nil)
	}
	// A forged or foreign cookie does not open it either.
	e.pubAs("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", http.StatusForbidden, code+"/items", nil)

	// A wrong password: the generic answer, no cookie; the right one unlocks every route.
	if c := e.unlock(code, "letmein-2", http.StatusForbidden); c != "" {
		t.Fatal("a cookie for a wrong password")
	}
	e.unlock(code, "", http.StatusForbidden)
	ck := e.unlock(code, "letmein-1", http.StatusNoContent)
	if ck == "" {
		t.Fatal("no unlock cookie")
	}
	meta.Reset()
	e.pubAs(ck, 200, code, &meta)
	if meta.GetLocked() || meta.GetName() != "Contract" || meta.GetKind() != v1.DiskItemKind_DISK_ITEM_KIND_FOLDER {
		t.Fatalf("unlocked meta %v", &meta)
	}
	var top v1.PublicDiskFolder
	e.pubAs(ck, 200, code+"/items", &top)
	if len(top.GetItems()) != 2 {
		t.Fatalf("unlocked listing %v", entryNames(&top))
	}
	e.pubAs(ck, 200, code+"/items/"+readme.GetId()+"/content", nil)
	e.pubAs(ck, 200, code+"/archive", nil)

	// A token of link A does not open link B (same password).
	other := e.upload(e.alice, "", "other.txt", 4)
	var linkB v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(other.GetId())+"/link", &v1.CreateDiskLinkRequest{Password: "letmein-1"}, &linkB)
	codeB := linkB.GetLink().GetCode()
	if !linkB.GetLink().GetHasPassword() {
		t.Fatalf("created with a password: %v", &linkB)
	}
	e.pubAs(ck, http.StatusForbidden, codeB+"/content", nil)
	meta.Reset()
	e.pubAs(ck, 200, codeB, &meta)
	if !meta.GetLocked() {
		t.Fatal("link B opened by link A's cookie")
	}

	// A change of the password ends the unlock; so does a removal followed by a new password.
	e.patchLink(e.admin, root.GetId(), http.StatusOK, &v1.UpdateDiskLinkRequest{Password: proto.String("second-pass")})
	e.pubAs(ck, http.StatusForbidden, code+"/items", nil)
	e.unlock(code, "letmein-1", http.StatusForbidden)
	ck2 := e.unlock(code, "second-pass", http.StatusNoContent)
	e.pubAs(ck2, 200, code+"/items", nil)
	got = e.patchLink(e.alice, root.GetId(), http.StatusOK, &v1.UpdateDiskLinkRequest{Password: proto.String("")})
	if got.GetLink().GetHasPassword() {
		t.Fatal("password not removed")
	}
	e.pubAs("", 200, code+"/items", nil) // open without a password
	e.patchLink(e.alice, root.GetId(), http.StatusOK, &v1.UpdateDiskLinkRequest{Password: proto.String("second-pass")})
	e.pubAs(ck2, http.StatusForbidden, code+"/items", nil)

	// Revoke and re-enable (same password): a new code, the old unlock is dead.
	ck3 := e.unlock(code, "second-pass", http.StatusNoContent)
	e.must(204, e.alice, "DELETE", item(root.GetId())+"/link", nil, nil)
	e.pubAs(ck3, http.StatusNotFound, code+"/items", nil)
	e.must(201, e.alice, "POST", item(root.GetId())+"/link", &v1.CreateDiskLinkRequest{Password: "second-pass"}, &link)
	code2 := link.GetLink().GetCode()
	w := e.call(uuid.Nil, "GET", "/api/public/disk/"+code2+"/items", nil, map[string]string{"Cookie": unlockCookie + "=" + ck3})
	if w.Code != http.StatusForbidden {
		t.Fatalf("the old unlock opened the re-enabled link: %d", w.Code)
	}

	// History: set, changed, removed, set — with the actor; nothing about the password itself.
	var page v1.DiskActivityPage
	e.must(200, e.alice, "GET", item(root.GetId())+"/activity", nil, &page)
	type entry struct {
		kind    v1.DiskActivityKind
		actor   string
		changed bool
	}
	var hist []entry
	for _, a := range page.GetActivities() {
		switch k := a.GetKind(); k {
		case v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_PASSWORD_ON, v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_PASSWORD_OFF:
			hist = append(hist, entry{k, a.GetActorId(), a.GetAfter().GetFields()["changed"].GetBoolValue()})
		}
		if strings.Contains(protojson.Format(a), "pass") && a.GetKind() != v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_ON {
			t.Fatalf("the password in the journal: %v", a)
		}
	}
	on, off := v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_PASSWORD_ON, v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_PASSWORD_OFF
	want := []entry{{on, e.alice.String(), false}, {off, e.alice.String(), false}, {on, e.admin.String(), true}, {on, e.alice.String(), false}}
	if len(hist) != len(want) {
		t.Fatalf("history %v, want %v", hist, want)
	}
	for i := range want {
		if hist[i] != want[i] {
			t.Fatalf("history %v, want %v", hist, want)
		}
	}
}

// TestDiskLinkUnlockLimits: password attempts are limited per IP and per link (Redis).
func TestDiskLinkUnlockLimits(t *testing.T) {
	e := newEnv(t)
	e.svc.UnlockKey = DeriveUnlockKey([]byte("test-secret-test-secret-test-secret"))
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	rc, err := redisx.Connect(context.Background(), redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rc.Close)
	f := e.upload(e.alice, "", "deal.txt", 5)
	var link v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(f.GetId())+"/link", &v1.CreateDiskLinkRequest{Password: "letmein-1"}, &link)
	code := link.GetLink().GetCode()
	e.svc.LinkUnlockLinkLimit = redisx.NewRateLimiter(rc, "rl:test-disk-pwl:"+uuid.NewString()+":", 2, 0.001)
	e.unlock(code, "nope-nope", http.StatusForbidden)
	e.unlock(code, "nope-nope", http.StatusForbidden)
	e.unlock(code, "letmein-1", http.StatusTooManyRequests) // even the right one, once the link's budget is out
	e.svc.LinkUnlockLinkLimit = nil
	e.svc.LinkUnlockLimit = redisx.NewRateLimiter(rc, "rl:test-disk-pw:"+uuid.NewString()+":", 1, 0.001)
	e.unlock(code, "nope-nope", http.StatusForbidden)
	e.unlock(code, "letmein-1", http.StatusTooManyRequests)
}

// TestDiskLinkViewOnly (ADR-0167): «Без скачивания» refuses the archive and files without an
// in-browser viewer, serves the rest inline; the switch is journaled.
func TestDiskLinkViewOnly(t *testing.T) {
	e := newEnv(t)
	root := e.folder(e.alice, "", "Press")
	notes := e.upload(e.alice, root.GetId(), "notes.txt", 10)
	pack := e.upload(e.alice, root.GetId(), "pack.zip", 10)
	var link v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(root.GetId())+"/link", &v1.CreateDiskLinkRequest{}, &link)
	code := link.GetLink().GetCode()
	h := e.pubAs("", 200, code+"/items/"+pack.GetId()+"/content", nil)
	if !strings.HasPrefix(h.Get("Content-Disposition"), "attachment") {
		t.Fatalf("plain link disposition %q", h.Get("Content-Disposition"))
	}

	got := e.patchLink(e.alice, root.GetId(), http.StatusOK, &v1.UpdateDiskLinkRequest{ViewOnly: proto.Bool(true)})
	if !got.GetLink().GetViewOnly() || got.GetLink().GetHasPassword() {
		t.Fatalf("view-only link %v", got)
	}
	var meta v1.PublicDiskFile
	e.pubAs("", 200, code, &meta)
	var top v1.PublicDiskFolder
	e.pubAs("", 200, code+"/items", &top)
	if !meta.GetViewOnly() || !top.GetViewOnly() {
		t.Fatalf("view_only not said: %v / %v", &meta, &top)
	}
	e.pubAs("", http.StatusForbidden, code+"/archive", nil)
	e.pubAs("", http.StatusForbidden, code+"/archive?check=1", nil)
	e.pubAs("", http.StatusForbidden, code+"/items/"+pack.GetId()+"/content", nil)
	h = e.pubAs("", 200, code+"/items/"+notes.GetId()+"/content", nil)
	if !strings.HasPrefix(h.Get("Content-Disposition"), "inline") || h.Get("Content-Security-Policy") == "" {
		t.Fatalf("view-only disposition %q", h.Get("Content-Disposition"))
	}
	// A file link: the same rule.
	doc := e.upload(e.alice, "", "brief.bin", 6)
	var fl v1.DiskLinkResponse
	e.must(201, e.alice, "POST", item(doc.GetId())+"/link", &v1.CreateDiskLinkRequest{ViewOnly: true}, &fl)
	e.pubAs("", http.StatusForbidden, fl.GetLink().GetCode()+"/content", nil)

	// Off again: the archive works; both switches are in the history.
	e.patchLink(e.alice, root.GetId(), http.StatusOK, &v1.UpdateDiskLinkRequest{ViewOnly: proto.Bool(false)})
	e.pubAs("", 200, code+"/archive", nil)
	var page v1.DiskActivityPage
	e.must(200, e.alice, "GET", item(root.GetId())+"/activity", nil, &page)
	var kinds []v1.DiskActivityKind
	for _, a := range page.GetActivities() {
		if k := a.GetKind(); k == v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_VIEW_ONLY_ON || k == v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_VIEW_ONLY_OFF {
			if a.GetActorId() != e.alice.String() {
				t.Fatalf("actor %v", a)
			}
			kinds = append(kinds, k)
		}
	}
	if len(kinds) != 2 || kinds[0] != v1.DiskActivityKind_DISK_ACTIVITY_KIND_LINK_VIEW_ONLY_OFF {
		t.Fatalf("history %v", kinds)
	}
}
