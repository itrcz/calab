package boards

import (
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/google/uuid"
	"strings"
	"testing"
)

func TestFormAnswers(t *testing.T) {
	title, other := uuid.NewString(), uuid.NewString()
	d := &v1.BoardFormDefinition{Title: "Intake", TitleFieldId: title, StatusId: uuid.NewString(), Fields: []*v1.BoardFormField{
		{Id: title, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_TEXT, Label: "Title", Required: true},
		{Id: other, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_EMAIL, Label: "Email", Required: true}}}
	if err := validateForm(d); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		kind  v1.BoardFormFieldType
		value string
		ok    bool
	}{
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_EMAIL, "person@example.com", true},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_EMAIL, "Person <person@example.com>", false},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_NUMBER, "42.5", true},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_NUMBER, "NaN", false},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_NUMBER, "1e999", false},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_DATE, "2026-02-28", true},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_DATE, "2026-02-30", false},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_CHECKBOX, "false", false},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_CHECKBOX, "true", true},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_SELECT, "One", true},
		{v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_SELECT, "Three", false},
	} {
		d.Fields[1].Type = tc.kind
		d.Fields[1].Options = []string{"One", "Two"}
		_, _, err := formAnswers(d, []*v1.BoardFormAnswer{{FieldId: title, Value: "A request"}, {FieldId: other, Value: tc.value}})
		if (err == nil) != tc.ok {
			t.Errorf("kind %v value %q: %v", tc.kind, tc.value, err)
		}
	}
	d.Fields[1].Type = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PARAGRAPH
	_, desc, err := formAnswers(d, []*v1.BoardFormAnswer{{FieldId: title, Value: "Title"}, {FieldId: other, Value: "@everyone [x](https://example.com) <script>"}})
	if err != nil || strings.Contains(desc, "@everyone") || strings.Contains(desc, "<script>") {
		t.Fatalf("unsafe rendered response %q %v", desc, err)
	}
	for _, answers := range [][]*v1.BoardFormAnswer{
		{}, {{FieldId: title, Value: "Title"}, {FieldId: title, Value: "Duplicate"}}, {{FieldId: uuid.NewString(), Value: "Unknown"}}, {{FieldId: title, Value: strings.Repeat("x", 2001)}},
	} {
		if _, _, err := formAnswers(d, answers); err == nil {
			t.Error("invalid answers accepted")
		}
	}
}

func TestFormDefinitionTextLimits(t *testing.T) {
	for _, value := range []string{"", "   ", "x" + strings.Repeat(" ", 100), strings.Repeat("я", 101)} {
		if err := validFormText("label", value); err == nil {
			t.Fatalf("accepted oversized or blank definition text: %q", value)
		}
	}
	if err := validFormText("label", strings.Repeat("я", 100)); err != nil {
		t.Fatal(err)
	}
}

func TestFormExtendedTypes(t *testing.T) {
	id := uuid.NewString()
	d := &v1.BoardFormDefinition{Title: "Contact", StatusId: uuid.NewString(), Fields: []*v1.BoardFormField{{Id: id, Label: "Contact", Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PHONE}}}
	if err := validateForm(d); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"", true}, {"+7 (999) 123-45-67", true}, {"020 7946 0018", true}, {"+1.212.555.0100", true}, {"1234567", true}, {"123456789012345", true},
		{"123456", false}, {"1234567890123456", false}, {"+7 CALL NOW", false}, {"123+4567", false}, {"++1234567", false}, {"１２３４５６７", false}, {"1234567\n8", false}, {"1234567" + strings.Repeat("-", 58), false},
	} {
		t.Run(tc.value, func(t *testing.T) {
			title, desc, err := formAnswers(d, []*v1.BoardFormAnswer{{FieldId: id, Value: tc.value}})
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
			if err == nil && (title != "Contact" || (tc.value != "" && !strings.Contains(desc, tc.value))) {
				t.Fatalf("phone not preserved %q %q", title, desc)
			}
		})
	}
	d.Fields[0].Required = true
	if _, _, err := formAnswers(d, nil); err == nil {
		t.Fatal("required phone omitted")
	}
	d.Fields[0].Type = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_URL
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"https://example.test/a?q=1", true}, {"http://example.test", true}, {"https://例子.test/path", true}, {"javascript:alert(1)", false}, {"file:///tmp/a", false}, {"example.test", false}, {"https://", false}, {"https://user:secret@example.test", false}, {"https://example.test/a b", false}, {"https://example.test/\tbad", false},
	} {
		_, _, err := formAnswers(d, []*v1.BoardFormAnswer{{FieldId: id, Value: tc.value}})
		if (err == nil) != tc.valid {
			t.Errorf("url %q: %v", tc.value, err)
		}
	}
	d.Fields[0].Type = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_MULTISELECT
	d.Fields[0].Options = []string{"One", "Two", "Three"}
	if err := validateForm(d); err != nil {
		t.Fatal(err)
	}
	for _, answer := range []*v1.BoardFormAnswer{
		{FieldId: id}, {FieldId: id, Value: "One"}, {FieldId: id, Values: []string{"Unknown"}}, {FieldId: id, Values: []string{"One", "One"}}, {FieldId: id, Values: make([]string, 31)},
	} {
		if _, _, err := formAnswers(d, []*v1.BoardFormAnswer{answer}); err == nil {
			t.Fatalf("invalid multiple choice accepted: %v", answer)
		}
	}
	_, desc, err := formAnswers(d, []*v1.BoardFormAnswer{{FieldId: id, Values: []string{"Three", "One"}}})
	if err != nil || !strings.Contains(desc, "One; Three") {
		t.Fatalf("ordered choices %q %v", desc, err)
	}
	d.Fields[0].Required = false
	if _, _, err := formAnswers(d, nil); err != nil {
		t.Fatal(err)
	}
	d.TitleFieldId = id
	if err := validateForm(d); err == nil {
		t.Fatal("multiple choice used as title source")
	}
	d.TitleFieldId = ""
	d.Fields[0].Type = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_TEXT
	d.Fields[0].Options = nil
	if _, _, err := formAnswers(d, []*v1.BoardFormAnswer{{FieldId: id, Values: []string{"One"}}}); err == nil {
		t.Fatal("values accepted on scalar")
	}
	d.TitleFieldId = id
	if err := validateForm(d); err != nil {
		t.Fatal(err)
	}
	title, _, err := formAnswers(d, nil)
	if err != nil || title != "Contact" {
		t.Fatalf("empty title fallback %q %v", title, err)
	}
	long := strings.Repeat("я", 210) + "\nsecond line"
	title, desc, err = formAnswers(d, []*v1.BoardFormAnswer{{FieldId: id, Value: long}})
	if err != nil || title != strings.Repeat("я", 200) || !strings.Contains(desc, long) {
		t.Fatalf("title truncation %q %q %v", title, desc, err)
	}
	d.Fields[0].Type = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PARAGRAPH
	title, _, err = formAnswers(d, []*v1.BoardFormAnswer{{FieldId: id, Value: "First\nSecond"}})
	if err != nil || title != "First Second" {
		t.Fatalf("multiline title %q %v", title, err)
	}
}
