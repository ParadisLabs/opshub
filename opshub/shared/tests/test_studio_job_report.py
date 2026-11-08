"""Verify all three studio job_report.py copies behave identically offline."""
from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import os
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
STUDIOS = {
    "faceless-studio": "trendscope",
    "faceless-turkce-studio": "true-crime",
    "deep-history-studio": "deep-history",
}


def load(module_name, path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StudioJobReportTests(unittest.TestCase):
    def test_every_studio(self):
        for studio, expected in STUDIOS.items():
            with self.subTest(studio=studio):
                path = os.path.join(ROOT, studio, "job_report.py")
                self.assertTrue(os.path.exists(path), f"missing {path}")
                mod = load("jr_" + studio.replace("-", "_"), path)
                self.assertEqual(mod.STUDIO, expected)

                # manual run: no job id -> pure no-op
                self.assertEqual(mod.report("running", "research", 1, env={}),
                                 {"skipped": "no job id"})

                # job id but no secret -> skipped, not raised
                out = mod.report("running", "research", 1,
                                 env={"OPSHUB_JOB_ID": "j1", "HUB_URL": "https://h"})
                self.assertEqual(out["skipped"], "hub misconfigured")

                captured = {}

                def transport(method, url, headers, body):
                    captured.update(method=method, url=url, headers=headers, body=body)
                    return 200, '{"status":"ok"}'

                env = {
                    "OPSHUB_JOB_ID": "j1",
                    "HUB_URL": "https://hub.test/",
                    "HUB_WEBHOOK_SECRET": "s3cret",
                }
                out = mod.report("running", "assets", 42, "rendering", "episodes/ep1",
                                 env=env, transport=transport)
                self.assertEqual(out, {"status": 200})
                self.assertEqual(captured["method"], "POST")
                self.assertEqual(captured["url"], "https://hub.test/jobs/j1/status")

                payload = json.loads(captured["body"])
                self.assertEqual(payload["schema_version"], "1.0")
                self.assertEqual(payload["studio"], expected)
                self.assertEqual(payload["progress"], 42)
                self.assertEqual(payload["stage"], "assets")
                self.assertEqual(payload["output"], "episodes/ep1")

                expected_sig = "sha256=" + hmac.new(
                    b"s3cret", captured["body"], hashlib.sha256).hexdigest()
                self.assertEqual(captured["headers"]["x-hub-signature-256"], expected_sig)

                # hub rejection is reported, never raised
                out = mod.report("running", "assets", 1, env=env,
                                 transport=lambda *a: (503, "hub misconfigured"))
                self.assertEqual(out["error"], 503)

    def test_workflows_wire_the_job_id(self):
        for studio in STUDIOS:
            path = os.path.join(ROOT, studio, ".github", "workflows", "produce.yml")
            with open(path) as f:
                text = f.read()
            self.assertIn("OPSHUB_JOB_ID", text, studio)
            self.assertIn("job_report.py", text, studio)


if __name__ == "__main__":
    unittest.main()
