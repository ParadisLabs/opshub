"""Phase 3 regression suite: providers, budgets, render, studios, /run all."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
OPSHUB = os.path.dirname(HERE)
sys.path.insert(0, OPSHUB)
sys.path.insert(0, os.path.join(OPSHUB, "shared"))
os.environ.setdefault("TTS_MODE", "synthetic")

from production import qa, runner, studios  # noqa: E402
from production.contracts import Job, new_job_id  # noqa: E402
from production.narration import synthesize  # noqa: E402
from production.providers.base import ProviderError  # noqa: E402
from production.providers.chain import ProviderChain  # noqa: E402
from production.providers.gemini import GeminiProvider  # noqa: E402
from production.providers.groq import GroqProvider  # noqa: E402
from production.providers.internet_archive import InternetArchiveProvider  # noqa: E402
from production.providers.pixabay import PixabayProvider  # noqa: E402
from production.providers.wikimedia import WikimediaProvider  # noqa: E402
from production.redact import sanitize  # noqa: E402
from production.render import (RenderError, ensure_tools, make_still,  # noqa: E402
                               render_episode)
from production.synthetic import SyntheticLLM  # noqa: E402
from production.usage import BudgetExceeded, UsageLedger  # noqa: E402

SECRET = "AIza" + "S" * 32


def gemini_ok_body(payload=None):
    return json.dumps({
        "candidates": [{"content": {"parts": [{"text": json.dumps(payload or {"ok": True})}]}}],
        "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 34,
                          "totalTokenCount": 46},
    })


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url, headers, body))
        item = self.responses.pop(0) if self.responses else (200, "{}")
        if callable(item):
            return item(method, url, headers, body)
        return item


class TestRedaction(unittest.TestCase):
    def test_known_and_shaped_secrets_are_removed(self):
        text = f"call failed key={SECRET} Bearer gsk_{'a' * 30} ?key={SECRET}"
        cleaned = sanitize(text, [SECRET])
        self.assertNotIn(SECRET, cleaned)
        self.assertNotIn("gsk_", cleaned)
        self.assertIn("[redacted]", cleaned)


class TestUsageBudget(unittest.TestCase):
    def test_record_and_totals(self):
        with tempfile.TemporaryDirectory() as d:
            ledger = UsageLedger(os.path.join(d, "usage.json"))
            ledger.record("j1", "gemini", "m", prompt_tokens=10, completion_tokens=5)
            self.assertEqual(ledger.totals(job_id="j1")["tokens"], 15)
            self.assertEqual(ledger.totals(job_id="j1")["calls"], 1)

    def test_budget_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            ledger = UsageLedger(os.path.join(d, "usage.json"), job_tokens=5)
            with self.assertRaises(BudgetExceeded):
                ledger.check("j1", estimated_tokens=100)

    def test_call_budget_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            ledger = UsageLedger(os.path.join(d, "usage.json"), job_calls=1)
            ledger.record("j1", "mock", "m")
            with self.assertRaises(BudgetExceeded):
                ledger.check("j1", calls=1)


class TestGemini(unittest.TestCase):
    def test_discovery_generation_and_usage(self):
        transport = FakeTransport([
            (200, json.dumps({"models": [
                {"name": "models/gemini-3.8-flash",
                 "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/text-embedding-004",
                 "supportedGenerationMethods": ["embedContent"]},
            ]})),
            (200, gemini_ok_body({"sources": ["a"]})),
        ])
        with tempfile.TemporaryDirectory() as d:
            ledger = UsageLedger(os.path.join(d, "u.json"))
            provider = GeminiProvider({"GEMINI_API_KEY": SECRET}, transport=transport,
                                      ledger=ledger, sleeper=lambda s: None)
            result = provider.generate_json("hi", job_id="j1",
                                            schema={"required": ["sources"],
                                                    "types": {"sources": "list"}})
            self.assertEqual(result["model"], "gemini-3.8-flash")
            self.assertEqual(result["data"]["sources"], ["a"])
            self.assertEqual(ledger.totals(job_id="j1")["tokens"], 46)

    def test_rate_limit_retries_then_succeeds(self):
        transport = FakeTransport([
            (200, json.dumps({"models": [{"name": "models/gemini-3.8-flash",
                                          "supportedGenerationMethods": ["generateContent"]}]})),
            (429, "rate limited"),
            (200, gemini_ok_body()),
        ])
        provider = GeminiProvider({"GEMINI_API_KEY": SECRET}, transport=transport,
                                  sleeper=lambda s: None)
        result = provider.generate_json("hi", job_id="j", max_attempts=3)
        self.assertEqual(result["attempts"], 2)

    def test_auth_failure_is_not_retried(self):
        transport = FakeTransport([
            (200, json.dumps({"models": [{"name": "models/gemini-3.8-flash",
                                          "supportedGenerationMethods": ["generateContent"]}]})),
            (401, f"bad key {SECRET}"),
        ])
        provider = GeminiProvider({"GEMINI_API_KEY": SECRET}, transport=transport,
                                  sleeper=lambda s: None)
        with self.assertRaises(ProviderError) as ctx:
            provider.generate_json("hi", job_id="j", max_attempts=4)
        self.assertFalse(ctx.exception.retryable)
        self.assertNotIn(SECRET, str(ctx.exception))
        self.assertEqual(len([c for c in transport.calls if c[0] == "POST"]), 1)

    def test_schema_validation_rejects(self):
        transport = FakeTransport([
            (200, json.dumps({"models": [{"name": "models/gemini-3.8-flash",
                                          "supportedGenerationMethods": ["generateContent"]}]})),
            (200, gemini_ok_body({"wrong": 1})),
        ])
        provider = GeminiProvider({"GEMINI_API_KEY": SECRET}, transport=transport,
                                  sleeper=lambda s: None)
        with self.assertRaises(ProviderError):
            provider.generate_json("hi", job_id="j",
                                   schema={"required": ["sources"]})

    def test_budget_blocks_before_call(self):
        transport = FakeTransport([(200, json.dumps({"models": [
            {"name": "models/gemini-3.8-flash",
             "supportedGenerationMethods": ["generateContent"]}]}))])
        with tempfile.TemporaryDirectory() as d:
            ledger = UsageLedger(os.path.join(d, "u.json"), job_tokens=10)
            provider = GeminiProvider({"GEMINI_API_KEY": SECRET}, transport=transport,
                                      ledger=ledger, sleeper=lambda s: None)
            with self.assertRaises(BudgetExceeded):
                provider.generate_json("hi", job_id="j")


class TestGroq(unittest.TestCase):
    def test_rotates_to_secondary_key_on_rate_limit(self):
        responses = [
            (200, json.dumps({"data": [{"id": "openai/gpt-oss-120b"}]})),
            (429, "rate limited"),
            (200, json.dumps({"choices": [{"message": {"content": json.dumps({"ok": 1})}}],
                              "usage": {"prompt_tokens": 5, "completion_tokens": 7}})),
        ]
        transport = FakeTransport(responses)
        provider = GroqProvider({"GROQ_API_KEY": "gsk_" + "a" * 20,
                                 "GROQ_API_KEY_2": "gsk_" + "b" * 20},
                                transport=transport, sleeper=lambda s: None)
        result = provider.generate_json("hi", job_id="j", max_attempts=1)
        self.assertEqual(result["key_index"], 1)
        self.assertEqual(result["usage"]["completion_tokens"], 7)

    def test_auth_failure_is_finite(self):
        transport = FakeTransport([
            (200, json.dumps({"data": [{"id": "openai/gpt-oss-120b"}]})),
            (401, "bad key"),
            (401, "bad key"),
        ])
        provider = GroqProvider({"GROQ_API_KEY": "gsk_" + "a" * 20,
                                 "GROQ_API_KEY_2": "gsk_" + "b" * 20},
                                transport=transport, sleeper=lambda s: None)
        with self.assertRaises(ProviderError):
            provider.generate_json("hi", job_id="j", max_attempts=3)
        self.assertLessEqual(len([c for c in transport.calls if c[0] == "POST"]), 2)


class TestChain(unittest.TestCase):
    def test_falls_back_and_records_reason(self):
        class Bad:
            name = "bad"

            def configured(self):
                return True

            def generate_json(self, *a, **k):
                raise ProviderError("boom", provider="bad")

            def _secrets(self):
                return []

        class Good:
            name = "good"

            def configured(self):
                return True

            def generate_json(self, prompt, **kwargs):
                return {"data": {"ok": True}, "provider": "good"}

        chain = ProviderChain([Bad(), Good()])
        result = chain.generate_json("hi", job_id="j")
        self.assertEqual(result["provider"], "good")
        self.assertTrue(result["fallbacks"])


class TestPixabay(unittest.TestCase):
    def test_search_cache_and_checksummed_download(self):
        hits = json.dumps({"hits": [{
            "id": 1, "tags": "city", "pageURL": "https://pixabay.com/1",
            "user": "author", "largeImageURL": "https://cdn/1.jpg",
            "imageWidth": 1080, "imageHeight": 1920}]}).encode()
        calls = {"search": 0, "download": 0}

        def transport(url, timeout):
            calls["search"] += 1
            return 200, hits

        def downloader(url, timeout):
            calls["download"] += 1
            return 200, b"\x89PNG" + b"x" * 100

        with tempfile.TemporaryDirectory() as d:
            provider = PixabayProvider({"PIXABAY_API_KEY": "k" * 10},
                                       cache_path=os.path.join(d, "cache.json"),
                                       transport=transport, downloader=downloader)
            first = provider.search("city")
            second = provider.search("city")
            self.assertEqual(len(first), 1)
            self.assertEqual(len(second), 1)
            self.assertEqual(calls["search"], 1)  # second search is served from cache
            asset = provider.download(first[0], os.path.join(d, "assets"))
            self.assertTrue(os.path.exists(asset["path"]))
            self.assertEqual(len(asset["sha256"]), 64)
            self.assertEqual(asset["license"].split()[0], "Pixabay")

    def test_missing_key_is_reported(self):
        provider = PixabayProvider({})
        with self.assertRaises(ProviderError):
            provider.search("city")


class TestRender(unittest.TestCase):
    def test_real_mp4_has_h264_aac_and_srt(self):
        ensure_tools()
        with tempfile.TemporaryDirectory() as d:
            scenes = []
            for i in (1, 2):
                image = make_still(os.path.join(d, f"img{i}.png"), 320, 568,
                                   label=f"scene {i}", index=i)
                audio = synthesize("", os.path.join(d, f"a{i}.wav"), seconds=3.0)["path"]
                scenes.append({"image": image, "audio": audio, "seconds": 3.0,
                               "caption": f"Caption {i}", "narration": f"Line {i}"})
            report = render_episode(scenes, os.path.join(d, "out.mp4"),
                                    width=320, height=568, fps=12,
                                    ken_burns=False, preset="ultrafast")
            self.assertEqual(report["status"], "passed")
            self.assertEqual(report["video_codec"], "h264")
            self.assertEqual(report["audio_codec"], "aac")
            self.assertEqual((report["width"], report["height"]), (320, 568))
            self.assertTrue(os.path.exists(report["srt_path"]))
            self.assertGreater(report["duration"], 5.0)


def small_ctx(tmp: str, llm=None):
    return {
        "llm": llm or SyntheticLLM("phase3 test"), "outdir": tmp,
        "allow_tts": False, "ken_burns": False,
        "short_width": 320, "short_height": 568, "short_fps": 10,
        "short_seconds": 8, "landscape_width": 480, "landscape_height": 270,
        "landscape_fps": 8, "landscape_seconds": 10,
        "production_mode": "test",
    }


class TestStudios(unittest.TestCase):
    def test_trendscope_production(self):
        with tempfile.TemporaryDirectory() as d:
            job = Job(job_id=new_job_id("trendscope"), studio="trendscope",
                      topic="AI agents")
            result = studios.trendscope(job, small_ctx(d))
            self.assertNotEqual(result["verdict"], "blocked")
            self.assertFalse(result["publishing_enabled"])
            video = result["artifacts"][0]
            self.assertEqual((video["width"], video["height"]), (320, 568))
            self.assertEqual(video["video_codec"], "h264")
            self.assertEqual(video["audio_codec"], "aac")
            self.assertEqual(result["manifest"]["problems"], [])

    def test_true_crime_editorial_gate_blocks(self):
        class BadDossier(SyntheticLLM):
            def generate_json(self, prompt, *, schema=None, **kwargs):
                payload = self._dossier()
                payload["victims_protected"] = False
                payload["allegations"][0]["status"] = "rumour"
                return {"data": payload, "provider": "test", "model": "bad"}

        with tempfile.TemporaryDirectory() as d:
            job = Job(job_id=new_job_id("true-crime"), studio="true-crime",
                      topic="case")
            result = studios.true_crime(job, small_ctx(d, llm=BadDossier()))
            self.assertEqual(result["verdict"], "blocked")
            self.assertEqual(result["artifacts"], [])
            self.assertTrue(any("victim" in r for r in result["blocked_reasons"]))

    def test_true_crime_pass_case_renders(self):
        with tempfile.TemporaryDirectory() as d:
            job = Job(job_id=new_job_id("true-crime"), studio="true-crime",
                      topic="case")
            result = studios.true_crime(job, small_ctx(d))
            self.assertNotEqual(result["verdict"], "blocked")
            self.assertEqual(len(result["artifacts"]), 1)

    def test_deep_history_both_formats(self):
        with tempfile.TemporaryDirectory() as d:
            job = Job(job_id=new_job_id("deep-history"), studio="deep-history",
                      topic="silk road")
            result = studios.deep_history(job, small_ctx(d))
            kinds = {(a["type"], a["width"], a["height"]) for a in result["artifacts"]}
            self.assertIn(("video", 320, 568), kinds)
            self.assertIn(("video_landscape", 480, 270), kinds)
            self.assertFalse(result["publishing_enabled"])
            self.assertIn("narration_coverage", result)
            self.assertIn("long_form_narration_coverage", result)
            manifest_path = result["manifest"]["path"]
            with open(manifest_path) as f:
                manifest = json.load(f)
            videos = [v for v in manifest["assets"].values() if v["kind"] == "video"]
            self.assertEqual(len(videos), 2, "both formats must be in the durable manifest")
            self.assertTrue(any(v["meta"].get("format") == "landscape" for v in videos))
            self.assertEqual(result["manifest"]["problems"], [])


class TestRunner(unittest.TestCase):
    def test_failure_isolation_and_duplicates(self):
        original = runner.STUDIO_FUNCS["true-crime"]

        def boom(*args, **kwargs):
            raise RuntimeError("simulated studio outage")

        runner.STUDIO_FUNCS["true-crime"] = boom
        try:
            with tempfile.TemporaryDirectory() as d:
                ctx = small_ctx(d)
                first = runner.run_all(ctx, topic="isolation")
                self.assertEqual(first["statuses"]["trendscope"], "complete")
                self.assertEqual(first["statuses"]["deep-history"], "complete")
                self.assertEqual(first["statuses"]["true-crime"], "failed")
                self.assertFalse(first["publishing_enabled"])
        finally:
            runner.STUDIO_FUNCS["true-crime"] = original

    def test_duplicate_trigger_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = small_ctx(d)
            first = runner.run_all(ctx, topic="dup", studios_to_run=["trendscope"])
            second = runner.run_all(ctx, topic="dup", studios_to_run=["trendscope"])
            self.assertFalse(first["jobs"][0]["duplicate"])
            self.assertTrue(second["jobs"][0]["duplicate"])
            self.assertEqual(first["jobs"][0]["job_id"], second["jobs"][0]["job_id"])

    def test_cancellation_is_final(self):
        with tempfile.TemporaryDirectory() as d:
            ctx = small_ctx(d)
            result = runner.run_all(ctx, topic="cancel",
                                    studios_to_run=["trendscope"],
                                    cancel=lambda: True)
            self.assertEqual(result["statuses"]["trendscope"], "cancelled")


class TestProviderOutages(unittest.TestCase):
    def test_gemini_malformed_json_is_rejected(self):
        transport = FakeTransport([
            (200, json.dumps({"models": [{"name": "models/gemini-3.8-flash",
                                          "supportedGenerationMethods": ["generateContent"]}]})),
            (200, "this is not json"),
        ])
        provider = GeminiProvider({"GEMINI_API_KEY": SECRET}, transport=transport,
                                  sleeper=lambda s: None)
        with self.assertRaises(ProviderError):
            provider.generate_json("hi", job_id="j")

    def test_gemini_500_retries_then_fails_cleanly(self):
        transport = FakeTransport([
            (200, json.dumps({"models": [{"name": "models/gemini-3.8-flash",
                                          "supportedGenerationMethods": ["generateContent"]}]})),
            (500, "upstream boom"),
            (500, "upstream boom"),
        ])
        provider = GeminiProvider({"GEMINI_API_KEY": SECRET}, transport=transport,
                                  sleeper=lambda s: None)
        with self.assertRaises(ProviderError) as ctx:
            provider.generate_json("hi", job_id="j", max_attempts=2)
        self.assertTrue(ctx.exception.retryable)
        self.assertEqual(len([c for c in transport.calls if c[0] == "POST"]), 2)

    def test_transport_timeout_is_retryable(self):
        calls = {"n": 0}

        def transport(method, url, headers, body, timeout):
            if method == "GET":
                return 200, json.dumps({"models": [{
                    "name": "models/gemini-3.8-flash",
                    "supportedGenerationMethods": ["generateContent"]}]})
            calls["n"] += 1
            raise ProviderError("transport error: TimeoutError", retryable=True,
                                provider="gemini")

        provider = GeminiProvider({"GEMINI_API_KEY": SECRET}, transport=transport,
                                  sleeper=lambda s: None)
        with self.assertRaises(ProviderError):
            provider.generate_json("hi", job_id="j", max_attempts=2)
        self.assertEqual(calls["n"], 2)

    def test_groq_outage_recovers_on_same_key(self):
        transport = FakeTransport([
            (200, json.dumps({"data": [{"id": "openai/gpt-oss-120b"}]})),
            (500, "upstream"),
            (200, json.dumps({"choices": [{"message": {
                "content": json.dumps({"ok": 1})}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1}})),
        ])
        provider = GroqProvider({"GROQ_API_KEY": "gsk_" + "a" * 20},
                                transport=transport, sleeper=lambda s: None)
        result = provider.generate_json("hi", job_id="j", max_attempts=2)
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["key_index"], 0)


class TestBudgetAndRenderFailures(unittest.TestCase):
    def test_daily_budget_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            ledger = UsageLedger(os.path.join(d, "u.json"), job_calls=99, daily_calls=1)
            ledger.record("j1", "mock", "m")
            with self.assertRaises(BudgetExceeded):
                ledger.check("j2", calls=1)

    def test_interrupted_render_missing_scene_asset(self):
        ensure_tools()
        with tempfile.TemporaryDirectory() as d:
            image = make_still(os.path.join(d, "i.png"), 160, 284, index=1)
            audio = synthesize("", os.path.join(d, "a.wav"), seconds=1.0)["path"]
            with self.assertRaises(RenderError):
                render_episode([{"image": image,
                                 "audio": os.path.join(d, "missing.wav"),
                                 "seconds": 1.0, "caption": "x"}],
                               os.path.join(d, "out.mp4"), width=160, height=284, fps=8)

    def test_srt_uses_narration_and_synthetic_watermark(self):
        ensure_tools()
        with tempfile.TemporaryDirectory() as d:
            image = make_still(os.path.join(d, "i.png"), 160, 284, index=1)
            audio = synthesize("", os.path.join(d, "a.wav"), seconds=1.5)["path"]
            report = render_episode(
                [{"image": image, "audio": audio, "seconds": 1.5,
                  "caption": "SHORT CAPTION",
                  "narration": "Spoken narration line."}],
                os.path.join(d, "out.mp4"), width=160, height=284, fps=8,
                watermark="SYNTHETIC TEST")
            with open(report["srt_path"]) as f:
                srt = f.read()
            self.assertIn("Spoken narration line.", srt)
            self.assertNotIn("SHORT CAPTION", srt)
            self.assertEqual(report["status"], "passed")
            self.assertIn(report["watermark_mode"], ("text", "bar"))
            self.assertIn("captions_burned", report)


class TestStockWiring(unittest.TestCase):
    class FakeStock:
        def __init__(self, fail=False):
            self.fail = fail

        def configured(self):
            return True

        def resolve(self, query, dest, **kwargs):
            if self.fail:
                raise RuntimeError("stock outage")
            os.makedirs(dest, exist_ok=True)
            path = os.path.join(dest, "stock.png")
            make_still(path, 160, 284, index=2)
            return {"path": path, "license": "Pixabay Content License",
                    "sha256": "a" * 64, "asset_id": "1"}

    def _scenes(self, d, stock):
        return studios._make_scenes(
            {"scenes": [{"narration": "line", "visual": "city skyline",
                         "caption": "caption"}]},
            os.path.join(d, "images"), os.path.join(d, "audio"),
            width=160, height=284, total_seconds=4, voice="x", allow_tts=False,
            pixabay=stock, job_id="j")

    def test_pixabay_asset_is_preferred(self):
        with tempfile.TemporaryDirectory() as d:
            scenes = self._scenes(d, self.FakeStock())
            self.assertEqual(scenes[0]["image_source"], "pixabay")
            self.assertIn("Pixabay", scenes[0]["image_license"])
            self.assertTrue(os.path.exists(scenes[0]["image"]))

    def test_stock_outage_falls_back_to_labelled_synthetic(self):
        with tempfile.TemporaryDirectory() as d:
            scenes = self._scenes(d, self.FakeStock(fail=True))
            self.assertEqual(scenes[0]["image_source"], "synthetic")
            self.assertEqual(scenes[0]["image_error"], "RuntimeError")

    def test_asset_sources_record_author_licence_and_page(self):
        class Source(self.FakeStock):
            def resolve(self, query, dest, **kwargs):
                asset = super().resolve(query, dest, **kwargs)
                asset.update({"source": "wikimedia", "author": "A. Photographer",
                              "page_url": "https://commons.wikimedia.org/wiki/File:X",
                              "retrieved_at": 123})
                return asset

        with tempfile.TemporaryDirectory() as d:
            scenes = studios._make_scenes(
                {"scenes": [{"narration": "line", "visual": "map"}]},
                os.path.join(d, "images"), os.path.join(d, "audio"),
                width=160, height=284, total_seconds=4, voice="x", allow_tts=False,
                asset_sources=[Source()], job_id="j", visual_style="archival")
            self.assertEqual(scenes[0]["image_source"], "wikimedia")
            self.assertEqual(scenes[0]["image_author"], "A. Photographer")
            self.assertIn("commons.wikimedia.org", scenes[0]["image_page_url"])
            self.assertFalse(scenes[0]["historical_evidence"])


class TestArchiveProviders(unittest.TestCase):
    def test_wikimedia_keeps_attribution(self):
        body = json.dumps({"query": {"pages": {"1": {
            "pageid": 1, "imageinfo": [{
                "mime": "image/jpeg", "descriptionurl": "https://commons.wikimedia.org/wiki/File:X",
                "thumburl": "https://upload.wikimedia.org/x.jpg", "width": 800, "height": 600,
                "extmetadata": {
                    "LicenseShortName": {"value": "CC BY-SA 4.0"},
                    "Artist": {"value": "<a>Jane Doe</a>"},
                    "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0/"},
                },
            }],
        }}}}).encode()
        calls = []
        def transport(url, timeout):
            calls.append(url)
            return 200, body
        def downloader(url, timeout):
            return 200, b"\x89PNG\r\n\x1a\n" + b"x" * 20
        provider = WikimediaProvider(transport=transport, downloader=downloader)
        with tempfile.TemporaryDirectory() as d:
            asset = provider.resolve("silk road map", d, job_id="j")
            self.assertEqual(asset["source"], "wikimedia")
            self.assertEqual(asset["author"], "Jane Doe")
            self.assertEqual(asset["license"], "CC BY-SA 4.0")
            self.assertIn("creativecommons.org", asset["license_url"])
            self.assertTrue(os.path.exists(asset["path"]))
            self.assertTrue(calls[0].startswith("https://commons.wikimedia.org/w/api.php"))

    def test_internet_archive_uses_metadata_and_rights(self):
        def transport(url, timeout):
            if "advancedsearch" in url:
                return 200, json.dumps({"response": {"docs": [
                    {"identifier": "item-1", "title": "Map", "licenseurl": "https://rights.example/"}]}}).encode()
            return 200, json.dumps({
                "metadata": {"creator": "Archive Author", "rights": "Public Domain"},
                "files": [{"name": "map.jpg", "format": "JPEG"}],
            }).encode()
        provider = InternetArchiveProvider(
            transport=transport,
            downloader=lambda url, timeout: (200, b"\xff\xd8\xff" + b"y" * 20))
        with tempfile.TemporaryDirectory() as d:
            asset = provider.resolve("old map", d, job_id="j")
            self.assertEqual(asset["source"], "internet-archive")
            self.assertEqual(asset["author"], "Archive Author")
            self.assertIn("rights.example", asset["license"])
            self.assertTrue(os.path.exists(asset["path"]))


class TestDeepHistoryGates(unittest.TestCase):
    def test_rejects_non_english_language_and_voice(self):
        with tempfile.TemporaryDirectory() as d:
            job = Job(job_id="j", studio="deep-history", language="tr")
            with self.assertRaisesRegex(RuntimeError, "language gate"):
                studios.deep_history(job, small_ctx(d))
            job = Job(job_id="j", studio="deep-history", language="en")
            ctx = small_ctx(d); ctx["voice"] = "tr-TR-AhmetNeural"
            with self.assertRaisesRegex(RuntimeError, "voice gate"):
                studios.deep_history(job, ctx)

    def test_moderation_refusal_uses_safe_nonpublishable_fallback(self):
        class Refusing:
            calls = 0
            def generate_json(self, *a, **k):
                self.calls += 1
                raise RuntimeError("provider moderation 8007")
        llm = Refusing()
        with tempfile.TemporaryDirectory() as d:
            ctx = small_ctx(d, llm=llm)
            result = studios.deep_history(Job(job_id="j", studio="deep-history"), ctx)
            self.assertTrue(result["moderation_fallback"])
            self.assertFalse(result["publishable"])
            self.assertEqual(result["verdict"], "blocked")
            self.assertEqual(llm.calls, 1, "the refused prompt must not be retried")
            self.assertTrue(any("moderation" in b for b in result["blocking_failures"]))

    def test_short_non_synthetic_script_is_rejected_not_padded(self):
        research = {"topic": "x", "synthetic": False,
                    "timeline": [{"order": i} for i in range(1, 5)],
                    "sources": [{"id": "a"}, {"id": "b"}],
                    "narrator": {"name": "Explorer"}}
        script = {"title": "x", "synthetic": False,
                  "chapters": [{"narration": "too short"} for _ in range(5)]}
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            with patch.object(studios, "_deep_generate", side_effect=[research, script]):
                with self.assertRaisesRegex(RuntimeError, "length gate"):
                    studios.deep_history(Job(job_id="j", studio="deep-history"), small_ctx(d))


if __name__ == "__main__":
    unittest.main(verbosity=2)
