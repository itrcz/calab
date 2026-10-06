package messages

import (
	"context"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Literal @nick mentions (ADR-0077). The stored form of a mention stays @<user_id>: a
// literal @nick typed by hand, by a bot or through the API becomes @<user_id> when that user
// is visible to the sender in the room; other nicks stay text.

var (
	// The "@" starts at a non-word boundary ("mail@x" is no mention); the name is checked
	// against the nickname rules (users.ValidateUsername) by the lookup itself.
	nickRE = regexp.MustCompile(`(?:^|[^\p{L}\p{N}_.@-])@([A-Za-z][A-Za-z0-9_]{2,31})`)
	// A @<uuid> mention whose first group looks like a name ("@abcdef12-…") is not a nick.
	uuidHeadRE = regexp.MustCompile(`^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
)

// nickSpan is one literal @nick: content[at:end] is "@name".
type nickSpan struct {
	at, end int
	name    string // lower case
}

// literalNicks finds the @nick tokens outside code blocks and spans (at most maxMentions
// distinct names).
func literalNicks(content string) []nickSpan {
	blank := func(m string) string { return strings.Repeat(" ", len(m)) }
	masked := codeSpanRE.ReplaceAllStringFunc(codeBlockRE.ReplaceAllStringFunc(content, blank), blank)
	var out []nickSpan
	seen := map[string]bool{}
	for _, m := range nickRE.FindAllStringSubmatchIndex(masked, -1) {
		start, end := m[2], m[3]
		if r, _ := utf8.DecodeRuneInString(masked[end:]); end < len(masked) && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
			continue // longer than a nickname, or followed by non-ASCII letters
		}
		if uuidHeadRE.MatchString(masked[start:]) {
			continue
		}
		name := strings.ToLower(masked[start:end])
		if name == "everyone" || name == "here" {
			continue
		}
		if !seen[name] {
			if len(seen) >= maxMentions {
				continue
			}
			seen[name] = true
		}
		out = append(out, nickSpan{at: start - 1, end: end, name: name})
	}
	return out
}

// resolveNicks rewrites the literal @nick mentions of content to @<user_id> for the users
// the sender sees in the room: in a DM its participants; in a workspace room (task comment
// rooms included) the workspace's members — for a guest sender only the people visible to
// it (perm.GuestVisible). If the result would exceed MaxContent, content is kept as is.
func resolveNicks(ctx context.Context, q *sqlc.Queries, content string, acc perm.RoomAccess, sender uuid.UUID) (string, error) {
	spans := literalNicks(content)
	if len(spans) == 0 {
		return content, nil
	}
	names := make([]string, 0, len(spans))
	seen := map[string]bool{}
	for _, s := range spans {
		if !seen[s.name] {
			seen[s.name] = true
			names = append(names, s.name)
		}
	}
	ids := map[string]uuid.UUID{}
	if acc.DM {
		rows, err := q.ResolveUsernames(ctx, names)
		if err != nil {
			return "", err
		}
		for _, r := range rows {
			for _, m := range acc.Members { // the participants (a notes shelf: the owner)
				if r.ID == m {
					ids[strings.ToLower(r.Username)] = r.ID
				}
			}
		}
	} else {
		rows, err := q.ResolveMemberUsernames(ctx, sqlc.ResolveMemberUsernamesParams{WorkspaceID: acc.WorkspaceID, Names: names})
		if err != nil {
			return "", err
		}
		var visible map[uuid.UUID]bool
		if acc.Role == perm.RoleGuest && len(rows) > 0 {
			if visible, err = rooms.GuestVisibleUsers(ctx, q, nil, acc.WorkspaceID, sender); err != nil {
				return "", err
			}
		}
		for _, r := range rows {
			if visible == nil || visible[r.ID] {
				ids[strings.ToLower(r.Username)] = r.ID
			}
		}
	}
	if len(ids) == 0 {
		return content, nil
	}
	var b strings.Builder
	last := 0
	for _, s := range spans {
		id, ok := ids[s.name]
		if !ok {
			continue
		}
		b.WriteString(content[last:s.at])
		b.WriteString("@" + id.String())
		last = s.end
	}
	b.WriteString(content[last:])
	if out := b.String(); utf8.RuneCountInString(out) <= MaxContent {
		return out, nil
	}
	return content, nil
}
