#!/usr/bin/env bash
# No fixture startup/reset, external credentials or production mutations.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
: "${IDENTITY_TEST_HARNESS:?Set the absolute ORIGINAL retained tools/identity-test-env.sh path}"
version=${1:-18}
actual_sha=$(git -C "$root" rev-parse HEAD)
if [[ -n ${IDENTITY_BROWSER_EXPECTED_SHA:-} ]]; then
 [[ $actual_sha == "$IDENTITY_BROWSER_EXPECTED_SHA" ]] || { echo 'Expected SHA does not match this checkout' >&2; exit 2; }
 [[ -z $(git -C "$root" status --porcelain) ]] || { echo 'Exact-SHA acceptance requires a clean checkout' >&2; exit 2; }
fi
case "$version" in 18|17) ;; *) echo 'Use PostgreSQL 18 or 17' >&2; exit 2 ;; esac
[[ $(node --version) == v22.* ]] || { echo 'Node 22 required' >&2; exit 2; }
[[ $(pnpm --version) == 10.* ]] || { echo 'pnpm 10 required' >&2; exit 2; }
export GOTOOLCHAIN=go1.26.9
[[ $(go version) == *'go1.26.9 '* ]] || { echo 'Go 1.26.9 required' >&2; exit 2; }
endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
case "$endpoint" in unix://*|npipe://*) ;; *) echo 'Local Docker required' >&2; exit 2 ;; esac
ports=$("$IDENTITY_TEST_HARNESS" ports)
project=${ports%%$'\n'*}; project=${project#project=}
[[ $project =~ ^calaba-identity-test-[a-f0-9]{10}$ ]] || { echo 'Invalid retained fixture' >&2; exit 2; }
eval "$("$IDENTITY_TEST_HARNESS" env "$version" qa)"
[[ $TEST_PG_URL == */identity_qa ]] || { echo 'Original QA fixture required' >&2; exit 2; }
export TEST_PG_URL="${TEST_PG_URL%/identity_qa}/identity_browser"
# Avoid the legacy App TestMain's leased DB and FLUSHDB. Use shared DB9 with
# a random <=64-byte namespace, cleaned by exact-prefix SCAN+DEL only.
export TEST_REDIS_URL="${TEST_REDIS_URL%/15}/9"
printf '%s\n' "SELECT 'CREATE DATABASE identity_browser' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='identity_browser')\gexec" |
 docker exec -i "$project-pg$version-1" psql -U identity_test -d identity_test -v ON_ERROR_STOP=1
export CALABA_IDENTITY_BROWSER_REQUIRED=1
export IDENTITY_BROWSER_SCRIPT="$root/infra/identity-test/browser-identity-e2e.mjs"
export IDENTITY_BROWSER_WEB_DIR="$root/apps/desktop/dist-web"
run_dir=$(mktemp -d "${TMPDIR:-/tmp}/calaba-browser-evidence.XXXXXX")
printf 'Browser acceptance SHA=%s PostgreSQL=%s Node=%s pnpm=%s logs=%s\n' "$(git -C "$root" rev-parse HEAD)" "$version" "$(node --version)" "$(pnpm --version)" "$run_dir"
git -C "$root" status --porcelain > "$run_dir/working-tree-files.txt"
shasum -a 256 "$root/apps/server/internal/app/identity_browser_e2e_integration_test.go" "$IDENTITY_BROWSER_SCRIPT" "$root/infra/identity-test/browser-identity-e2e.sh" > "$run_dir/harness.sha256"
# Every invocation rebuilds this checkout once; no stale bundle reuse flag.
(cd "$root" && pnpm -F @calaba/desktop build:web) > "$run_dir/build.log" 2>&1 || { tail -40 "$run_dir/build.log"; exit 1; }
shasum -a 256 "$IDENTITY_BROWSER_WEB_DIR/index.html" > "$run_dir/bundle.sha256"
cd "$root/apps/server"
# Explicit file list avoids package TestMain and every unrelated integration test.
if ! go test -race -tags integration -count=1 -timeout 5m -v ./internal/app/identity_browser_e2e_integration_test.go > "$run_dir/browser.log" 2>&1; then
 tail -70 "$run_dir/browser.log"; exit 1
fi
if rg -q -- '--- SKIP:' "$run_dir/browser.log" || ! rg -q '^IDENTITY_BROWSER_REQUIRED_PASS$' "$run_dir/browser.log"; then
 echo 'Required browser acceptance skipped or missing pass marker' >&2; exit 1
fi
rg 'PASS |IDENTITY_BROWSER_|^ok' "$run_dir/browser.log"
printf 'Evidence=%s\n' "$run_dir"
