//go:build integration

package app_test

import (
	"context"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"strings"
	"sync"
	"testing"
)

func TestBoardFormsConcurrentQuota(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Concurrent forms"}, 201)
	d := formFixture(b)
	original := testApp.Plans.PlanLimits(v1.Plan_PLAN_FREE)
	testApp.Plans.SetDefaults(plans.Limits{BoardFormsPerBoard: 5}, plans.DefaultTeam, plans.DefaultBusiness)
	t.Cleanup(func() { testApp.Plans.SetDefaults(original, plans.DefaultTeam, plans.DefaultBusiness) })
	statuses := make(chan int, 10)
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() {
			c := &client{t: t, token: o.token}
			statuses <- c.do("POST", "/api/boards/"+b.Id+"/forms", &v1.CreateBoardFormRequest{Definition: d}, nil)
		})
	}
	wg.Wait()
	close(statuses)
	created, limited := 0, 0
	for status := range statuses {
		switch status {
		case 201:
			created++
		case 409:
			limited++
		default:
			t.Errorf("unexpected status %d", status)
		}
	}
	if created != 5 || limited != 5 {
		t.Fatalf("created %d limited %d", created, limited)
	}
}

func TestBoardFormsSecurityAndAtomicity(t *testing.T) {
	limiter := testApp.Boards.FormIPLimit
	testApp.Boards.FormIPLimit = nil
	t.Cleanup(func() { testApp.Boards.FormIPLimit = limiter })
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Secure forms"}, 201)
	d := formFixture(b)
	path := "/api/boards/" + b.Id + "/forms"
	var fr v1.BoardFormResponse
	o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, &fr)
	code := fr.Form.Url[strings.LastIndex(fr.Form.Url, "/")+1:]
	public := "/api/public/forms/" + code
	a := &client{t: t}
	request := &v1.SubmitBoardFormRequest{Revision: fr.Form.Revision, Nonce: uuid.NewString(), Answers: []*v1.BoardFormAnswer{{FieldId: d.TitleFieldId, Value: "Atomic"}}}
	// Invalid data creates neither a task nor a hidden room or receipt nor advances numbering.
	var before, after int
	query := "SELECT next_number FROM boards WHERE id=$1"
	if err := testDB.Pool.QueryRow(context.Background(), query, b.Id).Scan(&before); err != nil {
		t.Fatal(err)
	}
	bad := &v1.SubmitBoardFormRequest{Revision: request.Revision, Nonce: uuid.NewString()}
	a.must(422, "POST", public+"/submissions", bad, nil)
	if err := testDB.Pool.QueryRow(context.Background(), query, b.Id).Scan(&after); err != nil || before != after {
		t.Fatalf("number changed %d -> %d: %v", before, after, err)
	}
	// Duplicate nonce under concurrency must produce exactly one task.
	var wg sync.WaitGroup
	codes := make(chan int, 3)
	for range 3 {
		wg.Go(func() {
			c := &client{t: t, token: o.token}
			codes <- c.do("POST", "/api/forms/"+code+"/submissions", request, nil)
		})
	}
	wg.Wait()
	close(codes)
	created := 0
	for status := range codes {
		if status == 201 {
			created++
		} else if status != 200 {
			t.Errorf("unexpected duplicate status %d", status)
		}
	}
	if created != 1 || len(listTasks(t, o, b.Id, nil)) != 1 {
		t.Fatal("duplicate tasks")
	}
	// SSO enforced blocks anonymous capabilities even for a previously opened public form.
	identityReferencePolicy(t, ws.Id, "enforced")
	a.must(403, "GET", public, nil, nil)
	a.must(403, "POST", public+"/submissions", request, nil)
	identityReferencePolicy(t, ws.Id, "off")
	// A stale editor cannot overwrite a newer definition.
	o.must(200, "PUT", path+"/"+fr.Form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, nil)
	o.must(409, "PUT", path+"/"+fr.Form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, nil)
	request.Nonce = uuid.NewString()
	a.must(409, "POST", public+"/submissions", request, nil)
	// Board archive revokes the link.
	o.must(204, "DELETE", "/api/boards/"+b.Id, nil, nil)
	a.must(404, "GET", public, nil, nil)
}

func TestBoardFormsPlansAndWebhook(t *testing.T) {
	withFreeLimits(t)
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Form plans"}, 201)
	path := "/api/boards/" + b.Id + "/forms"
	d := formFixture(b)
	o.must(409, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	setPlan(t, ws.Id, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	var fr v1.BoardFormResponse
	for range 5 {
		o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, &fr)
	}
	o.must(409, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	setPlan(t, ws.Id, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE})
	for range 15 {
		o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	}
	o.must(409, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	recv := newBoardHookRecv(t)
	recv.secret = "forms-test-webhook-secret"
	o.must(200, "PUT", "/api/boards/"+b.Id+"/webhook", &v1.SetBoardWebhookRequest{Url: recv.srv.URL, Secret: recv.secret}, nil)
	answers := []*v1.BoardFormAnswer{{FieldId: d.TitleFieldId, Value: "Webhook from form"}}
	o.must(200, "POST", path+"/preview", &v1.PreviewBoardFormRequest{Definition: d, Answers: answers}, nil)
	if pendingDeliveries(t, b.Id) != 0 {
		t.Fatal("preview queued a webhook")
	}
	code := fr.Form.Url[strings.LastIndex(fr.Form.Url, "/")+1:]
	anon := &client{t: t, ip: "192.0.2.159"}
	anon.must(201, "POST", "/api/public/forms/"+code+"/submissions", &v1.SubmitBoardFormRequest{Revision: fr.Form.Revision, Nonce: uuid.NewString(), Answers: answers}, nil)
	received := recv.wait("form webhook", func(events []*v1.BoardWebhookEvent) bool { return len(events) == 1 })
	if received[0].Type != "task.created" || received[0].Actor != nil || received[0].Task.Title != "Webhook from form" {
		t.Fatalf("form webhook mismatch: %v", received[0])
	}
	setPlan(t, ws.Id, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_CUSTOM, Limits: &v1.PlanLimits{}})
	for range 5 {
		o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	}
	// The board has a webhook (Business only): the superadmin overrides the limits (ADR-0086).
	setPlan(t, ws.Id, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, OverrideLimits: true})
	o.must(409, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, nil)
	anon.must(200, "GET", "/api/public/forms/"+code, nil, nil)
	setPlan(t, ws.Id, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_FREE, OverrideLimits: true})
	anon.must(409, "GET", "/api/public/forms/"+code, nil, nil)
	o.must(204, "DELETE", path+"/"+fr.Form.Id, nil, nil)
}

func TestBoardFormsDeleteRaceAndRevocation(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Revocation"}, 201)
	d := formFixture(b)
	d.IsPrivate, d.AllowedUserIds = true, []string{bob.id}
	path := "/api/boards/" + b.Id + "/forms"
	var fr v1.BoardFormResponse
	o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, &fr)
	code := fr.Form.Url[strings.LastIndex(fr.Form.Url, "/")+1:]
	target := "/api/forms/" + code
	request := &v1.SubmitBoardFormRequest{Revision: fr.Form.Revision, Nonce: uuid.NewString(), Answers: []*v1.BoardFormAnswer{{FieldId: d.TitleFieldId, Value: "Revocation"}}}
	bob.must(200, "GET", target, nil, nil)
	o.must(204, "DELETE", "/api/workspaces/"+ws.Id+"/members/"+bob.id, nil, nil)
	if status := bob.do("POST", target+"/submissions", request, nil); status != 403 && status != 404 {
		t.Fatalf("removed member status %d", status)
	}
	d.IsPrivate, d.AllowedUserIds = false, nil
	o.must(200, "PUT", path+"/"+fr.Form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, &fr)
	request.Revision = fr.Form.Revision
	// Deleting a selected status closes intake instead of silently changing the target.
	o.must(200, "DELETE", "/api/boards/"+b.Id+"/statuses/"+d.StatusId+"?move_to="+b.Statuses[0].Id, nil, nil)
	o.must(409, "POST", target+"/submissions", request, nil)
	d.StatusId = b.Statuses[0].Id
	o.must(200, "PUT", path+"/"+fr.Form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, &fr)
	request.Revision = fr.Form.Revision
	var wg sync.WaitGroup
	statuses := make(chan int, 3)
	for range 2 {
		wg.Go(func() {
			c := &client{t: t, token: o.token}
			statuses <- c.do("POST", target+"/submissions", request, nil)
		})
	}
	wg.Go(func() { c := &client{t: t, token: o.token}; statuses <- c.do("DELETE", path+"/"+fr.Form.Id, nil, nil) })
	wg.Wait()
	close(statuses)
	deletes := 0
	for status := range statuses {
		if status == 204 {
			deletes++
		} else if status != 200 && status != 201 && status != 404 {
			t.Errorf("delete race status %d", status)
		}
	}
	if deletes != 1 || len(listTasks(t, o, b.Id, nil)) > 1 {
		t.Fatal("delete/submit race invariant")
	}
	o.must(404, "GET", target, nil, nil)
}

func TestBoardFormsAutomations(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	setPlan(t, ws.Id, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM})
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Form rules"}, 201)
	d := formFixture(b)
	rule := createRule(t, o, b.Id, &v1.CreateBoardRuleRequest{Name: "Intake priority", Trigger: onCreated(), Actions: []*v1.RuleAction{doPriority(v1.TaskPriority_TASK_PRIORITY_URGENT)}}, 201)
	path := "/api/boards/" + b.Id + "/forms"
	answers := []*v1.BoardFormAnswer{{FieldId: d.TitleFieldId, Value: "Automated intake"}}
	o.must(200, "POST", path+"/preview", &v1.PreviewBoardFormRequest{Definition: d, Answers: answers}, nil)
	if len(ruleRuns(t, o, rule.Id)) != 0 || len(listTasks(t, o, b.Id, nil)) != 0 {
		t.Fatal("preview ran automation")
	}
	var fr v1.BoardFormResponse
	o.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, &fr)
	code := fr.Form.Url[strings.LastIndex(fr.Form.Url, "/")+1:]
	a := &client{t: t, ip: "192.0.2.160"}
	req := &v1.SubmitBoardFormRequest{Revision: fr.Form.Revision, Nonce: uuid.NewString(), Answers: answers}
	a.must(201, "POST", "/api/public/forms/"+code+"/submissions", req, nil)
	a.must(200, "POST", "/api/public/forms/"+code+"/submissions", req, nil)
	tasks := listTasks(t, o, b.Id, nil)
	if len(tasks) != 1 || tasks[0].Priority != v1.TaskPriority_TASK_PRIORITY_URGENT || len(ruleRuns(t, o, rule.Id)) != 1 {
		t.Fatal("submission must run automation exactly once")
	}
}

func TestBoardFormsExtendedTypes(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.Id, &v1.CreateBoardRequest{Name: "Typed intake"}, 201)
	bt := createBot(t, o, ws.Id, "typedforms")
	setBoardPerms(o, b.Id, 200, userOv(bt.id, perm.ViewBoard|perm.ManageBoard, 0))
	phone, link, multi := uuid.NewString(), uuid.NewString(), uuid.NewString()
	d := &v1.BoardFormDefinition{Title: "Contact request", StatusId: b.Statuses[0].Id, TitleFieldId: phone, Fields: []*v1.BoardFormField{
		{Id: phone, Label: "Phone", Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_PHONE, Required: true},
		{Id: link, Label: "Website", Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_URL},
		{Id: multi, Label: "Services", Type: v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_MULTISELECT, Required: true, Options: []string{"Design", "Development", "Support"}},
	}}
	path := "/api/boards/" + b.Id + "/forms"
	var fr v1.BoardFormResponse
	bt.must(201, "POST", path, &v1.CreateBoardFormRequest{Definition: d}, &fr)
	code := fr.Form.Url[strings.LastIndex(fr.Form.Url, "/")+1:]
	answers := []*v1.BoardFormAnswer{{FieldId: phone, Value: "+7 (999) 123-45-67"}, {FieldId: link, Value: "https://example.test/request"}, {FieldId: multi, Values: []string{"Support", "Design"}}}
	bt.must(200, "POST", path+"/preview", &v1.PreviewBoardFormRequest{Definition: d, Answers: answers}, nil)
	if len(listTasks(t, o, b.Id, nil)) != 0 {
		t.Fatal("preview created a task")
	}
	a := &client{t: t, ip: "192.0.2.180"}
	for _, bad := range []struct {
		field  int
		value  string
		values []string
	}{
		{0, "not a phone", nil}, {1, "javascript:alert(1)", nil}, {2, "", []string{"Design", "Design"}}, {2, "", []string{"Unknown"}},
	} {
		req := &v1.SubmitBoardFormRequest{Revision: fr.Form.Revision, Nonce: uuid.NewString(), Answers: answers}
		req = proto.Clone(req).(*v1.SubmitBoardFormRequest)
		req.Answers[bad.field].Value, req.Answers[bad.field].Values = bad.value, bad.values
		a.must(422, "POST", "/api/public/forms/"+code+"/submissions", req, nil)
	}
	if len(listTasks(t, o, b.Id, nil)) != 0 {
		t.Fatal("invalid submission created a task")
	}
	req := &v1.SubmitBoardFormRequest{Revision: fr.Form.Revision, Nonce: uuid.NewString(), Answers: answers}
	bt.must(201, "POST", "/api/forms/"+code+"/submissions", req, nil)
	answers[2].Values = []string{"Design", "Support"}
	bt.must(200, "POST", "/api/forms/"+code+"/submissions", req, nil)
	tasks := listTasks(t, o, b.Id, nil)
	if len(tasks) != 1 || tasks[0].Title != answers[0].Value || tasks[0].CreatedBy != bt.id || !strings.Contains(tasks[0].Description, "Design; Support") || !strings.Contains(tasks[0].Description, answers[1].Value) {
		t.Fatal("typed bot task differs from submitted values")
	}
	// No fixed first-field type: replace it with multiple choice and use the form name.
	d.TitleFieldId = ""
	d.Fields[0].Type = v1.BoardFormFieldType_BOARD_FORM_FIELD_TYPE_MULTISELECT
	d.Fields[0].Options = []string{"Call", "Email"}
	bt.must(200, "PUT", path+"/"+fr.Form.Id, &v1.UpdateBoardFormRequest{Definition: d, Revision: fr.Form.Revision}, &fr)
	req.Revision, req.Nonce = fr.Form.Revision, uuid.NewString()
	req.Answers[0] = &v1.BoardFormAnswer{FieldId: phone, Values: []string{"Call"}}
	anon := &client{t: t, ip: "192.0.2.181"}
	anon.must(201, "POST", "/api/public/forms/"+code+"/submissions", req, nil)
	tasks = listTasks(t, o, b.Id, nil)
	found := false
	for _, task := range tasks {
		if task.Title == d.Title && task.CreatedBy == "" {
			found = true
		}
	}
	if len(tasks) != 2 || !found {
		t.Fatal("anonymous title fallback missing")
	}
}
