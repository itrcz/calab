package calendar

import (
	"context"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// Invitations (ADR-0038 §4, «Дополнение»): one mail per attendee with an address — members with
// a confirmed address, external attendees always — with invite.ics (METHOD REQUEST / CANCEL,
// UID <id>@calab, SEQUENCE). External attendees also get the signed answer links and, with a
// room, their guest link. Mail is best-effort: a refused mail (rate limit, no SMTP) is logged.

// mailTTL: an invitation not delivered within a day is dropped.
const mailTTL = mail.MaxRetry

// contentFreeTitle stands for the meeting title and organizer in mails of an enforced-SSO
// workspace (the product name, not a translation).
const contentFreeTitle = "Calab"

func (s *Service) eventURL(id uuid.UUID) string {
	return strings.TrimRight(s.cfg.PublicURL, "/") + "/e/" + id.String()
}

func (s *Service) guestURL(code string) string {
	return strings.TrimRight(s.cfg.PublicURL, "/") + "/r/" + code
}

// viewURL is the meeting link of an external attendee's mail («Диплинки для приглашённых»):
// /e/<id>?t=<view token>, valid until the end of the meeting (series) + 1 h like its guest link.
func (s *Service) viewURL(b *bundle, email string) string {
	tok := signRSVP(s.key, rsvpClaims{Event: b.ev.ID, Status: statusView, Email: email, Exp: s.tokenExpiry(b).Add(guestLinkAfter)})
	return s.eventURL(b.ev.ID) + "?t=" + url.QueryEscape(tok)
}

// usableLink returns the guest link of the external attendee a, unless revoked.
func (s *Service) usableLink(ctx context.Context, b *bundle, a sqlc.EventAttendee) (sqlc.RoomInvite, bool) {
	if a.InviteID == nil || b.ev.RoomID == nil {
		return sqlc.RoomInvite{}, false
	}
	inv, err := s.db.Q.GetRoomInvite(ctx, *a.InviteID)
	return inv, err == nil && inv.RevokedAt == nil
}

// sendMails queues tmpl to the recipients among `to` — narrowed by mailRecipients (recipients.go)
// to attendees of b, without the organizer for a REQUEST and only the unanswered for an
// invitation: no caller can mail a stranger or invite the organizer to their own meeting.
func (s *Service) sendMails(ctx context.Context, b *bundle, tmpl mail.Template, method string, to []sqlc.EventAttendee) {
	to = mailRecipients(b, tmpl, to)
	if !s.mail.Enabled() || len(to) == 0 {
		return
	}
	ids := []uuid.UUID{b.ev.OrganizerID}
	for _, a := range b.att {
		if a.UserID != nil {
			ids = append(ids, *a.UserID)
		}
	}
	for _, a := range to {
		if a.UserID != nil {
			ids = append(ids, *a.UserID)
		}
	}
	rows, err := s.db.Q.ListEventUsers(ctx, ids)
	if err != nil {
		logErr(ctx, "mail: users", err)
		return
	}
	users := make(map[uuid.UUID]sqlc.ListEventUsersRow, len(rows))
	for _, u := range rows {
		users[u.ID] = u
	}
	org := users[b.ev.OrganizerID]
	orgName := func(string) string { return org.DisplayName }
	icsOrg := org
	if org.IsBot {
		// ADR-0051: the workspace sends on behalf of the bot (the system address, no Reply-To);
		// outside recipients get the language of the bot's owner.
		wsName, bot := "", org.DisplayName
		if ws, err := s.db.Q.GetWorkspace(ctx, b.ev.WorkspaceID); err == nil {
			wsName = ws.Name
		}
		if row, err := s.db.Q.GetBot(ctx, org.ID); err == nil {
			if owner, err := s.db.Q.GetUser(ctx, row.OwnerUserID); err == nil {
				org.Locale = owner.Locale
			}
		}
		orgName = func(locale string) string { return mail.OnBehalfOfBot(locale, wsName, bot) }
		icsOrg.DisplayName = wsName
	}
	roomName := ""
	if b.ev.RoomID != nil {
		if r, err := s.db.Q.GetRoom(ctx, *b.ev.RoomID); err == nil {
			roomName = r.Name
		}
	}
	occ, ok := b.series.Next(s.Now(), lookAhead)
	if !ok {
		occ = Occurrence{b.series.Start, b.series.End}
	}
	ics := BuildICS(s.icsEvent(b, method, users, icsOrg, roomName, "", s.eventURL(b.ev.ID)))
	var names, members []string
	for _, a := range b.att {
		if a.UserID != nil {
			names = append(names, users[*a.UserID].DisplayName)
			members = append(members, users[*a.UserID].DisplayName)
		} else {
			names = append(names, deref(a.Email))
		}
	}
	// Enforced SSO (ADR-0054): the mail leaves the IdP's control, so it carries no meeting
	// details — no title, organizer, room, attendees or invite.ics, only the time and the
	// meeting link, which needs the organization's sign-in to open.
	free := s.contentFree(ctx, b.ev.WorkspaceID)
	queued := 0
	for _, a := range to {
		addr, locale, loc := "", mail.LocaleEN, b.series.Loc
		if a.UserID != nil {
			u, ok := users[*a.UserID]
			if !ok || u.Email == nil || u.EmailVerifiedAt == nil || u.IsBot || u.IsGuest {
				continue // no confirmed address: no mail
			}
			addr = *u.Email
			if u.Locale != nil {
				locale = *u.Locale
			}
			if u.Timezone != nil {
				loc = loadZone(*u.Timezone)
			}
		} else {
			addr = deref(a.Email)
			if org.Locale != nil {
				locale = *org.Locale
			}
		}
		attendees, invite, link := strings.Join(names, ", "), ics, s.eventURL(b.ev.ID)
		if a.UserID == nil {
			// An outside recipient sees colleagues by name only and no other outside address:
			// its invite.ics lists the organizer and its own line (RFC 5546 needs no more). Its
			// meeting link carries a view token: it has no account to open /e/<id> with.
			own := deref(a.Email)
			attendees = strings.Join(append(slices.Clone(members), own), ", ")
			link = s.viewURL(b, own)
			invite = BuildICS(s.icsEvent(b, method, users, icsOrg, roomName, own, link))
		}
		date, when := formatWhen(locale, occ, b.ev.AllDay, loc)
		if free {
			p := mail.Params{"title": contentFreeTitle, "date": date, "when": when, "organizer": contentFreeTitle, "url": s.eventURL(b.ev.ID)}
			if err := s.mail.Enqueue(ctx, nil, mail.Mail{To: addr, Template: tmpl, Locale: locale, Params: p, Priority: mail.PriorityNotice, TTL: mailTTL}); err != nil {
				logErr(ctx, "mail: enqueue", err)
				continue
			}
			queued++
			continue
		}
		p := mail.Params{
			"title": b.ev.Title, "date": date, "when": when, "organizer": orgName(locale), "url": link,
			"room": roomName, "repeat": repeatText(locale, b.series.Rule.Repeat), "attendees": attendees,
			mail.ParamICS: invite, mail.ParamICSMethod: method,
		}
		if org.Email != nil && org.EmailVerifiedAt != nil { // an unconfirmed address proves nothing
			p[mail.ParamReplyTo] = *org.Email
		}
		if a.UserID == nil && method == MethodRequest {
			s.externalLinks(ctx, b, a, p)
		}
		err := s.mail.Enqueue(ctx, nil, mail.Mail{To: addr, Template: tmpl, Locale: locale, Params: p, Priority: mail.PriorityNotice, TTL: mailTTL})
		if err != nil {
			logErr(ctx, "mail: enqueue", err)
			continue
		}
		queued++
	}
	if queued > 0 {
		s.mail.Wake()
	}
}

// externalLinks adds the signed answer links and the guest link of an external attendee.
func (s *Service) externalLinks(ctx context.Context, b *bundle, a sqlc.EventAttendee, p mail.Params) {
	exp := s.tokenExpiry(b)
	base := s.eventURL(b.ev.ID) + "/rsvp?t="
	for param, st := range map[string]string{"rsvp_accept": StatusAccepted, "rsvp_decline": StatusDeclined, "rsvp_maybe": StatusMaybe} {
		p[param] = base + url.QueryEscape(signRSVP(s.key, rsvpClaims{Event: b.ev.ID, Status: st, Email: deref(a.Email), Exp: exp}))
	}
	if inv, ok := s.usableLink(ctx, b, a); ok {
		p["guest_url"] = s.guestURL(inv.Code)
	}
}

// tokenExpiry: answers are accepted until the meeting (the series) ends; an endless series
// takes a year from now.
func (s *Service) tokenExpiry(b *bundle) time.Time {
	if u := b.series.UntilAt(); u != nil {
		return *u
	}
	return s.Now().Add(365 * 24 * time.Hour)
}

// icsEvent describes b for invite.ics with the meeting link; only != "" keeps that external
// attendee's line alone.
func (s *Service) icsEvent(b *bundle, method string, users map[uuid.UUID]sqlc.ListEventUsersRow, org sqlc.ListEventUsersRow, roomName, only, link string) ICSEvent {
	e := ICSEvent{
		UID: b.ev.ID.String() + "@calab", Sequence: int(b.ev.Sequence), Method: method, Series: b.series,
		Title: b.ev.Title, Description: b.ev.Description, URL: link, Stamp: s.Now(),
		Organizer: ICSPerson{Name: org.DisplayName, Email: s.organizerAddress(org)},
	}
	if roomName != "" {
		e.Location = "Calab: " + roomName
	}
	for _, a := range b.att {
		if only != "" && deref(a.Email) != only {
			continue
		}
		p := ICSPerson{Optional: !a.Required, PartStat: PartStat(a.Status)}
		if a.UserID != nil {
			u := users[*a.UserID]
			if u.Email == nil || u.EmailVerifiedAt == nil || u.IsBot || u.IsGuest {
				continue
			}
			p.Name, p.Email = u.DisplayName, *u.Email
		} else {
			p.Email = deref(a.Email)
		}
		e.Attendees = append(e.Attendees, p)
	}
	return e
}

// organizerAddress: the organizer's confirmed address, else the system sender (replies reach
// the organizer through Reply-To).
func (s *Service) organizerAddress(org sqlc.ListEventUsersRow) string {
	if org.Email != nil && org.EmailVerifiedAt != nil {
		return *org.Email
	}
	from := s.cfg.MailFrom
	if i := strings.LastIndexByte(from, '<'); i >= 0 {
		from = strings.TrimSuffix(from[i+1:], ">")
	}
	if from == "" {
		return "noreply@calab.invalid"
	}
	return from
}

// formatWhen renders an occurrence for a mail in loc: the date for the subject and the full
// time range with the zone.
func formatWhen(locale string, o Occurrence, allDay bool, loc *time.Location) (date, when string) {
	dateFmt := "2006-01-02"
	if locale == mail.LocaleRU {
		dateFmt = "02.01.2006"
	}
	st, en := o.Start.In(loc), o.End.In(loc)
	date = st.Format(dateFmt)
	if allDay {
		last := en.Add(-time.Second)
		if last.Format(dateFmt) == date {
			return date, date
		}
		return date, date + " – " + last.Format(dateFmt)
	}
	when = date + " " + st.Format("15:04") + "–"
	if en.Format(dateFmt) != date {
		when += en.Format(dateFmt) + " "
	}
	return date, when + en.Format("15:04") + " (" + loc.String() + ")"
}

var repeatTexts = map[string][5]string{
	mail.LocaleEN:   {"", "every day", "every week", "every two weeks", "every month"},
	mail.LocaleRU:   {"", "каждый день", "каждую неделю", "раз в две недели", "каждый месяц"},
	mail.LocaleES:   {"", "cada día", "cada semana", "cada dos semanas", "cada mes"},
	mail.LocaleZhCN: {"", "每天", "每周", "每两周", "每月"},
}

func repeatText(locale string, r v1.EventRepeat) string {
	t, ok := repeatTexts[mail.Locale(locale)]
	if !ok || int(r) < 0 || int(r) >= len(t) {
		return ""
	}
	return t[r]
}
