//go:build integration

package canvas

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/ysync"
)

// withFiles gives the env the files service (the canvas upload route) and GET /api/files/{id}
// answering through files.CanRead.
func (e *env) withFiles() *files.Service {
	e.t.Helper()
	store, err := blob.NewFS(e.t.TempDir())
	if err != nil {
		e.t.Fatal(err)
	}
	fs := files.NewService(e.d, store, e.ev, 10<<20, 0)
	e.svc.Files = fs
	d := e.d
	e.mux.Handle("GET /api/files/{id}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, err := uuid.Parse(r.Header.Get("X-Test-User"))
		if err != nil {
			http.Error(w, "no user", http.StatusUnauthorized)
			return
		}
		r = r.WithContext(perm.WithResolver(auth.WithIdentity(r.Context(), auth.Identity{UserID: u, SessionID: uuid.New()}), d.Q))
		httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
			f, err := d.Q.GetFile(r.Context(), uuid.MustParse(r.PathValue("id")))
			if err != nil {
				return httpx.NotFound("file")
			}
			ok, err := fs.CanRead(r, f)
			if err != nil {
				return err
			}
			if !ok {
				return httpx.NotFound("file")
			}
			w.WriteHeader(http.StatusOK)
			return nil
		}).ServeHTTP(w, r)
	}))
	return fs
}

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 3, 2))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func (e *env) uploadTo(user uuid.UUID, itemID, name string, data []byte) *httptest.ResponseRecorder {
	e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		e.t.Fatal(err)
	}
	_, _ = fw.Write(data)
	_ = mw.Close()
	r := httptest.NewRequestWithContext(context.Background(), "POST", item(itemID)+"/files", &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r.Header.Set("X-Test-User", user.String())
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	return w
}

// Owner 23.11.2026: a picture pasted or dropped on a canvas goes up with CANVAS_WRITE, belongs to
// the canvas and is read with CANVAS_VIEW on it; not a picture, a trashed canvas, a folder and
// whoever does not see the canvas are refused; the file is not an «upload waiting for a message».
func TestCanvasPictureUpload(t *testing.T) {
	e := newEnv(t, ysync.Config{})
	e.withFiles()
	ctx := context.Background()
	c := e.create(e.alice, "", "Retro")

	w := e.uploadTo(e.alice, c.GetId(), "shot.png", tinyPNG(t))
	if w.Code != 201 {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	var out v1.UploadFileResponse
	if err := protojson.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	meta := out.GetFile()
	if meta.GetMime() != "image/png" || meta.GetWidth() != 3 || meta.GetHeight() != 2 {
		t.Fatalf("meta %+v", meta)
	}
	fid := uuid.MustParse(meta.GetId())
	if cf, err := e.d.Q.GetCanvasItemFile(ctx, fid); err != nil || cf.ItemID.String() != c.GetId() {
		t.Fatalf("canvas file row %+v %v", cf, err)
	}
	// Read with CANVAS_VIEW: members see a canvas that is not restricted; a guest and an outsider do not.
	for u, want := range map[uuid.UUID]int{e.alice: 200, e.bob: 200, e.admin: 200, e.guest: 404, e.outsider: 404} {
		if got := e.call(u, "GET", "/api/files/"+fid.String(), nil).Code; got != want {
			t.Errorf("read as %s: %d, want %d", u, got, want)
		}
	}
	// Not an «upload waiting for a message»: the pending-upload bytes skip it.
	alice := e.alice
	if b, err := e.d.Q.UnattachedBytesByUploader(ctx, sqlc.UnattachedBytesByUploaderParams{UploaderID: &alice, WorkspaceID: &e.ws}); err != nil || b != 0 {
		t.Fatalf("unattached bytes %d %v", b, err)
	}

	// Refusals: not a picture, someone who does not see the canvas, a folder, a trashed canvas.
	if got := e.uploadTo(e.alice, c.GetId(), "notes.txt", []byte("plain text, not a picture")).Code; got != 422 {
		t.Errorf("text upload: %d, want 422", got)
	}
	if got := e.uploadTo(e.guest, c.GetId(), "shot.png", tinyPNG(t)).Code; got != 404 {
		t.Errorf("guest upload: %d, want 404", got)
	}
	dir := e.mkdir(e.alice, "", "Folder")
	if got := e.uploadTo(e.alice, dir.GetId(), "shot.png", tinyPNG(t)).Code; got != 409 {
		t.Errorf("folder upload: %d, want 409", got)
	}
	e.must(200, e.alice, "POST", item(c.GetId())+"/trash", nil, nil)
	if got := e.uploadTo(e.alice, c.GetId(), "shot.png", tinyPNG(t)).Code; got != 409 {
		t.Errorf("trashed upload: %d, want 409", got)
	}
	// In the trash it stays readable to who sees the canvas there.
	if got := e.call(e.alice, "GET", "/api/files/"+fid.String(), nil).Code; got != 200 {
		t.Errorf("read in the trash: %d", got)
	}
	// Deleted forever: the reference goes with the canvas.
	e.must(204, e.alice, "DELETE", item(c.GetId()), nil, nil)
	if _, err := e.d.Q.GetCanvasItemFile(ctx, fid); err == nil {
		t.Fatal("the canvas file row must go with the canvas")
	}
}
