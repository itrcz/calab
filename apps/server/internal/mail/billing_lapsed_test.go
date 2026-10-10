package mail

import (
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func violations() []*v1.PlanLimitViolation {
	return []*v1.PlanLimitViolation{
		{Kind: v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS, Current: 12, Limit: 10},
		{Kind: v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB, Current: 800, Limit: 500},
		{Kind: v1.PlanLimitKind_PLAN_LIMIT_KIND_TELEPHONY, Current: 1},
	}
}

// The blockers are worded in the recipient's locale: counted limits with numbers, features
// without; an unknown locale falls back to English.
func TestFreeBlockers(t *testing.T) {
	want := map[string]string{
		LocaleEN:   "members 12 / 10; storage, MB 800 / 500; telephony",
		LocaleRU:   "участники 12 / 10; хранилище, МБ 800 / 500; телефония",
		LocaleES:   "miembros 12 / 10; almacenamiento, MB 800 / 500; telefonía",
		LocaleZhCN: "成员 12 / 10; 存储（MB） 800 / 500; 电话",
		"de":       "members 12 / 10; storage, MB 800 / 500; telephony",
		"":         "members 12 / 10; storage, MB 800 / 500; telephony",
	}
	for loc, w := range want {
		if got := FreeBlockers(loc, violations()); got != w {
			t.Errorf("%q: %q, want %q", loc, got, w)
		}
	}
	if got := FreeBlockers("en", nil); got != "" {
		t.Errorf("nothing blocks: %q", got)
	}
	many := make([]*v1.PlanLimitViolation, 0, 10)
	for range 10 {
		many = append(many, &v1.PlanLimitViolation{Kind: v1.PlanLimitKind_PLAN_LIMIT_KIND_BOTS, Current: 5, Limit: 1})
	}
	if got := strings.Count(FreeBlockers("en", many), ";"); got != maxBlockers-1 {
		t.Errorf("the list is capped: %d separators", got)
	}
}

// Both mails render in every locale with the blockers and (soon) the deadline, no price anywhere,
// and the reasons row is left out when the list is unknown.
func TestLapsedMailsRender(t *testing.T) {
	for _, loc := range Locales() {
		reasons := FreeBlockers(loc, violations())
		for _, tmpl := range []Template{TemplateBillingLapsed, TemplateBillingLapseSoon} {
			p := Params{"workspace": "Team", "url": "https://app.example.com", "reasons": reasons, "deadline": "2026-10-12 09:00 UTC"}
			m, err := Render(tmpl, loc, p)
			if err != nil {
				t.Fatalf("%s/%s: %v", tmpl, loc, err)
			}
			for part, body := range map[string]string{"text": m.Text, "html": m.HTML} {
				if !strings.Contains(body, reasons) && !strings.Contains(body, strings.ReplaceAll(reasons, "&", "&amp;")) {
					t.Errorf("%s/%s %s: no blockers", tmpl, loc, part)
				}
				if tmpl == TemplateBillingLapseSoon && !strings.Contains(body, "2026-10-12 09:00 UTC") {
					t.Errorf("%s/%s %s: no deadline", tmpl, loc, part)
				}
				for _, cur := range []string{"$", "USD", "₽", "RUB", "€"} {
					if strings.Contains(body, cur) {
						t.Errorf("%s/%s %s: a price (%s) in a plan-state mail", tmpl, loc, part, cur)
					}
				}
			}
			bare, err := Render(tmpl, loc, Params{"workspace": "Team", "url": "https://app.example.com", "deadline": "2026-10-12"})
			if err != nil || strings.Contains(bare.Text, lapsedDict[loc].Reasons) {
				t.Errorf("%s/%s without blockers: %v", tmpl, loc, err)
			}
		}
	}
	if !IsBillingTemplate(TemplateBillingLapsed) || !IsBillingTemplate(TemplateBillingLapseSoon) {
		t.Error("lapsed mails are billing (financial) templates")
	}
}
