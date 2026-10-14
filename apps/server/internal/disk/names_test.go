package disk

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCleanName(t *testing.T) {
	for in, want := range map[string]string{" Report.pdf ": "Report.pdf", "Папка": "Папка", strings.Repeat("я", 255): strings.Repeat("я", 255)} {
		if got, err := cleanName(in); err != nil || got != want {
			t.Errorf("cleanName(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "  ", ".", "..", "a/b", `a\b`, "a\x00b", strings.Repeat("я", 256)} {
		if _, err := cleanName(bad); err == nil {
			t.Errorf("cleanName(%q) accepted", bad)
		}
	}
}

func TestCursorRoundTrip(t *testing.T) {
	c := cursor{Rank: 1, Name: "отчёт", Size: 42, Updated: time.Unix(1700000000, 5).UTC(), ID: uuid.New()}
	got, err := decodeCursor(c.encode())
	if err != nil || *got != c {
		t.Fatalf("round trip %v %v", got, err)
	}
	for _, bad := range []string{"%%", "e30", "bm90LWpzb24"} {
		if _, err := decodeCursor(bad); err == nil {
			t.Errorf("decodeCursor(%q) accepted", bad)
		}
	}
}
