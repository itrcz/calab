package office

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// HostPath is where the Calab host page (infra/office/calab-editor.{html,js}) is served on the
// Document Server's origin: mounted read-only into its web-apps tree, which the Document Server's
// own nginx already serves (no extra ingress rule).
const HostPath = "/web-apps/apps/calab/calab-editor.html"

// Mode maps the caller's Disk bits on the item and its format to the editor mode: DISK_WRITE
// (which «Правка» gives, with DISK_VIEW) on a format edited in place edits; DISK_VIEW alone, a
// view-only or legacy format views; nothing is not found. A trashed item, a workspace that takes
// no writes and the phone (Community Edition has no mobile web editing) view only.
func Mode(it Item, f Format, phone bool) v1.OfficeMode {
	switch {
	case !it.Bits.Has(perm.DiskView):
		return v1.OfficeMode_OFFICE_MODE_UNSPECIFIED
	case f.Cap == capEdit && it.Bits.Has(perm.DiskWrite) && !it.Trashed && !it.ReadOnly && !phone:
		return v1.OfficeMode_OFFICE_MODE_EDIT
	default:
		return v1.OfficeMode_OFFICE_MODE_VIEW
	}
}

var errUnsupported = httpx.Coded(http.StatusUnsupportedMediaType, v1.ErrorCode_ERROR_CODE_VALIDATION, "this file type does not open in the editor")

func (s *Service) tooLarge() error {
	return httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_FILE_TOO_LARGE, "the file is too large for the editor")
}

// opening is what one open of the editor needs.
type opening struct {
	format   Format
	mode     v1.OfficeMode
	key      string
	title    string
	fileURL  string
	callback string // "" = none (view only of an attachment)
	itemID   string
	fileID   uuid.UUID
	// noDownload: a view-only public link (ADR-0167) — the viewer offers no download, print or
	// copy. A barrier in the editor's UI, not a protection: the file URL is in the configuration.
	noDownload bool
}

// config: GET /api/office/config?item=|file=&theme=dark|light&phone=1&lang=ru.
func (s *Service) config(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	if id.IsBot || id.ViaBot != uuid.Nil {
		return auth.ErrBotNotAllowed // bots read files through the Disk API, never an editor session
	}
	if s.ConfigLimit != nil {
		if err := s.ConfigLimit.Take(r.Context(), id.UserID.String()); err != nil {
			return err
		}
	}
	q := r.URL.Query()
	phone := q.Get("phone") == "1"
	var op opening
	var err error
	switch {
	case q.Get("item") != "":
		op, err = s.openItem(r, id.UserID, q.Get("item"), phone)
	case q.Get("file") != "":
		op, err = s.openFile(r, q.Get("file"))
	default:
		return httpx.Validation("item", "item or file is required")
	}
	if err != nil {
		return err
	}
	name, err := s.store.DisplayName(r.Context(), id.UserID)
	if err != nil {
		return err
	}
	resp, err := s.sign(op, id.UserID, name, q.Get("theme") == "light", phone, q.Get("lang"))
	if err != nil {
		return err
	}
	slog.InfoContext(r.Context(), "office: open", "user", id.UserID, "item", op.itemID, "file", op.fileID, "ext", op.format.Ext, "mode", op.mode.String(), "key", op.key)
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

// openItem opens a Disk file: joins the item's session (or starts one), so everyone who opens
// it until the session ends shares its key.
func (s *Service) openItem(r *http.Request, uid uuid.UUID, raw string, phone bool) (opening, error) {
	itemID, err := uuid.Parse(raw)
	if err != nil {
		return opening{}, httpx.NotFound("item")
	}
	ctx := r.Context()
	it, err := s.store.ItemFor(ctx, uid, itemID)
	if errors.Is(err, ErrNotFound) {
		return opening{}, httpx.NotFound("item")
	}
	if err != nil {
		return opening{}, err
	}
	f, ok := FormatOf(it.Name)
	if !ok {
		return opening{}, errUnsupported
	}
	if it.Size > s.cfg.MaxSize {
		return opening{}, s.tooLarge()
	}
	mode := Mode(it, f, phone)
	if mode == v1.OfficeMode_OFFICE_MODE_UNSPECIFIED {
		return opening{}, httpx.NotFound("item")
	}
	op := opening{format: f, mode: mode, title: it.Name, itemID: it.ID.String(), fileID: it.FileID}
	if f.Cap != capEdit {
		// Never written: a view session per file version, no callback.
		op.key = viewKey(s.cfg.URLKey, "v-", it.FileID, "")
		tok, err := signURL(s.cfg.URLKey, opFile, it.ID, it.FileID, "", s.Now().Add(s.cfg.FileURLTTL))
		if err != nil {
			return op, err
		}
		op.fileURL = s.cfg.APIURL + "/api/office/file/" + tok
		return op, nil
	}
	// Viewers are marked too: the Document Server never reports them (status 1 lists editors),
	// so the access recheck finds them only by these marks.
	editing := mode == v1.OfficeMode_OFFICE_MODE_EDIT
	fresh := Session{Key: sessionKey(s.cfg.URLKey, it.ID, it.FileID), FileID: it.FileID}
	sess, err := s.sessions.Join(ctx, it.ID, fresh, uid, editing)
	if err != nil {
		return op, err
	}
	if sess.FileID != it.FileID {
		// The current file replaced the session's own: a forcesave of this session committed and
		// its Advance has not run yet (only a callback of the live key saves over the session's
		// file). Ending the session here would refuse every later save of its editors.
		prev, err := s.store.LastVersion(ctx, it.ID)
		if err != nil {
			return op, err
		}
		if prev == sess.FileID {
			ok, err := s.sessions.Advance(ctx, it.ID, sess.Key, it.FileID)
			if err != nil {
				return op, err
			}
			if ok {
				sess.FileID = it.FileID
			}
		}
	}
	if sess.FileID != it.FileID {
		// A session left behind (the Document Server lost it, or the file changed outside the
		// editor): its key would open stale content. Start over on the current file.
		slog.WarnContext(ctx, "office: stale session replaced", "item", it.ID, "key", sess.Key)
		if err := s.sessions.End(ctx, it.ID, sess.Key); err != nil {
			return op, err
		}
		if sess, err = s.sessions.Join(ctx, it.ID, fresh, uid, editing); err != nil {
			return op, err
		}
	}
	op.key = sess.Key
	fileTok, err := signURL(s.cfg.URLKey, opFile, it.ID, sess.FileID, "", s.Now().Add(s.cfg.FileURLTTL))
	if err != nil {
		return op, err
	}
	cbTok, err := signURL(s.cfg.URLKey, opCallback, it.ID, uuid.Nil, sess.Key, time.Time{})
	if err != nil {
		return op, err
	}
	op.fileURL = s.cfg.APIURL + "/api/office/file/" + fileTok
	op.callback = s.cfg.APIURL + "/api/office/callback/" + cbTok
	return op, nil
}

// openFile opens an attachment (a chat or task file the caller may read): view only. Its
// files row never changes, so there is nothing to save in place: «Сохранить в Диск» makes an
// editable copy (POST /api/workspaces/{id}/disk/import).
func (s *Service) openFile(r *http.Request, raw string) (opening, error) {
	fileID, err := uuid.Parse(raw)
	if err != nil {
		return opening{}, httpx.NotFound("file")
	}
	f, err := s.store.FileFor(r, fileID)
	if errors.Is(err, ErrNotFound) {
		return opening{}, httpx.NotFound("file")
	}
	if err != nil {
		return opening{}, err
	}
	fm, ok := FormatOf(f.Name)
	if !ok {
		return opening{}, errUnsupported
	}
	if f.Size > s.cfg.MaxSize {
		return opening{}, s.tooLarge()
	}
	tok, err := signURL(s.cfg.URLKey, opAttach, f.ID, uuid.Nil, "", s.Now().Add(s.cfg.FileURLTTL))
	if err != nil {
		return opening{}, err
	}
	return opening{format: fm, mode: v1.OfficeMode_OFFICE_MODE_VIEW, key: viewKey(s.cfg.URLKey, "a-", f.ID, ""), title: f.Name,
		fileURL: s.cfg.APIURL + "/api/office/file/" + tok, fileID: f.ID}, nil
}

// regionOf is the editor's region (the format of dates, numbers and currency) of an app
// language: the language's own region for the app's four, the language itself otherwise.
func regionOf(code string) string {
	switch l := strings.ToLower(code); {
	case l == "ru" || l == "en" || l == "es" || l == "zh" || strings.HasPrefix(l, "zh-"):
		return langOf(l).tag
	default:
		return code
	}
}

// sign makes the signed editor configuration of op for uid.
func (s *Service) sign(op opening, uid uuid.UUID, name string, light, phone bool, lang string) (*v1.OfficeConfigResponse, error) {
	edit := op.mode == v1.OfficeMode_OFFICE_MODE_EDIT
	theme := s.cfg.ThemeDark
	if light {
		theme = s.cfg.ThemeLight
	}
	if lang == "" || len(lang) > 8 {
		lang = "ru"
	}
	editorMode, editorType := "view", "desktop"
	if edit {
		editorMode = "edit"
	}
	if phone {
		editorType = "mobile"
	}
	customization := map[string]any{
		// Free in Community Edition (not license-gated in web-apps); see ADR-0143 §Вид. The editor
		// draws its own header (compact: name, save state, co-editors); the Calab shell has none.
		"uiTheme":             theme,
		"compactHeader":       true,
		"compactToolbar":      false,
		"toolbarHideFileName": false,
		"hideRightMenu":       true,
		"autosave":            true,
		"forcesave":           true, // Ctrl+S / «Сохранить» → status 6 → a version now
		"help":                false,
		"feedback":            false,
		"plugins":             false,
		"close":               map[string]any{"visible": false},
		"zoom":                100,
		"unit":                "cm",
	}
	if !phone {
		// «Открыть расположение файла» raises onRequestClose in the host page: the client leaves
		// the file view (the phone has its own back bar). The label is the editor's own, in lang.
		customization["goback"] = map[string]any{"requestClose": true}
	}
	editorConfig := map[string]any{
		"mode": editorMode,
		"lang": lang,
		// Dates, numbers and currency as the app language writes them (the trial: DD.MM.YYYY
		// showed as 01,07,2026 without it).
		"region":        regionOf(lang),
		"coEditing":     map[string]any{"mode": "fast", "change": false},
		"user":          map[string]any{"id": uid.String(), "name": name},
		"customization": customization,
	}
	if op.callback != "" {
		editorConfig["callbackUrl"] = op.callback
	}
	cfg := map[string]any{
		"type":         editorType,
		"documentType": op.format.DocType,
		"document": map[string]any{
			"fileType": op.format.Ext,
			"key":      op.key,
			"title":    op.title,
			"url":      op.fileURL,
			"permissions": map[string]any{
				"edit": edit, "comment": edit, "review": edit, "fillForms": edit, "modifyFilter": edit,
				"download": !op.noDownload, "print": !op.noDownload, "copy": !op.noDownload, "chat": false, "protect": false,
			},
		},
		"editorConfig": editorConfig,
	}
	tok, err := signConfig(s.cfg.Secret, cfg, ConfigTokenTTL)
	if err != nil {
		return nil, err
	}
	cfg["token"] = tok
	raw, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	return &v1.OfficeConfigResponse{DocsUrl: s.cfg.DocsURL, HostUrl: s.cfg.DocsURL + HostPath, ConfigJson: string(raw), Mode: op.mode,
		Key: op.key, Format: op.format.proto(), ItemId: op.itemID, FileId: op.fileID.String()}, nil
}
