#!/bin/sh
# Test-only TLS certificate for the dev GreenMail (mail engine integration test, ADR-0088 §11).
# The engine verifies certificates strictly, so GreenMail gets a localhost certificate and the
# test trusts it as its CA. Output (git-ignored): certs/greenmail.p12 (for GreenMail), certs/ca.pem.
set -eu
dir="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$dir/key.pem" -out "$dir/ca.pem" 2>/dev/null
openssl pkcs12 -export -inkey "$dir/key.pem" -in "$dir/ca.pem" -name greenmail \
  -passout pass:changeit -out "$dir/greenmail.p12"
chmod 644 "$dir/greenmail.p12" "$dir/ca.pem"
echo "certs in $dir"
