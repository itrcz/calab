// Package users serves the caller's own profile and settings (/api/me) and the caller's
// private notes about other users (/api/users/{id}/note).
package users

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // IANA zones for ValidateTimezone: the distroless image has no zoneinfo
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/birthdays"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/profile"
	"github.com/calaba/calaba/server/internal/rooms"
)

// StatusNotifier announces a custom status change as PRESENCE_UPDATE (the gateway).
type StatusNotifier interface {
	StatusChanged(ctx context.Context, userID uuid.UUID)
}

// Handlers serves /api/me.
type Handlers struct {
	db     *db.DB
	events events.Publisher
	status StatusNotifier
}

// NewHandlers creates the /api/me handlers.
func NewHandlers(d *db.DB, ev events.Publisher, status StatusNotifier) *Handlers {
	return &Handlers{db: d, events: ev, status: status}
}

// Routes registers authenticated routes; wrap must apply auth.
func (h *Handlers) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/me", wrap(httpx.HandlerFunc(h.get)))
	mux.Handle("PATCH /api/me", wrap(httpx.HandlerFunc(h.update)))
	mux.Handle("PATCH /api/me/status", wrap(httpx.HandlerFunc(h.updateStatus)))
	mux.Handle("GET /api/users/{id}/note", wrap(httpx.HandlerFunc(h.getNote)))
	mux.Handle("PUT /api/users/{id}/note", wrap(httpx.HandlerFunc(h.putNote)))
	mux.Handle("DELETE /api/users/{id}/note", wrap(httpx.HandlerFunc(h.deleteNote)))
}

func (h *Handlers) get(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	u, err := h.db.Q.GetUser(r.Context(), id.UserID)
	if err != nil {
		return err
	}
	me, err := pbconv.LocalMe(r.Context(), h.db.Q, u)
	if err != nil {
		return err
	}
	if !id.IsBot && id.Principal.Authority != identitypolicy.LocalAccount {
		me = pbconv.ScopedMe(u)
	}
	httpx.Write(w, http.StatusOK, &v1.GetMeResponse{Me: me})
	return nil
}

func (h *Handlers) update(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	var req v1.UpdateMeRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if cur, err := h.db.Q.GetUser(r.Context(), id.UserID); err != nil {
		return err
	} else if cur.IsGuest && (req.StatusText != nil || req.AvatarFileId != nil || req.Birthday != nil || req.BirthdayHidden != nil || req.EventReminders != nil || req.WorkHours != nil || req.HideMessageTextInNotifications != nil) {
		return httpx.Forbidden("guests can only change their name and settings") // ADR-0016
	}
	if id.IsBot && (req.StatusText != nil || req.Settings != nil || req.Timezone != nil || req.Locale != nil || req.Birthday != nil ||
		req.BirthdayHidden != nil || req.EventReminders != nil || req.WorkHours != nil || req.HideMessageTextInNotifications != nil) {
		return auth.ErrBotNotAllowed // ADR-0031: a bot changes only its name and avatar here
	}
	p := sqlc.UpdateUserParams{ID: id.UserID}
	if req.DisplayName != nil {
		name, err := auth.ValidateDisplayName(req.GetDisplayName())
		if err != nil {
			return err
		}
		p.DisplayName = &name
	}
	if req.StatusText != nil {
		st := strings.TrimSpace(req.GetStatusText())
		if utf8.RuneCountInString(st) > 128 {
			return httpx.Validation("statusText", "status text must be at most 128 characters")
		}
		p.StatusText = &st
	}
	if req.AvatarFileId != nil {
		p.SetAvatar = true
		if s := req.GetAvatarFileId(); s != "" {
			fid, err := uuid.Parse(s)
			if err != nil {
				return httpx.Validation("avatarFileId", "invalid file id")
			}
			if err := files.ValidateOwnImage(r.Context(), h.db.Q, fid, id.UserID, nil); err != nil {
				if files.IsBadImage(err) {
					return httpx.Validation("avatarFileId", "must be an image you uploaded")
				}
				return err
			}
			p.AvatarFileID = &fid
		}
	}
	if req.Timezone != nil {
		p.SetTimezone = true
		if tz := strings.TrimSpace(req.GetTimezone()); tz != "" {
			if err := ValidateTimezone(tz); err != nil {
				return err
			}
			p.Timezone = &tz
		}
	}
	if req.Locale != nil { // language of emails (ADR-0023); private, like settings
		p.SetLocale = true
		if tag := strings.TrimSpace(req.GetLocale()); tag != "" {
			l := mail.Supported(tag)
			if l == "" {
				return httpx.Validation("locale", "supported languages: en, ru, es, zh-CN")
			}
			p.Locale = &l
		}
	}
	if b := req.GetBirthday(); b != nil { // docs/09 #76
		p.SetBirthday = true
		var err error
		if p.BirthdayDay, p.BirthdayMonth, p.BirthdayYear, err = birthdays.Columns(b, time.Now()); err != nil {
			return err
		}
	}
	p.BirthdayHidden = req.BirthdayHidden
	p.HideMessageTextInNotifications = req.HideMessageTextInNotifications
	if req.Settings != nil {
		st := req.GetSettings()
		if st.AudioBitrateKbps != nil && !rooms.ValidAudioBitrate(st.GetAudioBitrateKbps()) {
			return httpx.Validation("settings.audioBitrateKbps", rooms.AudioBitrateError)
		}
		b, err := pbconv.EncodeSettings(st)
		if err != nil {
			return err
		}
		p.Settings = b
	}
	var reminders []int16
	if er := req.GetEventReminders(); er != nil { // ADR-0038 §5
		var err error
		if reminders, err = eventReminders(er.GetMinutes()); err != nil {
			return err
		}
	}
	var workStart, workEnd int16
	var workDays []int16
	if wh := req.GetWorkHours(); wh != nil { // ADR-0041
		var err error
		if workStart, workEnd, workDays, err = calendar.ValidateWorkHours(wh); err != nil {
			return err
		}
	}
	u, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.User, error) { return guarded.UpdateUser(r.Context(), p) })
	if db.IsForeignKeyViolation(err) {
		return httpx.Validation("avatarFileId", "file not found")
	}
	if err != nil {
		return err
	}
	if er := req.GetEventReminders(); er != nil {
		if u, err = db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.User, error) {
			return guarded.SetUserEventReminders(r.Context(), sqlc.SetUserEventRemindersParams{
				ID: id.UserID, EventReminders: reminders, EventRemindersDnd: er.GetDnd(),
			})
		}); err != nil {
			return err
		}
	}
	if req.GetWorkHours() != nil {
		if u, err = db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.User, error) {
			return guarded.SetUserWorkHours(r.Context(), sqlc.SetUserWorkHoursParams{
				ID: id.UserID, WorkStartMin: workStart, WorkEndMin: workEnd, WorkDays: workDays,
			})
		}); err != nil {
			return err
		}
	}
	public := req.DisplayName != nil || req.StatusText != nil || req.AvatarFileId != nil || req.Timezone != nil ||
		req.Birthday != nil || req.BirthdayHidden != nil
	profile.Publish(r.Context(), h.db.Q, h.events, u, public)
	httpx.Write(w, http.StatusOK, &v1.UpdateMeResponse{Me: pbconv.Me(u)})
	return nil
}

// eventReminders validates meeting reminder minutes: ≤ 5 distinct values of
// calendar.ReminderChoices, stored largest first.
func eventReminders(in []uint32) ([]int16, error) {
	out := make([]int16, 0, len(in))
	for _, m := range in {
		if !slices.Contains(calendar.ReminderChoices, int(m)) { //nolint:gosec // compared, not converted back
			return nil, httpx.Validation("eventReminders.minutes", "reminders are 5, 10, 15, 30, 60, 120 or 1440 minutes")
		}
		if !slices.Contains(out, int16(m)) { //nolint:gosec // ≤ 1440
			out = append(out, int16(m)) //nolint:gosec // ≤ 1440
		}
	}
	if len(out) > 5 {
		return nil, httpx.Validation("eventReminders.minutes", "at most 5 reminders")
	}
	slices.SortFunc(out, func(a, b int16) int { return int(b) - int(a) })
	return out, nil
}

// Custom status limits.
const maxStatusTTL = 30 * 24 * time.Hour

// updateStatus: PATCH /api/me/status — sets or clears (empty text and emoji) the custom status.
func (h *Handlers) updateStatus(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	var req v1.UpdateStatusRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if cur, err := h.db.Q.GetUser(r.Context(), id.UserID); err != nil {
		return err
	} else if cur.IsGuest {
		return httpx.Forbidden("not available for guest accounts")
	}
	text := strings.TrimSpace(req.GetText())
	if utf8.RuneCountInString(text) > 128 {
		return httpx.Validation("text", "status text must be at most 128 characters")
	}
	emoji := req.GetEmoji()
	if emoji != "" && (len(emoji) > 32 || !messages.ValidEmoji(emoji)) {
		return httpx.Validation("emoji", "not an emoji")
	}
	var expires *time.Time
	if s := req.GetExpiresInSeconds(); s > 0 {
		d := time.Duration(s) * time.Second
		if d > maxStatusTTL {
			return httpx.Validation("expiresInSeconds", "status can expire in at most 30 days")
		}
		t := time.Now().Add(d)
		expires = &t
	}
	if text == "" && emoji == "" {
		expires = nil
	}
	u, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.User, error) {
		return guarded.UpdateStatus(r.Context(), sqlc.UpdateStatusParams{ID: id.UserID, StatusText: text, StatusEmoji: emoji, StatusExpiresAt: expires})
	})
	if err != nil {
		return err
	}
	profile.Publish(r.Context(), h.db.Q, h.events, u, true)
	if h.status != nil {
		h.status.StatusChanged(r.Context(), id.UserID)
	}
	httpx.Write(w, http.StatusOK, &v1.UpdateMeResponse{Me: pbconv.Me(u)})
	return nil
}

// ValidateTimezone accepts IANA zone names ("Europe/Moscow", "UTC"); the zone database is
// embedded (time/tzdata, imported here), so this works in the distroless image too. "Local"
// and paths are rejected: the name must mean the same on every machine.
func ValidateTimezone(tz string) error {
	bad := len(tz) > 64 || tz == "Local"
	// IANA names are capitalized per segment ("America/Argentina/Buenos_Aires", "Etc/GMT+3");
	// checking that keeps validation independent of a case-insensitive file system (macOS)
	// and rules out paths.
	for _, seg := range strings.Split(tz, "/") {
		bad = bad || seg == "" || seg[0] < 'A' || seg[0] > 'Z'
	}
	if bad {
		return httpx.Validation("timezone", "timezone must be an IANA time zone name, e.g. Europe/Moscow")
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return httpx.Validation("timezone", "unknown time zone "+strconv.Quote(tz))
	}
	return nil
}
