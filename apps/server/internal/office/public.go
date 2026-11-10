package office

import (
	"context"
	"log/slog"
	"strings"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Opens reports whether a file of this name and size opens in the editor (disk.PublicOffice).
func (s *Service) Opens(name string, size int64) bool {
	_, ok := FormatOf(name)
	return s.cfg.Enabled && ok && size <= s.cfg.MaxSize
}

// PublicView signs the view-only configuration of a file reached through a public Disk link
// (ADR-0165; disk.PublicOffice): the attachment path — a short-lived URL token pinned to the
// file, no session, no callback — for an anonymous visitor (a fresh user id per open, «Гость»).
// The caller checked the link and the file's place in it.
func (s *Service) PublicView(ctx context.Context, fileID uuid.UUID, title string, size int64, light, phone, noDownload bool, lang string) (*v1.OfficeConfigResponse, error) {
	if !s.cfg.Enabled {
		return nil, httpx.NotFound("office")
	}
	fm, ok := FormatOf(title)
	if !ok {
		return nil, errUnsupported
	}
	if size > s.cfg.MaxSize {
		return nil, s.tooLarge()
	}
	tok, err := signURL(s.cfg.URLKey, opAttach, fileID, uuid.Nil, "", s.Now().Add(s.cfg.FileURLTTL))
	if err != nil {
		return nil, err
	}
	op := opening{format: fm, mode: v1.OfficeMode_OFFICE_MODE_VIEW, key: viewKey(s.cfg.URLKey, "a-", fileID, ""), title: title,
		fileURL: s.cfg.APIURL + "/api/office/file/" + tok, fileID: fileID, noDownload: noDownload}
	name := "Guest"
	if lang == "" || strings.HasPrefix(strings.ToLower(lang), "ru") {
		name = "Гость"
	}
	out, err := s.sign(op, uuid.New(), name, light, phone, lang)
	if err != nil {
		return nil, err
	}
	slog.InfoContext(ctx, "office: public view", "file", fileID, "ext", fm.Ext)
	return out, nil
}
