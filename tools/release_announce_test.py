"""CHANGELOG → chat message formatting of tools/release-announce.py.

    python3 -m unittest tools/release_announce_test.py
"""
import importlib.util
import os
import unittest

_spec = importlib.util.spec_from_file_location(
    "release_announce", os.path.join(os.path.dirname(os.path.abspath(__file__)), "release-announce.py"))
ra = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ra)

CHANGELOG = """# Изменения

## [Unreleased]

### Добавлено
- **Не выпущено**: не должно попасть.

## [1.2.3] — 2026-09-28

### Исправлено
- **Звук**: не пропадает после сна (#90).

### Обновление
- Миграция 00040 выполняется автоматически.

### Добавлено
- **Бейджи**: картинки рядом с именем (#82). Миграция 00035.
- **Пересылка** (ADR-0033, #81): в личные и комнаты,
  несколько получателей сразу.

### Изменено
- **Стикеры**: эмодзи из общего пикера (#79).

## [1.2.2] — 2026-09-20

### Добавлено
- **Старое**: не должно попасть.

[1.2.3]: https://example.test
"""


class RenderTest(unittest.TestCase):
    def test_message(self):
        self.assertEqual(ra.render("1.2.3", CHANGELOG), "\n\n".join([
            "🚀 **Calab 1.2.3** — 28 сентября 2026",
            "✨ **Добавлено**\n\n• **Бейджи**: картинки рядом с именем.\n"
            "• **Пересылка**: в личные и комнаты, несколько получателей сразу.",
            "🔧 **Изменено**\n\n• **Стикеры**: эмодзи из общего пикера.",
            "🐞 **Исправлено**\n\n• **Звук**: не пропадает после сна.",
            "Обновление придёт само",
        ]))

    def test_missing_version(self):
        with self.assertRaises(ra.AnnounceError):
            ra.render("9.9.9", CHANGELOG)

    def test_clean_bullet(self):
        self.assertEqual(ra.clean_bullet("**A**: b (ADR-0034, #85). Миграции 00034 и 00035."), "**A**: b.")
        self.assertEqual(ra.clean_bullet("**A**: see (например, это) (#1)"), "**A**: see (например, это)")

    def test_limit_keeps_whole_bullets(self):
        bullets = "\n".join(f"- **Пункт {i}**: " + "х" * 300 for i in range(30))
        msg = ra.render("2.0.0", f"## [2.0.0] — 2026-10-01\n\n### Добавлено\n{bullets}\n")
        self.assertLessEqual(len(msg), ra.MAX_CONTENT)
        self.assertIn("…и ещё пунктов: ", msg)
        self.assertTrue(msg.endswith("Обновление придёт само"))
        for line in msg.split("\n"):
            if line.startswith("• "):
                self.assertTrue(line.endswith("х" * 300))  # never cut mid-bullet


SHORT = """## [2.0.0] — 2026-10-02

Вступление.

### Коротко
- Вход через корпоративный SSO.
- Новый сайт calab.io.

### Добавлено
- **SSO**: полный текст (#1).
"""


class ShortTest(unittest.TestCase):
    def test_short_only(self):
        self.assertEqual(ra.render("2.0.0", SHORT), "\n\n".join([
            "🚀 **Calab 2.0.0** — 2 октября 2026",
            "• Вход через корпоративный SSO.\n• Новый сайт calab.io.",
            "Обновление придёт само",
        ]))

    def test_no_link(self):
        self.assertNotIn("http", ra.render("2.0.0", SHORT))

    def test_without_short_is_unchanged(self):
        # byte-for-byte the pre-«Коротко» output
        self.assertEqual(ra.render("1.2.3", CHANGELOG).count("Подробнее"), 0)
        self.assertIn("✨ **Добавлено**", ra.render("1.2.3", CHANGELOG))

    def test_short_not_in_full_render(self):
        sections = ra.parse_sections(ra.changelog_section(SHORT, "2.0.0")[1])
        full = [t for t, _ in sections if t not in ra.SKIP]
        self.assertEqual(full, ["Добавлено"])

    def test_too_long_fails(self):
        big = "## [2.0.0] — 2026-10-02\n\n### Коротко\n" + "\n".join("- " + "х" * 300 for _ in range(14)) + "\n"
        with self.assertRaises(ra.AnnounceError):
            ra.render("2.0.0", big)

    def test_all_mixes_both(self):
        text = SHORT + "\n" + CHANGELOG.split("# Изменения\n", 1)[1]
        out = {v: ra.render(v, text) for v in ra.released_versions(text)}
        self.assertTrue(out["2.0.0"].startswith("🚀 **Calab 2.0.0**"))
        self.assertNotIn("Подробнее:", out["1.2.3"])
        self.assertIn("🐞 **Исправлено**", out["1.2.3"])


class VersionsTest(unittest.TestCase):
    def test_released_oldest_first(self):
        text = CHANGELOG + "\n## [1.10.0] — 2026-10-02\n\n### Добавлено\n- x\n"
        self.assertEqual(ra.released_versions(text), ["1.2.2", "1.2.3", "1.10.0"])

    def test_every_released_version_renders(self):
        for v in ra.released_versions(CHANGELOG):
            self.assertTrue(ra.render(v, CHANGELOG).startswith(f"🚀 **Calab {v}**"))


class FakeApi:
    """Server side of POST (dedup by nonce, deleted nonce → 409), PATCH, list and DELETE."""

    def __init__(self, msgs=None, deleted_nonces=(), forbidden=()):
        self.msgs = list(msgs or [])  # newest first
        self.deleted = set(deleted_nonces)
        self.forbidden = set(forbidden)
        self.log = []

    def call(self, method, path, body=None):
        self.log.append((method, path))
        if method == "POST":
            if body["nonce"] in self.deleted:
                raise ra.HttpError("409", 409)
            for m in self.msgs:
                if m.get("nonce") == body["nonce"]:
                    return 200, {"message": m}
            m = {"id": f"m{len(self.log)}", "authorId": "bot", "content": body["content"], "nonce": body["nonce"]}
            self.msgs.insert(0, m)
            return 201, {"message": m}
        if method == "PATCH":
            mid = path.rsplit("/", 1)[1]
            next(m for m in self.msgs if m["id"] == mid)["content"] = body["content"]
            return 200, {}
        if method == "GET":
            return 200, {"messages": list(self.msgs), "hasMore": False}
        if method == "DELETE":
            mid = path.rsplit("/", 1)[1]
            if mid in self.forbidden:
                raise ra.HttpError("403", 403)
            m = next(m for m in self.msgs if m["id"] == mid)
            self.msgs.remove(m)
            if m.get("nonce"):
                self.deleted.add(m["nonce"])
            return 204, {}
        raise AssertionError(method)


class AnnounceTest(unittest.TestCase):
    def test_post_then_unchanged_then_updated(self):
        api = FakeApi()
        self.assertEqual(ra.announce(api, "r", "1.0.0", "a")[0], "posted")
        self.assertEqual(ra.announce(api, "r", "1.0.0", "a")[0], "unchanged")
        self.assertEqual(ra.announce(api, "r", "1.0.0", "b")[0], "updated")
        self.assertEqual([m["content"] for m in api.msgs], ["b"])

    def test_deleted_post_takes_next_nonce(self):
        api = FakeApi(deleted_nonces={"release-1.0.0"})
        state, _ = ra.announce(api, "r", "1.0.0", "a")
        self.assertEqual(state, "posted")
        self.assertEqual(api.msgs[0]["nonce"], "release-1.0.0-r2")
        self.assertEqual(ra.announce(api, "r", "1.0.0", "a")[0], "unchanged")  # re-run finds the r2 post

    def test_purge_counts_and_refusals(self):
        api = FakeApi(msgs=[{"id": "b1", "authorId": "bot", "nonce": "release-1.0.0", "content": "x"},
                            {"id": "o1", "authorId": "owner", "content": "#0.9"},
                            {"id": "o2", "authorId": "owner", "content": "#0.8"}], forbidden={"o2"})
        own, others, refused = ra.purge(api, "r", "bot")
        self.assertEqual((own, others, [m["id"] for m in refused]), (1, 1, ["o2"]))
        self.assertEqual(ra.announce(api, "r", "1.0.0", "x")[0], "posted")  # after purge: fresh post


if __name__ == "__main__":
    unittest.main()
