//go:build integration

package files

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/searchq"
)

// ADR-0096: pictures and covers of wiki pages (live or in the trash) are references: the 24 h
// orphan cleanup keeps them and they are not «uploads waiting for a message».
func TestCleanupOrphansKeepsWikiFiles(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	store, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(d, store, nil, 1<<20, 0)
	user, ws := diskSeed(ctx, t, d)

	old := 25 * time.Hour
	pic := diskFile(ctx, t, d, store, ws, user, 100, old)
	cover := diskFile(ctx, t, d, store, ws, user, 200, old)
	trashedPic := diskFile(ctx, t, d, store, ws, user, 300, old)
	orphan := diskFile(ctx, t, d, store, ws, user, 400, old)

	page, err := d.Q.CreateWikiPage(ctx, sqlc.CreateWikiPageParams{WorkspaceID: ws, Title: "Guide", OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Q.AddWikiPageFile(ctx, sqlc.AddWikiPageFileParams{PageID: page.ID, FileID: pic.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.UpdateWikiPage(ctx, sqlc.UpdateWikiPageParams{ID: page.ID, SetCover: true, CoverFileID: &cover.ID, UpdatedBy: &user}); err != nil {
		t.Fatal(err)
	}
	sub, err := d.Q.CreateWikiPage(ctx, sqlc.CreateWikiPageParams{WorkspaceID: ws, ParentID: &page.ID, Title: "Old", OwnerID: &user})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Q.AddWikiPageFile(ctx, sqlc.AddWikiPageFileParams{PageID: sub.ID, FileID: trashedPic.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.TrashWikiSubtree(ctx, sqlc.TrashWikiSubtreeParams{ID: sub.ID, TrashedAt: time.Now(), TrashedBy: &user}); err != nil {
		t.Fatal(err)
	}

	pending, err := d.Q.UnattachedBytesByUploader(ctx, sqlc.UnattachedBytesByUploaderParams{UploaderID: user, WorkspaceID: &ws})
	if err != nil {
		t.Fatal(err)
	}
	if pending != orphan.Size {
		t.Fatalf("unattached bytes = %d, want only the orphan's %d", pending, orphan.Size)
	}
	if n, err := s.CleanupOrphans(ctx); err != nil || n != 1 {
		t.Fatalf("cleanup deleted %d files (%v), want 1 (the orphan)", n, err)
	}
	for _, f := range []sqlc.File{pic, cover, trashedPic} {
		if _, err := d.Q.GetFile(ctx, f.ID); err != nil {
			t.Fatalf("wiki file %s gone: %v", f.ID, err)
		}
	}
	if _, err := d.Q.GetFile(ctx, orphan.ID); !db.IsNotFound(err) {
		t.Fatalf("the orphan must go: %v", err)
	}
	if b, err := d.Q.GetWikiFilesBytes(ctx, &ws); err != nil || b != pic.Size+cover.Size+trashedPic.Size {
		t.Fatalf("wiki bytes %d %v", b, err)
	}
}

// The Wiki's queries on a small tree: positions and moves, paths, the per-page update counter,
// snapshots, versions, trash / restore, overrides, links, search candidates, delete forever.
func TestWikiQueries(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	store, err := blob.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	user, ws := diskSeed(ctx, t, d)
	q := d.Q

	member, err := q.GetBuiltinRole(ctx, sqlc.GetBuiltinRoleParams{WorkspaceID: ws, Builtin: ptr("member")})
	if err != nil {
		t.Fatal(err)
	}
	if perm.Bits(uint64(member.Permissions))&perm.Wiki != perm.WikiView|perm.WikiWrite { //nolint:gosec // bit mask
		t.Fatalf("member role of a new workspace = %d, want WIKI_VIEW | WIKI_WRITE", member.Permissions)
	}

	mk := func(parent *uuid.UUID, title string) sqlc.WikiPage {
		t.Helper()
		p, err := q.CreateWikiPage(ctx, sqlc.CreateWikiPageParams{WorkspaceID: ws, ParentID: parent, Title: title, OwnerID: &user})
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	a, b, c := mk(nil, "A"), mk(nil, "Онбординг"), mk(nil, "C")
	if a.Position != 0 || b.Position != 1 || c.Position != 2 {
		t.Fatalf("positions %d %d %d", a.Position, b.Position, c.Position)
	}
	a1 := mk(&a.ID, "A1")
	a2 := mk(&a.ID, "A2")
	if a1.Position != 0 || a2.Position != 1 {
		t.Fatalf("child positions %d %d", a1.Position, a2.Position)
	}
	if _, err := q.CreateWikiPage(ctx, sqlc.CreateWikiPageParams{WorkspaceID: ws, Title: string(make([]rune, 201))}); err == nil {
		t.Fatal("a title over 200 characters must be refused")
	}

	top, err := q.ListWikiChildren(ctx, sqlc.ListWikiChildrenParams{WorkspaceID: ws, Lim: 10})
	if err != nil || len(top) != 3 || top[0].WikiPageHead.ID != a.ID || !top[0].HasChildren || top[1].HasChildren {
		t.Fatalf("top level %+v %v", top, err)
	}
	next, err := q.ListWikiChildren(ctx, sqlc.ListWikiChildrenParams{WorkspaceID: ws, Lim: 10, CursorID: &a.ID, CursorPosition: 0})
	if err != nil || len(next) != 2 || next[0].WikiPageHead.ID != b.ID {
		t.Fatalf("second page %+v %v", next, err)
	}

	// Move C to the front of A's children: it takes position 0, A1 and A2 shift; the top level
	// closes the gap.
	if err := q.LockWikiTree(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if _, err := q.MoveWikiPage(ctx, sqlc.MoveWikiPageParams{ID: c.ID, ParentID: &a.ID, Position: 0, UpdatedBy: &user}); err != nil {
		t.Fatal(err)
	}
	if err := q.ReindexWikiSiblings(ctx, sqlc.ReindexWikiSiblingsParams{WorkspaceID: ws, ParentID: &a.ID, FirstID: &c.ID}); err != nil {
		t.Fatal(err)
	}
	if err := q.ReindexWikiSiblings(ctx, sqlc.ReindexWikiSiblingsParams{WorkspaceID: ws}); err != nil {
		t.Fatal(err)
	}
	kids, err := q.ListWikiChildren(ctx, sqlc.ListWikiChildrenParams{WorkspaceID: ws, ParentID: &a.ID, Lim: 10})
	if err != nil || len(kids) != 3 || kids[0].WikiPageHead.ID != c.ID || kids[1].WikiPageHead.ID != a1.ID || kids[2].WikiPageHead.Position != 2 {
		t.Fatalf("children after the move %+v %v", kids, err)
	}
	if pb, err := q.GetWikiPage(ctx, b.ID); err != nil || pb.Position != 1 {
		t.Fatalf("B after the move %+v %v", pb, err)
	}

	a21 := mk(&a2.ID, "A2.1")
	path, err := q.WikiPagePath(ctx, a21.ID)
	if err != nil || len(path) != 3 || path[0].WikiPageHead.ID != a.ID || path[2].WikiPageHead.ID != a21.ID || path[0].Depth != 2 {
		t.Fatalf("path %+v %v", path, err)
	}
	if depth, err := q.CountWikiSubtreeDepth(ctx, a.ID); err != nil || depth != 2 {
		t.Fatalf("subtree depth %d %v", depth, err)
	}
	if branch, err := q.ListWikiBranch(ctx, a.ID); err != nil || len(branch) != 4 || branch[3].WikiPageHead.ID != a21.ID {
		t.Fatalf("branch %+v %v", branch, err)
	}

	// Updates: seq per page from 1, independent counters, no append to a trashed page.
	for i := range 3 {
		u, err := q.AppendWikiUpdate(ctx, sqlc.AppendWikiUpdateParams{PageID: a.ID, Data: []byte{byte(i), 1}, AuthorID: &user})
		if err != nil || u.Seq != int64(i+1) {
			t.Fatalf("append %d: seq %d %v", i, u.Seq, err)
		}
	}
	if u, err := q.AppendWikiUpdate(ctx, sqlc.AppendWikiUpdateParams{PageID: b.ID, Data: []byte{9}}); err != nil || u.Seq != 1 {
		t.Fatalf("B's first seq %d %v", u.Seq, err)
	}
	if _, err := q.AppendWikiUpdate(ctx, sqlc.AppendWikiUpdateParams{PageID: a.ID, Data: make([]byte, 65537)}); err == nil {
		t.Fatal("an update over 64 KiB must be refused")
	}
	st, err := q.WikiUpdatesSince(ctx, sqlc.WikiUpdatesSinceParams{PageID: a.ID, AfterSeq: 1})
	if err != nil || st.Updates != 2 || st.Bytes != 4 || len(st.Authors) != 1 || st.Authors[0] != user {
		t.Fatalf("stats %+v %v", st, err)
	}
	ups, err := q.ListWikiUpdatesSince(ctx, sqlc.ListWikiUpdatesSinceParams{PageID: a.ID, AfterSeq: 1, Lim: 10})
	if err != nil || len(ups) != 2 || ups[0].Seq != 2 || !bytes.Equal(ups[1].Data, []byte{2, 1}) {
		t.Fatalf("since %+v %v", ups, err)
	}

	// Snapshots never go back; the updates they contain are dropped.
	if n, err := q.UpsertWikiSnapshot(ctx, sqlc.UpsertWikiSnapshotParams{PageID: a.ID, State: []byte("s2"), ThroughSeq: 2, SavedBy: &user}); err != nil || n != 1 {
		t.Fatalf("snapshot %d %v", n, err)
	}
	if n, err := q.UpsertWikiSnapshot(ctx, sqlc.UpsertWikiSnapshotParams{PageID: a.ID, State: []byte("s1"), ThroughSeq: 1}); err != nil || n != 0 {
		t.Fatalf("a stale snapshot must be ignored: %d %v", n, err)
	}
	if n, err := q.DeleteWikiUpdatesThrough(ctx, sqlc.DeleteWikiUpdatesThroughParams{PageID: a.ID, ThroughSeq: 2}); err != nil || n != 2 {
		t.Fatalf("compaction %d %v", n, err)
	}
	if snap, err := q.GetWikiSnapshot(ctx, a.ID); err != nil || snap.ThroughSeq != 2 || string(snap.State) != "s2" {
		t.Fatalf("snapshot %+v %v", snap, err)
	}
	if _, err := q.UpsertWikiSnapshot(ctx, sqlc.UpsertWikiSnapshotParams{PageID: b.ID, State: make([]byte, 2<<20+1), ThroughSeq: 1}); err == nil {
		t.Fatal("a snapshot over 2 MiB must be refused")
	}
	if _, err := q.SetWikiPageContent(ctx, sqlc.SetWikiPageContentParams{ID: a.ID, PlainText: "Отпуск оформляется через бухгалтерию", Preview: "Отпуск", DocSize: 2, UpdatedBy: &user}); err != nil {
		t.Fatal(err)
	}

	// Versions: ≤ 200 kept, older than 7 days one per day.
	now := time.Now()
	dayAgo10 := now.UTC().Truncate(24 * time.Hour).Add(-10*24*time.Hour + time.Hour)
	for i := range 3 {
		v, err := q.InsertWikiVersion(ctx, sqlc.InsertWikiVersionParams{PageID: a.ID, State: []byte("v"), PlainText: "t", Title: "A", Authors: []uuid.UUID{user}})
		if err != nil {
			t.Fatal(err)
		}
		// Two versions on one day ten days ago, one today.
		if i < 2 {
			if _, err := d.Pool.Exec(ctx, `UPDATE wiki_page_versions SET created_at = $2 WHERE id = $1`, v.ID, dayAgo10.Add(time.Duration(i)*time.Minute)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if n, err := q.PruneWikiVersions(ctx, sqlc.PruneWikiVersionsParams{PageID: a.ID, Now: now}); err != nil || n != 1 {
		t.Fatalf("prune %d %v", n, err)
	}
	vs, err := q.ListWikiVersions(ctx, sqlc.ListWikiVersionsParams{PageID: a.ID, Lim: 10})
	if err != nil || len(vs) != 2 || vs[0].Size != 1 {
		t.Fatalf("versions %+v %v", vs, err)
	}
	if v, err := q.GetWikiVersion(ctx, sqlc.GetWikiVersionParams{ID: vs[0].ID, PageID: b.ID}); !db.IsNotFound(err) {
		t.Fatalf("a version through another page: %+v %v", v, err)
	}

	// Search candidates: by a word of the text (russian stemming), by a title with a typo.
	search := func(text string) []sqlc.SearchWikiPagesRow {
		t.Helper()
		pq, err := searchq.Parse(text)
		if err != nil {
			t.Fatal(err)
		}
		hits, err := q.SearchWikiPages(ctx, sqlc.SearchWikiPagesParams{WorkspaceIds: []uuid.UUID{ws}, Tsq: pq.TS, Words: pq.Text, Phrase: searchq.Like(pq.Text), Now: now, Lim: 10})
		if err != nil {
			t.Fatal(err)
		}
		return hits
	}
	if hits := search("бухгалтерии"); len(hits) != 1 || hits[0].ID != a.ID || hits[0].Score <= 0 {
		t.Fatalf("search by text %+v", hits)
	}
	if hits := search("онбординк"); len(hits) != 1 || hits[0].ID != b.ID {
		t.Fatalf("search by a title with a typo %+v", hits)
	}
	if hits := search("сборд"); len(hits) != 0 {
		t.Fatalf("no match %+v", hits)
	}
	pq, _ := searchq.Parse("бухгалтерии")
	heads, err := q.WikiSearchHeadlines(ctx, sqlc.WikiSearchHeadlinesParams{Ids: []uuid.UUID{a.ID}, Tsq: pq.TS, Options: "StartSel=<, StopSel=>"})
	if err != nil || len(heads) != 1 || !bytes.Contains([]byte(heads[0].Snippet), []byte("<бухгалтерию>")) {
		t.Fatalf("headline %+v %v", heads, err)
	}

	// Trash A2: its subtree goes with it, the trash lists only A2; a trashed page takes no
	// updates; the restore puts it last under its parent.
	gone, err := q.TrashWikiSubtree(ctx, sqlc.TrashWikiSubtreeParams{ID: a2.ID, TrashedAt: now, TrashedBy: &user})
	if err != nil || len(gone) != 2 {
		t.Fatalf("trash %d %v", len(gone), err)
	}
	if trash, err := q.ListWikiTrash(ctx, sqlc.ListWikiTrashParams{WorkspaceID: ws, Lim: 10}); err != nil || len(trash) != 1 || trash[0].ID != a2.ID {
		t.Fatalf("trash listing %+v %v", trash, err)
	}
	if _, err := q.AppendWikiUpdate(ctx, sqlc.AppendWikiUpdateParams{PageID: a21.ID, Data: []byte{1}}); !db.IsNotFound(err) {
		t.Fatalf("an update of a trashed page: %v", err)
	}
	if err := q.ReindexWikiSiblings(ctx, sqlc.ReindexWikiSiblingsParams{WorkspaceID: ws, ParentID: &a.ID}); err != nil {
		t.Fatal(err)
	}
	back, err := q.RestoreWikiSubtree(ctx, sqlc.RestoreWikiSubtreeParams{ID: a2.ID, ParentID: &a.ID})
	if err != nil || len(back) != 2 {
		t.Fatalf("restore %d %v", len(back), err)
	}
	if p, err := q.GetWikiPage(ctx, a2.ID); err != nil || p.TrashedAt != nil || p.Position != 2 {
		t.Fatalf("A2 after restore %+v %v", p, err)
	}

	// Overrides carry the wiki VIEW / WRITE only; a deleted role and a leaving member drop theirs.
	role := uuid.New().String()
	if err := q.InsertWikiPermission(ctx, sqlc.InsertWikiPermissionParams{PageID: a.ID, TargetType: "role", TargetID: role, Allow: int64(perm.WikiView)}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []perm.Bits{perm.WikiManage, perm.DiskView} {
		if err := q.InsertWikiPermission(ctx, sqlc.InsertWikiPermissionParams{PageID: a.ID, TargetType: "user", TargetID: role, Allow: int64(bad)}); err == nil { //nolint:gosec // bit mask
			t.Fatalf("bits %d must not be stored in wiki overrides", bad)
		}
	}
	if err := q.InsertWikiPermission(ctx, sqlc.InsertWikiPermissionParams{PageID: a.ID, TargetType: "user", TargetID: user.String(), Deny: int64(perm.WikiWrite)}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.DeleteRoleOverrides(ctx, role); err != nil {
		t.Fatal(err)
	}
	if err := q.DeleteUserOverridesInWorkspace(ctx, sqlc.DeleteUserOverridesInWorkspaceParams{WorkspaceID: ws, UserID: user.String()}); err != nil {
		t.Fatal(err)
	}
	if ps, err := q.ListWikiPermissions(ctx, a.ID); err != nil || len(ps) != 0 {
		t.Fatalf("overrides after the role was deleted and the member left: %+v %v", ps, err)
	}

	// A live link keeps its code when changed; a revoked one gets the new code.
	code := func(c byte) string { return string(bytes.Repeat([]byte{c}, 43)) }
	l1, err := q.UpsertWikiLink(ctx, sqlc.UpsertWikiLinkParams{PageID: a.ID, Code: code('x'), CreatedBy: &user})
	if err != nil {
		t.Fatal(err)
	}
	l2, err := q.UpsertWikiLink(ctx, sqlc.UpsertWikiLinkParams{PageID: a.ID, Code: code('y'), IncludeChildren: true, CreatedBy: &user})
	if err != nil || l2.Code != l1.Code || !l2.IncludeChildren {
		t.Fatalf("link update %+v %v", l2, err)
	}
	if n, err := q.RevokeWikiLink(ctx, a.ID); err != nil || n != 1 {
		t.Fatalf("revoke %d %v", n, err)
	}
	if _, err := q.GetWikiLinkByCode(ctx, l1.Code); !db.IsNotFound(err) {
		t.Fatalf("a revoked link must not answer: %v", err)
	}
	l3, err := q.UpsertWikiLink(ctx, sqlc.UpsertWikiLinkParams{PageID: a.ID, Code: code('z'), CreatedBy: &user})
	if err != nil || l3.Code != code('z') || l3.IncludeChildren {
		t.Fatalf("link after revoke %+v %v", l3, err)
	}
	if row, err := q.GetWikiLinkByCode(ctx, l3.Code); err != nil || row.WikiPageHead.ID != a.ID {
		t.Fatalf("link by code %+v %v", row, err)
	}

	// Files of the branch: A2.1's picture is reachable through A's link with children only.
	pic := diskFile(ctx, t, d, store, ws, user, 500, time.Minute)
	shared := diskFile(ctx, t, d, store, ws, user, 600, time.Minute)
	if err := q.AddWikiPageFile(ctx, sqlc.AddWikiPageFileParams{PageID: a21.ID, FileID: pic.ID}); err != nil {
		t.Fatal(err)
	}
	if err := q.AddWikiPageFile(ctx, sqlc.AddWikiPageFileParams{PageID: a21.ID, FileID: shared.ID}); err != nil {
		t.Fatal(err)
	}
	if err := q.AddWikiPageFile(ctx, sqlc.AddWikiPageFileParams{PageID: b.ID, FileID: shared.ID}); err != nil {
		t.Fatal(err)
	}
	for _, x := range []struct {
		children, want bool
	}{{false, false}, {true, true}} {
		if ok, err := q.WikiBranchHasFile(ctx, sqlc.WikiBranchHasFileParams{PageID: a.ID, FileID: pic.ID, IncludeChildren: x.children}); err != nil || ok != x.want {
			t.Fatalf("branch file (children %v) = %v %v", x.children, ok, err)
		}
	}

	// Settings.
	if err := q.SetWikiTrashDays(ctx, sqlc.SetWikiTrashDaysParams{ID: ws, Days: ptr[int32](30)}); err != nil {
		t.Fatal(err)
	}
	if days, err := q.GetWikiTrashDays(ctx, ws); err != nil || days == nil || *days != 30 {
		t.Fatalf("trash days %v %v", days, err)
	}

	// Delete forever: the subtree's own files go (B still references the shared one), then the
	// pages with their updates, snapshots and versions.
	files, err := q.DeleteWikiSubtreeFiles(ctx, a.ID)
	if err != nil || len(files) != 1 || files[0].ID != pic.ID {
		t.Fatalf("subtree files %+v %v", files, err)
	}
	if n, err := q.DeleteWikiPage(ctx, a.ID); err != nil || n != 1 {
		t.Fatalf("delete %d %v", n, err)
	}
	if _, err := q.GetWikiPage(ctx, a21.ID); !db.IsNotFound(err) {
		t.Fatalf("A2.1 must be gone: %v", err)
	}
	if _, err := q.GetFile(ctx, shared.ID); err != nil {
		t.Fatalf("B's file must stay: %v", err)
	}
	var left int
	if err := d.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM wiki_page_versions) + (SELECT count(*) FROM wiki_page_snapshots WHERE page_id = $1)`, a.ID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("versions / snapshot left %d %v", left, err)
	}
}
