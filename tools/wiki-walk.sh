#!/bin/sh
# Wiki REST walkthrough with the exact requests of apps/desktop/src/renderer/services/wiki.ts
# (W7, docs/plans/wiki-v1-tasks.md). Usage: tools/wiki-walk.sh http://127.0.0.1:3066 [dump-dir]
# Needs a running server with REGISTRATION_MODE=open and curl + jq. Prints one line per step, exits 1
# on a mismatch. With a dump dir every answer is saved there as <name>.json — the fixtures of
# apps/desktop/src/renderer/services/__fixtures__/wiki (wiki.wire.test.ts). The sync socket and the
# versions need a browser: apps/desktop/e2e-web/wiki.spec.ts covers them.
set -eu
[ -z "${WALK_TRACE:-}" ] || set -x
B=${1:-http://127.0.0.1:3066}
DUMP=${2:-}
J='content-type: application/json'
TMP=${TMPDIR:-/tmp}/wiki-walk.$$
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT
[ -z "$DUMP" ] || mkdir -p "$DUMP"
fail() { echo "FAIL: $*" >&2; exit 1; }
want() { [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"; echo "ok  $1"; }
# keep NAME — saves the last answer ($TMP/last) as a fixture
keep() { [ -z "$DUMP" ] || cp "$TMP/last" "$DUMP/$1.json"; }
# call METHOD URL [json-body] — body to $TMP/last, prints the status
call() {
  m=$1; u=$2; shift 2
  if [ $# -gt 0 ]; then curl -s -o "$TMP/last" -w '%{http_code}' -X "$m" "$u" -H "$A" -H "$J" -d "$1"
  else curl -s -o "$TMP/last" -w '%{http_code}' -X "$m" "$u" -H "$A"; fi
}
S=$(date +%s)
E="w7-$S@example.com"
T=$(curl -sf -X POST "$B/api/auth/register" -H "$J" -d "{\"email\":\"$E\",\"password\":\"w7-password-1\",\"displayName\":\"W7\"}" | jq -r .tokens.accessToken)
A="authorization: Bearer $T"
WS=$(curl -sf -X POST "$B/api/workspaces" -H "$A" -H "$J" -d "{\"slug\":\"w7-$S\",\"name\":\"W7\"}" | jq -r '.workspace.id')
W="$B/api/workspaces/$WS/wiki"

# createPage: POST …/wiki/pages {parentId, title, icon}; the client creates an untitled page (title "")
want "create untitled: 201" "$(call POST "$W/pages" '{"parentId":"","title":"","icon":""}')" "201"
keep create-untitled
UNT=$(jq -r .page.id "$TMP/last")
want "untitled title kept empty" "$(jq -r .page.title "$TMP/last")" ""
want "owner bits (view+write+manage)" "$(jq -r '.page.myBits' "$TMP/last")" "1924145348608"
want "create titled: 201" "$(call POST "$W/pages" '{"parentId":"","title":"Hello","icon":"📝"}')" "201"
P=$(jq -r .page.id "$TMP/last")
BODY="{\"parentId\":\"$P\",\"title\":\"Kid\",\"icon\":\"\"}" # (nested quotes in $(…) break old /bin/sh)
want "child: 201" "$(call POST "$W/pages" "$BODY")" "201"
KID=$(jq -r .page.id "$TMP/last")
# loadChildren: GET …/pages?parent=&cursor= (top level: no parent); has_children on the row
call GET "$W/pages" > /dev/null; keep list-top
want "top listing order" "$(jq -r '[.pages[].title] | join(",")' "$TMP/last")" ",Hello"
want "has_children" "$(jq -r '.pages[1].hasChildren' "$TMP/last")" "true"
want "nextCursor empty" "$(jq -r .nextCursor "$TMP/last")" ""
call GET "$W/pages?parent=$P" > /dev/null; keep list-children
want "children listing" "$(jq -r '.pages[0].id == "'"$KID"'"' "$TMP/last")" "true"
# loadPage: GET /api/wiki/pages/{id} + …/path
call GET "$B/api/wiki/pages/$KID/path" > /dev/null; keep path
want "path crumbs" "$(jq -r '[.pages[].title] | join("/")' "$TMP/last")" "Hello/Kid"
# update: rename + icon (PATCH), move (parentId + position)
call PATCH "$B/api/wiki/pages/$P" '{"title":"Hello wiki","icon":"📚"}' > /dev/null; keep patch
want "rename+icon" "$(jq -r '.page.title + .page.icon' "$TMP/last")" "Hello wiki📚"
call PATCH "$B/api/wiki/pages/$KID" '{"parentId":"","position":0}' > /dev/null; keep move
want "move to top at 0" "$(jq -r '.page.parentId + (.page.position|tostring)' "$TMP/last")" "0"
call GET "$W/pages" > /dev/null
want "moved first" "$(jq -r '.pages[0].id == "'"$KID"'"' "$TMP/last")" "true"
# uploadImage: multipart "file" → {file: FileMeta}; cover via PATCH cover_file_id
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$TMP/p.png"
want "upload: 201" "$(curl -s -o "$TMP/last" -w '%{http_code}' -X POST "$B/api/wiki/pages/$P/files" -H "$A" -F "file=@$TMP/p.png;filename=p.png;type=image/png")" "201"
keep upload
FILE=$(jq -r .file.id "$TMP/last")
want "upload wrapper {file}" "$(jq -r '.file.name' "$TMP/last")" "p.png"
BODY="{\"coverFileId\":\"$FILE\"}"
call PATCH "$B/api/wiki/pages/$P" "$BODY" > /dev/null
want "cover set" "$(jq -r '.page.cover.id == "'"$FILE"'"' "$TMP/last")" "true"
# link: POST …/link {include_children, expires_at?} → {link, url}; the public page and its state stream
want "link: 201" "$(call POST "$B/api/wiki/pages/$P/link" '{"includeChildren":true}')" "201"
keep link
CODE=$(jq -r .link.code "$TMP/last")
want "link url path" "$(jq -r '.url | test("/w/'"$CODE"'$")' "$TMP/last")" "true"
curl -s -o "$TMP/last" "$B/api/public/wiki/$CODE"; keep public
want "public meta title" "$(jq -r .title "$TMP/last")" "Hello wiki"
want "public rootId" "$(jq -r '.rootId == "'"$P"'"' "$TMP/last")" "true"
want "public state" "$(curl -s -o "$TMP/state.bin" -w '%{http_code} %{content_type}' "$B/api/public/wiki/$CODE/state")" "200 application/octet-stream"
want "public picture" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/public/wiki/$CODE/files/$FILE")" "200"
# search: GET /api/search?q=&scope=&type=wiki&limit=20
sleep 1
call GET "$B/api/search?q=Hello&scope=$WS&type=wiki&limit=20" > /dev/null; keep search
want "search hit" "$(jq -r '.sections[0].type + " " + .sections[0].items[0].wiki.pageId' "$TMP/last")" "SEARCH_TYPE_WIKI $P"
# permissions (client: callEmpty PUT, then GET)
want "permissions PUT" "$(call PUT "$B/api/wiki/pages/$P/permissions" '{"entries":[],"restricted":false}')" "200"
call GET "$B/api/wiki/pages/$P/permissions" > /dev/null; keep perms
# journal, versions (empty before the first snapshot), settings
call GET "$B/api/wiki/pages/$P/activity" > /dev/null; keep activity
want "activity kinds" "$(jq -r '[.activities[].kind] | contains(["WIKI_ACTIVITY_KIND_CREATE","WIKI_ACTIVITY_KIND_RENAME","WIKI_ACTIVITY_KIND_LINK_ON"])' "$TMP/last")" "true"
call GET "$B/api/wiki/pages/$P/versions" > /dev/null; keep versions-empty
want "versions empty" "$(jq -r '.versions | length' "$TMP/last")" "0"
want "settings PUT" "$(call PUT "$W/settings" '{"trashDays":7}')" "200"
call GET "$W/settings" > /dev/null; keep settings
want "settings GET" "$(jq -r .trashDays "$TMP/last")" "7"
want "link DELETE" "$(call DELETE "$B/api/wiki/pages/$P/link")" "204"
# trash → listing trashed=1 → restore; a live page is not deletable forever (409)
want "trash: 200" "$(call POST "$B/api/wiki/pages/$P/trash")" "200"
keep trash
want "trashed root" "$(jq -r '.page.trashedRoot' "$TMP/last")" "true"
call GET "$W/pages?trashed=1" > /dev/null; keep list-trash
want "trash listing" "$(jq -r '.pages[0].id == "'"$P"'"' "$TMP/last")" "true"
want "restore" "$(call POST "$B/api/wiki/pages/$P/restore")" "200"
want "delete live page refused" "$(call DELETE "$B/api/wiki/pages/$P")" "409"
call POST "$B/api/wiki/pages/$KID/trash" > /dev/null
want "delete forever" "$(call DELETE "$B/api/wiki/pages/$KID")" "204"
call POST "$B/api/wiki/pages/$UNT/trash" > /dev/null
call POST "$W/trash/empty" > /dev/null; keep trash-empty
want "empty trash" "$(jq -r .deleted "$TMP/last")" "1"
want "gone: 404" "$(call GET "$B/api/wiki/pages/$KID")" "404"
keep not-found
want "sync without upgrade: 426" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/wiki/pages/$P/sync")" "426"
echo "ALL OK"
