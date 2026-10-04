package boards

import (
	"fmt"
	"math"
	"net/mail"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/google/uuid"
)

const maxFormFields = 30

func validateForm(d *v1.BoardFormDefinition) error {
	if d == nil {
		return httpx.Validation("definition", "form definition required")
	}
	if _, err := validText("title", d.Title, 1, 100); err != nil {
		return err
	}
	if utf8.RuneCountInString(d.Description) > 2000 {
		return httpx.Validation("description", "at most 2000 characters")
	}
	if len(d.Fields) == 0 || len(d.Fields) > maxFormFields {
		return httpx.Validation("fields", "1..30 fields required")
	}
	if _, err := uuid.Parse(d.StatusId); err != nil {
		return httpx.Validation("statusId", "status required")
	}
	if _, err := validPriority(d.Priority); err != nil {
		return err
	}
	seen, title := map[string]bool{}, false
	for i, f := range d.Fields {
		key := fmt.Sprintf("fields[%d]", i)
		if f == nil {
			return httpx.Validation(key, "field required")
		}
		if _, err := uuid.Parse(f.Id); err != nil || seen[f.Id] {
			return httpx.Validation(key+".id", "unique UUID required")
		}
		seen[f.Id] = true
		if _, err := validText(key+".label", f.Label, 1, 100); err != nil {
			return err
		}
		if utf8.RuneCountInString(f.Hint) > 500 || utf8.RuneCountInString(f.Placeholder) > 500 {
			return httpx.Validation(key, "hint and placeholder: at most 500 characters")
		}
		if f.Type < v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_TEXT || f.Type > v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_CHECKBOX {
			return httpx.Validation(key+".type", "unknown field type")
		}
		if f.Id == d.TitleFieldId {
			title = true
			if !f.Required || f.Type != v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_TEXT {
				return httpx.Validation("titleFieldId", "required short text field required")
			}
		}
		if f.Type == v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_SELECT {
			if len(f.Options) == 0 || len(f.Options) > 30 {
				return httpx.Validation(key+".options", "1..30 options required")
			}
			opts := map[string]bool{}
			for _, o := range f.Options {
				if _, err := validText(key+".options", o, 1, 100); err != nil {
					return err
				}
				if opts[o] {
					return httpx.Validation(key+".options", "duplicate option")
				}
				opts[o] = true
			}
		} else if len(f.Options) != 0 {
			return httpx.Validation(key+".options", "options require a select field")
		}
	}
	if !title {
		return httpx.Validation("titleFieldId", "title field required")
	}
	if len(d.AllowedUserIds) > 100 {
		return httpx.Validation("allowedUserIds", "at most 100 users")
	}
	users := map[string]bool{}
	for _, u := range d.AllowedUserIds {
		if _, err := uuid.Parse(u); err != nil || users[u] {
			return httpx.Validation("allowedUserIds", "unique user UUIDs required")
		}
		users[u] = true
	}
	if !d.IsPrivate && len(users) > 0 {
		return httpx.Validation("allowedUserIds", "public forms do not have an allowlist")
	}
	return nil
}

// Escape Markdown metacharacters and mention syntax. Answers are data, never commands or mentions.
func formText(s string) string {
	return strings.NewReplacer("\\", "\\\\", "`", "\\`", "*", "\\*", "_", "\\_", "[", "\\[", "]", "\\]", "<", "&lt;", ">", "&gt;", "#", "\\#", "!", "\\!", "@", "＠").Replace(s)
}

func formAnswers(d *v1.BoardFormDefinition, answers []*v1.BoardFormAnswer) (string, string, error) {
	if len(answers) > maxFormFields {
		return "", "", httpx.Validation("answers", "too many answers")
	}
	vals := map[string]string{}
	fields := map[string]bool{}
	for _, f := range d.Fields {
		fields[f.Id] = true
	}
	for _, a := range answers {
		if a == nil || !fields[a.FieldId] {
			return "", "", httpx.Validation("answers", "unknown field")
		}
		if _, ok := vals[a.FieldId]; ok {
			return "", "", httpx.Validation(a.FieldId, "duplicate answer")
		}
		vals[a.FieldId] = strings.TrimSpace(a.Value)
	}
	var title string
	var desc strings.Builder
	for _, f := range d.Fields {
		v := vals[f.Id]
		fail := func(message string) (string, string, error) { return "", "", httpx.Validation(f.Id, message) }
		if f.Required && (v == "" || (f.Type == v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_CHECKBOX && v != "true")) {
			return fail("required field")
		}
		if v == "" {
			continue
		}
		if utf8.RuneCountInString(v) > 2000 {
			return fail("at most 2000 characters")
		}
		switch f.Type {
		case v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_EMAIL:
			addr, err := mail.ParseAddress(v)
			if err != nil || addr.Address != v || addr.Name != "" {
				return fail("invalid email")
			}
		case v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_NUMBER:
			n, err := strconv.ParseFloat(v, 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
				return fail("finite number required")
			}
		case v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_DATE:
			if _, ok := ParseDate(v); !ok {
				return fail("valid YYYY-MM-DD date required")
			}
		case v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_SELECT:
			if !slices.Contains(f.Options, v) {
				return fail("unknown option")
			}
		case v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_CHECKBOX:
			if v != "true" && v != "false" {
				return fail("true or false required")
			}
		}
		if f.Id == d.TitleFieldId {
			if utf8.RuneCountInString(v) > MaxTitle || strings.ContainsAny(v, "\r\n") {
				return fail("single line, at most 200 characters")
			}
			title = v
		} else {
			if desc.Len() > 0 {
				desc.WriteString("\n\n")
			}
			desc.WriteString("**" + formText(f.Label) + "**\n" + formText(v))
		}
	}
	if _, err := validTitle(title); err != nil {
		return "", "", err
	}
	description, err := validDescription(desc.String())
	return title, description, err
}
