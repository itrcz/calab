package users

import (
	"net/http"
	"regexp"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Phone and nickname (ADR-0077).

const maxPhone = 32

var (
	usernameRe = regexp.MustCompile(`^[a-z][a-z0-9_]{2,31}$`)
	phoneRe    = regexp.MustCompile(`^\+?[0-9() -]+$`)
	spacesRe   = regexp.MustCompile(`\s+`)
)

// reservedUsernames cannot be taken by people: mention keywords and names that would pass
// for the product or its staff. Bot usernames are reserved by the shared unique index.
var reservedUsernames = map[string]bool{
	"here": true, "everyone": true, "channel": true, "all": true, "admin": true,
	"support": true, "calab": true, "system": true, "bot": true,
}

// errUsernameInvalid / errUsernameTaken are the PATCH /api/me answers.
func errUsernameInvalid(msg string) *httpx.Error {
	e := httpx.Coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_USERNAME_INVALID, msg)
	e.Field = "username"
	return e
}

func errUsernameTaken() *httpx.Error {
	e := httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_USERNAME_TAKEN, "username is taken")
	e.Field = "username"
	return e
}

// NormalizeUsername lower-cases the name and drops one leading "@" and surrounding spaces.
func NormalizeUsername(s string) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(s), "@"))
}

// ValidateUsername checks a normalized nickname: 3..32 of a-z, 0-9, "_", starting with a
// letter, not reserved.
func ValidateUsername(name string) *httpx.Error {
	if !usernameRe.MatchString(name) {
		return errUsernameInvalid("username must be 3..32 characters of a-z, 0-9 and _, starting with a letter")
	}
	if reservedUsernames[name] {
		return errUsernameInvalid("this username is reserved")
	}
	return nil
}

// NormalizePhone trims the number and collapses runs of spaces; "" = clear.
func NormalizePhone(s string) (string, error) {
	p := spacesRe.ReplaceAllString(strings.TrimSpace(s), " ")
	if p == "" {
		return "", nil
	}
	digits := 0
	for _, r := range p {
		if r >= '0' && r <= '9' {
			digits++
		}
	}
	if len(p) > maxPhone || !phoneRe.MatchString(p) || digits < 3 {
		return "", httpx.Validation("phone", "phone: up to 32 characters of +, digits, spaces and -()")
	}
	return p, nil
}

// usernameAvailable: GET /api/usernames/{name}/available — a hint for the profile form; the
// caller's own nickname is available. Rate limited per user (enumeration of nicknames).
func (h *Handlers) usernameAvailable(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	if h.UsernameLimit != nil {
		if err := h.UsernameLimit.Take(r.Context(), id.UserID.String()); err != nil {
			return err
		}
	}
	name := NormalizeUsername(r.PathValue("name"))
	out := &v1.UsernameAvailabilityResponse{Username: name, Available: true}
	if err := ValidateUsername(name); err != nil {
		out.Available, out.Reason = false, v1.ErrorCode_ERROR_CODE_USERNAME_INVALID
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	owner, err := h.db.Q.UsernameOwner(r.Context(), &name)
	switch {
	case db.IsNotFound(err):
	case err != nil:
		return err
	case owner != id.UserID:
		out.Available, out.Reason = false, v1.ErrorCode_ERROR_CODE_USERNAME_TAKEN
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// usernameColumn maps PATCH /api/me {username} to the column value (nil = clear).
func usernameColumn(raw string) (*string, error) {
	name := NormalizeUsername(raw)
	if name == "" {
		return nil, nil
	}
	if err := ValidateUsername(name); err != nil {
		return nil, err
	}
	return &name, nil
}

// isUsernameConflict reports a unique violation of users.username (409 USERNAME_TAKEN).
func isUsernameConflict(err error) bool {
	return db.UniqueViolation(err) == "users_username_key"
}
