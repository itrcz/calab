# Calab web client: build the SPA (apps/desktop -> dist-web) and serve it with nginx.
# Build context is the repository root.

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .

# Native uiohook-napi / Electron binaries are not needed for the web build.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm -F @calaba/desktop build:web

FROM nginx:alpine

# The official nginx image renders *.template files with envsubst at startup.
COPY infra/dokploy/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/desktop/dist-web /usr/share/nginx/html

EXPOSE 80
