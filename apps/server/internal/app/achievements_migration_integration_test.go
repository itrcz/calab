//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/achievements"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
)

// flakyStore fails reads of legacy pictures after the first `allow` ones: a server that dies in
// the middle of the startup task.
type flakyStore struct {
	blob.Store
	allow int32
	reads atomic.Int32
}

func (f *flakyStore) Get(ctx context.Context, key string) (blob.ReadSeekCloser, blob.Meta, error) {
	if strings.HasPrefix(key, "achievements/") && f.reads.Add(1) > f.allow {
		return nil, blob.Meta{}, errors.New("simulated crash")
	}
	return f.Store.Get(ctx, key)
}

// TestAchievementsMigration (ADR-0061 amendment 1, migration 00063 + achievements.MigrateLegacy):
// host achievements seeded the old way (pictures as blobs "achievements/<uuid>.webp") are copied
// into every workspace with grants of them (new ids, grants and chat cards re-pointed); an
// ungranted one is deleted; the pictures become files of the workspaces; a failure in the middle
// of the startup task resumes from the database state; a missing blob leaves the entry without a
// picture; the old blobs are deleted afterwards; a second run is a no-op.
func TestAchievementsMigration(t *testing.T) {
	ctx := context.Background()
	adminURL := env("TEST_PG_URL", env("TEST_DATABASE_URL", "postgres://calaba:calaba@localhost:55432/calaba"))
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("postgres unavailable: %v", err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var rb [4]byte
	_, _ = rand.Read(rb[:])
	name := "calaba_mig_" + hex.EncodeToString(rb[:])
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") }()
	u, _ := url.Parse(adminURL)
	u.Path = "/" + name
	d, err := db.Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := d.MigrateTo(ctx, 62); err != nil {
		t.Fatal(err)
	}
	must := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}

	// Two workspaces of one owner, a member in both, a text room with a card in the first.
	owner, member := uuid.New(), uuid.New()
	w1, w2, room := uuid.New(), uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{owner, member} {
		must(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')`, id, "m-"+id.String()[:8]+"@example.com")
	}
	must(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, $2, 'W1', $4), ($3, $5, 'W2', $4)`,
		w1, "mig-a-"+w1.String()[:8], w2, owner, "mig-b-"+w2.String()[:8])
	must(`INSERT INTO rooms (id, workspace_id, type, name) VALUES ($1, $2, 'text', 'general')`, room, w1)

	// The host catalog the old way: four entries with blobs (one blob missing).
	pics := map[string][]byte{}
	host := func(title string, withBlob bool) uuid.UUID {
		t.Helper()
		id := uuid.New()
		key := "achievements/" + uuid.NewString() + ".webp"
		img, err := achievements.PrepareAchievement(ctx, achievementPNG(t, false))
		if err != nil {
			t.Fatal(err)
		}
		if withBlob {
			if err := testStore.Put(ctx, key, bytes.NewReader(img), int64(len(img)), "image/webp"); err != nil {
				t.Fatal(err)
			}
			pics[key] = img
		}
		must(`INSERT INTO achievements (id, title, description, image_key, image_size, width, height, position, created_by)
			VALUES ($1, $2, 'd', $3, $4, 512, 512, 1, $5)`, id, title, key, len(img), owner)
		return id
	}
	both, onlyW1, unused, lost := host("Both", true), host("W1 only", true), host("Unused", true), host("Lost", false)
	var unusedKey string
	if err := d.Pool.QueryRow(ctx, `SELECT image_key FROM achievements WHERE id = $1`, unused).Scan(&unusedKey); err != nil {
		t.Fatal(err)
	}
	grant := func(ws, ach uuid.UUID, revoked bool) uuid.UUID {
		t.Helper()
		var id uuid.UUID
		if err := d.Pool.QueryRow(ctx, `INSERT INTO member_achievements (workspace_id, user_id, achievement_id, granted_by, note, revoked_at)
			VALUES ($1, $2, $3, $4, 'за дело', CASE WHEN $5 THEN now() END) RETURNING id`, ws, member, ach, owner, revoked).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	cardGrant := grant(w1, both, false)
	grant(w2, both, false)
	grant(w2, both, false)
	grant(w1, onlyW1, true) // revoked grants keep the entry too
	grant(w2, lost, false)
	var card uuid.UUID
	if err := d.Pool.QueryRow(ctx, `INSERT INTO messages (room_id, author_id, content, kind, payload)
		VALUES ($1, $2, '', 'system', jsonb_build_object('achievement', jsonb_build_object('achievementId', $3::text, 'grantId', $4::text, 'note', 'за дело')))
		RETURNING id`, room, member, both, cardGrant).Scan(&card); err != nil {
		t.Fatal(err)
	}
	must(`UPDATE member_achievements SET message_id = $1 WHERE id = $2`, card, cardGrant)

	// Migration 00063 (SQL).
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	type row struct {
		id, ws uuid.UUID
		title  string
		file   *uuid.UUID
		legacy *string
	}
	rows := func() map[string]row { // by "title@workspace"
		t.Helper()
		rs, err := d.Pool.Query(ctx, `SELECT id, workspace_id, title, file_id, legacy_image_key FROM achievements`)
		if err != nil {
			t.Fatal(err)
		}
		defer rs.Close()
		out := map[string]row{}
		for rs.Next() {
			var r row
			if err := rs.Scan(&r.id, &r.ws, &r.title, &r.file, &r.legacy); err != nil {
				t.Fatal(err)
			}
			wsName := "W1"
			if r.ws == w2 {
				wsName = "W2"
			}
			out[r.title+"@"+wsName] = r
		}
		return out
	}
	after := rows()
	if len(after) != 4 {
		t.Fatalf("entries after 00063: %v", after)
	}
	for _, k := range []string{"Both@W1", "Both@W2", "W1 only@W1", "Lost@W2"} {
		r, ok := after[k]
		if !ok || r.legacy == nil || r.file != nil || r.id == both || r.id == onlyW1 || r.id == lost {
			t.Fatalf("%s after 00063: %+v", k, r)
		}
	}
	var stale int
	if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM member_achievements m JOIN achievements a ON a.id = m.achievement_id
		WHERE a.workspace_id <> m.workspace_id`).Scan(&stale); err != nil || stale != 0 {
		t.Fatalf("grants pointing across workspaces: %d %v", stale, err)
	}
	var w2Both int
	if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM member_achievements WHERE achievement_id = $1`, after["Both@W2"].id).Scan(&w2Both); err != nil || w2Both != 2 {
		t.Fatalf("W2 grants of the copy: %d %v", w2Both, err)
	}
	var cardAch string
	if err := d.Pool.QueryRow(ctx, `SELECT payload->'achievement'->>'achievementId' FROM messages WHERE id = $1`, card).Scan(&cardAch); err != nil ||
		cardAch != after["Both@W1"].id.String() {
		t.Fatalf("card points at %q, want %s (%v)", cardAch, after["Both@W1"].id, err)
	}
	var usedBefore int64
	if err := d.Pool.QueryRow(ctx, `SELECT storage_used_bytes FROM workspaces WHERE id = $1`, w2).Scan(&usedBefore); err != nil {
		t.Fatal(err)
	}

	// The startup task dies after the first picture; the next start resumes.
	newSvc := func(store blob.Store) *achievements.Service {
		return achievements.New(d, store, files.NewService(d, store, events.Nop{}, 1<<20, 1<<40), events.Nop{}, nil)
	}
	if err := newSvc(&flakyStore{Store: testStore, allow: 1}).MigrateLegacy(ctx); err == nil {
		t.Fatal("the simulated crash did not surface")
	}
	mid := rows()
	done := 0
	for _, r := range mid {
		if r.legacy == nil {
			done++
		}
	}
	if done != 1 {
		t.Fatalf("entries done after the crash: %d (%v)", done, mid)
	}
	if _, _, err := testStore.Get(ctx, unusedKey); err != nil {
		t.Fatalf("an old blob went before the copy finished: %v", err)
	}
	if err := newSvc(testStore).MigrateLegacy(ctx); err != nil {
		t.Fatal(err)
	}
	final := rows()
	for k, r := range final {
		if r.legacy != nil {
			t.Fatalf("%s still waits: %+v", k, r)
		}
		if k == "Lost@W2" {
			if r.file != nil {
				t.Fatalf("a lost picture got a file: %+v", r)
			}
			continue
		}
		if r.file == nil {
			t.Fatalf("%s without a picture", k)
		}
		f, err := d.Q.GetFile(ctx, *r.file)
		if err != nil || f.WorkspaceID == nil || *f.WorkspaceID != r.ws || f.UploaderID != owner || f.Mime != "image/webp" {
			t.Fatalf("%s file: %+v %v", k, f, err)
		}
		rc, _, err := testStore.Get(ctx, f.Key)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(rc)
		_ = rc.Close()
		if !bytes.Equal(got, pics[firstKey(pics)]) { // every picture was made from the same PNG
			t.Fatalf("%s picture bytes differ", k)
		}
	}
	if final["Both@W1"].file == final["Both@W2"].file {
		t.Fatal("two workspaces share one picture file")
	}
	var usedAfter int64
	if err := d.Pool.QueryRow(ctx, `SELECT storage_used_bytes FROM workspaces WHERE id = $1`, w2).Scan(&usedAfter); err != nil || usedAfter <= usedBefore {
		t.Fatalf("W2 usage %d -> %d (%v)", usedBefore, usedAfter, err)
	}
	var left int
	if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM achievement_legacy_blobs`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("legacy blobs left: %d %v", left, err)
	}
	for key := range pics {
		if _, _, err := testStore.Get(ctx, key); !errors.Is(err, blob.ErrNotFound) {
			t.Fatalf("old blob %s after the migration: %v", key, err)
		}
	}
	// Idempotent: a second run changes nothing.
	if err := newSvc(testStore).MigrateLegacy(ctx); err != nil {
		t.Fatal(err)
	}
	for k, r := range rows() {
		if (r.file == nil) != (final[k].file == nil) || (r.file != nil && *r.file != *final[k].file) {
			t.Fatalf("%s changed on a second run", k)
		}
	}
}

func firstKey(m map[string][]byte) string {
	for k := range m {
		return k
	}
	return ""
}
