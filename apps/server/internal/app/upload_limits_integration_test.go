//go:build integration

package app_test

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// uploadWithHeaders is uploadRaw that also returns the Retry-After header.
func uploadWithHeaders(t *testing.T, u *user, wsID string, size int) (int, string, *v1.ApiError) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "blob.bin")
	_, _ = fw.Write(bytes.Repeat([]byte{'x'}, size))
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+"/api/workspaces/"+wsID+"/files", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+u.token)
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

// ADR-0155: a superadmin's per-workspace upload limits — the file size above MAX_FILE_SIZE_MB
// (1 MB in tests), the burst of uploads, 413 naming the limit, validation, back to the defaults;
// they apply to the next upload and are written to the admin log.
func TestWorkspaceUploadLimits(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	admin := superadminUser(t)
	path := "/api/admin/workspaces/" + wid + "/upload-limits"

	// Defaults: 1 MB per file, 413 FILE_TOO_LARGE with the limit in bytes.
	if st, _, e := uploadWithHeaders(t, o, wid, 3<<19); st != 413 || e.GetCode() != v1.ErrorCode_ERROR_CODE_FILE_TOO_LARGE || e.GetLimit() != 1<<20 {
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
	if st, _, e := uploadWithHeaders(t, o, wid, 3<<19); st != 201 {
		t.Fatalf("1.5 MB under a 2 MB override: %d %v", st, e)
	}
	if st, _, e := uploadWithHeaders(t, o, wid, 5<<19); st != 413 || e.GetLimit() != 2<<20 {
		t.Fatalf("2.5 MB over a 2 MB override: %d %v", st, e)
	}
	// The 413 above took the burst's second token: the next upload waits for the refill.
	st, retry, e := uploadWithHeaders(t, o, wid, 10)
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
	o = owner(t) // resets the default bucket
	if st, _, e := uploadWithHeaders(t, o, wid, 3<<19); st != 413 || e.GetLimit() != 1<<20 {
		t.Fatalf("after reset: %d %v", st, e)
	}
}
