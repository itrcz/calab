package httpx

import (
	"net/http"
	"path"
	"strings"
)

// Consent request IDs are capabilities, including the initial CSRF handle. Treat
// malformed and unmatched paths the same as registered routes; logging cannot
// depend on ServeMux having successfully resolved a pattern.
func sensitiveConsentPath(r *http.Request) bool {
	const prefix = "/api/oauth/requests"
	for _, value := range []string{r.URL.Path, path.Clean(r.URL.Path)} {
		if value == prefix || strings.HasPrefix(value, prefix+"/") {
			return true
		}
	}
	return false
}

func sensitiveFormPath(r *http.Request) bool {
	for _, value := range []string{r.URL.Path, path.Clean(r.URL.Path)} {
		for _, prefix := range []string{"/api/public/forms", "/api/forms", "/f"} {
			if value == prefix || strings.HasPrefix(value, prefix+"/") {
				return true
			}
		}
	}
	return false
}

func safeLogPath(r *http.Request) string {
	if sensitiveFormPath(r) {
		return "/forms/{code}"
	}
	if sensitiveConsentPath(r) {
		if strings.HasSuffix(r.URL.Path, "/bind") {
			return "/api/oauth/requests/{request}/bind"
		}
		if strings.HasSuffix(r.URL.Path, "/decision") {
			return "/api/oauth/requests/{request}/decision"
		}
		return "/api/oauth/requests/{request}"
	}
	return r.URL.Path
}

func safeLogError(r *http.Request, err error) any {
	if sensitiveFormPath(r) {
		return "form request failed"
	}
	if sensitiveConsentPath(r) {
		return "consent request failed"
	}
	return err
}
