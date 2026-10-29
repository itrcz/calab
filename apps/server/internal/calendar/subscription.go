package calendar

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
)

const subscriptionPurpose = "calab/calendar-subscription/v1"

func subscriptionToken(secret []byte, id uuid.UUID) string {
	key := hmac.New(sha256.New, secret)
	_, _ = key.Write([]byte(subscriptionPurpose))
	mac := hmac.New(sha256.New, key.Sum(nil))
	_, _ = mac.Write(id[:])
	return id.String() + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func parseSubscriptionToken(secret []byte, raw string) (uuid.UUID, error) {
	if len(raw) != 80 {
		return uuid.Nil, httpx.NotFound("calendar subscription")
	}
	id, err := uuid.Parse(raw[:36])
	if err != nil || id == uuid.Nil || !hmac.Equal([]byte(raw), []byte(subscriptionToken(secret, id))) {
		return uuid.Nil, httpx.NotFound("calendar subscription")
	}
	return id, nil
}

func calendarHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (s *Service) subscriptionGrant(id uuid.UUID) (*v1.CalendarSubscription, error) {
	base, err := url.Parse(s.cfg.PublicURL)
	if err != nil || base.Scheme != "https" || base.Host == "" || base.User != nil {
		return nil, httpx.Unavailable(errors.New("calendar subscription requires a public HTTPS origin"))
	}
	base.Path, base.RawPath, base.Fragment = "/api/calendar-feed.ics", "", ""
	base.RawQuery = url.Values{"t": {subscriptionToken(s.cfg.Secret, id)}}.Encode()
	feed := base.String()
	base.Scheme = "webcal"
	webcal := base.String()
	base.Scheme, base.Path = "https", "/api/calendar-connect"
	return &v1.CalendarSubscription{FeedUrl: feed, WebcalUrl: webcal, ConnectUrl: base.String()}, nil
}

// The public capability is not a substitute for organization sign-in. In enforced
// workspaces it is disabled, even when its owner currently has a valid SSO session.
func (s *Service) exportAllowed(ctx context.Context, user, ws uuid.UUID, public bool) error {
	if s.CheckBillingOpen != nil {
		if err := s.CheckBillingOpen(ctx, s.db.Q, ws); err != nil {
			return err
		}
	}
	if public {
		if err := auth.CheckPublicCapability(ctx, s.db.Q, ws); err != nil {
			var apiErr *httpx.Error
			if errors.As(err, &apiErr) && apiErr.Code == v1.ErrorCode_ERROR_CODE_SSO_REQUIRED {
				// A valid SSO session cannot authorize a persistent bearer feed. Do not
				// send SSO_REQUIRED to the renderer and trigger an endless sign-in loop.
				return httpx.Forbidden("calendar subscription disabled by organization policy").WithDetails("CALENDAR_SUBSCRIPTION_SSO", 0, 0)
			}
			return err
		}
	}
	ok, err := s.mayDeliver(ctx, user, ws)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound("calendar")
	}
	space, err := s.db.Q.GetWorkspace(ctx, ws)
	if err != nil {
		return err
	}
	if space.SuspendedAt != nil {
		return httpx.NotFound("calendar")
	}
	return nil
}

func (s *Service) manageSubscription(w http.ResponseWriter, r *http.Request) error {
	calendarHeaders(w)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	id := auth.MustFromContext(ctx)
	if id.Machine() {
		return httpx.Forbidden("human session required")
	}
	ws, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if _, err = requestViewer(r, ws, s.db.Q); err != nil {
		return err
	}
	// Revocation remains available even if policy now prevents creating a link.
	if r.Method == http.MethodDelete {
		if err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
			return q.DeleteCalendarSubscription(ctx, sqlc.DeleteCalendarSubscriptionParams{WorkspaceID: ws, UserID: id.UserID})
		}); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	if err := s.exportAllowed(ctx, id.UserID, ws, true); err != nil {
		return err
	}
	if _, err := s.subscriptionGrant(uuid.New()); err != nil {
		return err
	}
	var sub sqlc.CalendarSubscription
	switch r.Method {
	case http.MethodGet:
		sub, err = s.db.Q.GetCalendarSubscription(ctx, sqlc.GetCalendarSubscriptionParams{WorkspaceID: ws, UserID: id.UserID})
		if db.IsNotFound(err) {
			httpx.Write(w, http.StatusOK, &v1.CalendarSubscription{})
			return nil
		}
	case http.MethodPost:
		if err = s.writes.Take(ctx, id.UserID.String()); err != nil {
			return err
		}
		err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
			var e error
			sub, e = q.ActivateCalendarSubscription(ctx, sqlc.ActivateCalendarSubscriptionParams{ID: uuid.New(), WorkspaceID: ws, UserID: id.UserID})
			return e
		})
	case http.MethodPut:
		if err = s.writes.Take(ctx, id.UserID.String()); err != nil {
			return err
		}
		err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
			var e error
			sub, e = q.RotateCalendarSubscription(ctx, sqlc.RotateCalendarSubscriptionParams{NewID: uuid.New(), WorkspaceID: ws, UserID: id.UserID})
			return e
		})
	}
	if db.IsNotFound(err) {
		return httpx.NotFound("calendar subscription")
	}
	if err != nil {
		return err
	}
	grant, err := s.subscriptionGrant(sub.ID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, grant)
	return nil
}

func (s *Service) publicSubscription(r *http.Request) (sqlc.CalendarSubscription, error) {
	var empty sqlc.CalendarSubscription
	id, err := parseSubscriptionToken(s.cfg.Secret, r.URL.Query().Get("t"))
	if err != nil {
		return empty, err
	}
	if s.SubscriptionReads != nil {
		if err := s.SubscriptionReads.Take(r.Context(), id.String()); err != nil {
			return empty, err
		}
	}
	sub, err := s.db.Q.GetCalendarSubscriptionByID(r.Context(), id)
	if db.IsNotFound(err) {
		return empty, httpx.NotFound("calendar subscription")
	}
	if err != nil {
		return empty, err
	}
	if err = s.exportAllowed(r.Context(), sub.UserID, sub.WorkspaceID, true); err != nil {
		return empty, err
	}
	return sub, nil
}

func (s *Service) calendarFeed(w http.ResponseWriter, r *http.Request) error {
	calendarHeaders(w)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	sub, err := s.publicSubscription(r)
	if err != nil {
		return err
	}
	now := s.Now()
	contents, err := s.calendarContents(ctx, sub.UserID, sub.WorkspaceID, now.AddDate(0, 0, -30), now.AddDate(0, 0, 365))
	if err != nil {
		return err
	}
	return writeCalendar(w, contents, false)
}

func (s *Service) downloadCalendar(w http.ResponseWriter, r *http.Request) error {
	calendarHeaders(w)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	id := auth.MustFromContext(ctx)
	if id.Machine() {
		return httpx.Forbidden("human session required")
	}
	ws, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if _, err = requestViewer(r, ws, s.db.Q); err != nil {
		return err
	}
	if err = s.exportAllowed(ctx, id.UserID, ws, false); err != nil {
		return err
	}
	from, e1 := time.Parse(time.RFC3339, r.URL.Query().Get("from"))
	to, e2 := time.Parse(time.RFC3339, r.URL.Query().Get("to"))
	if e1 != nil || e2 != nil || !to.After(from) || to.Sub(from) > 400*24*time.Hour {
		return httpx.Validation("from", "choose a valid range of at most 400 days")
	}
	contents, err := s.calendarContents(ctx, id.UserID, ws, from, to)
	if err != nil {
		return err
	}
	return writeCalendar(w, contents, true)
}

func (s *Service) downloadEvent(w http.ResponseWriter, r *http.Request) error {
	calendarHeaders(w)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	id := auth.MustFromContext(r.Context())
	if id.Machine() {
		return httpx.Forbidden("human session required")
	}
	b, _, err := s.event(r, s.db.Q)
	if err != nil {
		return err
	}
	if b.ev.CancelledAt != nil {
		return httpx.NotFound("event")
	}
	if err = s.exportAllowed(r.Context(), id.UserID, b.ev.WorkspaceID, false); err != nil {
		return err
	}
	return writeCalendar(w, buildCalendarICS(b.ev.Title, []ICSEvent{s.exportEvent(b)}, s.Now()), true)
}

func (s *Service) exportEvent(b *bundle) ICSEvent {
	return ICSEvent{UID: b.ev.ID.String() + "@calab", Sequence: int(b.ev.Sequence), Series: b.series, Title: b.ev.Title, Description: b.ev.Description, URL: s.eventURL(b.ev.ID), Stamp: b.ev.UpdatedAt}
}

func (s *Service) calendarContents(ctx context.Context, user, ws uuid.UUID, from, to time.Time) (string, error) {
	evs, err := s.db.Q.ListCalendarExportEvents(ctx, sqlc.ListCalendarExportEventsParams{WorkspaceID: ws, UserID: user, From: from, To: to})
	if err != nil {
		return "", err
	}
	if len(evs) > 1000 {
		return "", httpx.Unavailable(errors.New("calendar export candidate limit"))
	}
	bundles, err := load(ctx, s.db.Q, evs)
	if err != nil {
		return "", err
	}
	events := make([]ICSEvent, 0, len(bundles))
	for _, b := range bundles {
		if !busyIn(b, user) || len(b.series.Between(from, to)) == 0 {
			continue
		}
		events = append(events, s.exportEvent(b))
	}
	space, err := s.db.Q.GetWorkspace(ctx, ws)
	if err != nil {
		return "", err
	}
	result := buildCalendarICS("Calab · "+space.Name, events, to)
	if len(result) > 8<<20 {
		return "", httpx.Unavailable(errors.New("calendar export size limit"))
	}
	return result, nil
}

func writeCalendar(w http.ResponseWriter, contents string, download bool) error {
	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	disposition := "inline"
	if download {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", disposition+`; filename="calab.ics"`)
	_, err := fmt.Fprint(w, contents) // #nosec G705 -- RFC 5545 text/calendar, nosniff; escaped text properties, never HTML.
	return err
}

var calendarConnectTemplate = template.Must(template.New("connect").Parse(`<!doctype html>
<html lang="{{.Lang}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Calab Calendar</title><style>
:root{color-scheme:light dark}body{font:17px/1.5 system-ui;margin:0;background:Canvas;color:CanvasText}main{max-width:32rem;margin:8vh auto;padding:24px}h1{font-size:28px}a{display:block;padding:14px 20px;background:#0071e3;color:white;border-radius:24px;text-align:center;text-decoration:none}p{margin:20px 0}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid GrayText;border-radius:12px;font:inherit}small{display:block;margin-top:20px}
</style></head><body><main><h1>{{.Title}}</h1><p>{{.Intro}}</p><a href="{{.Webcal}}">{{.Button}}</a><p>{{.Other}}</p><label for="feed">{{.Link}}</label><input id="feed" readonly value="{{.Feed}}"><small>{{.Private}}</small></main></body></html>`))

func (s *Service) calendarConnect(w http.ResponseWriter, r *http.Request) error {
	calendarHeaders(w)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	sub, err := s.publicSubscription(r.WithContext(ctx))
	if err != nil {
		return err
	}
	grant, err := s.subscriptionGrant(sub.ID)
	if err != nil {
		return err
	}
	page := struct {
		Lang, Title, Intro, Button, Other, Link, Private, Feed string
		Webcal                                                 template.URL
	}{
		Lang: "en", Title: "Calab Calendar", Intro: "Your Calab meetings in your phone's calendar. Updates arrive automatically; refresh timing depends on your calendar app.", Button: "Add to Apple Calendar", Other: "For Google Calendar, add the link using Other calendars → From URL on a computer.", Link: "Calendar link", Private: "This private link gives read access to your meetings. You can disable it in Calab. Edit meetings in Calab.", Feed: grant.FeedUrl,
		Webcal: template.URL(grant.WebcalUrl), // #nosec G203 -- fixed scheme, configured HTTPS origin and signed capability, no user HTML.
	}
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Accept-Language")), "ru") {
		page.Lang = "ru"
		page.Title = "Календарь Calab"
		page.Intro = "Ваши встречи Calab в календаре телефона. Изменения появляются автоматически; скорость обновления зависит от приложения календаря."
		page.Button = "Добавить в Apple Календарь"
		page.Other = "Для Google Календаря добавьте ссылку на компьютере: Другие календари → Добавить по URL."
		page.Link = "Ссылка календаря"
		page.Private = "Ссылка даёт доступ к вашим встречам. Отключить её можно в Calab. Редактируйте встречи в Calab."
	}
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Accept-Language")), "es") {
		page.Lang = "es"
		page.Title = "Calendario de Calab"
		page.Intro = "Tus reuniones de Calab en el calendario del teléfono. La frecuencia de actualización depende de tu aplicación."
		page.Button = "Añadir a Calendario de Apple"
		page.Other = "Google Calendar: en un ordenador, abre Otros calendarios → Desde URL y añade el enlace."
		page.Link = "Enlace del calendario"
		page.Private = "Este enlace privado permite leer tus reuniones. Puedes desactivarlo en Calab. Edita las reuniones en Calab."
	}
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Accept-Language")), "zh") {
		page.Lang = "zh-CN"
		page.Title = "Calab 日历"
		page.Intro = "在手机日历中查看您的 Calab 会议。更新频率取决于日历应用。"
		page.Button = "添加到 Apple 日历"
		page.Other = "Google 日历：在电脑上打开其他日历 → 通过网址，添加此链接。"
		page.Link = "日历链接"
		page.Private = "此私人链接可读取您的会议。您可以在 Calab 中停用链接。请在 Calab 中编辑会议。"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	return calendarConnectTemplate.Execute(w, page)
}
