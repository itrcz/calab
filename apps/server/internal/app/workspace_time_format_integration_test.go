//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestWorkspaceTimeFormat: the workspace clock format (docs/09 #73) defaults to AUTO, only
// MANAGE_WORKSPACE changes it, garbage is 422, and members get WORKSPACE_UPDATE with it.
func TestWorkspaceTimeFormat(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	path := "/api/workspaces/" + ws.GetId()
	tf := func(f v1.TimeFormat) *v1.UpdateWorkspaceRequest { return &v1.UpdateWorkspaceRequest{TimeFormat: &f} }

	if got := ws.GetTimeFormat(); got != v1.TimeFormat_TIME_FORMAT_AUTO {
		t.Fatalf("default time format: %v, want AUTO", got)
	}

	g := dialGW(t)
	g.identify(bob.token)

	bob.must(403, "PATCH", path, tf(v1.TimeFormat_TIME_FORMAT_H12), nil) // member: no MANAGE_WORKSPACE
	o.must(422, "PATCH", path, tf(v1.TimeFormat_TIME_FORMAT_UNSPECIFIED), nil)
	o.must(422, "PATCH", path, tf(v1.TimeFormat(99)), nil)

	for _, f := range []v1.TimeFormat{v1.TimeFormat_TIME_FORMAT_H12, v1.TimeFormat_TIME_FORMAT_H24, v1.TimeFormat_TIME_FORMAT_AUTO} {
		var r v1.UpdateWorkspaceResponse
		o.must(200, "PATCH", path, tf(f), &r)
		if got := r.GetWorkspace().GetTimeFormat(); got != f {
			t.Fatalf("PATCH %v: got %v", f, got)
		}
		g.wait("WORKSPACE_UPDATE "+f.String(), func(e *v1.DispatchEvent) bool {
			return e.GetWorkspaceUpdate().GetWorkspace().GetTimeFormat() == f
		})
	}

	// Other fields leave it alone; GET reads it back.
	o.must(200, "PATCH", path, tf(v1.TimeFormat_TIME_FORMAT_H12), nil)
	name := "Team 2"
	o.must(200, "PATCH", path, &v1.UpdateWorkspaceRequest{Name: &name}, nil)
	var got v1.GetWorkspaceResponse
	bob.must(200, "GET", path, nil, &got)
	if got.GetWorkspace().GetTimeFormat() != v1.TimeFormat_TIME_FORMAT_H12 {
		t.Fatalf("GET after rename: %v, want H12", got.GetWorkspace().GetTimeFormat())
	}
}
