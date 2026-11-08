"""Real render verification with FFmpeg.

Skipped automatically when ffmpeg/ffprobe are not on PATH. To run locally
without a system install:

    python3 -m venv /tmp/ffvenv
    /tmp/ffvenv/bin/pip install static-ffmpeg
    export PATH="$(/tmp/ffvenv/bin/python -c 'from static_ffmpeg import run; print(run.get_or_fetch_platform_executables_else_raise()[0].rsplit("/",1)[0])'):$PATH"
    python3 -m unittest discover -s opshub/shared/tests -v
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from production.media import have, probe, validate_video  # noqa: E402
from production.providers.mock import MockImage, silent_wav  # noqa: E402

HAS_FFMPEG = have("ffmpeg") and have("ffprobe")


def _run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def _silent(path, seconds=1.0):
    with open(path, "wb") as f:
        f.write(silent_wav(seconds))


def _segment(out, aud, seconds=1.0, audio=True):
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc2=size=1080x1920:rate=30:duration={seconds}",
    ]
    if audio:
        cmd += ["-i", aud]
    cmd += ["-t", str(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", "-shortest"] if audio else ["-an"]
    _run(cmd + [out])


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe not installed")
class RenderVerificationTests(unittest.TestCase):
    def test_mock_image_is_a_readable_png(self):
        with tempfile.TemporaryDirectory() as d:
            png = os.path.join(d, "scene.png")
            MockImage().generate("scene", png)
            info = probe(png)
            self.assertIsNotNone(info)
            stream = (info or {}).get("streams", [{}])[0]
            self.assertEqual(stream.get("codec_name"), "png")
            self.assertGreaterEqual(int(stream.get("width", 0)), 1)

    def test_two_segments_concat_and_validate(self):
        with tempfile.TemporaryDirectory() as d:
            aud = os.path.join(d, "a.wav")
            _silent(aud)
            segs = []
            for i in (1, 2):
                seg = os.path.join(d, f"s{i}.mp4")
                _segment(seg, aud)
                segs.append(seg)
            listing = os.path.join(d, "list.txt")
            with open(listing, "w") as f:
                f.writelines(f"file '{s}'\n" for s in segs)
            final = os.path.join(d, "final.mp4")
            _run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat",
                  "-safe", "0", "-i", listing, "-c", "copy", final])
            self.assertTrue(os.path.getsize(final) > 10_000)

            report = validate_video(final, expected_width=1080, expected_height=1920,
                                    min_seconds=1.5, max_seconds=6)
            self.assertEqual(report["status"], "passed", report["errors"])
            self.assertEqual(report["width"], 1080)
            self.assertEqual(report["height"], 1920)
            self.assertTrue(report["has_audio"])
            self.assertGreaterEqual(report["duration"], 1.5)
            checks = {c["name"]: c["ok"] for c in report["checks"]}
            self.assertTrue(checks.get("video_stream"))
            self.assertTrue(checks.get("audio_stream"))
            self.assertTrue(checks.get("no_long_black"))

    def test_missing_audio_is_reported_not_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            seg = os.path.join(d, "silent.mp4")
            _segment(seg, "", audio=False)
            report = validate_video(seg, expected_width=1080, expected_height=1920,
                                    require_audio=True)
            self.assertEqual(report["status"], "failed")
            self.assertIn("no audio stream", report["errors"])
            checks = {c["name"]: c["ok"] for c in report["checks"]}
            self.assertFalse(checks.get("audio_stream"))

    def test_wrong_resolution_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            aud = os.path.join(d, "a.wav")
            _silent(aud)
            seg = os.path.join(d, "small.mp4")
            _run(["ffmpeg", "-y", "-loglevel", "error",
                  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=1",
                  "-i", aud, "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                  "-c:a", "aac", "-shortest", seg])
            report = validate_video(seg, expected_width=1080, expected_height=1920)
            self.assertEqual(report["status"], "failed")
            self.assertTrue(any("width" in e or "height" in e for e in report["errors"]))


if __name__ == "__main__":
    unittest.main()
