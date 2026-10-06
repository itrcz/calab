//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
)

func formFixture(b *v1.Board) *v1.BoardFormDefinition {
	id := uuid.NewString()
	return &v1.BoardFormDefinition{Title: "Request", TitleFieldId: id, StatusId: b.Statuses[1].Id, Priority: v1.TaskPriority_TASK_PRIORITY_HIGH,
		Fields: []*v1.BoardFormField{{Id: id, Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_TEXT, Label: "Subject", Required: true},
			{Id: uuid.NewString(), Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PARAGRAPH, Label: "Details"}}}
}

func TestBoardFormsFlow(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Forms", IsPrivate: true}, 201)
	d := formFixture(b)
	path := "/api/boards/" + b.Id + "/forms"
	var fr v1.BoardFormResponse
	o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, &fr)
	form := fr.Form
	code := form.Url[strings.LastIndex(form.Url, "/")+1:]
	public := "/api/public/forms/" + code
	anon := &client{t: t}
	var view v1.PublicBoardFormResponse
	anon.must(200, "GET", public, nil, &view)
	if strings.Contains(string(anon.lastBody), b.Id) || strings.Contains(string(anon.lastBody), "allowedUserIds") {
		t.Fatal("private metadata leaked")
	}
	answers := []*v1.BoardFormAnswer{{FieldId: d.Fields[0].Id, Value: "From public form"}, {FieldId: d.Fields[1].Id, Value: "<script>alert(1)</script> @everyone"}}
	var preview v1.FormSubmissionResponse
	o.must(200, "POST", path+"/preview", &v1.PreviewBoardFormRequest{Definition: d, Answers: answers}, &preview)
	if !preview.Preview || len(listTasks(t, o, b.Id, nil)) != 0 {
		t.Fatal("preview created a task")
	}
	request := &v1.SubmitBoardFormRequest{Revision: form.Revision, Nonce: uuid.NewString(), Answers: answers}
	var first, second v1.FormSubmissionResponse
	anon.must(201, "POST", public+"/submissions", request, &first)
	anon.must(200, "POST", public+"/submissions", request, &second)
	if first.ReceiptId == "" || first.ReceiptId != second.ReceiptId {
		t.Fatal("idempotency receipt mismatch")
	}
	tasks := listTasks(t, o, b.Id, nil)
	if len(tasks) != 1 || tasks[0].Title != answers[0].Value || tasks[0].StatusId != d.StatusId || tasks[0].Priority != d.Priority || tasks[0].CreatedBy != "" {
		t.Fatalf("task mismatch: %v", tasks)
	}
	if strings.Contains(tasks[0].Description, "@everyone") {
		t.Fatal("answer turned into mention")
	}
	bob.must(404, "GET", "/api/tasks/"+tasks[0].Id, nil, nil)
	changed := proto.Clone(request).(*v1.SubmitBoardFormRequest)
	changed.Answers[0].Value = "Other"
	anon.must(409, "POST", public+"/submissions", changed, nil)
	// Private access is independent of board visibility; stale public pages cannot submit.
	d.IsPrivate, d.AllowedUserIds = true, []string{bob.id}
	o.must(200, "PUT", path+"/"+form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: form.Revision}, &fr)
	anon.must(401, "GET", public, nil, nil)
	anon.must(401, "POST", public+"/submissions", request, nil)
	private := "/api/forms/" + code
	o.must(404, "GET", private, nil, nil)
	bob.must(200, "GET", private, nil, &view)
	request.Revision, request.Nonce = view.Revision, uuid.NewString()
	bob.must(201, "POST", private+"/submissions", request, nil)
	bob.must(404, "GET", path, nil, nil)
	// Removing a recipient revokes open pages too.
	d.AllowedUserIds = nil
	o.must(200, "PUT", path+"/"+form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, &fr)
	bob.must(404, "POST", private+"/submissions", request, nil)
	o.must(204, "DELETE", path+"/"+form.Id, nil, nil)
	anon.must(404, "GET", public, nil, nil)
	bob.must(404, "GET", private, nil, nil)
	if len(listTasks(t, o, b.Id, nil)) != 2 {
		t.Fatal("delete removed submitted tasks")
	}
}

func TestBoardFormsBotAndLimits(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Bot forms"}, 201)
	bt := createBot(t, o, ws.Id, "forms")
	path := "/api/boards/" + b.Id + "/forms"
	d := formFixture(b)
	bt.must(403, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	setBoardPerms(o, b.Id, 200, userOv(bt.id, perm.ViewBoard|perm.ManageBoard, 0))
	var fr v1.BoardFormResponse
	bt.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, &fr)
	code := fr.Form.Url[strings.LastIndex(fr.Form.Url, "/")+1:]
	d.IsPrivate, d.AllowedUserIds = true, []string{bt.id}
	bt.must(200, "PUT", path+"/"+fr.Form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, &fr)
	var view v1.PublicBoardFormResponse
	bt.must(200, "GET", "/api/forms/"+code, nil, &view)
	bt.must(201, "POST", "/api/forms/"+code+"/submissions", &v1.SubmitBoardFormRequest{Revision: view.Revision, Nonce: uuid.NewString(), Answers: []*v1.BoardFormAnswer{{FieldId: d.TitleFieldId, Value: "Bot request"}}}, nil)
	tasks := listTasks(t, o, b.Id, nil)
	if len(tasks) != 1 || tasks[0].CreatedBy != bt.id {
		t.Fatal("bot submission attribution")
	}
	original := testApp.Plans.PlanLimits(v1.Plan_PLAN_FREE)
	testApp.Plans.SetDefaults(plans.Limits{BoardFormsPerBoard: 5}, plans.DefaultTeam, plans.DefaultBusiness)
	t.Cleanup(func() { testApp.Plans.SetDefaults(original, plans.DefaultTeam, plans.DefaultBusiness) })
	for range 4 {
		bt.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	}
	bt.must(409, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	testApp.Plans.SetDefaults(plans.Limits{BoardFormsDisabled: true}, plans.DefaultTeam, plans.DefaultBusiness)
	bt.must(409, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	bt.must(409, "GET", "/api/forms/"+code, nil, nil)
	bt.must(200, "GET", path, nil, nil)
	bt.must(204, "DELETE", path+"/"+fr.Form.Id, nil, nil)
	o.must(204, "DELETE", "/api/workspaces/"+ws.Id+"/bots/"+bt.id+"/token", nil, nil)
	bt.must(401, "GET", path, nil, nil)
	// Receipts are gone while tasks and their ordinary room remain.
	var count int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM tasks WHERE board_id=$1", b.Id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("tasks after deletion: %d %v", count, err)
	}
}

// FORMS off (owner 07.10): creating is 409 FEATURE_DISABLED and an existing form stops opening
// (404) until the feature is switched back on; the form itself is kept.
func TestBoardFormsFeatureOff(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "FormsOff"}, 201)
	path := "/api/boards/" + b.Id + "/forms"
	var fr v1.BoardFormResponse
	o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: formFixture(b)}, &fr)
	code := fr.Form.Url[strings.LastIndex(fr.Form.Url, "/")+1:]
	anon := &client{t: t}
	anon.must(200, "GET", "/api/public/forms/"+code, nil, nil)
	setBoardFeatures(t, b.Id, 1<<uint(v1.BoardFeature_BOARD_FEATURE_FORMS))
	o.must(409, "POST", path, &v1.CreateBoardFormRequest{Definition: formFixture(b)}, nil)
	if reason, _ := errReason(o.client); reason != "FEATURE_DISABLED" {
		t.Fatalf("reason %q", reason)
	}
	anon.must(404, "GET", "/api/public/forms/"+code, nil, nil)
	setBoardFeatures(t, b.Id, 0)
	anon.must(200, "GET", "/api/public/forms/"+code, nil, nil)
}
