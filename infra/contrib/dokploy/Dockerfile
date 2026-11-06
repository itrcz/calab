# Calab web client: build the SPA (apps/desktop -> dist-web) and serve it with nginx.
# Replaces the static part of the Caddyfile. Build context is the repository root:
#   docker build -f infra/contrib/dokploy/web/Dockerfile -t calab-web .

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# --ignore-scripts: the native uiohook-napi and the Electron binary download are not needed for the web build
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm -F @calaba/desktop build:web

FROM nginx:alpine
# *.template is rendered by the official image's envsubst at start (needs DOMAIN)
COPY infra/contrib/dokploy/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/desktop/dist-web /usr/share/nginx/html
