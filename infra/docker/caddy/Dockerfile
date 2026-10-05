# Caddy with the layer4 app (SNI routing of TURN/TLS on :443). See docs/03-network.md, ADR-0006.
# Base images pinned to the Caddy release by digest (Dependabot bumps them); bump together with caddy-l4.
FROM caddy:2.11.4-builder@sha256:369218c81ca6d6af249981221b3a5c764d886dd5b058f51d144066de13f2418d AS build
# Pinned: v0.1.2 (commit 42db569). Bump deliberately — caddy-l4 warns about breaking changes.
RUN xcaddy build --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:2.11.4@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile sites.caddy log.caddy /etc/caddy/
COPY entrypoint.sh /usr/local/bin/caddy-entrypoint
ENTRYPOINT ["/usr/local/bin/caddy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
