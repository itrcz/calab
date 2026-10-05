# Identity 2.0 deployment prerequisites and local evidence

Normative: [ADR-0054](../adr/0054-workspace-identity.md) and
[release contract §7, §8, §13](release-2.0-identity.md), including §13 at `37ad541d`.
This infra change is based on `981df255`; it does not deploy or certify the live cluster.

## Repository routing and headers

The app site proxies these paths before the SPA fallback, preserving method, query and body:

| Path (one workspace segment) | Supported server methods |
| --- | --- |
| `/oidc/workspaces/{uuid}/.well-known/openid-configuration` | GET |
| `/.well-known/oauth-authorization-server/oidc/workspaces/{uuid}` | GET |
| `/oidc/workspaces/{uuid}/jwks` | GET |
| `/oidc/workspaces/{uuid}/authorize` | GET |
| `/oidc/workspaces/{uuid}/token` | POST, OPTIONS |
| `/oidc/workspaces/{uuid}/userinfo` | GET, POST, OPTIONS |
| `/oidc/workspaces/{uuid}/revoke` | POST, OPTIONS |

The proxy does not validate UUIDs or authorize clients: the server validates those and
rejects unsupported methods. The matcher excludes extra path segments and lookalike
prefixes. Existing `/api/*`, `/gateway`, `/healthz` proxying remains; `/metrics` and
`/readyz` remain internal. `/oauth/consent` and `/sso/complete` serve `index.html` with
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and
the existing SPA CSP (including `script-src 'self' 'wasm-unsafe-eval'` and
`frame-ancestors 'none'`). Assets retain their existing caching/loading rules.

API referrer policy is written at response time to avoid duplicate upstream values
and cannot downgrade identity `no-referrer` to `same-origin`. Provider responses
retain upstream cache policy, including JWKS `public, max-age=60`; absent cache
headers default to `no-store`. Provider and `/api/*` proxy failures get `no-store`, `no-referrer`
and `frame-ancestors 'none'` through Caddy's separate error chain.

App access logging explicitly uses `output discard`. The global JSON error encoder
deletes `request>uri`, `request>headers`, and `resp_headers`: query parameters,
path-based consent handles, Referer/cookies and redirect Location cannot survive
in those structured fields. Do not enable debug/raw request logging or add
credential-bearing custom log fields. Preserve sanitized API logs and metrics.
See [Caddy logging](https://caddyserver.com/docs/caddyfile/directives/log) and
[runtime logging](https://caddyserver.com/docs/caddyfile/options#log).

## Operator configuration and key lifecycle

Compose forwards all nine actual `Config` identity settings unchanged.
The seven dependency settings default to empty. When all seven are empty,
`IdentitySettings()` returns nil and the legacy installation can start; registered
identity endpoints return 503. Edition/allowlist settings alone do not configure
identity dependencies. Any nonempty dependency requires a complete valid origin
and both keyrings; malformed/partial configuration fails `Config.Load` at startup.
There is no fallback to `JWT_SECRET`.

| Setting | Exact format |
| --- | --- |
| `IDENTITY_PUBLIC_ORIGIN` | Exact HTTPS origin, no userinfo, trailing slash, path, query or fragment. It must be an app host routed by every front proxy. Issuer is this origin plus `/oidc/workspaces/{uuid}`; Host/forwarded headers do not choose it. |
| `IDENTITY_ENCRYPTION_KEYS` | JSON object `kid → standard padded base64` decoding to exactly 32 independent AES-256 key bytes, maximum 32 keys. Neither encoded nor decoded bytes may reuse `JWT_SECRET`. |
| `IDENTITY_ENCRYPTION_ACTIVE_KID` | Existing encryption key ID; 1–64 bytes without NUL, CR or LF. Prefer ASCII letters, digits, `.`, `_`, `-` as an operator naming convention. |
| `OAUTH_SIGNING_KEYS` | JSON object `kid → PEM string`, maximum 32 distinct RSA keys. Exactly one PEM block per string, no encrypted PEM/headers or trailing material. RSA 2048–8192 bits. Active: PKCS#8 `PRIVATE KEY` or PKCS#1 `RSA PRIVATE KEY`; inactive: either private format or SPKI `PUBLIC KEY` / PKCS#1 `RSA PUBLIC KEY`. JSON strings use escaped `\n` for PEM line breaks. |
| `OAUTH_SIGNING_ACTIVE_KID` | Existing signing ID selecting a private key; 1–128 ASCII letters, digits, `.`, `_`, `-`. Different kids cannot alias the same RSA key. |
| `IDENTITY_ENDPOINTS` | Empty or JSON array of objects with `url`, `approved_cidrs`, `private_cidrs`, optional `ca_pem`, `workspace_ids` (exact workspace UUIDs the override applies to; required with `private_cidrs` unless `IDENTITY_EDITION=enterprise`). URLs are exact complete HTTPS endpoints (including query); overrides cannot contain duplicate URLs. Network values are CIDR strings. Public HTTPS endpoints do not require pre-enumeration. |
| `IDENTITY_DIRECTORY_HOSTS` | Empty or JSON array of objects with `host`, nonempty `networks` (CIDR strings), optional `ca_pem`, `workspace_ids` (exact workspace UUIDs allowed to use the host; required unless `IDENTITY_EDITION=enterprise`). Hosts must be exact lowercase names without trailing dot, port, userinfo or slash; no duplicate hosts. Required for LDAPS access. |
| `IDENTITY_EDITION` | `cloud` (default) or `enterprise`. Cloud Business still needs the workspace's current positive entitlement. |
| `IDENTITY_ENTERPRISE_WORKSPACE_IDS` | Comma-separated exact nonzero workspace UUIDs, no wildcard. Enterprise entitlement needs the workspace in this list. |

Network exceptions reject loopback/unspecified networks in production configuration;
private networks require explicit operator policy and valid TLS CA material. Keep
origin/network policy/edition in deployment ConfigMap, keyrings only in the existing
Secret delivery mechanism. Never put private keys in ConfigMaps, command arguments,
reports or rendered config output. [.env.example](../../infra/docker/.env.example)
contains intentionally invalid placeholders only; replace them offline and protect
the resulting dotenv/Secret. Preserve JSON strings through the secret delivery path.

Before signing-key activation, publish the next public key under its final kid while
the current private key stays active, roll all replicas, then verify every workspace
JWKS exposes it. Wait at least one JWKS cache window (60 seconds) before switching
the next kid to its private key and changing `OAUTH_SIGNING_ACTIVE_KID`. Retain the old
public key for the last old ID token's lifetime (maximum five minutes) plus 60 seconds
skew plus 60 seconds JWKS cache; do not keep signing with it. Back up both keyrings
with the DB; keep encryption keys until dependent ciphertext has been re-encrypted.
The full rotation/restore contract is [release §8](release-2.0-identity.md).

## Cluster rollout is a separate prerequisite

`.github/workflows/images.yml` builds a web image containing Caddy 2.11.4 and static
files only. `infra/docker/web-image/Dockerfile` deliberately omits Caddyfile and
entrypoint. A repo Caddy change or web image digest rollout therefore does **not**
update cluster routing, logging or operator configuration.
(Superseded: since `Caddyfile.behind-proxy` the web image carries its config — see docs/06.)

Coordinator-provided read-only observation (2026-10-01): context `gptunnel`, namespace
`calab`; web ConfigMap `calab-web-config` owns `Caddyfile`, `cluster-sites.sh`,
`entrypoint.sh`, and uses `api:3000`. API uses `calab-api` ConfigMap and `calab-env`
Secret via envFrom; no identity/signing keys were present. The controller owning
API env-sync/env-checksum annotations was not determined. Ingress `calab` uses
nginx through `ingress-nginx` in namespace `default`; the shared controller
ConfigMap had no logging overrides. These observations are supplied evidence,
not a fresh inspection by this worker; deployment owners must reconfirm them.

Operator steps, to be performed in an authorized release window:

1. Identify the declarative owners/reconcilers of those ConfigMaps, Secret, ingress
   and checksum annotations. Save a protected rollback snapshot without printing
   secrets. Verify approved release SHA/digests, migrations and two security reviews.
2. Merge the precise `@identity_provider` / `handle @identity_provider` stanza from
   [Caddyfile](../../infra/docker/caddy/Caddyfile) into the cluster app site, replacing
   only its upstream with `api:3000`. Keep it before SPA fallback. Apply the same
   error-handler policies (merge into any existing `handle_errors`, preserving
   unrelated errors), deferred API referrer policy, sensitive SPA handle, and
   default-only web referrer policy. Keep the existing cluster site generation,
   listen ports, release/landing routes and upstreams; do not paste the host-network
   `caddy-l4` listener wrapper into the stock cluster image.
3. Apply the app access-log discard and global error-field deletion to the actual
   Caddy ConfigMap. Validate the fully rendered cluster config using its exact image
   in isolation, test all app aliases, then roll/reload via the owning controller.
4. Front ingress access logging needs an independent scoped change. The nginx
   default log format includes `$request` and `$http_referer`; Caddy cannot redact
   logs already written by ingress. Merge this into **only** the `calab` ingress
   declarative source (not the shared ingress controller):

   ```yaml
   metadata:
     annotations:
       nginx.ingress.kubernetes.io/enable-access-log: "false"
   ```

   This is the supported [per-ingress access-log annotation](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/#enable-access-log);
   the [controller defaults](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/#log-format-upstream)
   explain the exposure. It does not suppress nginx **error** logs. Test controlled
   upstream failures with synthetic credentials and inspect error logs/collectors.
   If they include request/query/Referer, the platform owner must provide a scoped
   Calab vhost/location suppression or redaction before identity is enabled. Do not
   change shared-controller logging or enable unrestricted snippet annotations.
5. Deliver origin/edition/network config and independent keyrings through the existing
   API source of truth; update its checksum/sync mechanism and roll API replicas.
   All dependencies absent is compatible but does not make identity usable. Partial
   configuration must stop the new pod rather than quietly disable protection.
6. Verify the public canonical issuer origin and aliases through **every** ingress/LB:
   discovery JSON has canonical issuer/endpoint URLs, JWKS contains only RSA public
   fields and expected kids, authorize produces a protocol error/consent redirect
   instead of SPA HTML, token/userinfo/revoke respond as API. Complete an isolated
   pilot code+PKCE/consent/refresh/revoke flow; verify API/web release versions and
   SSO callback reachability with the registered IdP redirect URL.
7. Verify consent/completion HTML is no-store/no-referrer/unframeable and its hashed
   script loads; exercise no-store/no-referrer error responses and preserve JWKS
   cache policy. Send synthetic code/state/ticket/nonce/request/consent handles,
   path handles and Referer through the whole chain; scan Caddy, ingress, API and
   collectors without printing real credentials. No sentinel may survive. Record
   applied config revision, Secret revision identifier (no values), pod/image
   digests, origin, test results and log scan outcome. Check proxy error logs too.
8. Start disabled, then an optional test workspace pilot. Test recovery before
   enforced. Do not roll back to a binary ignoring identity policy/authority on
   enforced data; retain required decrypt/verify keys during restore/rollback.

None of these cluster mutations or production flows was executed for this task.
Live routing, identity configuration, ingress error-log behavior and end-to-end
deployment remain operator acceptance gates, not claimed fixed by the repo diff.

## Reproducible local checks

Run from the repository root with Python 3, Docker Compose (rendering only) and
Caddy **2.11.4**, matching both pinned Dockerfiles:

```sh
python3 infra/identity-test/identity-proxy-test.py
# Optional actual Config.Load check; temporary binary only, no backend connection:
(cd apps/server && go build -o /tmp/calaba-identity-infra-config-check ./cmd/server)
python3 infra/identity-test/identity-proxy-test.py --server-bin /tmp/calaba-identity-infra-config-check
rm /tmp/calaba-identity-infra-config-check
```

The script uses a private temp directory, ephemeral loopback ports, synthetic
`identity.test`/`alias.test`/`rtc.test`/`turn.test` hosts, `auto_https off`, isolated
Caddy data/config paths, and a silent mock upstream. It never runs compose up,
requests production certificates, calls kubectl, or reads an operator dotenv.
Config checking uses an unknown server subcommand after `Config.Load`; it cannot
connect, serve or migrate. It checks legacy and edition-only accepted configuration
and rejects each of the seven individually partial dependency settings.

Recorded on 2026-10-01: Caddy 2.11.4 validate/adapt and 49 routing/header/failure
checks passed; 10 synthetic log sentinels absent, including error-log requests;
Compose forwarded all nine operator settings unchanged and kept empty defaults;
Config.Load passed both legacy cases and rejected all seven partial cases.
`make lint` from the root passed (Go vet with/without integration tags, golangci-lint
0 issues, workspace ESLint) after `pnpm install --frozen-lockfile --ignore-scripts`.
`cd apps/server && go test ./internal/config -count=1` and `git diff --check` passed.
Stock Caddy testing excludes only the unrelated global TURN listener wrapper.
To validate that wrapper too, supply a Caddy binary built from the pinned
`infra/docker/caddy/Dockerfile` with `--caddy-bin <path> --require-layer4`.
TURN/media, real IdP/AD compatibility, live TLS/ingress and production rollout
were not tested here. Full CI/integration and two final-SHA reviews remain lead gates.
