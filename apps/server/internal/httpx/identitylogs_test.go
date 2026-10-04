package httpx

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConsentCapabilitiesNeverAppearInHTTPLogs(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(previous)
	secret := "calab_request_sensitive_capability" //nolint:gosec // Non-secret redaction test marker.
	mux := http.NewServeMux()
	mux.Handle("POST /api/oauth/requests/{request}/bind", HandlerFunc(func(http.ResponseWriter, *http.Request) error {
		return fmt.Errorf("database error contains %s", secret)
	}))
	handler := Observe(mux)
	for _, raw := range []string{"/api/oauth/requests/" + secret + "/bind", "/api/oauth/requests/" + secret + "/unknown", "/api/oauth//requests/" + secret + "/bind", "/api/oauth/requests/" + secret + "/../bind", "/api/oauth/requests%2F" + secret + "%2Fbind"} {
		req := httptest.NewRequestWithContext(context.Background(), "POST", raw, nil)
		handler.ServeHTTP(httptest.NewRecorder(), req)
		canceled, cancel := context.WithCancel(context.Background())
		cancel()
		WriteError(httptest.NewRecorder(), req.WithContext(canceled), fmt.Errorf("dependency %s", secret))
	}
	if strings.Contains(logs.String(), secret) {
		t.Fatalf("consent capability leaked in logs: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "/api/oauth/requests/{request}/bind") || !strings.Contains(logs.String(), "unmatched") {
		t.Fatal("redaction lost useful route evidence")
	}
}

func TestFormCapabilitiesNeverAppearInHTTPLogs(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	marker := "form-capability-sentinel"
	mux := http.NewServeMux()
	mux.Handle("POST /api/public/forms/{code}/submissions", HandlerFunc(func(http.ResponseWriter, *http.Request) error { return fmt.Errorf("database %s", marker) }))
	handler := Observe(mux)
	for _, raw := range []string{"/api/public/forms/" + marker + "/submissions", "/api/forms/" + marker, "/api/public//forms/" + marker, "/api/public/forms%2F" + marker, "/f/" + marker} {
		req := httptest.NewRequestWithContext(context.Background(), "POST", raw, nil)
		handler.ServeHTTP(httptest.NewRecorder(), req)
		WriteError(httptest.NewRecorder(), req, fmt.Errorf("source %s", marker))
	}
	if strings.Contains(logs.String(), marker) {
		t.Fatal("form capability leaked")
	}
}
