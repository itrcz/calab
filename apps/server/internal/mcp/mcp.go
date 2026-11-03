// Package mcp is the Model Context Protocol endpoint for bots (CBF-48): any LLM client works
// with Calab through a bot token. It speaks JSON-RPC 2.0 over the Streamable HTTP transport
// (POST only, JSON answers, no server stream and no sessions) and offers a small set of tools.
//
// A tool never touches the services directly: it calls the REST API of the server in process
// with the caller's own Authorization header (Handler.API), so authentication, the bot route
// table, the rate limits, the identity gate and every handler's permission check apply exactly
// as to the bot's own REST call — an MCP tool gives a bot nothing its token does not give it.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Path is the endpoint's route (any method; only POST is served).
const Path = auth.MCPPath

// maxBody caps a JSON-RPC request.
const maxBody = 1 << 20

// protocolVersions are the MCP revisions this server speaks, newest first. The answer to
// initialize repeats the client's version when it is one of them, else the newest.
var protocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

// instructions is sent once in initialize: kept short, the tools describe themselves.
const instructions = "Calab as the signed-in person (OAuth), this bot, or the person it acts for (Calab-On-Behalf): find ids with find or list_tasks, then read / act; \"me\" is that identity. Rights are its roles; a refusal is final."

// ErrNotBot answers a person's app session: the endpoint takes a bot token (itself or on behalf,
// ADR-0156) or the token of the person's MCP session (OAuth, ADR-0158).
var ErrNotBot = httpx.Forbidden("the MCP endpoint needs an MCP connection (OAuth) or a bot token")

// Handler serves Path. It must run inside auth.Require (the private route wrapper).
type Handler struct {
	// API is the server's full HTTP handler: tools call REST routes through it. Set before the
	// first request (the app builds it after the routes).
	API http.Handler
	// Version is the server version reported in initialize.
	Version string
}

// New returns a handler; API is set later.
func New(version string) *Handler { return &Handler{Version: version} }

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// JSON-RPC error codes.
const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
)

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		// No server-initiated stream (GET) and no sessions to end (DELETE): 405 per the transport.
		w.Header().Set("Allow", http.MethodPost)
		httpx.WriteError(w, r, httpx.Coded(http.StatusMethodNotAllowed, v1.ErrorCode_ERROR_CODE_BAD_REQUEST, "only POST is served"))
		return
	}
	id, ok := auth.FromContext(r.Context())
	if !ok || (!id.Machine() && !id.MCP) {
		httpx.WriteError(w, r, ErrNotBot)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		writeRPC(w, http.StatusRequestEntityTooLarge, rpcResponse{Error: &rpcError{codeInvalidRequest, "request too large"}})
		return
	}
	body = bytes.TrimSpace(body)
	if len(body) > 0 && body[0] == '[' {
		writeRPC(w, http.StatusBadRequest, rpcResponse{Error: &rpcError{codeInvalidRequest, "batches are not supported"}})
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeRPC(w, http.StatusBadRequest, rpcResponse{Error: &rpcError{codeParse, "invalid JSON"}})
		return
	}
	if req.JSONRPC != "2.0" || req.Method == "" {
		writeRPC(w, http.StatusBadRequest, rpcResponse{ID: req.ID, Error: &rpcError{codeInvalidRequest, "not a JSON-RPC 2.0 request"}})
		return
	}
	if len(req.ID) == 0 || string(req.ID) == "null" {
		// A notification (initialized, cancelled, …): nothing to answer.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	result, rerr := h.dispatch(r, req)
	writeRPC(w, http.StatusOK, rpcResponse{ID: req.ID, Result: result, Error: rerr})
}

func (h *Handler) dispatch(r *http.Request, req rpcRequest) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		v := protocolVersions[0]
		for _, s := range protocolVersions {
			if s == p.ProtocolVersion {
				v = s
			}
		}
		return map[string]any{
			"protocolVersion": v,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "calab", "version": h.Version},
			"instructions":    instructions,
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": toolList}, nil
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &rpcError{codeInvalidParams, "invalid params"}
		}
		t, ok := tools[p.Name]
		if !ok {
			return nil, &rpcError{codeInvalidParams, "unknown tool " + p.Name}
		}
		var a args
		if len(p.Arguments) > 0 && string(p.Arguments) != "null" {
			if err := json.Unmarshal(p.Arguments, &a); err != nil {
				return toolError("arguments: " + err.Error()), nil
			}
		}
		out, err := t.run(r.Context(), &api{h: h.API, outer: r}, a)
		if err != nil {
			return toolError(errText(err)), nil
		}
		b, err := json.Marshal(out)
		if err != nil {
			return toolError("internal error"), nil
		}
		return map[string]any{"content": []map[string]any{{"type": "text", "text": string(b)}}}, nil
	}
	return nil, &rpcError{codeMethodNotFound, "method not found: " + req.Method}
}

// toolError is a tool result the model reads (MCP: tool failures are results, not protocol
// errors), so it can correct the arguments or give up.
func toolError(text string) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": true}
}

func errText(err error) string {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.Error()
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	return err.Error()
}

func writeRPC(w http.ResponseWriter, status int, resp rpcResponse) {
	resp.JSONRPC = "2.0"
	if resp.ID == nil {
		resp.ID = json.RawMessage("null")
	}
	b, _ := json.Marshal(resp)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}
