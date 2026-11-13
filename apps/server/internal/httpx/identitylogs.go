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

// sensitiveCanvasPath: a public canvas link code is a capability (like a form code).
func sensitiveCanvasPath(r *http.Request) bool {
	const prefix = "/api/public/canvas"
	for _, value := range []string{r.URL.Path, path.Clean(r.URL.Path)} {
		if value == prefix || strings.HasPrefix(value, prefix+"/") {
			return true
		}
	}
	return false
}

// sensitiveOfficePath: the file and callback URLs the Document Server calls carry signed
// capabilities (ADR-0143: the callback token has no expiry and names the item and the session
// key); so do the file URLs of the MCP tools (CBF-185/187).
func sensitiveOfficePath(r *http.Request) (string, bool) {
	for _, value := range []string{r.URL.Path, path.Clean(r.URL.Path)} {
		for _, prefix := range []string{"/api/office/file", "/api/office/callback", "/api/mcp/file", "/api/mcp/upload"} {
			if value == prefix || strings.HasPrefix(value, prefix+"/") {
				return prefix + "/{token}", true
			}
		}
	}
	return "", false
}

func safeLogPath(r *http.Request) string {
	if p, ok := sensitiveOfficePath(r); ok {
		return p
	}
	if sensitiveFormPath(r) {
		return "/forms/{code}"
	}
	if sensitiveCanvasPath(r) {
		return "/api/public/canvas/{code}"
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
	if sensitiveCanvasPath(r) {
		return "canvas request failed"
	}
	if sensitiveConsentPath(r) {
		return "consent request failed"
	}
	return err
}
