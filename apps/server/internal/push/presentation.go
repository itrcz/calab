package push

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
)

// presentation runs only after dispatch has checked the recipient's current authority.
// It never copies raw gateway payloads, URLs to attachments, or credentials.
func (s *Service) presentation(ctx context.Context, q *sqlc.Queries, recipient sqlc.User, job sqlc.PushDelivery, payload *Payload) error {
	switch job.Kind {
	case messageKind:
		message, err := q.GetMessage(ctx, job.ReferenceID)
		if err != nil {
			return err
		}
		author, err := q.GetUser(ctx, message.AuthorID)
		if err != nil {
			return err
		}
		room, err := q.GetRoom(ctx, message.RoomID)
		if err != nil {
			return err
		}
		if room.Type != "dm" || room.DmKey == nil {
			payload.Subtitle = previewLine(room.Name, 80)
		}
		payload.PersonID = presentationID(payload.Binding, author.ID.String())
		payload.ConversationID = presentationID(payload.Binding, message.RoomID.String())
		payload.AvatarJPEG = s.avatar(ctx, q, author)
		payload.Title = previewLine(author.DisplayName, 80)
		if payload.Title == "" {
			payload.Title = "Calab"
		}
		payload.Body = messagePreview(message.Content, recipient)
		if payload.Body == "" {
			attachments, err := q.ListAttachments(ctx, []uuid.UUID{message.ID})
			if err != nil {
				return err
			}
			payload.Body = attachmentPreview(message, attachments, recipient.Locale)
		}
	case callKind:
		call, live, err := s.Calls.Current(ctx, recipient.ID)
		if err != nil {
			return err
		}
		if live && call.ID == job.ReferenceID {
			caller, err := q.GetUser(ctx, call.Caller)
			if err != nil {
				return err
			}
			payload.PersonID = presentationID(payload.Binding, caller.ID.String())
			payload.AvatarJPEG = s.avatar(ctx, q, caller)
			payload.CallerName = previewLine(caller.DisplayName, 80)
		}
	}
	return nil
}

var wireMention = regexp.MustCompile(`(?i)@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)

func messagePreview(content string, recipient sqlc.User) string {
	// Never turn arbitrary IDs in user-authored text into an unrestricted profile lookup.
	mention := "@member"
	if recipient.Locale != nil && strings.HasPrefix(strings.ToLower(*recipient.Locale), "ru") {
		mention = "@участник"
	}
	content = wireMention.ReplaceAllStringFunc(content, func(raw string) string {
		if strings.EqualFold(raw[1:], recipient.ID.String()) && recipient.DisplayName != "" {
			return "@" + previewLine(recipient.DisplayName, 80)
		}
		return mention
	})
	return previewLine(content, 240)
}

// APNs renders these as plain text. Keep emoji/ZWJ intact, remove control/bidi spoofing,
// and bound Unicode scalars so a preview stays well below the provider payload limit.
func previewLine(raw string, limit int) string {
	clean := strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return ' '
		}
		if unicode.IsControl(r) || r == 0x061c || r == 0x200e || r == 0x200f || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
			return -1
		}
		return r
	}, raw)
	runes := []rune(strings.Join(strings.Fields(clean), " "))
	if len(runes) > limit {
		return string(runes[:limit-1]) + "…"
	}
	return string(runes)
}

func attachmentPreview(message sqlc.Message, attachments []sqlc.ListAttachmentsRow, locale *string) string {
	ru := locale != nil && strings.HasPrefix(strings.ToLower(*locale), "ru")
	label := func(en, russian string) string {
		if ru {
			return russian
		}
		return en
	}
	if message.StickerID != nil {
		return label("Sticker", "Стикер")
	}
	if len(attachments) > 1 {
		return label("Attachments", "Вложения")
	}
	if len(attachments) == 1 {
		file := attachments[0].File
		if file.VoiceDurationMs != nil {
			return label("Voice message", "Голосовое сообщение")
		}
		if strings.HasPrefix(file.Mime, "image/") {
			return label("Photo", "Фото")
		}
		if strings.HasPrefix(file.Mime, "video/") {
			return label("Video", "Видео")
		}
		return label("File", "Файл")
	}
	return label("New message", "Новое сообщение")
}

// Scope OS contact/conversation suggestions to this registered account binding.
func presentationID(binding, id string) string {
	sum := sha256.Sum256([]byte(binding + ":" + id))
	return hex.EncodeToString(sum[:])
}
