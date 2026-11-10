package office

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestPublicView: a public link's file opens view-only on the attachment path — no session, no
// callback, no edit rights — and the Document Server fetches exactly that file with it.
func TestPublicView(t *testing.T) {
	h := newHarness(t)
	f := h.store.addAttachment("plan.docx", []byte("PK-docx"))
	if !h.svc.Opens("plan.docx", 10) || h.svc.Opens("photo.png", 10) || h.svc.Opens("plan.docx", h.svc.cfg.MaxSize+1) {
		t.Fatal("Opens")
	}
	if _, err := h.svc.PublicView(context.Background(), f.ID, "photo.png", 10, false, false, false, "ru"); err == nil {
		t.Fatal("an unsupported type opened")
	}
	resp, err := h.svc.PublicView(context.Background(), f.ID, "plan.docx", 7, true, false, false, "en")
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetMode() != v1.OfficeMode_OFFICE_MODE_VIEW || resp.GetItemId() != "" {
		t.Fatalf("mode %v item %q", resp.GetMode(), resp.GetItemId())
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(resp.GetConfigJson()), &cfg); err != nil {
		t.Fatal(err)
	}
	if dig(cfg, "editorConfig", "mode") != "view" || dig(cfg, "document", "permissions", "edit") != false {
		t.Fatalf("not view-only: %v", cfg)
	}
	if _, ok := cfg["editorConfig"].(map[string]any)["callbackUrl"]; ok {
		t.Fatal("a public view has a callback")
	}
	if len(h.sessions.m) != 0 {
		t.Fatal("a public view joined a session")
	}
	if dig(cfg, "editorConfig", "user", "name") != "Guest" {
		t.Fatalf("user %v", dig(cfg, "editorConfig", "user"))
	}
	// The Document Server downloads the file through the signed URL.
	u := dig(cfg, "document", "url").(string)
	path := strings.TrimPrefix(u, "http://api.calab.test")
	r := httptest.NewRequestWithContext(context.Background(), http.MethodGet, path, nil)
	r.Header.Set("Authorization", "Bearer "+dsToken(t, dsSecret, jwt.MapClaims{"operation": "download", "exp": time.Now().Add(time.Minute).Unix()}))
	w := httptest.NewRecorder()
	h.mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Body.String() != "PK-docx" {
		t.Fatalf("download %d %q", w.Code, w.Body.String())
	}
	if dig(cfg, "document", "permissions", "download") != true {
		t.Fatalf("download off on a plain link: %v", dig(cfg, "document", "permissions"))
	}
	// A view-only link (ADR-0167): no download, print or copy in the viewer.
	resp, err = h.svc.PublicView(context.Background(), f.ID, "plan.docx", 7, false, false, true, "ru")
	if err != nil {
		t.Fatal(err)
	}
	cfg = nil
	if err := json.Unmarshal([]byte(resp.GetConfigJson()), &cfg); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"download", "print", "copy"} {
		if dig(cfg, "document", "permissions", k) != false {
			t.Fatalf("view-only %s: %v", k, dig(cfg, "document", "permissions"))
		}
	}
	h.svc.cfg.Enabled = false
	if _, err := h.svc.PublicView(context.Background(), f.ID, "plan.docx", 7, false, false, false, ""); err == nil || h.svc.Opens("plan.docx", 1) {
		t.Fatal("opened while off")
	}
}
