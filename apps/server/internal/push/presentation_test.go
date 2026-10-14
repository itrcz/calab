package push

import (
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPreviewTextBoundsAndControls(t *testing.T) {
	if got := previewLine("  Илья\n\tПривет\x00\u202e  👩‍💻 ", 240); got != "Илья Привет 👩‍💻" {
		t.Fatalf("preview: %q", got)
	}
	got := previewLine(strings.Repeat("я", 300), 240)
	if !utf8.ValidString(got) || utf8.RuneCountInString(got) != 240 || !strings.HasSuffix(got, "…") {
		t.Fatal("unbounded or broken Unicode preview")
	}
}
func TestAttachmentPreviewsNeverExposeStorageDetails(t *testing.T) {
	ru := "ru"
	duration := int32(1234)
	sticker := uuid.New()
	for _, tc := range []struct {
		name    string
		message sqlc.Message
		files   []sqlc.ListAttachmentsRow
		locale  *string
		want    string
	}{
		{name: "plain fallback", want: "New message"},
		{name: "sticker", message: sqlc.Message{StickerID: &sticker}, locale: &ru, want: "Стикер"},
		{name: "voice", files: []sqlc.ListAttachmentsRow{{File: sqlc.File{VoiceDurationMs: &duration, Key: "private-key"}}}, locale: &ru, want: "Голосовое сообщение"},
		{name: "image", files: []sqlc.ListAttachmentsRow{{File: sqlc.File{Mime: "image/png", Name: "secret.png"}}}, want: "Photo"},
		{name: "file", files: []sqlc.ListAttachmentsRow{{File: sqlc.File{Name: "secret.pdf"}}}, want: "File"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := attachmentPreview(tc.message, tc.files, tc.locale); got != tc.want {
				t.Fatalf("preview %q", got)
			}
		})
	}
}

func TestPreviewMentionsDoNotExposeWireIDsOrLookupForeignProfiles(t *testing.T) {
	ru := "ru"
	recipient := sqlc.User{ID: uuid.New(), DisplayName: "Данис", Locale: &ru}
	foreign := uuid.NewString()
	got := messagePreview("Привет @"+recipient.ID.String()+" и @"+foreign, recipient)
	if got != "Привет @Данис и @участник" {
		t.Fatalf("preview: %q", got)
	}
}
