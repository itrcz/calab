#!/bin/sh
# Builds the host lists for the Caddyfile from the env (docs/10-branding.md, docs/06):
#   DOMAIN         primary domain: rtc.<DOMAIN>, turn.<DOMAIN> (LiveKit announces turn.<DOMAIN>)
#   APP_HOST       the app (web client, API, gateway, /download/); default: DOMAIN
#   LANDING_HOST   static landing (optional; empty = no landing site)
#   DOMAIN_ALT, DOMAIN_LEGACY  extra app hosts (aliases, optional; e.g. meet.gptunnel.ru, or app.calab.ru after
#                  the move to calab.io). Only the app is served there: clients get the rtc. URL from the API
#   DOMAIN_ALIASES extra zones, space-separated (optional; e.g. calab.ru next to DOMAIN=calab.io): rtc.<zone> and
#                  turn.<zone> are served too (same LiveKit), so a client allowed only the old family keeps working
#   LANDING_HOST_ALIASES   extra landing hosts, space-separated (optional): 301 to LANDING_HOST, same path
#   LANDING_HOST_MIRRORS   extra landing hosts, space-separated (optional): the SAME landing, no redirect (a mirror
#                  domain that must keep working on its own when the primary one is unreachable)
#   RELEASES_HOST_ALIASES  extra release feed hosts, space-separated (optional): the SAME feed, no redirect —
#                  installed builds have their feed host baked in (docs/06 «Домены»)
#   RELEASES_HOST  desktop release feed (optional; empty = none): reverse proxy to a public-read S3 bucket
#                  when S3_PUBLIC_URL is set (the bucket's public base URL, e.g. Yandex Object Storage
#                  https://storage.yandexcloud.net/<bucket> — path-style — or a virtual-hosted URL without a
#                  path), else /srv/releases. With it set, /download/* on the app and landing hosts redirects
#                  there (302, same path), except the stable shortcuts /download/<mac-arm64|mac-x64|win|linux|deb>
#                  (→ RELEASES_HOST/latest/<file>, copied there by release.yml) and /download/ itself (picks the
#                  file by User-Agent; unknown → the landing's #download). The release host's root and any
#                  listing redirect to the landing's #download (when LANDING_HOST is set).
#   BEHIND_PROXY_PORT  set only with Caddyfile.behind-proxy (TLS terminated by a proxy in front): every site
#                  address becomes http://<host>:<port>, so Caddy serves plain HTTP there and requests no certificates
# Caddy substitutes {$VAR} before parsing, so a list expands into several site addresses / SNI values.
# The landing site is generated into /tmp/landing.caddy (imported by the Caddyfile; empty when unset),
# because a site block with an empty address would not parse.
set -eu
: "${DOMAIN:?DOMAIN is required}"
# Site address(es) for the given hosts: as is, or http://<host>:<port> behind a proxy.
addr() {
	for h in "$@"; do
		if [ -n "${BEHIND_PROXY_PORT:-}" ]; then printf 'http://%s:%s ' "$h" "$BEHIND_PROXY_PORT"; else printf '%s ' "$h"; fi
	done
}
APP_HOSTS="${APP_HOST:-$DOMAIN}" RTC_HOSTS="rtc.$DOMAIN" TURN_HOSTS="turn.$DOMAIN"
for h in "${DOMAIN_ALT:-}" "${DOMAIN_LEGACY:-}"; do
	[ -n "$h" ] || continue
	APP_HOSTS="$APP_HOSTS $h"
done
for z in ${DOMAIN_ALIASES:-}; do
	RTC_HOSTS="$RTC_HOSTS rtc.$z" TURN_HOSTS="$TURN_HOSTS turn.$z"
done
# LiveKit signal origins for the web client CSP connect-src (wss signal + https /rtc/validate)
RTC_ORIGINS=""
for h in $RTC_HOSTS; do RTC_ORIGINS="$RTC_ORIGINS wss://$h https://$h"; done
if [ -n "${LANDING_HOST:-}" ]; then
	# shellcheck disable=SC2086 # host lists are space-separated on purpose
	printf '%s{\n\timport landing_site\n}\n' "$(addr "$LANDING_HOST" ${LANDING_HOST_MIRRORS:-})" > /tmp/landing.caddy
	for h in ${LANDING_HOST_ALIASES:-}; do
		printf '%s{\n\tredir https://%s{uri} 301\n}\n' "$(addr "$h")" "$LANDING_HOST" >> /tmp/landing.caddy
	done
else
	: > /tmp/landing.caddy
fi

# /download/ on app + landing: redirect to the release host, or serve /srv/releases locally.
# Stable installer names under latest/ (release.yml publish-s3 copies each release there):
#   <shortcut> <file>
LATEST_FILES='mac-arm64 Calab-mac-arm64.dmg
mac-x64 Calab-mac-x64.dmg
win Calab-win-x64.exe
linux Calab-linux-x86_64.AppImage
deb calab-linux-amd64.deb'
if [ -n "${RELEASES_HOST:-}" ]; then
	LATEST="https://$RELEASES_HOST/latest"
	# No landing: /download/ without a target falls back to the old behaviour (the release host's root).
	FALLBACK="https://$RELEASES_HOST/"
	[ -z "${LANDING_HOST:-}" ] || FALLBACK="https://$LANDING_HOST/#download"
	{
		# `handle` so it runs before the site's catch-all handle; `route` inside keeps the order below (the
		# first matching redir wins) — plain directives would be re-sorted (path matchers before named ones).
		printf 'handle /download/* {\n\troute {\n'
		printf '%s\n' "$LATEST_FILES" | while read -r key file; do
			printf '\tredir /download/%s %s/%s 302\n' "$key" "$LATEST" "$file"
			printf '\tredir /download/%s/ %s/%s 302\n' "$key" "$LATEST" "$file"
		done
		# /download/ (the landing's old button): the installer for the visitor's OS. Android and ChromeOS
		# also say "Linux"/"X11" — no desktop build for them, so they go to the landing like any other UA.
		printf '\t@dl_mac {\n\t\tpath /download/\n\t\theader User-Agent *Macintosh*\n\t}\n'
		printf '\tredir @dl_mac %s/Calab-mac-arm64.dmg 302\n' "$LATEST"
		printf '\t@dl_win {\n\t\tpath /download/\n\t\theader User-Agent *Windows*\n\t}\n'
		printf '\tredir @dl_win %s/Calab-win-x64.exe 302\n' "$LATEST"
		printf '\t@dl_linux {\n\t\tpath /download/\n\t\theader_regexp User-Agent (Linux|X11)\n\t\tnot header_regexp User-Agent (Android|CrOS)\n\t}\n'
		printf '\tredir @dl_linux %s/Calab-linux-x86_64.AppImage 302\n' "$LATEST"
		printf '\tredir /download/ %s 302\n' "$FALLBACK"
		# everything else (the electron-updater feed of older builds: latest*.yml, releases/<ver>/…): same path
		printf '\t@dl path_regexp dl ^/download/(.*)$\n'
		printf '\tredir @dl https://%s/{re.dl.1} 302\n' "$RELEASES_HOST"
		printf '\t}\n}\n'
	} > /tmp/download.caddy
else
	printf 'handle_path /download/* {\n\timport releases_files\n}\n' > /tmp/download.caddy
fi

# The release host itself. With a landing, its root / listings / index.html go to the landing's #download
# (people land there, not on a bare file list); files are served as before.
RELEASES_LISTING=""
if [ -n "${LANDING_HOST:-}" ]; then
	RELEASES_LISTING="$(printf '\t@listing path / */ /index.html\n\tredir @listing https://%s/#download 302' "$LANDING_HOST")"
fi
# shellcheck disable=SC2086
[ -z "${RELEASES_HOST:-}" ] || RELEASES_SITE="$(addr "$RELEASES_HOST" ${RELEASES_HOST_ALIASES:-})"
if [ -z "${RELEASES_HOST:-}" ]; then
	: > /tmp/releases.caddy
elif [ -n "${S3_PUBLIC_URL:-}" ]; then
	# https://host[/prefix] → upstream https://host, keys under /prefix; S3 sees its own Host header
	S3_UPSTREAM="$(printf '%s' "$S3_PUBLIC_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
	S3_PREFIX="$(printf '%s' "$S3_PUBLIC_URL" | sed -E 's#^https?://[^/]+##; s#/+$##')"
	cat > /tmp/releases.caddy <<EOF_S3
$RELEASES_SITE{
	import releases_host_headers
$RELEASES_LISTING
	# latest/: stable names overwritten by every release — revalidate; VERSION is read by the landing (CORS).
	handle /latest/* {
		rewrite * $S3_PREFIX{uri}
		reverse_proxy $S3_UPSTREAM {
			header_up Host {upstream_hostport}
			header_down Cache-Control "no-cache"
			header_down Access-Control-Allow-Origin "*"
		}
	}
	# (several rewrites in one block are mutually exclusive in Caddy — hence a separate handle for /)
	handle / {
		rewrite * $S3_PREFIX/index.html
		reverse_proxy $S3_UPSTREAM {
			header_up Host {upstream_hostport}
			header_down Cache-Control "no-cache"
		}
	}
	@meta path /index.html *.yml *.yaml
	handle @meta {
		rewrite * $S3_PREFIX{uri}
		reverse_proxy $S3_UPSTREAM {
			header_up Host {upstream_hostport}
			header_down Cache-Control "no-cache"
		}
	}
	handle {
		rewrite * $S3_PREFIX{uri}
		reverse_proxy $S3_UPSTREAM {
			header_up Host {upstream_hostport}
			header_down Cache-Control "public, max-age=31536000, immutable"
		}
	}
}
EOF_S3
else
	printf '%s{\n\timport releases_host_headers\n%s\n\timport releases_files\n}\n' "$RELEASES_SITE" "$RELEASES_LISTING" > /tmp/releases.caddy
fi

# The landing reads RELEASES_HOST/latest/VERSION (its CSP connect-src).
RELEASES_ORIGIN=""
[ -z "${RELEASES_HOST:-}" ] || RELEASES_ORIGIN=" https://$RELEASES_HOST"

# shellcheck disable=SC2086
APP_HOSTS="$(addr $APP_HOSTS)"
# The landing also reads APP_HOST /api/billing/public/offers (CORS on the server: PUBLIC_LANDING_URLS).
APP_ORIGIN=" https://${APP_HOST:-$DOMAIN}"
export APP_HOSTS RTC_HOSTS TURN_HOSTS RTC_ORIGINS RELEASES_ORIGIN APP_ORIGIN
exec "$@"
