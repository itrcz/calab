package push

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/blob/blobtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
)

func TestAvatarPrivateThumbnailBoundsCacheAndFallback(t *testing.T) {
	store := blobtest.New()
	a := NewAvatars(store)
	key := "avatar/thumb"
	f := sqlc.File{ID: uuid.New(), Sha256: "original", ThumbnailKey: &key}
	src := image.NewRGBA(image.Rect(0, 0, 256, 128))
	for y := 0; y < 128; y++ {
		for x := 0; x < 256; x++ {
			src.Set(x, y, color.RGBA{uint8(x), uint8(y), 50, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, src); err != nil {
		t.Fatal(err)
	}
	store.Set(key, buf.Bytes())
	// Conversion must be correct independently of a loaded CI runner's wall clock.
	value := a.pictureWithinBudget(context.Background(), f)
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(raw) == 0 || len(raw) > maxAvatarBytes {
		t.Fatalf("avatar not bounded JPEG: %d %v", len(raw), err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width > 64 || cfg.Height > 64 {
		t.Fatal("avatar dimensions", cfg, err)
	}
	store.Fail(errors.New("storage offline"))
	if a.picture(context.Background(), f) != value {
		t.Fatal("immutable thumbnail was not cached")
	}
	f.ID = uuid.New()
	if a.picture(context.Background(), f) != "" {
		t.Fatal("failed new avatar must fall back to text")
	}
	store.Fail(nil)
	store.Set(key, []byte("not an image"))
	if a.picture(context.Background(), f) != "" {
		t.Fatal("malformed avatar accepted")
	}
	buf.Reset()
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1024, 1))); err != nil {
		t.Fatal(err)
	}
	store.Set(key, buf.Bytes())
	if a.picture(context.Background(), f) != "" {
		t.Fatal("oversized image decoded")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if a.picture(ctx, f) != "" {
		t.Fatal("canceled work continued")
	}
}

func TestPresentationIdentifiersAreStableAndAccountScoped(t *testing.T) {
	binding, room := uuid.NewString(), uuid.NewString()
	one := presentationID(binding, room)
	if len(one) != 64 || one != presentationID(binding, room) || one == presentationID(uuid.NewString(), room) || one == presentationID(binding, uuid.NewString()) {
		t.Fatal("presentation identity leaked across accounts/conversations")
	}
}

func TestAPNSAvatarFallsBackBeforePayloadLimit(t *testing.T) {
	p := providerPayload()
	p.Kind = "message"
	p.PersonID = strings.Repeat("a", 64)
	p.ConversationID = strings.Repeat("b", 64)
	p.AvatarJPEG = strings.Repeat("a", 2048)
	aps := map[string]any{"alert": map[string]string{"title": strings.Repeat("<", 80), "body": strings.Repeat("<", 240)}, "thread-id": p.ConversationID, "mutable-content": 1}
	body, err := apnsBody(p, aps)
	if err != nil || len(body) > 4096 {
		t.Fatal("oversized notification", len(body), err)
	}
	var decoded struct {
		Payload
		APS map[string]any `json:"aps"`
	}
	if err = json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.AvatarJPEG != "" || decoded.Binding != p.Binding || decoded.APS["thread-id"] != p.ConversationID {
		t.Fatal("picture fallback damaged routing/grouping")
	}
	aps["alert"] = map[string]string{"title": "Илья", "body": "Привет"}
	body, err = apnsBody(p, aps)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(body, &decoded); err != nil || decoded.AvatarJPEG != p.AvatarJPEG {
		t.Fatal("ordinary avatar missing")
	}
}

type waitingAvatarStore struct {
	blob.Store
	expired bool
}

func (s *waitingAvatarStore) Get(ctx context.Context, _ string) (blob.ReadSeekCloser, blob.Meta, error) {
	if _, bounded := ctx.Deadline(); !bounded {
		return nil, blob.Meta{}, errors.New("missing deadline")
	}
	<-ctx.Done()
	s.expired = errors.Is(ctx.Err(), context.DeadlineExceeded)
	return nil, blob.Meta{}, ctx.Err()
}
func TestAvatarSlowStorageUsesTextFallback(t *testing.T) {
	store := &waitingAvatarStore{}
	key := "avatar/slow"
	f := sqlc.File{ID: uuid.New(), ThumbnailKey: &key}
	if NewAvatars(store).picture(context.Background(), f) != "" || !store.expired {
		t.Fatal("avatar lookup did not enforce its short delivery budget")
	}
}
