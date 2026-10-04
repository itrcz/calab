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
		{}, {{FieldId: title, Value: "Title"}, {FieldId: title, Value: "Duplicate"}}, {{FieldId: uuid.NewString(), Value: "Unknown"}}, {{FieldId: title, Value: strings.Repeat("x", 201)}},
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
