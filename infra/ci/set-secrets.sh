#!/usr/bin/env bash
# Copy release/CI secrets from the owner's root .env into GitHub Actions secrets (docs/06, "Релизы: GitHub
# Actions → S3"). Values are never printed.
#
#   infra/ci/set-secrets.sh [--dry-run] [path/to/.env]      # default: <repo>/.env
#
# Auth: an existing `gh auth login`, or GITHUB_TOKEN (fine-grained, "Secrets: read and write" on the repo),
# which is passed to gh as GH_TOKEN. Repo: GITHUB_REPO (default itrcz/calab).
#
# Recognised keys (the owner's .env names; only non-empty ones are set; anything else, e.g. CFTOKEN, is
# ignored). Certificates/keys are given as base64 content, not paths:
#   S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_PUBLIC_URL
#   APPLE_CERT_P12_BASE64 APPLE_CERT_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_BASE64 APPLE_TEAM_ID
#   WIN_CERT_P12_BASE64 WIN_CERT_PASSWORD
#   STAND_SSH_KEY STAND_HOST STAND_KNOWN_HOSTS   (optional stand fallback)
# GITHUB_TOKEN in .env (or the environment) is only used to authenticate gh — it is never stored as a secret.
# Certificates that do not decode into a valid PKCS#12 / private key are still uploaded, but reported: the
# release workflow treats them as absent and builds unsigned.
set -euo pipefail

dry=0; [[ "${1:-}" == --dry-run ]] && { dry=1; shift; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${1:-$ROOT/.env}"
REPO="${GITHUB_REPO:-itrcz/calab}"
[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh CLI required (brew install gh)" >&2; exit 1; }
GH_TOKEN_FROM_ENV_FILE="$(grep -E '^[[:space:]]*(export[[:space:]]+)?GITHUB_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r' || true)"
tok="${GITHUB_TOKEN:-$GH_TOKEN_FROM_ENV_FILE}"
[[ -n "$tok" ]] && export GH_TOKEN="$tok"
unset tok GH_TOKEN_FROM_ENV_FILE
if (( ! dry )); then
  gh auth status >/dev/null 2>&1 || [[ -n "${GH_TOKEN:-}" ]] || { echo "not authenticated: gh auth login, or GITHUB_TOKEN=…" >&2; exit 1; }
fi

KEYS=(S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_PUBLIC_URL
      APPLE_CERT_P12_BASE64 APPLE_CERT_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_BASE64 APPLE_TEAM_ID
      WIN_CERT_P12_BASE64 WIN_CERT_PASSWORD
      STAND_SSH_KEY STAND_HOST STAND_KNOWN_HOSTS)

# validity of base64 certificate material (reported only; never printed)
check_material() { # key value → "valid"/"INVALID (…)"
  local tmp; tmp="$(mktemp)"
  if ! printf '%s' "$2" | base64 -d > "$tmp" 2>/dev/null || [[ ! -s "$tmp" ]]; then rm -f "$tmp"; echo "INVALID (not base64)"; return; fi
  case "$1" in
    APPLE_CERT_P12_BASE64|WIN_CERT_P12_BASE64)
      local pwkey=APPLE_CERT_PASSWORD; [[ "$1" == WIN_* ]] && pwkey=WIN_CERT_PASSWORD
      if P12PW="$(value_of "$pwkey")" openssl pkcs12 -in "$tmp" -passin env:P12PW -noout 2>/dev/null \
         || P12PW="$(value_of "$pwkey")" openssl pkcs12 -legacy -in "$tmp" -passin env:P12PW -noout 2>/dev/null; then
        echo valid; else echo "INVALID (not a PKCS#12 or wrong password)"; fi ;;
    APPLE_API_KEY_BASE64)
      if openssl pkey -in "$tmp" -noout 2>/dev/null; then echo valid; else echo "INVALID (not a private key)"; fi ;;
  esac
  rm -f "$tmp"
}

# read KEY=VALUE without sourcing (no command execution from .env); strip optional surrounding quotes
value_of() {
  local line v
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" | tail -1)" || return 0
  v="${line#*=}"; v="${v%$'\r'}"
  [[ "$v" == \"*\" || "$v" == \'*\' ]] && v="${v:1:${#v}-2}"
  v="${v/#\~/$HOME}"
  printf '%s' "$v"
}

set_n=0 skip_n=0
for k in "${KEYS[@]}"; do
  v="$(value_of "$k")"
  if [[ -z "$v" ]]; then skip_n=$((skip_n + 1)); continue; fi
  kind="value"
  case "$k" in
    APPLE_CERT_P12_BASE64|WIN_CERT_P12_BASE64|APPLE_API_KEY_BASE64) kind="base64, $(check_material "$k" "$v")" ;;
    STAND_SSH_KEY|STAND_KNOWN_HOSTS) if [[ -f "$v" ]]; then v="$(cat "$v")"; kind="file"; fi ;;
  esac
  if (( dry )); then
    echo "would set $k ($kind, ${#v} chars)"
  else
    printf '%s' "$v" | gh secret set "$k" --repo "$REPO" >/dev/null   # no --body: gh reads stdin (--body - would store a literal "-")
    echo "set $k ($kind)"
  fi
  set_n=$((set_n + 1))
done
echo "$([[ $dry == 1 ]] && echo 'dry run: ')$set_n secret(s) for $REPO, $skip_n key(s) absent/empty in $(basename "$ENV_FILE")"
if [[ -z "$(value_of S3_REGION)" ]]; then echo "note: S3_REGION empty — the workflow uses ru-central1 (Yandex Object Storage)"; fi
if (( ! dry )) && [[ -z "$(value_of S3_BUCKET)" && -z "$(value_of STAND_HOST)" ]]; then
  echo "note: neither S3_* nor STAND_* set — tagged releases will build but not be published" >&2
fi
