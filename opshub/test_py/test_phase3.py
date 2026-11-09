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
from production.providers.pixabay import PixabayProvider  # noqa: E402
from production.redact import sanitize  # noqa: E402
from production.render import (ensure_tools, make_still, render_episode)  # noqa: E402
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
