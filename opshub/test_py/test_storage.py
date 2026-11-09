import hashlib
import hmac
import os
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
OPSHUB = os.path.dirname(HERE)
sys.path.insert(0, OPSHUB)
sys.path.insert(0, os.path.join(OPSHUB, "shared"))

from production.storage import upload_artifacts


class UploadTests(unittest.TestCase):
    def _result(self, d):
        video = os.path.join(d, "episode.mp4")
        srt = os.path.join(d, "episode.srt")
        manifest = os.path.join(d, "manifest.json")
        Path(video).write_bytes(b"mp4-bytes")
        Path(srt).write_text("1\n00:00:00,000 --> 00:00:01,000\nHi\n")
        Path(manifest).write_text('{"assets":{}}')
        return {"artifacts": [{"type": "video", "path": video, "subtitles": srt}],
                "manifest": {"path": manifest}}

    def test_skips_without_hub_configuration(self):
        with tempfile.TemporaryDirectory() as d:
            out = upload_artifacts("job-1", self._result(d), env={})
            self.assertFalse(out["enabled"])
            self.assertEqual(out["errors"], [])

    def test_uploads_signed_video_subtitles_and_manifest(self):
        calls = []
        def transport(method, url, headers, body):
            calls.append((method, url, headers, body))
            return 200, '{"stored":true}'
        with tempfile.TemporaryDirectory() as d:
            out = upload_artifacts(
                "job-1", self._result(d),
                env={"HUB_URL": "https://hub.example", "HUB_WEBHOOK_SECRET": "s3cret"},
                transport=transport)
            self.assertTrue(out["enabled"])
            self.assertEqual(len(calls), 3)
            kinds = " ".join(c[1] for c in calls)
            self.assertIn("/video/episode.mp4", kinds)
            self.assertIn("/subtitles/episode.srt", kinds)
            self.assertIn("/manifest/manifest.json", kinds)
            for method, url, headers, body in calls:
                # The Worker decodes the URL path before verifying the HMAC.
                key = urllib.parse.unquote(url.split("/files/", 1)[1])
                expected = "sha256=" + hmac.new(
                    b"s3cret", f"POST\n{key}\n{hashlib.sha256(body).hexdigest()}".encode(),
                    hashlib.sha256).hexdigest()
                self.assertEqual(headers["x-hub-signature-256"], expected)
            self.assertEqual(out["errors"], [])

    def test_signs_decoded_key_for_spaced_filename(self):
        calls = []
        def transport(method, url, headers, body):
            calls.append((url, headers, body))
            return 200, "{}"
        with tempfile.TemporaryDirectory() as d:
            video = os.path.join(d, "episode one.mp4")
            Path(video).write_bytes(b"mp4")
            out = upload_artifacts(
                "job-1", {"artifacts": [{"type": "video", "path": video}]},
                env={"HUB_URL": "https://hub.example", "HUB_WEBHOOK_SECRET": "s3cret"},
                transport=transport)
            self.assertEqual(out["errors"], [])
            url, headers, body = calls[0]
            self.assertIn("episode%20one.mp4", url)
            key = urllib.parse.unquote(url.split("/files/", 1)[1])
            expected = "sha256=" + hmac.new(
                b"s3cret", f"POST\n{key}\n{hashlib.sha256(body).hexdigest()}".encode(),
                hashlib.sha256).hexdigest()
            self.assertEqual(headers["x-hub-signature-256"], expected)

    def test_failed_upload_is_reported_not_raised(self):
        with tempfile.TemporaryDirectory() as d:
            out = upload_artifacts(
                "job-1", self._result(d),
                env={"HUB_URL": "https://hub.example", "HUB_WEBHOOK_SECRET": "s"},
                transport=lambda *a: (503, "unavailable"))
            self.assertFalse(out["verified"])
            self.assertEqual(len(out["errors"]), 3)
