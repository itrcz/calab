package mcp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
)

// innerRoutes are the route patterns the tools call (api.call): an MCP connection's token
// (ADR-0158) reaches these and the endpoint, nothing else (auth.Service.MCPInnerRoutes). A new
// tool that calls another route adds it here; the OAuth integration test runs every tool.
var innerRoutes = []string{
	"GET /api/boards/{id}",
	"GET /api/me/tasks",
	"GET /api/rooms/{id}",
	"GET /api/rooms/{id}/messages",
	"GET /api/search",
	"GET /api/t/{key}",
	"GET /api/tasks/{id}",
	"GET /api/workspaces",
	"GET /api/workspaces/{id}/boards",
	"GET /api/workspaces/{id}/members",
	"GET /api/workspaces/{id}/members/{userId}",
	"GET /api/workspaces/{id}/rooms",
	"GET /api/workspaces/{id}/tasks/search",
	"PATCH /api/tasks/{id}",
	"POST /api/boards/{id}/tasks",
	"POST /api/rooms/{id}/messages",
	"PUT /api/tasks/{id}/assignees",
}

// InnerRoutes returns the set of innerRoutes.
func InnerRoutes() map[string]bool {
	m := make(map[string]bool, len(innerRoutes))
	for _, r := range innerRoutes {
		m[r] = true
	}
	return m
}

// maxAnswer caps one REST answer read by a tool (a page of history with attachments fits).
const maxAnswer = 8 << 20

// api calls REST routes of the server in process as the MCP caller: the same Authorization
// header goes through the whole handler chain (auth.Require, the bot route table, rate limits,
// the identity gate, the handler's own permission checks).
type api struct {
	h     http.Handler
	outer *http.Request
}

// apiError is a REST refusal as the model reads it.
type apiError struct {
	status int
	e      *v1.ApiError
}

func (a *apiError) Error() string {
	code := strings.TrimPrefix(a.e.GetCode().String(), "ERROR_CODE_")
	msg := fmt.Sprintf("%d %s: %s", a.status, code, a.e.GetMessage())
	if r := a.e.GetReason(); r != "" {
		msg += " (" + r + ")"
	}
	if f := a.e.GetField(); f != "" {
		msg += " [field " + f + "]"
	}
	return msg
}

var (
	marshal   = protojson.MarshalOptions{}
	unmarshal = protojson.UnmarshalOptions{DiscardUnknown: true}
)

// call performs method path?query with body (nil = none) and decodes the answer into out
// (nil = ignore). A status ≥ 400 is an *apiError.
func (a *api) call(ctx context.Context, method, path string, query url.Values, body, out proto.Message) error {
	if a.h == nil {
		return errors.New("MCP endpoint is not wired")
	}
	var rd io.Reader = http.NoBody
	if body != nil {
		b, err := marshal.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	u := path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	// A fresh context, cancelled with the MCP request: none of the outer request's values (its
	// identity, mutation boundary, publish budget) leak into the inner one, which the chain
	// builds itself like for any REST call.
	// The one value it carries is the channel (ADR-0156): what the call writes is marked «via MCP».
	inner, cancel := context.WithCancel(auth.WithChannel(context.Background(), auth.ChannelMCP))
	defer cancel()
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	req, err := http.NewRequestWithContext(inner, method, u, rd)
	if err != nil {
		return err
	}
	// Only what identifies the caller: the token, Calab-On-Behalf (ADR-0156: the inner call is
	// checked on behalf again, route by route) and the client address headers (the chain
	// recomputes the client IP from RemoteAddr and the trusted proxies).
	for _, k := range []string{"Authorization", auth.OnBehalfHeader, "X-Forwarded-For", "X-Real-Ip", "User-Agent", "Accept-Language"} {
		if v := a.outer.Header.Values(k); len(v) > 0 {
			req.Header[k] = v
		}
	}
	req.RemoteAddr, req.Host = a.outer.RemoteAddr, a.outer.Host
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := &recorder{header: http.Header{}}
	a.h.ServeHTTP(rec, req)
	if rec.overflow {
		return errors.New("answer too large")
	}
	st := rec.code()
	if st >= 400 {
		var e v1.ApiError
		if err := unmarshal.Unmarshal(rec.buf.Bytes(), &e); err != nil || e.GetMessage() == "" {
			e.Message = http.StatusText(st)
		}
		return &apiError{status: st, e: &e}
	}
	if out != nil && rec.buf.Len() > 0 {
		if err := unmarshal.Unmarshal(rec.buf.Bytes(), out); err != nil {
			return fmt.Errorf("decode %s %s: %w", method, path, err)
		}
	}
	return nil
}

// recorder is the in-process response of a tool's REST call.
type recorder struct {
	header   http.Header
	status   int
	buf      bytes.Buffer
	overflow bool
}

func (r *recorder) Header() http.Header { return r.header }

func (r *recorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
}

func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	if r.buf.Len()+len(b) > maxAnswer {
		r.overflow = true
		return 0, errors.New("mcp: answer too large")
	}
	return r.buf.Write(b)
}

func (r *recorder) code() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

// seg escapes one path segment.
func seg(s string) string { return url.PathEscape(strings.TrimSpace(s)) }
