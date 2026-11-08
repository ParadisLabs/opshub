"""FFmpeg/ffprobe media validation. Degrades to "skipped" when tools are absent."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from typing import Any, Dict, List, Optional


def have(tool: str) -> bool:
    return shutil.which(tool) is not None


def _run(cmd: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def probe(path: str) -> Optional[Dict[str, Any]]:
    if not have("ffprobe") or not os.path.exists(path):
        return None
    p = _run(["ffprobe", "-v", "error", "-print_format", "json",
              "-show_format", "-show_streams", path])
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout)
    except ValueError:
        return None


def _num(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def validate_video(path: str, *, expected_width: Optional[int] = None,
                   expected_height: Optional[int] = None,
                   min_seconds: Optional[float] = None,
                   max_seconds: Optional[float] = None,
                   require_audio: bool = True) -> Dict[str, Any]:
    """Structured validation report. Never raises for missing media."""
    report: Dict[str, Any] = {
        "path": path,
        "status": "skipped",
        "checks": [],
        "errors": [],
        "duration": None,
        "width": None,
        "height": None,
        "has_audio": False,
    }
    if not have("ffprobe") or not have("ffmpeg"):
        report["errors"].append("ffprobe/ffmpeg not available")
        return report
    if not os.path.exists(path):
        report["status"] = "failed"
        report["errors"].append("file does not exist")
        return report

    data = probe(path)
    if not data:
        report["status"] = "failed"
        report["errors"].append("unreadable media")
        return report

    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format", {})
    duration = _num(fmt.get("duration"))

    report["duration"] = round(duration, 3)
    report["has_audio"] = audio is not None
    if video:
        report["width"] = video.get("width")
        report["height"] = video.get("height")

    checks = report["checks"]

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            report["errors"].append(detail or name)

    check("video_stream", video is not None, "no video stream")
    if require_audio:
        check("audio_stream", audio is not None, "no audio stream")
    if expected_width and video:
        check("width", video.get("width") == expected_width,
              f"width {video.get('width')} != {expected_width}")
    if expected_height and video:
        check("height", video.get("height") == expected_height,
              f"height {video.get('height')} != {expected_height}")
    if min_seconds is not None:
        check("min_duration", duration >= min_seconds,
              f"duration {duration:.1f}s < {min_seconds}s")
    if max_seconds is not None:
        check("max_duration", duration <= max_seconds,
              f"duration {duration:.1f}s > {max_seconds}s")

    # Black-frame / silence scan (cheap, bounded output).
    try:
        scan = _run(["ffmpeg", "-hide_banner", "-i", path, "-vf",
                     "blackdetect=d=1:pix_th=0.10", "-af",
                     "silencedetect=n=-50dB:d=2", "-f", "null", "-"])
        stderr = scan.stderr or ""
        black = re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", stderr)
        silence = re.findall(r"silence_duration: ([\d.]+)", stderr)
        report["black_segments"] = len(black)
        report["silent_segments"] = len(silence)
        total_black = sum(max(0.0, _num(b[1]) - _num(b[0])) for b in black)
        check("no_long_black", total_black < max(2.0, duration * 0.05),
              f"{total_black:.1f}s of black frames")
    except Exception as exc:  # noqa: BLE001 - diagnostics only
        report["errors"].append(f"scan failed: {str(exc)[:120]}")

    report["status"] = "passed" if not report["errors"] else "failed"
    return report


def make_thumbnail(video: str, out_png: str, at_seconds: float = 1.0) -> Optional[str]:
    if not have("ffmpeg") or not os.path.exists(video):
        return None
    p = _run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{at_seconds:.2f}",
              "-i", video, "-frames:v", "1", out_png])
    return out_png if p.returncode == 0 and os.path.exists(out_png) else None
