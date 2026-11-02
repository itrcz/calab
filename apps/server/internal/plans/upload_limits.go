package plans

import (
	"fmt"
	"log/slog"
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Ranges of the upload limits a superadmin sets per workspace (ADR-0155); the migration's CHECKs
// repeat them.
const (
	maxUploadBurst   = 10000
	maxUploadPerHour = 100000
)

// UploadDefaults are the server's upload limits (UPLOAD_RATE_BURST, UPLOAD_RATE_PER_HOUR,
// MAX_FILE_SIZE_MB): what a workspace without an override gets.
type UploadDefaults struct {
	Burst, PerHour, MaxFileMB int
}

func u32(v int) *uint32 {
	x := uint32(max(v, 0)) //nolint:gosec // non-negative config values
	return &x
}

func fromDB(v *int32) *uint32 {
	if v == nil {
		return nil
	}
	return u32(int(*v))
}

// uploadLimits fills the upload limits of an admin workspace: the overrides of ws, the defaults
// and the cap.
func (a *Admin) uploadLimits(aw *v1.AdminWorkspace, ws sqlc.Workspace) {
	aw.UploadLimits = &v1.UploadLimits{Burst: fromDB(ws.UploadBurst), PerHour: fromDB(ws.UploadPerHour), MaxFileMb: fromDB(ws.MaxFileMb)}
	d := a.UploadDefaults
	aw.UploadDefaults = &v1.UploadLimits{Burst: u32(d.Burst), PerHour: u32(d.PerHour), MaxFileMb: u32(d.MaxFileMB)}
	aw.MaxFileMbCap = config.MaxFileSizeCapMB
}

// limitArg checks an optional limit against 1..maximum (nil = the default).
func limitArg(v *uint32, field string, maximum uint32) (*int32, error) {
	if v == nil {
		return nil, nil
	}
	if *v < 1 || *v > maximum {
		return nil, httpx.Validation(field, fmt.Sprintf("must be 1..%d", maximum))
	}
	x := int32(*v) //nolint:gosec // bounded above
	return &x, nil
}

func logValue(v *int32) string {
	if v == nil {
		return "default"
	}
	return fmt.Sprint(*v)
}

// setUploadLimits: PUT /api/admin/workspaces/{id}/upload-limits {limits} (ADR-0155). The next
// upload reads them with the workspace row; the change is written to the admin log.
func (a *Admin) setUploadLimits(w http.ResponseWriter, r *http.Request) error {
	id, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	var req v1.AdminSetUploadLimitsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	l := req.GetLimits()
	if l == nil {
		l = &v1.UploadLimits{} // all back to the defaults
	}
	p := sqlc.SetWorkspaceUploadLimitsParams{ID: id}
	if p.Burst, err = limitArg(l.Burst, "limits.burst", maxUploadBurst); err != nil {
		return err
	}
	if p.PerHour, err = limitArg(l.PerHour, "limits.perHour", maxUploadPerHour); err != nil {
		return err
	}
	if p.MaxFileMb, err = limitArg(l.MaxFileMb, "limits.maxFileMb", config.MaxFileSizeCapMB); err != nil {
		return err
	}
	actor := auth.MustFromContext(r.Context()).UserID
	logged := fmt.Sprintf("burst=%s per_hour=%s max_file_mb=%s", logValue(p.Burst), logValue(p.PerHour), logValue(p.MaxFileMb))
	err = a.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.SetWorkspaceUploadLimits(r.Context(), p); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("workspace")
			}
			return err
		}
		return q.InsertAdminLog(r.Context(), sqlc.InsertAdminLogParams{WorkspaceID: id, ActorID: &actor, Action: "upload_limits", Reason: logged})
	})
	if err != nil {
		return err
	}
	slog.InfoContext(r.Context(), "admin: workspace upload limits", "workspace", id, "by", actor, "limits", logged)
	aw, err := a.one(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.AdminSetUploadLimitsResponse{Workspace: aw})
	return nil
}
