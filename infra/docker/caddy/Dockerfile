# Caddy with the layer4 app (SNI routing of TURN/TLS on :443). See docs/03-network.md, ADR-0006.
# Base images pinned to the Caddy release by digest (Dependabot bumps them); bump together with caddy-l4.
FROM caddy:2.11.8-builder@sha256:d4eb070c36154bd2d4c94b40359a03c6168346d5af5404963c74691ab77fb63f AS build
# Pinned: v0.1.2 (commit 42db569). Bump deliberately — caddy-l4 warns about breaking changes.
RUN xcaddy build --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:2.11.8@sha256:4fcafa98afd1c2e642e353e3c5cf9ddbe892fcee14bc990e7ba2c5b78e51f9cf
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile sites.caddy log.caddy /etc/caddy/
COPY entrypoint.sh /usr/local/bin/caddy-entrypoint
ENTRYPOINT ["/usr/local/bin/caddy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
