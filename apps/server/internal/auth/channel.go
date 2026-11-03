package auth

import "context"

// The channel of a request (ADR-0156): how the action reached the API. Only the server sets it,
// in process — the MCP endpoint marks the REST calls of its tools — so no header or claim of a
// client can forge it. Messages and task journal entries of the request's own actor keep it
// (messages.via, task_activity.via) and the clients show «via MCP».
const (
	// ChannelMCP: a tool of the MCP endpoint (/api/mcp) made the call.
	ChannelMCP = "mcp"
)

type channelKey struct{}

// WithChannel marks ctx as a request that came through channel (ChannelMCP).
func WithChannel(ctx context.Context, channel string) context.Context {
	return context.WithValue(ctx, channelKey{}, channel)
}

// Channel returns the channel of the request for storing (messages.via, task_activity.via), or
// nil for an ordinary request.
func Channel(ctx context.Context) *string {
	if c, ok := ctx.Value(channelKey{}).(string); ok && c != "" {
		return &c
	}
	return nil
}
