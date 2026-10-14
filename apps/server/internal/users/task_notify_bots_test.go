package users

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/httpx"
)

func TestParseTaskNotifyBots(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	got, err := parseTaskNotifyBots([]string{a.String(), b.String(), a.String()})
	if err != nil || len(got) != 2 || got[0] != a || got[1] != b {
		t.Fatalf("parse = %v, %v", got, err)
	}
	if got, err := parseTaskNotifyBots(nil); err != nil || len(got) != 0 {
		t.Fatalf("empty = %v, %v", got, err)
	}
	many := make([]string, MaxTaskNotifyBots+1)
	for i := range many {
		many[i] = uuid.NewString()
	}
	ten := many[:MaxTaskNotifyBots]
	if _, err := parseTaskNotifyBots(ten); err != nil {
		t.Fatalf("10 bots: %v", err)
	}
	for name, in := range map[string][]string{
		"not a uuid": {"opsa"},
		"nil uuid":   {uuid.Nil.String()},
		"too many":   many,
	} {
		_, err := parseTaskNotifyBots(in)
		var e *httpx.Error
		if !errors.As(err, &e) || e.Status != http.StatusUnprocessableEntity || e.Reason != ReasonTaskNotifyBotUnavailable ||
			!strings.HasPrefix(e.Field, "taskNotifyBots") {
			t.Errorf("%s: %v", name, err)
		}
	}
}
