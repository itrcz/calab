#!/bin/sh
# Disk REST walkthrough with the exact requests of apps/desktop/src/renderer/services/disk.ts
# (D6, docs/plans/disk-v1-tasks.md). Usage: tools/disk-walk.sh http://127.0.0.1:3066
# Needs a running server with REGISTRATION_MODE=open and jq. Prints one line per step, exits 1 on a mismatch.
set -eu
B=${1:-http://127.0.0.1:3066}
J='content-type: application/json'
fail() { echo "FAIL: $*" >&2; exit 1; }
want() { [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"; echo "ok  $1"; }
E="d6-$(date +%s)@example.com"
T=$(curl -sf -X POST "$B/api/auth/register" -H "$J" -d "{\"email\":\"$E\",\"password\":\"d6-password-1\",\"displayName\":\"D6\"}" | jq -r .tokens.accessToken)
A="authorization: Bearer $T"
SLUG="d6-$(date +%s)"
WS=$(curl -sf -X POST "$B/api/workspaces" -H "$A" -H "$J" -d "{\"slug\":\"$SLUG\",\"name\":\"D6\"}" | jq -r '.workspace.id')
D="$B/api/workspaces/$WS/disk"
# createFolder: POST …/folders {parentId, name}
F=$(curl -sf -X POST "$D/folders" -H "$A" -H "$J" -d '{"parentId":"","name":"Docs"}' | jq -r .item.id)
want "folder created" "$(curl -sf "$D/items?sort=name" -H "$A" | jq -r '.items[0].name')" "Docs"
# uploadInto: multipart field "file", parent in the query
printf 'hello disk' > "${TMPDIR:-/tmp}/d6.txt"
U=$(curl -sf -X POST "$D/upload?parent=$F" -H "$A" -F "file=@${TMPDIR:-/tmp}/d6.txt;filename=d6.txt;type=text/plain")
FILE=$(echo "$U" | jq -r .item.id)
want "uploaded name" "$(echo "$U" | jq -r .item.name)" "d6.txt"
want "listing parent+sort" "$(curl -sf "$D/items?parent=$F&sort=name" -H "$A" | jq -r '.items | length')" "1"
want "listing nextCursor empty" "$(curl -sf "$D/items?parent=$F&sort=updated" -H "$A" | jq -r '.nextCursor')" ""
want "path crumbs" "$(curl -sf "$B/api/disk/items/$FILE/path" -H "$A" | jq -r '[.items[].name] | join("/")')" "Docs/d6.txt"
# paging: limit=1 over a folder with 2 files → next_cursor, then the cursor gives the other one
curl -sf -X POST "$D/upload?parent=$F" -H "$A" -F "file=@${TMPDIR:-/tmp}/d6.txt;filename=second.txt;type=text/plain" > /dev/null
P1=$(curl -sf "$D/items?parent=$F&sort=name&limit=1" -H "$A")
C=$(echo "$P1" | jq -r .nextCursor)
[ -n "$C" ] || fail "no nextCursor on the first page"
want "page 2 via cursor" "$(curl -sf "$D/items?parent=$F&cursor=$C&sort=name&limit=1" -H "$A" | jq -r '.items[0].name != "'"$(echo "$P1" | jq -r '.items[0].name')"'"')" "true"
# rename / move
want "rename" "$(curl -sf -X PATCH "$B/api/disk/items/$FILE" -H "$A" -H "$J" -d '{"name":"d6b.txt"}' | jq -r .item.name)" "d6b.txt"
want "move to root" "$(curl -sf -X PATCH "$B/api/disk/items/$FILE" -H "$A" -H "$J" -d '{"parentId":""}' | jq -r '.item.parentId')" ""
# trash / listing trashed=1 / restore
curl -sf -X POST "$B/api/disk/items/$FILE/trash" -H "$A" > /dev/null
want "trash listing" "$(curl -sf "$D/items?trashed=1&sort=name" -H "$A" | jq -r '.items[0].id == "'"$FILE"'"')" "true"
curl -sf -X POST "$B/api/disk/items/$FILE/restore" -H "$A" > /dev/null
want "restored" "$(curl -sf "$D/items?trashed=1&sort=name" -H "$A" | jq -r '.items | length')" "0"
# permissions (client: callEmpty PUT, then GET) and link
want "permissions PUT" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/api/disk/items/$FILE/permissions" -H "$A" -H "$J" -d '{"entries":[],"restricted":false}')" "200"
L=$(curl -sf -X POST "$B/api/disk/items/$FILE/link" -H "$A" -H "$J" -d '{}')
CODE=$(echo "$L" | jq -r .link.code)
want "link url" "$(echo "$L" | jq -r '.url | test("/d/")')" "true"
want "public file" "$(curl -sf "$B/api/public/disk/$CODE" | jq -r .name)" "d6b.txt"
want "link DELETE" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$B/api/disk/items/$FILE/link" -H "$A")" "204"
# journal, usage, settings (DiskSettings { trashDays })
want "item activity" "$(curl -sf "$B/api/disk/items/$FILE/activity" -H "$A" | jq -r '[.activities[].kind] | contains(["DISK_ACTIVITY_KIND_UPLOAD"])')" "true"
want "usage disk_bytes" "$(curl -sf "$D/usage" -H "$A" | jq -r .diskBytes)" "20"
want "settings PUT" "$(curl -sf -X PUT "$D/settings" -H "$A" -H "$J" -d '{"trashDays":30}' | jq -r .trashDays)" "30"
want "settings GET" "$(curl -sf "$D/settings" -H "$A" | jq -r .trashDays)" "30"
# delete forever + empty trash
curl -sf -X POST "$B/api/disk/items/$FILE/trash" -H "$A" > /dev/null
want "empty trash" "$(curl -sf -X POST "$D/trash/empty" -H "$A" | jq -r .deleted)" "1"
echo "ALL OK"
