"""Offline tests for the shared production package.

Run: python3 -m unittest discover -s opshub/shared/tests -v
No network, no credentials, no sleeps.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from production import contracts  # noqa: E402
from production.assets import AssetStore, workspace_durability_warning  # noqa: E402
from production.jobclient import JobClient, Misconfigured, sign  # noqa: E402
from production.pipeline import StageRunner  # noqa: E402
from production.providers.base import (  # noqa: E402
    Provider, ProviderError, classify_status, retry_call,
)
from production.providers.mock import (  # noqa: E402
    PNG_1X1, MockImage, MockLLM, MockPublisher, MockTTS, silent_wav,
)
from production.providers.registry import readiness_report  # noqa: E402
from production import qa  # noqa: E402


class ContractTests(unittest.TestCase):
    def test_aliases(self):
        for raw, want in [("english", "trendscope"), ("TRUECRIME", "true-crime"),
                          ("deep_history", "deep-history"), ("history", "deep-history")]:
            self.assertEqual(contracts.canonical_studio(raw), want)
        self.assertIsNone(contracts.canonical_studio("nope"))

    def test_valid_event(self):
        job = contracts.Job(job_id="j1", studio="trendscope", topic="ai")
        payload = contracts.build_event(job)
        self.assertEqual(payload["schema_version"], "1.0")
        self.assertEqual(payload["event"], "opshub.produce")
        self.assertEqual(contracts.validate_event(payload), [])

    def test_invalid_events(self):
        self.assertIn("unknown studio", contracts.validate_event(
            {"schema_version": "1.0", "studio": "bogus", "job_id": "x"}))
        self.assertTrue(contracts.validate_event(
            {"schema_version": "2.0", "studio": "trendscope", "job_id": "x"}))
        self.assertTrue(contracts.validate_event(
            {"schema_version": "1.0", "studio": "trendscope", "job_id": ""}))
        self.assertTrue(contracts.validate_event(
            {"schema_version": "1.0", "studio": "trendscope", "job_id": "x",
             "format": "imax"}))

    def test_job_ids_unique(self):
        ids = {contracts.new_job_id("trendscope") for _ in range(50)}
        self.assertEqual(len(ids), 50)


class ProviderTests(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(classify_status(401), ("invalid credential", False))
        self.assertTrue(classify_status(429)[1])
        self.assertTrue(classify_status(503)[1])
        self.assertFalse(classify_status(400)[1])

    def test_retry_then_success(self):
        calls = {"n": 0}
        delays = []

        def flaky():
            calls["n"] += 1
            if calls["n"] < 3:
                raise ProviderError("rate limited", status=429, retryable=True)
            return "ok"

        out = retry_call(flaky, attempts=3, sleeper=delays.append)
        self.assertEqual(out, "ok")
        self.assertEqual(calls["n"], 3)
        self.assertEqual(len(delays), 2)
        self.assertTrue(delays[1] > delays[0])

    def test_no_retry_on_permanent(self):
        calls = {"n": 0}

        def bad():
            calls["n"] += 1
            raise ProviderError("bad key", status=401, retryable=False)

        with self.assertRaises(ProviderError):
            retry_call(bad, attempts=3, sleeper=lambda _: None)
        self.assertEqual(calls["n"], 1)

    def test_report_states(self):
        class NeedsKey(Provider):
            name = "needs-key"
            required_env = ("SOME_KEY",)

        self.assertEqual(NeedsKey({}).report().state, "not_configured")
        self.assertEqual(NeedsKey({"SOME_KEY": "x"}).report().state, "configured")
        self.assertEqual(NeedsKey({"SOME_KEY": "x"}).report(verify=True).state, "operational")

    def test_readiness_never_leaks_values(self):
        env = {"GROQ_API_KEY": "super-secret-value-123", "HUB_URL": "https://h",
               "HUB_WEBHOOK_SECRET": "another-secret-456"}
        report = readiness_report(env)
        blob = json.dumps(report)
        self.assertNotIn("super-secret-value-123", blob)
        self.assertNotIn("another-secret-456", blob)
        self.assertIn("groq", report["configured"])
        self.assertFalse(report["publishing_enabled"])


class MockProviderTests(unittest.TestCase):
    def test_mock_image_png(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.png")
            MockImage().generate("prompt", p)
            with open(p, "rb") as f:
                self.assertTrue(f.read(8).startswith(b"\x89PNG\r\n\x1a\n"))

    def test_silent_wav(self):
        self.assertTrue(silent_wav(0.2).startswith(b"RIFF"))

    def test_llm_deterministic(self):
        a = MockLLM(topic="t").complete_json("p", schema="research")
        b = MockLLM(topic="t").complete_json("p", schema="research")
        self.assertEqual(a, b)
        self.assertTrue(a["mock"])
        self.assertGreaterEqual(len(a["sources"]), 2)

    def test_publisher_requires_authorization(self):
        pub = MockPublisher()
        with self.assertRaises(PermissionError):
            pub.publish("youtube", "video.mp4")
        rec = pub.publish("youtube", "video.mp4", authorized=True)
        self.assertTrue(rec["mock"])


class QATests(unittest.TestCase):
    def scores(self, **over):
        base = {"research": 90, "script": 90, "visuals": 90, "narration": 90,
                "audio": 90, "subtitles": 90, "rendering": 90, "compliance": 90}
        base.update(over)
        return base

    def test_pass(self):
        r = qa.evaluate(self.scores())
        self.assertEqual(r["verdict"], "pass")
        self.assertFalse(r["publishing_enabled"])

    def test_blocking_beats_high_score(self):
        r = qa.evaluate(self.scores(), blocking_failures=["copyright claim"])
        self.assertEqual(r["verdict"], "blocked")

    def test_missing_mandatory_blocks(self):
        r = qa.evaluate(self.scores(compliance=0))
        self.assertEqual(r["verdict"], "blocked")

    def test_low_score_revise(self):
        r = qa.evaluate(self.scores(script=20, visuals=20))
        self.assertEqual(r["verdict"], "revise")


class AssetTests(unittest.TestCase):
    def test_add_verify_and_tamper(self):
        with tempfile.TemporaryDirectory() as d:
            store = AssetStore(d, "trendscope")
            rec = store.add_bytes("image", "a.png", PNG_1X1)
            self.assertEqual(rec["bytes"], len(PNG_1X1))
            self.assertEqual(store.verify(), [])
            # duplicate identical bytes returns the same record
            again = store.add_bytes("image", "b.png", PNG_1X1)
            self.assertEqual(again["id"], rec["id"])
            # tamper
            path = os.path.join(store.root, rec["path"])
            with open(path, "wb") as f:
                f.write(PNG_1X1 + b"tamper")
            self.assertTrue(any("checksum" in p for p in store.verify()))

    def test_ci_warning(self):
        self.assertIsNotNone(workspace_durability_warning({"GITHUB_ACTIONS": "true"}))
        self.assertIsNone(workspace_durability_warning({}))


class PipelineTests(unittest.TestCase):
    def test_run_and_resume(self):
        with tempfile.TemporaryDirectory() as d:
            state = os.path.join(d, "state.json")
            progress = []
            calls = []

            def make(name):
                def fn():
                    calls.append(name)
                    return name
                return fn

            runner = StageRunner(state, "job-1", on_progress=progress.append)
            summary = runner.run([("research", make("research")),
                                  ("writing", make("writing"))])
            self.assertEqual(summary["status"], "complete")
            self.assertEqual(calls, ["research", "writing"])
            self.assertEqual(progress[-1]["progress"], 50)

            # Resume with a fresh runner: completed stages are skipped.
            runner2 = StageRunner(state, "job-1")
            runner2.run([("research", make("research")),
                         ("writing", make("writing")),
                         ("assets", make("assets"))])
            self.assertEqual(calls, ["research", "writing", "assets"])

    def test_failure_recorded_then_retried(self):
        with tempfile.TemporaryDirectory() as d:
            state = os.path.join(d, "state.json")
            attempts = {"n": 0}

            def boom():
                attempts["n"] += 1
                raise RuntimeError("render failed")

            runner = StageRunner(state, "job-2")
            with self.assertRaises(RuntimeError):
                runner.run([("rendering", boom)])
            self.assertEqual(runner.failed(), ["rendering"])
            with open(state) as f:
                saved = json.load(f)
            self.assertEqual(saved["status"], "failed")

            def ok():
                attempts["n"] += 1
                return "done"

            runner2 = StageRunner(state, "job-2")
            runner2.run([("rendering", ok)])
            self.assertEqual(attempts["n"], 2)
            self.assertEqual(runner2.completed(), ["rendering"])


class JobClientTests(unittest.TestCase):
    def test_fails_closed(self):
        with self.assertRaises(Misconfigured):
            JobClient("", "").create({"job_id": "x"})
        with self.assertRaises(Misconfigured):
            JobClient("https://h", "").create({"job_id": "x"})

    def test_signs_payload(self):
        captured = {}

        def transport(method, url, headers, body):
            captured.update(method=method, url=url, headers=headers, body=body)
            return 200, '{"status":"ok"}'

        client = JobClient("https://hub.test", "s3cret", transport=transport)
        out = client.update("job-9", status="running", stage="assets", progress=42)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(captured["url"], "https://hub.test/jobs/job-9/status")
        expected = sign("s3cret", captured["body"])
        self.assertEqual(captured["headers"]["x-hub-signature-256"], expected)
        # independent HMAC check
        independent = "sha256=" + hmac.new(b"s3cret", captured["body"],
                                           hashlib.sha256).hexdigest()
        self.assertEqual(expected, independent)
        self.assertEqual(json.loads(captured["body"])["progress"], 42)

    def test_rejection_raises(self):
        client = JobClient("https://hub.test", "s3cret",
                           transport=lambda *a: (403, "nope"))
        with self.assertRaises(RuntimeError):
            client.update("job-9", status="running", stage="assets")


if __name__ == "__main__":
    unittest.main()
