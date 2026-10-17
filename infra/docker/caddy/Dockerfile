# Caddy with the layer4 app (SNI routing of TURN/TLS on :443). See docs/03-network.md, ADR-0006.
# Base images pinned to the Caddy release by digest (Dependabot bumps them); bump together with caddy-l4.
FROM caddy:2.11.7-builder@sha256:d842facfd63b960922e57444ff76fd8f0793a66dfdcf481af8026e1f4e6a39b4 AS build
# Pinned: v0.1.2 (commit 42db569). Bump deliberately — caddy-l4 warns about breaking changes.
RUN xcaddy build --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile sites.caddy log.caddy /etc/caddy/
COPY entrypoint.sh /usr/local/bin/caddy-entrypoint
ENTRYPOINT ["/usr/local/bin/caddy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
