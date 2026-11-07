//go:build integration

package app_test

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/config"
)

// uploadWithHeaders is uploadRaw that also returns the Retry-After header.
func uploadWithHeaders(t *testing.T, u *user, wsID string, size int) (int, string, *v1.ApiError) {
	t.Helper()
	return uploadSized(t, u.token, nil, "/api/workspaces/"+wsID+"/files", size)
}

// uploadSized posts a multipart "file" of size bytes to path with token and the extra header (nil
// = none, e.g. Calab-On-Behalf) and returns the status, Retry-After and the error body.
func uploadSized(t *testing.T, token string, header http.Header, path string, size int) (int, string, *v1.ApiError) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "blob.bin")
	_, _ = fw.Write(bytes.Repeat([]byte{'x'}, size))
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var e v1.ApiError
	if resp.StatusCode >= 300 {
		_ = protojson.Unmarshal(raw, &e)
	}
	return resp.StatusCode, resp.Header.Get("Retry-After"), &e
}

// declaredUpload sends only the head of an upload declaring contentLength bytes (a file above
// the hard cap is never really sent) and returns the early answer the server gives before
// reading the body.
func declaredUpload(t *testing.T, token, path string, contentLength int64) (int, *v1.ApiError) {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	conn, err := (&net.Dialer{}).DialContext(context.Background(), "tcp", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"+
		"Content-Type: multipart/form-data; boundary=b\r\nContent-Length: %d\r\n\r\n--b\r\n",
		path, u.Host, token, contentLength); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var e v1.ApiError
	_ = protojson.Unmarshal(raw, &e)
	return resp.StatusCode, &e
}

// ADR-0155: a superadmin's per-workspace upload limits — the file size above MAX_FILE_SIZE_MB
// (1 MB in tests), the burst of uploads, 413 naming the limit, validation, back to the defaults;
// they apply to the next upload and are written to the admin log. The uploader is a member: an
// administrator of the workspace is bound by the hard cap only (ADR-0164).
func TestWorkspaceUploadLimits(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	m := register(t, invite(t, o, wid))
	admin := superadminUser(t)
	path := "/api/admin/workspaces/" + wid + "/upload-limits"

	// Defaults: 1 MB per file, 413 FILE_TOO_LARGE with the limit in bytes.
	if st, _, e := uploadWithHeaders(t, m, wid, 3<<19); st != 413 || e.GetCode() != v1.ErrorCode_ERROR_CODE_FILE_TOO_LARGE || e.GetLimit() != 1<<20 {
		t.Fatalf("default limit: %d %v", st, e)
	}
	var got v1.AdminGetWorkspaceResponse
	admin.must(200, "GET", "/api/admin/workspaces/"+wid, nil, &got)
	if d := got.GetWorkspace().GetUploadDefaults(); d.GetMaxFileMb() != 1 || d.GetBurst() != 30 || d.GetPerHour() != 120 ||
		got.GetWorkspace().GetMaxFileMbCap() != 4096 || got.GetWorkspace().GetUploadLimits().MaxFileMb != nil {
		t.Fatalf("defaults: %v", got.GetWorkspace())
	}

	// Validation and access.
	admin.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "PUT", path, &v1.AdminSetUploadLimitsRequest{Limits: &v1.UploadLimits{MaxFileMb: proto.Uint32(4097)}})
	admin.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "PUT", path, &v1.AdminSetUploadLimitsRequest{Limits: &v1.UploadLimits{Burst: proto.Uint32(0)}})
	o.wantErr(404, v1.ErrorCode_ERROR_CODE_NOT_FOUND, "PUT", path, &v1.AdminSetUploadLimitsRequest{})

	// Override: 2 MB per file, 2 uploads at once, then 1 an hour — no restart.
	var set v1.AdminSetUploadLimitsResponse
	admin.must(200, "PUT", path, &v1.AdminSetUploadLimitsRequest{Limits: &v1.UploadLimits{
		Burst: proto.Uint32(2), PerHour: proto.Uint32(1), MaxFileMb: proto.Uint32(2)}}, &set)
	if l := set.GetWorkspace().GetUploadLimits(); l.GetBurst() != 2 || l.GetPerHour() != 1 || l.GetMaxFileMb() != 2 {
		t.Fatalf("set: %v", l)
	}
	if st, _, e := uploadWithHeaders(t, m, wid, 3<<19); st != 201 {
		t.Fatalf("1.5 MB under a 2 MB override: %d %v", st, e)
	}
	if st, _, e := uploadWithHeaders(t, m, wid, 5<<19); st != 413 || e.GetLimit() != 2<<20 {
		t.Fatalf("2.5 MB over a 2 MB override: %d %v", st, e)
	}
	// The 413 above took the burst's second token: the next upload waits for the refill.
	st, retry, e := uploadWithHeaders(t, m, wid, 10)
	if st != 429 || e.GetCode() != v1.ErrorCode_ERROR_CODE_RATE_LIMITED || retry == "" {
		t.Fatalf("burst: %d %q %v", st, retry, e)
	}

	// The change is in the admin log.
	var n int
	if err := testDB.Pool.QueryRow(context.Background(),
		"SELECT count(*) FROM workspace_admin_log WHERE workspace_id = $1 AND action = 'upload_limits' AND reason = 'burst=2 per_hour=1 max_file_mb=2'", wid).Scan(&n); err != nil || n != 1 {
		t.Fatalf("admin log: %d %v", n, err)
	}

	// Back to the defaults: the user's own bucket again, 1 MB per file.
	admin.must(200, "PUT", path, &v1.AdminSetUploadLimitsRequest{}, &set)
	if l := set.GetWorkspace().GetUploadLimits(); l.Burst != nil || l.PerHour != nil || l.MaxFileMb != nil {
		t.Fatalf("reset: %v", l)
	}
	m = register(t, invite(t, o, wid)) // a fresh default bucket
	if st, _, e := uploadWithHeaders(t, m, wid, 3<<19); st != 413 || e.GetLimit() != 1<<20 {
		t.Fatalf("after reset: %d %v", st, e)
	}
}

// ADR-0164 (CBF-163): administrators of a workspace — its owner and holders of the role with
// ADMINISTRATOR (the built-in «Админ») — upload files above the workspace's limit (1 MB in tests) up to the hard cap,
// into the Disk and as attachments, also through a bot acting on their behalf; everyone else,
// a bot acting for a member included, keeps the workspace's limit.
func TestAdminUploadsAboveWorkspaceLimit(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	m := register(t, invite(t, o, wid))
	a := register(t, invite(t, o, wid))
	adminRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN // the built-in role carrying ADMINISTRATOR
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+a.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	files, disk := "/api/workspaces/"+wid+"/files", "/api/workspaces/"+wid+"/disk/upload"
	const big = 3 << 19 // 1.5 MB
	capBytes := uint64(config.MaxFileSizeCapMB) << 20

	// The owner and an ADMINISTRATOR role: above the workspace's limit, both paths.
	for _, u := range []*user{o, a} {
		for _, p := range []string{files, disk} {
			if st, _, e := uploadSized(t, u.token, nil, p, big); st != 201 {
				t.Fatalf("admin %s: 1.5 MB into %s: %d %v", u.id, p, st, e)
			}
		}
		// Above the hard cap: refused before the body, naming the cap.
		if st, e := declaredUpload(t, u.token, disk, int64(capBytes)+2<<20); st != 413 || e.GetCode() != v1.ErrorCode_ERROR_CODE_FILE_TOO_LARGE || e.GetLimit() != capBytes {
			t.Fatalf("admin %s above the cap: %d %v", u.id, st, e)
		}
	}
	// A member: the workspace's limit, as before.
	for _, p := range []string{files, disk} {
		if st, _, e := uploadSized(t, m.token, nil, p, big); st != 413 || e.GetCode() != v1.ErrorCode_ERROR_CODE_FILE_TOO_LARGE || e.GetLimit() != 1<<20 {
			t.Fatalf("member: 1.5 MB into %s: %d %v", p, st, e)
		}
	}

	// A bot on behalf of the owner (ADR-0106) counts as the owner.
	bt := createBot(t, o, wid, "skrepka")
	if st, _ := setActsAsOwner(o, wid, bt.id, true); st != 200 {
		t.Fatalf("acts_as_owner: %d", st)
	}
	owner := http.Header{"Calab-On-Behalf": {"owner"}}
	if st, _, e := uploadSized(t, bt.token, owner, disk, big); st != 201 {
		t.Fatalf("bot on behalf of the owner: %d %v", st, e)
	}
	// On behalf of a consenting member (ADR-0111): the member's limit.
	m.must(200, "PUT", "/api/workspaces/"+wid+"/bots/"+bt.id+"/delegations/"+m.id, nil, nil)
	if st, _, e := uploadSized(t, bt.token, http.Header{"Calab-On-Behalf": {m.id}}, disk, big); st != 413 || e.GetLimit() != 1<<20 {
		t.Fatalf("bot on behalf of a member: %d %v", st, e)
	}
	// The bot itself, a plain member of the workspace: the workspace's limit.
	if st, _, e := uploadSized(t, bt.token, nil, files, big); st != 413 || e.GetLimit() != 1<<20 {
		t.Fatalf("bot itself: %d %v", st, e)
	}
}
