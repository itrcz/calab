# Caddy with the layer4 app (SNI routing of TURN/TLS on :443). See docs/03-network.md, ADR-0006.
# Base images pinned to the Caddy release by digest (Dependabot bumps them); bump together with caddy-l4.
FROM caddy:2.11.9-builder@sha256:cda07fe9d82728c7ac44d844306d435e98131423dc7b114f05a8a8ecfff94707 AS build
# Pinned: v0.1.2 (commit 42db569). Bump deliberately — caddy-l4 warns about breaking changes.
RUN xcaddy build --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:2.11.9@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile sites.caddy log.caddy /etc/caddy/
COPY entrypoint.sh /usr/local/bin/caddy-entrypoint
ENTRYPOINT ["/usr/local/bin/caddy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
