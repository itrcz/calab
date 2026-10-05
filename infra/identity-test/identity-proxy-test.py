#!/usr/bin/env python3
"""Exercise the repository Caddy app routes using loopback-only mock services.

Requires the repository-pinned Caddy version (optionally with caddy-l4) and Docker
Compose for config rendering only. No Docker services, certificates or live hosts.
"""

import argparse
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse


ROOT = Path(__file__).resolve().parents[2]
WORKSPACE = "11111111-1111-4111-8111-111111111111"
ISSUER = f"/oidc/workspaces/{WORKSPACE}"
DEPENDENCIES = (
    "IDENTITY_PUBLIC_ORIGIN", "IDENTITY_ENCRYPTION_KEYS", "IDENTITY_ENCRYPTION_ACTIVE_KID",
    "OAUTH_SIGNING_KEYS", "OAUTH_SIGNING_ACTIVE_KID", "IDENTITY_ENDPOINTS", "IDENTITY_DIRECTORY_HOSTS",
)
OPERATOR_ENV = DEPENDENCIES + ("IDENTITY_EDITION", "IDENTITY_ENTERPRISE_WORKSPACE_IDS")
SENTINELS = [f"synthetic-secret-{name}" for name in
             ("code", "state", "ticket", "nonce", "request", "consent", "referer", "location", "cookie", "body")]
QUERY = urllib.parse.urlencode(dict(zip(("code", "state", "ticket", "nonce", "request", "consent"), SENTINELS)))
SPA = b'<!doctype html><script type="module" src="/assets/test.js"></script><div>identity-test-spa</div>'


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def remove_block(source, marker):
    """Remove one literal line-opened Caddy block, leaving all app handlers intact."""
    start = source.index(marker)
    brace = source.index("{", start)
    depth = 1
    end = brace + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[:start] + source[end:]


class Upstream(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.reply()

    def do_POST(self):
        self.reply()

    def do_OPTIONS(self):
        self.reply()

    def reply(self):
        path = urllib.parse.urlsplit(self.path).path
        self.server.requests.append((self.command, self.path))
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.bodies.append(body)
        status = 302 if "/callback/" in path else 200
        if urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("fixture_status") == ["503"]:
            status = 503
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=60" if path.endswith("/jwks") else "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        if status == 302:
            self.send_header("Location", "/sso/complete?ticket=" + SENTINELS[7])
        self.end_headers()
        self.wfile.write(json.dumps({"upstream": True, "method": self.command, "target": self.path}).encode())


def request(port, path, method="GET", body=None, host="identity.test"):
    client = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        client.request(method, path, body=body, headers={
            "Host": host, "Referer": "https://identity.test/?code=" + SENTINELS[6],
            "Cookie": "test=" + SENTINELS[8], "Content-Type": "application/x-www-form-urlencoded",
        })
        response = client.getresponse()
        return response.status, response.getheaders(), response.read()
    finally:
        client.close()


def header(headers, name):
    values = [v for k, v in headers if k.lower() == name.lower()]
    require(len(values) == 1, f"Expected one {name} header, got {values}")
    return values[0]


def compose_check(temp):
    # Use an empty explicit dotenv, a minimal process env, and synthetic values only.
    dotenv = temp / "empty.env"
    dotenv.write_text("")
    env = {"PATH": os.environ["PATH"], "HOME": str(Path.home()), "DOMAIN": "identity.test",
           "JWT_SECRET": "synthetic-legacy-jwt", "POSTGRES_PASSWORD": "synthetic-pg",
           "REDIS_PASSWORD": "synthetic-redis", "LIVEKIT_API_KEY": "synthetic-livekit-key",
           "LIVEKIT_API_SECRET": "synthetic-livekit-secret"}
    command = ["docker", "compose", "--env-file", str(dotenv), "-f",
               str(ROOT / "infra/docker/compose.yml"), "config", "--format", "json"]
    for configured in (False, True):
        expected = {key: "" for key in OPERATOR_ENV}
        expected["IDENTITY_EDITION"] = "cloud"
        if configured:
            expected.update({key: "synthetic-" + key.lower() for key in OPERATOR_ENV})
            expected["IDENTITY_EDITION"] = "enterprise"
            expected["IDENTITY_ENTERPRISE_WORKSPACE_IDS"] = WORKSPACE
            expected["IDENTITY_ENCRYPTION_KEYS"] = '{"enc-current":"<base64-placeholder>"}'
            expected["OAUTH_SIGNING_KEYS"] = '{"sig-current":"<RSA-PEM-placeholder>\\n"}'
        result = subprocess.run(command, env=env | (expected if configured else {}),
                                capture_output=True, text=True, timeout=30)
        require(result.returncode == 0, "Compose config failed: " + result.stderr)
        actual = json.loads(result.stdout)["services"]["api"]["environment"]
        require(all(actual[key] == value for key, value in expected.items()), "Compose identity env mismatch")
    example = (ROOT / "infra/docker/.env.example").read_text()
    for key in OPERATOR_ENV:
        require(re.search(rf"^{key}=", example, re.M), f"Missing example setting: {key}")
    print("PASS: Compose legacy defaults and all 9 operator settings forwarded without mutation")


def config_check(server):
    # The unknown subcommand validates Config.Load but cannot connect/migrate/serve.
    env = {"DATABASE_URL": "postgres://unused.test/unused", "REDIS_URL": "redis://unused.test/0",
           "JWT_SECRET": "synthetic-unused-jwt-secret-32-bytes"}
    cases = [{}, {"IDENTITY_EDITION": "enterprise", "IDENTITY_ENTERPRISE_WORKSPACE_IDS": WORKSPACE}]
    for extra in cases:
        result = subprocess.run([server, "identity-config-validation-only"], env=env | extra,
                                capture_output=True, text=True, timeout=10)
        require(result.returncode != 0 and "unknown command" in result.stdout + result.stderr
                and "identity-config-validation-only" in result.stdout + result.stderr,
                "Legacy/edition-only configuration did not pass Config.Load")
    for key in DEPENDENCIES:
        value = "https://identity.test" if key == "IDENTITY_PUBLIC_ORIGIN" else "synthetic-placeholder"
        result = subprocess.run([server, "identity-config-validation-only"], env=env | {key: value},
                                capture_output=True, text=True, timeout=10)
        require(result.returncode != 0 and "invalid identity operator configuration:" in result.stderr,
                f"Partial configuration did not fail closed: {key}")
    print("PASS: server Config.Load legacy + edition-only accepted; all 7 partial dependency settings rejected")


def run(caddy, require_layer4, server):
    pinned = re.search(r"FROM caddy:([\d.]+)@", (ROOT / "infra/docker/caddy/Dockerfile").read_text())[1]
    version = subprocess.check_output([caddy, "version"], text=True).strip()
    require(version.split()[0] == "v" + pinned, f"Need pinned Caddy {pinned}, got {version}")
    modules = subprocess.check_output([caddy, "list-modules"], text=True)
    layer4 = "caddy.listeners.layer4" in modules.splitlines()
    require(not require_layer4 or layer4, "Full listener validation requires caddy-l4")
    if server:
        config_check(server)
    with tempfile.TemporaryDirectory(prefix="calaba-identity-proxy-") as name:
        temp = Path(name)
        compose_check(temp)
        web = temp / "web"
        (web / "assets").mkdir(parents=True)
        (web / "index.html").write_bytes(SPA)
        (web / "assets/test.js").write_text("document.body.dataset.loaded = 'yes';")
        for filename in ("download.caddy", "landing.caddy", "releases.caddy"):
            (temp / filename).write_text("")
        upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        upstream.requests, upstream.bodies = [], []
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        caddy_dir = ROOT / "infra/docker/caddy"
        source = (caddy_dir / "Caddyfile").read_text()
        if not layer4:
            source = remove_block(source, "\tservers :443 {")
        # Production host/env values are never consulted, and no TLS/ACME listeners are opened.
        source = source.replace("{\n\tadmin off", "{\n\tauto_https off\n\tdefault_bind 127.0.0.1\n\tadmin off", 1)

        def local(text):
            text = text.replace("/tmp/", str(temp) + "/").replace("/srv/web", str(web))
            text = text.replace("/srv/releases", str(temp / "releases")).replace("/srv/landing", str(temp / "landing"))
            text = text.replace("127.0.0.1:3000", f"127.0.0.1:{upstream.server_port}")
            return text.replace("127.0.0.1:7880", f"127.0.0.1:{upstream.server_port}")

        # Caddyfile imports sites.caddy and log.caddy relative to its own directory.
        for imported in ("sites.caddy", "log.caddy"):
            (temp / imported).write_text(local((caddy_dir / imported).read_text()))
        config = temp / "Caddyfile"
        config.write_text(local(source))
        env = {"PATH": os.environ["PATH"], "HOME": str(temp), "XDG_CONFIG_HOME": str(temp / "config"),
               "XDG_DATA_HOME": str(temp / "data"),
               "APP_HOSTS": f"http://identity.test:{port} http://alias.test:{port}",
               "RTC_HOSTS": f"http://rtc.test:{port}", "TURN_HOSTS": f"http://turn.test:{port}",
               "RTC_ORIGINS": " https://rtc.test wss://rtc.test", "RELEASES_ORIGIN": ""}
        validation = subprocess.run([caddy, "validate", "--config", str(config)], env=env,
                                    capture_output=True, text=True, timeout=20)
        require(validation.returncode == 0, "Caddy validate failed: " + validation.stderr)
        adapted = subprocess.run([caddy, "adapt", "--config", str(config)], env=env,
                                 capture_output=True, text=True, check=True, timeout=20)
        log_config = json.loads(adapted.stdout)["logging"]["logs"]
        require(any(v.get("writer", {}).get("output") == "discard" for v in log_config.values()),
                "App access logs must be explicitly discarded")
        discarded_loggers = {"http.log.access." + name for name, value in log_config.items()
                             if value.get("writer", {}).get("output") == "discard"}
        log_path = temp / "caddy.log"
        count = 0
        process = None
        try:
            with log_path.open("w") as log:
                process = subprocess.Popen([caddy, "run", "--config", str(config)], env=env,
                                           stdout=log, stderr=subprocess.STDOUT)
                for _ in range(100):
                    require(process.poll() is None, "Caddy stopped before startup")
                    try:
                        if request(port, "/")[0] == 200:
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise AssertionError("Caddy did not start")
                routes = [("GET", ISSUER + "/.well-known/openid-configuration"),
                          ("GET", f"/.well-known/oauth-authorization-server/oidc/workspaces/{WORKSPACE}"),
                          ("GET", ISSUER + "/jwks"), ("GET", ISSUER + "/authorize"),
                          ("POST", ISSUER + "/token"), ("GET", ISSUER + "/userinfo"),
                          ("POST", ISSUER + "/userinfo"), ("POST", ISSUER + "/revoke"),
                          ("OPTIONS", ISSUER + "/token"), ("GET", "/api/auth/sso/callback/" + WORKSPACE),
                          ("POST", "/api/oauth/requests/" + SENTINELS[5] + "/bind"),
                          ("GET", f"/api/workspaces/{WORKSPACE}/identity/connections"),
                          ("GET", f"/api/workspaces/{WORKSPACE}/oauth/clients"),
                          ("GET", "/api/me/oauth-grants"), ("GET", "/healthz"), ("GET", "/gateway")]
                for host in ("identity.test", "alias.test"):
                    for method, path in routes:
                        target = path + "?" + QUERY
                        form = ("code=" + SENTINELS[9]) if method == "POST" else None
                        status, headers, body = request(port, target, method, form, host)
                        require(status == (302 if "/callback/" in path else 200), f"API status: {path}")
                        require(json.loads(body) == {"upstream": True, "method": method, "target": target},
                                f"Not proxied intact: {path}")
                        require((method, target) == upstream.requests[-1], f"Upstream mismatch: {path}")
                        if form:
                            require(upstream.bodies[-1] == form.encode(), "Form body modified")
                        if path not in ("/healthz", "/gateway"):
                            require(header(headers, "Referrer-Policy") == "no-referrer", f"Referrer weakened: {path}")
                            expected = "public, max-age=60" if path.endswith("/jwks") else "no-store"
                            require(header(headers, "Cache-Control") == expected, f"Cache policy changed: {path}")
                            require("frame-ancestors 'none'" in header(headers, "Content-Security-Policy"), "API CSP lost")
                        count += 1
                for path in (ISSUER + "/authorize", "/api/auth/sso/workspaces/" + WORKSPACE):
                    status, headers, body = request(port, path + "?fixture_status=503&" + QUERY)
                    require(status == 503 and json.loads(body)["upstream"], "Legacy disabled endpoint became SPA")
                    require(header(headers, "Cache-Control") == "no-store", "Upstream error cache policy lost")
                    require(header(headers, "Referrer-Policy") == "no-referrer", "Upstream error referrer policy lost")
                    count += 1
                spa_paths = ("/sso/complete", "/oauth/consent", "/", "/rooms/test",
                             ISSUER + "/token/extra", "/oidc/workspaces/extra/workspace/token",
                             "/oidc/workspaces-not-a-route/token",
                             f"/.well-known/oauth-authorization-server/oidc/workspaces/{WORKSPACE}/extra")
                for path in spa_paths:
                    before = len(upstream.requests)
                    status, headers, body = request(port, path + "?" + QUERY)
                    require(status == 200 and body == SPA, f"SPA did not load: {path}")
                    require(len(upstream.requests) == before, f"SPA/near-match was proxied: {path}")
                    sensitive = path in ("/sso/complete", "/oauth/consent")
                    require(header(headers, "Cache-Control") == ("no-store" if sensitive else "no-cache"), "SPA caching")
                    require(header(headers, "Referrer-Policy") == ("no-referrer" if sensitive else "same-origin"), f"SPA referrer: {path}")
                    csp = header(headers, "Content-Security-Policy")
                    require("script-src 'self' 'wasm-unsafe-eval'" in csp and "frame-ancestors 'none'" in csp,
                            "SPA CSP blocks scripts or allows framing")
                    require(header(headers, "X-Frame-Options") == "DENY", "SPA framing allowed")
                    count += 1
                status, headers, body = request(port, "/assets/test.js")
                require(status == 200 and b"dataset.loaded" in body, "SPA script asset unavailable")
                require(header(headers, "Cache-Control") == "public, max-age=31536000, immutable", "Asset caching changed")
                require(request(port, "/assets/missing.js")[0] == 404, "Missing asset fell through to SPA")
                require(request(port, "/metrics")[0] == 404 and request(port, "/readyz")[0] == 404,
                        "Internal endpoint exposed")
                count += 4
                upstream.shutdown()
                upstream.server_close()
                for path in (ISSUER + "/token", "/api/oauth/requests/" + SENTINELS[5] + "/bind"):
                    status, headers, _ = request(port, path + "?" + QUERY, "POST", "code=" + SENTINELS[9])
                    require(status == 502, "Unavailable upstream did not fail closed")
                    require(header(headers, "Cache-Control") == "no-store", "Proxy error can be cached")
                    require(header(headers, "Referrer-Policy") == "no-referrer", "Proxy error leaks referrer")
                    require("frame-ancestors 'none'" in header(headers, "Content-Security-Policy"), "Error allows framing")
                    count += 1
                # The app's handled error does not emit a runtime error. The synthetic RTC
                # site has no error handler and exercises the same global log filter.
                require(request(port, "/?" + QUERY, host="rtc.test")[0] == 502, "Error log fixture failed")
                count += 1
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if thread.is_alive():
                upstream.shutdown()
                upstream.server_close()
            thread.join(timeout=5)
        logs = log_path.read_text()
        require(all(sentinel not in logs for sentinel in SENTINELS), "Secret sentinel found in Caddy logs")
        errors = [json.loads(line) for line in logs.splitlines() if line.startswith("{")]
        require(any(record.get("status") == 502 for record in errors), "No proxy error log exercised")
        require(all("uri" not in record.get("request", {}) and "headers" not in record.get("request", {})
                    and "resp_headers" not in record for record in errors), "Request details survived log filter")
        require(not any(record.get("logger") in discarded_loggers for record in errors),
                "Discarded app access logs were emitted")
        print(f"PASS: Caddy {pinned} validate/adapt; {count} routing/header/failure checks; 10 log sentinels absent")
        print("Listener validation: " + ("full caddy-l4 config" if layer4 else
              "stock Caddy app config (TURN listener wrapper excluded; not tested)"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caddy-bin", default=shutil.which("caddy"))
    parser.add_argument("--require-layer4", action="store_true", help="Also require full TURN listener validation")
    parser.add_argument("--server-bin", help="Optionally verify Config.Load without opening backend connections")
    args = parser.parse_args()
    require(args.caddy_bin is not None, "Install repository-pinned Caddy or pass --caddy-bin")
    run(args.caddy_bin, args.require_layer4, args.server_bin)
