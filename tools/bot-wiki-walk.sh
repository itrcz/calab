#!/bin/sh
# Bots on the Disk and in the Wiki (ADR-0094 / ADR-0096 addenda 2026-10-14), end to end with the
# built bot SDK (packages/bot-sdk/dist) against a real server: a person registers and creates a
# workspace and a bot; the bot (SDK) creates a folder, uploads a file, creates a wiki page and
# writes Markdown into it over the sync socket; the person then sees the title and preview the bot
# posted (REST GET /api/wiki/pages/{id}) and the bot reads the page back.
#
# Usage: tools/bot-wiki-walk.sh http://127.0.0.1:3067
# Needs jq, node ≥ 22, `pnpm -F @calaba/bot-sdk build`, and a server with REGISTRATION_MODE=open, e.g.
#   createdb calaba_botwiki
#   cd apps/server && DATABASE_URL=postgres://mac@localhost:5432/calaba_botwiki REDIS_URL=redis://localhost:6379/12 \
#     JWT_SECRET=dev-only-jwt-secret-dev-only-jwt-secret REGISTRATION_MODE=open LIVEKIT_URL=ws://localhost:7880 \
#     LIVEKIT_INTERNAL_URL=http://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret SMTP_HOST= \
#     STORAGE_PATH=/tmp/botwiki-files HTTP_ADDR=127.0.0.1:3067 PUBLIC_APP_URL=http://127.0.0.1:3067 go run ./cmd/server
# Prints one line per step, exits 1 on a mismatch.
set -eu
B=${1:-http://127.0.0.1:3067}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SDK="$ROOT/packages/bot-sdk/dist/index.js"
[ -f "$SDK" ] || { echo "build the SDK first: pnpm -F @calaba/bot-sdk build" >&2; exit 1; }
J='content-type: application/json'
fail() { echo "FAIL: $*" >&2; exit 1; }
# printf, not echo: sh's echo expands the \n inside JSON strings.
want() { [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"; echo "ok  $1"; }
N=$(date +%s)
T=$(curl -sf -X POST "$B/api/auth/register" -H "$J" -d "{\"email\":\"bw-$N@example.com\",\"password\":\"bw-password-1\",\"displayName\":\"BW\"}" | jq -r .tokens.accessToken)
A="authorization: Bearer $T"
WS=$(curl -sf -X POST "$B/api/workspaces" -H "$A" -H "$J" -d "{\"slug\":\"bw-$N\",\"name\":\"BW\"}" | jq -r .workspace.id)
BOT=$(curl -sf -X POST "$B/api/workspaces/$WS/bots" -H "$A" -H "$J" -d "{\"displayName\":\"Scribe\",\"username\":\"scribe_$N\",\"description\":\"walk\"}")
TOKEN=$(printf '%s\n' "$BOT" | jq -r .token)
case "$TOKEN" in calab_bot_*) echo "ok  bot created" ;; *) fail "bot token: $BOT" ;; esac

# The bot, through the SDK: disk folder + upload, wiki page + write (sync socket) + read.
OUT=$(SDK="$SDK" B="$B" TOKEN="$TOKEN" WS="$WS" node --input-type=module -e '
const { Bot } = await import(process.env.SDK);
const bot = new Bot(process.env.TOKEN, { server: process.env.B });
const ws = process.env.WS;
const folder = await bot.disk.createFolder(ws, "Reports");
const file = await bot.disk.upload(ws, new TextEncoder().encode("hello from a bot"), "hello.txt", folder.id);
const dl = await bot.disk.download(file.id);
const text = await new Response(dl.stream).text();
const page = await bot.wiki.pages.create(ws, { title: "Draft" });
await bot.wiki.page(page.id).write("## Status\n\nAll **green** this week.\n\n- [x] Disk\n- [ ] Wiki", { title: "Bot report" });
await bot.wiki.page(page.id).append("Signed: the bot");
const back = await bot.wiki.page(page.id).read();
console.log(JSON.stringify({ folder: folder.id, file: file.id, parent: file.parentId, text, page: page.id, back }));
')
FOLDER=$(printf '%s\n' "$OUT" | jq -r .folder)
want "bot upload into its folder" "$(printf '%s\n' "$OUT" | jq -r '.parent')" "$FOLDER"
want "bot download" "$(printf '%s\n' "$OUT" | jq -r .text)" "hello from a bot"
PAGE=$(printf '%s\n' "$OUT" | jq -r .page)
want "bot reads its page back" "$(printf '%s\n' "$OUT" | jq -r .back.markdown)" "$(printf '## Status\n\nAll **green** this week.\n\n- [x] Disk\n- [ ] Wiki\n\nSigned: the bot')"

# The person sees what the bot did.
want "person sees the bot's file" "$(curl -sf "$B/api/workspaces/$WS/disk/items?parent=$FOLDER" -H "$A" | jq -r '.items[0].name')" "hello.txt"
P=$(curl -sf "$B/api/wiki/pages/$PAGE" -H "$A")
want "page title (snapshot meta)" "$(printf '%s\n' "$P" | jq -r .page.title)" "Bot report"
want "page preview" "$(printf '%s\n' "$P" | jq -r .page.preview)" "Status All green this week. Disk Wiki Signed: the bot"
want "page updated by the bot" "$(printf '%s\n' "$P" | jq -r '.page.updatedBy == "'"$(printf '%s\n' "$BOT" | jq -r .bot.user.id)"'"')" "true"
echo "ALL OK"
