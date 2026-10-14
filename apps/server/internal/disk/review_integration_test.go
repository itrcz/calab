//go:build integration

package disk

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// The journal of an item does not name folders the reader does not see (ADR-0094 §2), and a
// file of the Disk is not an upload that a message or a task may take.
func TestDiskJournalHidesUnseenFolders(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	secret := e.folder(e.alice, "", "Secret")
	e.must(200, e.alice, "PUT", item(secret.GetId())+"/permissions", &v1.UpdateDiskPermissionsRequest{Restricted: proto.Bool(true)}, nil)
	doc := e.upload(e.alice, secret.GetId(), "a.txt", 3)
	e.must(200, e.alice, "PATCH", item(doc.GetId()), &v1.UpdateDiskItemRequest{ParentId: proto.String("")}, nil)
	names := func(user uuid.UUID) []string {
		t.Helper()
		var act v1.DiskActivityPage
		e.must(200, user, "GET", item(doc.GetId())+"/activity", nil, &act)
		var out []string
		for _, a := range act.GetActivities() {
			for _, side := range []*structpb.Struct{a.GetBefore(), a.GetAfter()} {
				if n := side.GetFields()["parent_name"].GetStringValue(); n != "" {
					out = append(out, n)
				}
			}
		}
		return out
	}
	if got := names(e.alice); len(got) != 2 || got[0] != "Secret" || got[1] != "Secret" {
		t.Fatalf("alice sees the folder in the journal: %v", got)
	}
	if got := names(e.bob); len(got) != 0 {
		t.Fatalf("bob must not learn the restricted folder's name: %v", got)
	}
	rows, err := e.d.Q.GetFilesWithUsage(ctx, []uuid.UUID{uuid.MustParse(doc.GetFile().GetId())})
	if err != nil || len(rows) != 1 || !rows[0].Attached {
		t.Fatalf("a Disk file must count as attached: %+v %v", rows, err)
	}
}
