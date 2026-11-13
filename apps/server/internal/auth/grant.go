package auth

import (
	"context"

	"github.com/google/uuid"
)

// Grants (ADR-0158 addendum «files»): the MCP tools hand an agent short-lived signed URLs to
// download an attachment or upload a file with curl, so the bytes never pass through the model.
// Such a URL carries no token: it names the tool's caller as a Grant, and the URL's handler
// replays the REST call in process with the Grant in the context (a server-only value, like the
// channel: no header or claim of a client sets it). Require then rebuilds the identity from the
// Grant and checks it is still alive — the bot's token is still its current one, the MCP session
// is not revoked — and the rest of the chain (the bot route table, the identity gate, the
// handler's own permission checks) runs as for the caller's own call.

// Grant is the caller of an MCP tool as a signed URL keeps it: the token's subject (a bot and its
// token id, or a person and their MCP session) and the Calab-On-Behalf of the call.
type Grant struct {
	UserID    uuid.UUID `json:"u"`
	SessionID uuid.UUID `json:"s"`
	Bot       bool      `json:"b,omitempty"`
	// OnBehalf is the Calab-On-Behalf value ("" none, "owner", a member's user id): the replayed
	// call sends it again and is checked on behalf again (ADR-0106 / ADR-0111).
	OnBehalf string `json:"o,omitempty"`
}

// GrantOf is the Grant of an MCP caller's identity; false for an identity the MCP endpoint does
// not serve (a person's app session).
func GrantOf(id Identity) (Grant, bool) {
	switch {
	case id.OnBehalf():
		ob := OnBehalfOwner
		if id.ForMember {
			ob = id.UserID.String()
		}
		return Grant{UserID: id.ViaBot, SessionID: id.SessionID, Bot: true, OnBehalf: ob}, true
	case id.IsBot:
		return Grant{UserID: id.UserID, SessionID: id.SessionID, Bot: true}, true
	case id.MCP:
		return Grant{UserID: id.UserID, SessionID: id.SessionID}, true
	}
	return Grant{}, false
}

type grantKey struct{}

// WithGrant marks ctx as an in-process call made for g (the signed URL handlers of the MCP tools).
func WithGrant(ctx context.Context, g Grant) context.Context {
	return context.WithValue(ctx, grantKey{}, g)
}

func grantFrom(ctx context.Context) (Grant, bool) {
	g, ok := ctx.Value(grantKey{}).(Grant)
	if !ok {
		return Grant{}, false
	}
	// Only the MCP tools' in-process calls carry a grant.
	if c := Channel(ctx); c == nil || *c != ChannelMCP {
		return Grant{}, false
	}
	return g, true
}

// grantIdentity rebuilds the identity of g now: the bot's token id must still be its current,
// unrevoked token (a replaced or revoked token, a disabled or deleted bot: ErrSessionRevoked);
// an MCP session must be alive (liveSession). On behalf is applied afterwards by Require from
// the replayed call's header, like for any bot request.
func (s *Service) grantIdentity(ctx context.Context, g Grant) (Identity, error) {
	if g.UserID == uuid.Nil || g.SessionID == uuid.Nil {
		return Identity{}, ErrInvalidToken
	}
	if !g.Bot {
		return s.liveSession(ctx, Identity{UserID: g.UserID, SessionID: g.SessionID, MCP: true})
	}
	a, err := s.loadBotAuth(ctx, g.UserID)
	if err != nil {
		return Identity{}, err
	}
	if a.hash == nil || a.tokenID != g.SessionID {
		return Identity{}, ErrSessionRevoked
	}
	revoked, err := s.IsRevoked(ctx, a.tokenID)
	if err != nil {
		return Identity{}, err
	}
	if revoked {
		return Identity{}, ErrSessionRevoked
	}
	return Identity{UserID: g.UserID, SessionID: a.tokenID, IsBot: true}, nil
}
