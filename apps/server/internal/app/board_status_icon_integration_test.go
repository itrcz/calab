//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func statusByID(b *v1.Board, id string) *v1.BoardStatus {
	for _, s := range b.GetStatuses() {
		if s.GetId() == id {
			return s
		}
	}
	return nil
}

func statusByName(b *v1.Board, name string) *v1.BoardStatus {
	for _, s := range b.GetStatuses() {
		if s.GetName() == name {
			return s
		}
	}
	return nil
}

// TestBoardStatusIcon (ADR-0093): a status icon token is set on create and update, "" resets it
// to the type icon, an unknown token is 422, and an update without icon keeps it.
func TestBoardStatusIcon(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Icons", Key: "ICO"}, 201)
	for _, s := range b.GetStatuses() {
		if s.GetIcon() != "" {
			t.Fatalf("template status %q has icon %q", s.GetName(), s.GetIcon())
		}
	}
	base := "/api/boards/" + b.GetId() + "/statuses"

	bad := "sparkles"
	o.must(422, "POST", base, &v1.CreateBoardStatusRequest{Name: "Bad", Icon: &bad}, nil)

	eye := "eye"
	var r v1.BoardResponse
	o.must(201, "POST", base, &v1.CreateBoardStatusRequest{Name: "Ревью", Type: v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED, Icon: &eye}, &r)
	st := statusByName(r.GetBoard(), "Ревью")
	if st == nil || st.GetIcon() != "eye" {
		t.Fatalf("created status %v", st)
	}
	path := base + "/" + st.GetId()

	q := "three-quarters"
	o.must(200, "PATCH", path, &v1.UpdateBoardStatusRequest{Icon: &q}, &r)
	if got := statusByID(r.GetBoard(), st.GetId()).GetIcon(); got != q {
		t.Fatalf("icon after update %q", got)
	}
	name := "На ревью"
	o.must(200, "PATCH", path, &v1.UpdateBoardStatusRequest{Name: &name}, &r)
	if got := statusByID(r.GetBoard(), st.GetId()); got.GetIcon() != q || got.GetName() != name {
		t.Fatalf("icon kept on rename: %v", got)
	}
	o.must(422, "PATCH", path, &v1.UpdateBoardStatusRequest{Icon: &bad}, nil)
	empty := ""
	o.must(200, "PATCH", path, &v1.UpdateBoardStatusRequest{Icon: &empty}, &r)
	if got := statusByID(r.GetBoard(), st.GetId()).GetIcon(); got != "" {
		t.Fatalf("icon after reset %q", got)
	}
	o.must(200, "GET", "/api/boards/"+b.GetId(), nil, &r)
	if got := statusByID(r.GetBoard(), st.GetId()); got == nil || got.GetIcon() != "" {
		t.Fatalf("board read %v", got)
	}
}
