# Calab on Dokploy (community-maintained)

Runs Calab behind the Traefik that [Dokploy](https://dokploy.com) already operates, instead of the
host-network Caddy stack in `infra/docker/`.

**Status:** community-maintained and **not covered by the project CI**. It can lag behind
`infra/docker/compose.yml`; when you upgrade, diff the two files (environment of `api`, the LiveKit
config against `infra/docker/livekit/livekit.yaml.tpl`, the web headers against the Caddyfile).


## Requirements

- Dokploy with its Traefik: entrypoints `web` / `websecure`, certificate resolver `letsencrypt`,
  middleware `redirect-to-https@file` (all Dokploy defaults).
- DNS A records for `<DOMAIN>`, `rtc.<DOMAIN>` and `turn.<DOMAIN>` pointing at the host
  (DNS-only if you use Cloudflare: WebRTC and TURN cannot be proxied).
- Open on the host and any provider firewall: `7881/tcp`, `7882/udp`, `3478/udp`
  (`TURN_UDP_PORT`), `20000-20099/udp`.

## Deploy

1. In Dokploy create a Compose service, provider Git, your repository and branch,
   Compose Path `./infra/contrib/dokploy/compose.yml`.
2. Fill the Environment tab from `.env.example` (`DOMAIN` is required).
3. Do **not** add domains in the Dokploy UI for this service: routing is defined by the labels.
4. Deploy. Check `https://<DOMAIN>/healthz`, then join a voice room from two clients.

`TRAEFIK_MIDDLEWARES` lets you attach your own middlewares (for example a CrowdSec bouncer) to
every HTTPS router.

## Notes

- **TURN:** UDP defaults to 3478 because Dokploy's Traefik may hold 443/udp for HTTP/3. TURN/TLS
  for UDP-blocked networks goes over 443/tcp through Traefik (SNI `turn.<DOMAIN>`, LiveKit
  `external_tls`). The relay range is 100 ports because Docker starts a proxy per published UDP
  port. The `ips.excludes` of the host-network template is intentionally absent: on a bridge
  network it can leave LiveKit without ICE candidates.
- **Identity 2.0:** the `IDENTITY_*` / `OAUTH_SIGNING_*` variables are passed through; the
  provider paths `/oidc/` and `/.well-known/oauth-authorization-server/oidc/` are routed to the API
  with `no-store` / `no-referrer` / `frame-ancestors`. The logging gates in
  `docs/06-deployment.md` apply to your Traefik too: make sure its access logs do not record
  OAuth query parameters or `Referer`.
- **Upgrade:** back up Postgres first (`pg_dump -Fc`); migrations run at API start and rolling the
  image back alone is not supported.
