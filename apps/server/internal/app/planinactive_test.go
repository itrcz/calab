package app

import (
	"net/http"
	"strings"
	"testing"
)

// Every route of the restricted mode is a registered write route whose workspace the identity
// gate resolves (so the check can run), and the billing routes — the way out — are never in it.
func TestPlanInactiveRoutesClassified(t *testing.T) {
	for pattern, action := range planInactiveRoutes {
		scope, ok := identityRoutes[pattern]
		if !ok {
			t.Errorf("%q is not a registered route", pattern)
			continue
		}
		method, _, _ := strings.Cut(pattern, " ")
		if method == http.MethodGet || method == http.MethodHead || action == "" {
			t.Errorf("%q: only write routes with an action are restricted", pattern)
		}
		switch scope {
		case scopePublic, scopeGlobal, scopeAdmin, scopeProfile, scopeAggregate, scopeMachine, scopeVoice, scopeBilling:
			t.Errorf("%q: scope %d has no workspace for the restricted-mode check", pattern, scope)
		}
	}
}
