#!/usr/bin/env bash
# Smoke test of the MCP endpoint (ADR-0114, ADR-0156): initialize -> tools/list -> tools/call find.
# Usage: CALAB_BOT_TOKEN=calab_bot_... tools/mcp-smoke.sh [base-url]   (default https://app.calab.io)
# The token is read from the environment and is never printed.
set -euo pipefail

base="${1:-${CALAB_BASE_URL:-https://app.calab.io}}"
: "${CALAB_BOT_TOKEN:?set CALAB_BOT_TOKEN to a bot token}"
url="${base%/}/api/mcp"

# The token goes through a curl config on stdin, so it is not in the process list either.
call() {
  printf 'header = "Authorization: Bearer %s"\n' "$CALAB_BOT_TOKEN" |
    curl -sS --fail-with-body --config - "$url" -H 'Content-Type: application/json' -d "$1"
  echo
}

echo "== initialize"
call '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-smoke","version":"0"}}}'
echo "== tools/list"
call '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
echo "== tools/call find (boards)"
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"find","arguments":{"q":"","kind":"boards"}}}'
