# Production web image: Caddy plus the static web client and landing of one release, nothing else.
# Built by .github/workflows/images.yml from a context with three directories:
#   web/      apps/desktop/dist-web (pnpm -F @calaba/desktop build:web, source maps removed)
#   landing/  apps/landing/out      (pnpm -F @calaba/landing build)
#   caddy/    infra/docker/caddy: Caddyfile.behind-proxy, sites.caddy, log.caddy, entrypoint.sh
# Runs behind a TLS-terminating proxy (Caddyfile.behind-proxy): plain HTTP on BEHIND_PROXY_PORT, the API at
# API_UPSTREAM, host names from the env (entrypoint.sh). The config ships with the release, so a rollout by
# digest brings the matching Caddy config too.
FROM caddy:2.11.4@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52
# Copying the binary drops its file capability (cap_net_bind_service): Caddy listens on a high port and
# must start in a container with every capability dropped and no privilege escalation.
RUN cp /usr/bin/caddy /usr/bin/caddy.nocap && mv /usr/bin/caddy.nocap /usr/bin/caddy \
 && rm -f /etc/caddy/Caddyfile && mkdir -p /srv/releases
COPY web /srv/web
COPY landing /srv/landing
COPY caddy/Caddyfile.behind-proxy /etc/caddy/Caddyfile
COPY caddy/sites.caddy caddy/log.caddy /etc/caddy/
COPY caddy/entrypoint.sh /usr/local/bin/caddy-entrypoint
ENV XDG_DATA_HOME=/tmp/caddy/data XDG_CONFIG_HOME=/tmp/caddy/config BEHIND_PROXY_PORT=8080
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/caddy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
