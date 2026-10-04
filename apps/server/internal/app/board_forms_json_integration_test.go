//go:build integration

package app_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestBoardFormsRejectUnknownJSON(t *testing.T) {
	limiter := testApp.Boards.FormIPLimit
	testApp.Boards.FormIPLimit = nil
	t.Cleanup(func() { testApp.Boards.FormIPLimit = limiter })
	owner, _, ws, _ := setupTeam(t)
	board := createBoard(t, owner, ws.Id, &v1.CreateBoardRequest{Name: "Strict forms"}, 201)
	definition := formFixture(board)
	path := "/api/boards/" + board.Id + "/forms"
	// Mutate raw JSON, since protobuf request types cannot express misspelled properties.
	reject := func(method, route string, request proto.Message, token string, mutate func(map[string]any)) {
		t.Helper()
		body, err := protojson.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		var object map[string]any
		if err := json.Unmarshal(body, &object); err != nil {
			t.Fatal(err)
		}
		mutate(object)
		body, err = json.Marshal(object)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(t.Context(), method, srv.URL+route, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 400 || !bytes.Contains(raw, []byte("unknown field")) {
			t.Fatalf("%s %s: want unknown-field 400, got %d %s", method, route, resp.StatusCode, raw)
		}
	}
	topLevel := func(o map[string]any) { o["unexpected"] = true }
	typoPrivacy := func(o map[string]any) { o["definition"].(map[string]any)["isPrivte"] = true }
	unknownField := func(o map[string]any) {
		d := o["definition"].(map[string]any)
		d["fields"].([]any)[0].(map[string]any)["requred"] = true
	}
	for _, mutate := range []func(map[string]any){topLevel, typoPrivacy, unknownField} {
		reject("POST", path, &v1.CreateBoardFormRequest{Definition: definition}, owner.token, mutate)
	}
	var listed v1.ListBoardFormsResponse
	owner.must(200, "GET", path, nil, &listed)
	if len(listed.Forms) != 0 {
		t.Fatal("malformed create persisted a form")
	}
	var created v1.BoardFormResponse
	owner.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: definition}, &created)
	for _, mutate := range []func(map[string]any){topLevel, typoPrivacy, unknownField} {
		reject("PUT", path+"/"+created.Form.Id, &v1.UpdateBoardFormRequest{Definition: definition, Revision: created.Form.Revision}, owner.token, mutate)
	}
	answers := []*v1.BoardFormAnswer{{FieldId: definition.TitleFieldId, Value: "Strict request"}}
	unknownAnswer := func(o map[string]any) { o["answers"].([]any)[0].(map[string]any)["unexpected"] = "ignored?" }
	for _, mutate := range []func(map[string]any){topLevel, typoPrivacy, unknownField, unknownAnswer} {
		reject("POST", path+"/preview", &v1.PreviewBoardFormRequest{Definition: definition, Answers: answers}, owner.token, mutate)
	}
	code := created.Form.Url[strings.LastIndex(created.Form.Url, "/")+1:]
	submit := &v1.SubmitBoardFormRequest{Revision: created.Form.Revision, Nonce: uuid.NewString(), Answers: answers}
	for _, route := range []string{"/api/public/forms/", "/api/forms/"} {
		for _, mutate := range []func(map[string]any){topLevel, unknownAnswer} {
			reject("POST", route+code+"/submissions", submit, owner.token, mutate)
		}
	}
	if len(listTasks(t, owner, board.Id, nil)) != 0 {
		t.Fatal("malformed request created a task")
	}
	owner.must(200, "GET", path, nil, &listed)
	if len(listed.Forms) != 1 || listed.Forms[0].Revision != created.Form.Revision {
		t.Fatal("malformed update changed form")
	}
	// Rejected input must not consume the nonce; a valid retry creates exactly one task.
	anonymous := &client{t: t}
	anonymous.must(201, "POST", "/api/public/forms/"+code+"/submissions", submit, nil)
	anonymous.must(200, "POST", "/api/public/forms/"+code+"/submissions", submit, nil)
	if len(listTasks(t, owner, board.Id, nil)) != 1 {
		t.Fatal("valid retry did not create exactly one task")
	}
}
