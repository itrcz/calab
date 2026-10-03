#!/usr/bin/env python3
"""Post the release notes of one version into the team's «what's new» room as a bot.

    tools/release-announce.py <version> [--dry-run] [--changelog CHANGELOG.md] [--env-file .env]
    tools/release-announce.py --all [--purge --yes] [--dry-run]

Env:
  CALAB_RELEASE_BOT_TOKEN  bot token (required unless --dry-run); sent only as `Authorization: Bearer`
  CALAB_API_URL            default https://app.calab.io
  CALAB_RELEASE_ROOM       default «Calab - что нового? ✨» (exact room name)

If the section has a `### Коротко` block (3-7 one-line bullets), only it is posted: header, the bullets,
footer — no link (owner, 03.10). Without it the whole section is rendered (old versions, --all).
Reads the `## [<version>]` section of CHANGELOG.md and renders it with the chat's markdown-lite
(apps/desktop/src/renderer/lib/markdown: bold, links, line breaks — no lists or headings, so bullets
are «• » lines). The post uses nonce `release-<version>`: the server dedups by (author, nonce)
(docs/04 «Сообщения: порядок и идемпотентность»), so a re-run never double-posts; it edits the
existing post instead when the rendered text changed (see announce()).
--all posts every released version, oldest first, ~1 s apart (message limiter). --purge --yes first
deletes every message of the room (others' need MANAGE_MESSAGES; 403s are listed, not worked around).
Called by the `announce` step of infra/docker/release.sh (one version, never --purge).
Python 3 stdlib only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_CONTENT = 4000  # runes; apps/server/internal/messages MaxContent
DEFAULT_API = "https://app.calab.io"
DEFAULT_ROOM = "Calab - что нового? ✨"

# Section order and emoji; «Обновление» (operator notes: migrations, env) is never posted.
SECTIONS = [("Добавлено", "✨"), ("Изменено", "🔧"), ("Исправлено", "🐞"),
            ("Удалено", "🧹"), ("Безопасность", "🔒")]
SKIP = {"Обновление", "Коротко"}  # «Коротко» is the summary: never repeated in the full render
SUMMARY = "Коротко"
OTHER_EMOJI = "📌"
MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
          "сентября", "октября", "ноября", "декабря"]
TRUNCATED = "…и ещё пунктов: {} — полный список в CHANGELOG.md"
NONCE_SLOTS = 20  # release-<v>, release-<v>-r2, …: a deleted post's nonce stays taken (409)
PACE_SEC = 1.1    # messages limiter: burst 5, 1/s per (room, author)

# A parenthetical made only of references: (#82), (ADR-0033, #81), (ADR-0034)
REF_PAREN = re.compile(r"\s*\((?:\s*(?:#\d+|ADR-\d+)\s*[,;]?)+\)")
# «Миграция 00035.» / «Миграции 00034, 00035.» tails
MIGRATION = re.compile(r"\s*Миграци[яи]\s+\d{3,}(?:\s*(?:,|и)\s*\d{3,})*\.?")


class AnnounceError(Exception):
    pass


def changelog_section(text: str, version: str) -> tuple[str, list[str]]:
    """The date from the heading and the body lines of `## [<version>]`."""
    head = f"## [{version}]"
    lines = text.replace("\r\n", "\n").split("\n")
    for i, line in enumerate(lines):
        if line.startswith(head):
            m = re.search(r"(\d{4})-(\d{2})-(\d{2})", line[len(head):])
            date = f"{int(m.group(3))} {MONTHS[int(m.group(2)) - 1]} {m.group(1)}" if m else ""
            body = []
            for nxt in lines[i + 1:]:
                if nxt.startswith("## [") or re.match(r"^\[[^\]]+\]: ", nxt):
                    break
                body.append(nxt)
            return date, body
    raise AnnounceError(f"no section [{version}] in CHANGELOG.md")


def released_versions(text: str) -> list[str]:
    """Every `## [x.y.z]` of CHANGELOG.md (never [Unreleased]), oldest first."""
    vs = re.findall(r"^## \[(\d+(?:\.\d+)*)\]", text.replace("\r\n", "\n"), re.M)
    return sorted(set(vs), key=lambda v: tuple(int(p) for p in v.split(".")))


def parse_sections(body: list[str]) -> list[tuple[str, list[str]]]:
    """[(title, [bullet text])] in file order; continuation lines are joined into their bullet."""
    out: list[tuple[str, list[str]]] = []
    for line in body:
        if line.startswith("### "):
            out.append((line[4:].strip(), []))
        elif not out:
            continue
        elif re.match(r"^[-*] ", line):
            out[-1][1].append(line[2:].strip())
        elif line.strip() and out[-1][1] and line[:1] in (" ", "\t"):
            out[-1][1][-1] += " " + line.strip()
    return out


def clean_bullet(s: str) -> str:
    s = MIGRATION.sub("", s)
    s = REF_PAREN.sub("", s)
    s = re.sub(r"\s+([.,;:])", r"\1", s).strip()
    return re.sub(r"\s{2,}", " ", s)


def render_short(version: str, date: str, bullets: list[str]) -> str:
    """Header, the «Коротко» bullets, footer (no link to the full list — owner, 03.10)."""
    header = f"🚀 **Calab {version}**" + (f" — {date}" if date else "")
    msg = "\n\n".join([header, "\n".join(f"• {b}" for b in bullets), "Обновление придёт само"])
    if len(msg) > MAX_CONTENT:
        raise AnnounceError(f"«{SUMMARY}» of [{version}] is {len(msg)} chars (limit {MAX_CONTENT}): shorten it")
    return msg


def render(version: str, changelog: str) -> str:
    date, body = changelog_section(changelog, version)
    short = [clean_bullet(b) for t, bs in parse_sections(body) if t == SUMMARY for b in bs if b.strip()]
    if short:
        return render_short(version, date, short)
    parsed = [(t, [clean_bullet(b) for b in bs if b.strip()]) for t, bs in parse_sections(body)
              if t not in SKIP]
    order = {t: i for i, (t, _) in enumerate(SECTIONS)}
    parsed.sort(key=lambda s: order.get(s[0], len(SECTIONS)))  # stable: unknown ones keep file order
    emoji = dict(SECTIONS)
    parsed = [(t, bs) for t, bs in parsed if bs]
    if not parsed:
        raise AnnounceError(f"section [{version}] has nothing to announce")

    header = f"🚀 **Calab {version}**" + (f" — {date}" if date else "")
    footer = "Обновление придёт само"

    total = sum(len(bs) for _, bs in parsed)

    def build(limit: int | None) -> str:
        # Blank line before every heading and the footer, and after a heading (owner, 28.09).
        parts, n = [header], 0
        for title, bullets in parsed:
            if limit is not None and n >= limit:
                break
            take = bullets if limit is None else bullets[:limit - n]
            n += len(take)
            parts.append(f"{emoji.get(title, OTHER_EMOJI)} **{title}**\n\n" + "\n".join(f"• {b}" for b in take))
        if limit is not None:
            parts.append(TRUNCATED.format(total - n))
        parts.append(footer)
        return "\n\n".join(parts)

    msg = build(None)
    limit = total
    while len(msg) > MAX_CONTENT:
        limit -= 1
        if limit < 0:
            raise AnnounceError("message does not fit even without bullets")
        msg = build(limit)
    return msg




# --- API ---------------------------------------------------------------------------------------

class HttpError(AnnounceError):
    def __init__(self, msg: str, status: int):
        super().__init__(msg)
        self.status = status


class Api:
    def __init__(self, base: str, token: str):
        self.base, self.token = base.rstrip("/"), token

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(5):
            req = urllib.request.Request(self.base + path, data=data, method=method)
            req.add_header("Authorization", f"Bearer {self.token}")
            req.add_header("Accept", "application/json")
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, json.loads(r.read() or b"{}")
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 4:  # same body (same nonce) is safe to repeat
                    time.sleep(min(float(e.headers.get("Retry-After") or 1), 10))
                    continue
                try:
                    err = json.loads(e.read() or b"{}")
                except ValueError:
                    err = {}
                code = err.get("code", "?")
                reason = f", reason {err['reason']}" if err.get("reason") else ""
                raise HttpError(f"{method} {path} → HTTP {e.code} ({code}{reason})", e.code) from None
            except urllib.error.URLError as e:
                raise AnnounceError(f"{method} {path} → {e.reason}") from None
        raise AnnounceError(f"{method} {path} → still rate limited")


def find_room(api: Api, name: str) -> tuple[str, str, str]:
    """(room id, workspace name, bot user id) of the room with exactly this name among the bot's workspaces."""
    _, me = api.call("GET", "/api/bots/me")
    bot = me.get("bot", {})
    _, wss = api.call("GET", "/api/workspaces")
    workspaces = wss.get("workspaces", [])
    found = []
    for ws in workspaces:
        _, rooms = api.call("GET", f"/api/workspaces/{urllib.parse.quote(ws['id'])}/rooms")
        found += [(r["id"], ws.get("name", ws["id"])) for r in rooms.get("rooms", []) if r.get("name") == name]
    who = bot.get("username") or bot.get("user", {}).get("displayName", "bot")
    if not found:
        raise AnnounceError(
            f"bot @{who} sees no room named «{name}» in its {len(workspaces)} workspace(s): an admin must add "
            "the bot to that workspace and give it VIEW_ROOM + SEND_MESSAGES in the room")
    if len(found) > 1:
        raise AnnounceError(f"{len(found)} rooms named «{name}» are visible to @{who}; set CALAB_RELEASE_ROOM")
    return found[0][0], found[0][1], bot.get("user", {}).get("id", "")


def announce(api: Api, room_id: str, version: str, msg: str) -> tuple[str, str]:
    """Bring the post of `version` to `msg`: ("posted" | "updated" | "unchanged", message id).

    POST with nonce release-<v>: 201 = new post; 200 = the server returned our earlier post with that
    nonce (dedup by author+nonce) → PATCH it if the text differs. A deleted post keeps its nonce taken
    (409), so the next slot release-<v>-r2, … is tried; the first live or free slot wins, which keeps
    re-runs idempotent."""
    room = urllib.parse.quote(room_id)
    for slot in range(1, NONCE_SLOTS + 1):
        nonce = f"release-{version}" + (f"-r{slot}" if slot > 1 else "")
        try:
            status, res = api.call("POST", f"/api/rooms/{room}/messages", {"content": msg, "nonce": nonce})
        except HttpError as e:
            if e.status == 409:
                continue
            raise
        m = res.get("message", {})
        mid = m.get("id", "?")
        if status == 201:
            return "posted", mid
        if m.get("content") == msg:
            return "unchanged", mid
        api.call("PATCH", f"/api/messages/{urllib.parse.quote(mid)}", {"content": msg})
        return "updated", mid
    raise AnnounceError(f"all {NONCE_SLOTS} nonce slots of {version} are taken by deleted posts")


def purge(api: Api, room_id: str, bot_id: str) -> tuple[int, int, list[dict]]:
    """Delete every message of the room: (own deleted, others deleted, others refused with 403)."""
    msgs, before = [], None
    while True:
        q = f"/api/rooms/{urllib.parse.quote(room_id)}/messages?limit=100" + (f"&before={before}" if before else "")
        _, res = api.call("GET", q)
        page = res.get("messages", [])
        msgs += page
        if not res.get("hasMore") or not page:
            break
        before = page[-1]["id"]
    own = others = 0
    refused = []
    for m in msgs:
        try:
            api.call("DELETE", f"/api/messages/{urllib.parse.quote(m['id'])}")
        except HttpError as e:
            if e.status == 403 and m.get("authorId") != bot_id:
                refused.append(m)
                continue
            if e.status == 404:  # already gone
                continue
            raise
        if m.get("authorId") == bot_id:
            own += 1
        else:
            others += 1
    return own, others, refused


def load_env_file(path: str) -> None:
    """KEY=VALUE lines of a dotenv file into os.environ (already set variables win). Values are never printed."""
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.removeprefix("export ").split("=", 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                v = v[1:-1]
            os.environ.setdefault(k.strip(), v)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("version", nargs="?")
    ap.add_argument("--all", action="store_true", help="every released version of CHANGELOG.md, oldest first")
    ap.add_argument("--purge", action="store_true", help="first delete every message of the room (needs --yes)")
    ap.add_argument("--yes", action="store_true", help="confirm --purge")
    ap.add_argument("--dry-run", action="store_true", help="print the message(s), post nothing")
    ap.add_argument("--env-file", help="dotenv file to read CALAB_* from (e.g. the repo-root .env)")
    ap.add_argument("--changelog", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "CHANGELOG.md"))
    a = ap.parse_args(argv)
    if bool(a.version) == a.all:
        ap.error("give either <version> or --all")
    if a.purge and not a.yes and not a.dry_run:
        ap.error("--purge deletes every message of the room: add --yes")
    try:
        with open(a.changelog, encoding="utf-8") as f:
            changelog = f.read()
        versions = released_versions(changelog) if a.all else [a.version.removeprefix("v")]
        msgs = [(v, render(v, changelog)) for v in versions]
        if a.dry_run:
            print("\n\n----\n\n".join(m for _, m in msgs))
            for v, m in msgs:
                print(f"-- {v}: {len(m)} chars" + (" (cut)" if "…и ещё пунктов" in m else ""), file=sys.stderr)
            print("-- dry run: nothing posted" + (", nothing purged" if a.purge else ""), file=sys.stderr)
            return 0
        if a.env_file:
            load_env_file(a.env_file)
        token = os.environ.get("CALAB_RELEASE_BOT_TOKEN", "").strip()
        if not token:
            raise AnnounceError("CALAB_RELEASE_BOT_TOKEN is not set")
        api = Api(os.environ.get("CALAB_API_URL") or DEFAULT_API, token)
        room = os.environ.get("CALAB_RELEASE_ROOM") or DEFAULT_ROOM
        room_id, ws_name, bot_id = find_room(api, room)
        if a.purge:
            own, others, refused = purge(api, room_id, bot_id)
            print(f"release-announce: purged «{room}»: {own} own, {others} others' deleted, {len(refused)} refused (403)")
            for m in refused:
                first = m.get("content", "").split("\n", 1)[0][:60]
                print(f"  refused: {m['id']} {m.get('createdAt', '')[:10]} «{first}» — needs MANAGE_MESSAGES")
        for i, (v, msg) in enumerate(msgs):
            if i:
                time.sleep(PACE_SEC)
            state, mid = announce(api, room_id, v, msg)
            print(f"release-announce: {v} {state}: message {mid} ({len(msg)} chars) in «{room}» ({ws_name})")
        return 0
    except (AnnounceError, OSError) as e:
        print(f"release-announce: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
