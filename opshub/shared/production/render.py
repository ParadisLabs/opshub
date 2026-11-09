"""Real media rendering with FFmpeg: H.264 video, AAC audio, burned captions.

Nothing here simulates a render. If ffmpeg/ffprobe are missing the call fails
loudly instead of returning a fake MP4. Every finished file is probed and
validated (dimensions, codecs, duration, audio stream, black frames, silence)
before it can be reported as a production artifact.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .redact import sanitize

FPS_DEFAULT = 30
AUDIO_RATE = 48000
PRESET_DEFAULT = "veryfast"


class RenderError(RuntimeError):
    """Raised when a render or validation step fails."""


# ---------------------------------------------------------------- tools
def _workspace_tools() -> Optional[str]:
    here = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        candidate = os.path.join(here, ".tools")
        if os.path.isdir(candidate):
            for name in sorted(os.listdir(candidate)):
                path = os.path.join(candidate, name)
                if os.path.isfile(os.path.join(path, "ffmpeg")):
                    return path
        here = os.path.dirname(here)
    return None


def ensure_tools() -> None:
    """Put a discovered ffmpeg/ffprobe directory on PATH once."""
    tools = _workspace_tools()
    if tools and tools not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = tools + os.pathsep + os.environ.get("PATH", "")


def ffmpeg_bin() -> str:
    override = os.environ.get("FFMPEG_BIN", "").strip()
    if override and os.path.exists(override):
        return override
    ensure_tools()
    found = shutil.which("ffmpeg")
    if not found:
        raise RenderError("ffmpeg is not installed or not on PATH")
    return found


def ffprobe_bin() -> str:
    override = os.environ.get("FFPROBE_BIN", "").strip()
    if override and os.path.exists(override):
        return override
    ensure_tools()
    found = shutil.which("ffprobe")
    if not found:
        raise RenderError("ffprobe is not installed or not on PATH")
    return found


def font_path() -> Optional[str]:
    override = os.environ.get("CAPTION_FONT", "").strip()
    candidates = [override] if override else []
    tools = _workspace_tools()
    if tools:
        # .tools holds both the ffmpeg build and a sibling fonts/ directory.
        root = os.path.dirname(tools)
        for base in (root, tools):
            candidates.append(os.path.join(base, "fonts", "DejaVuSans-Bold.ttf"))
            candidates.append(os.path.join(base, "fonts", "Roboto-Bold.ttf"))
    candidates += [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


_FILTERS: Dict[str, bool] = {}


def filter_available(name: str) -> bool:
    """True when this ffmpeg build provides the filter (static builds often lack drawtext)."""
    if name in _FILTERS:
        return _FILTERS[name]
    try:
        proc = subprocess.run([ffmpeg_bin(), "-hide_banner", "-filters"],
                              capture_output=True, text=True, timeout=20)
        _FILTERS[name] = proc.returncode == 0 and bool(re.search(rf"\b{re.escape(name)}\b", proc.stdout))
    except Exception:  # noqa: BLE001
        _FILTERS[name] = False
    return _FILTERS[name]


def _run(cmd: Sequence[str], timeout: int = 900) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run([str(c) for c in cmd], capture_output=True,
                              text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RenderError(f"ffmpeg timed out after {timeout}s") from None
    if proc.returncode != 0:
        raise RenderError("ffmpeg failed: " + sanitize(proc.stderr[-1200:]))
    return proc


# ---------------------------------------------------------------- probe
def probe(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        raise RenderError(f"media does not exist: {path}")
    proc = _run([ffprobe_bin(), "-v", "error", "-print_format", "json",
                 "-show_format", "-show_streams", path], timeout=120)
    try:
        return json.loads(proc.stdout)
    except ValueError:
        raise RenderError("ffprobe returned unreadable JSON") from None


def probe_duration(path: str) -> float:
    try:
        return float(probe(path).get("format", {}).get("duration", 0) or 0)
    except Exception:  # noqa: BLE001
        return 0.0


# ---------------------------------------------------------------- assets
def make_still(path: str, width: int, height: int, *, label: str = "",
               colors: Sequence[str] = ("0x1b2430", "0x3a2b26"), index: int = 1) -> str:
    """Render a deterministic non-black still with an optional label."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    color = colors[index % len(colors)]
    vf = [f"drawbox=x=0:y=0:w={width}:h={height}:color={colors[(index + 1) % len(colors)]}@0.55:t=fill"]
    font = font_path()
    text_file = None
    if font and label.strip() and filter_available("drawtext"):
        text_file = path + ".txt"
        with open(text_file, "w") as f:
            f.write(wrap_text(label, 34)[:220])
        vf.append(
            f"drawtext=fontfile={font}:textfile={text_file}:fontcolor=white:"
            f"fontsize={max(28, width // 22)}:box=1:boxcolor=black@0.35:"
            f"boxborderw=24:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=12"
        )
    _run([ffmpeg_bin(), "-y", "-loglevel", "error", "-f", "lavfi",
          "-i", f"color=c={color}:s={width}x{height}:d=1", "-frames:v", "1",
          "-vf", ",".join(vf), path], timeout=120)
    if text_file and os.path.exists(text_file):
        os.remove(text_file)
    return path


def wrap_text(text: str, limit: int = 38, max_lines: int = 3) -> str:
    words = str(text or "").strip().split()
    lines: List[str] = []
    current = ""
    for word in words:
        if len(current) + len(word) + 1 <= limit:
            current = (current + " " + word).strip()
        else:
            if current:
                lines.append(current)
            current = word
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    return "\n".join(lines)


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------- subtitles
def _ts(seconds: float) -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(cues: Sequence[Dict[str, Any]], path: str) -> str:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        for i, cue in enumerate(cues, start=1):
            f.write(f"{i}\n{_ts(cue['start'])} --> {_ts(cue['end'])}\n"
                    f"{str(cue.get('text', '')).strip()}\n\n")
    return path


def read_srt(path: str) -> List[Dict[str, Any]]:
    cues: List[Dict[str, Any]] = []
    pattern = re.compile(r"(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)")
    with open(path) as f:
        blocks = f.read().strip().split("\n\n")
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        match = pattern.search(lines[1])
        if not match:
            continue
        g = [int(x) for x in match.groups()]
        start = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000.0
        end = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000.0
        cues.append({"start": start, "end": end,
                     "text": " ".join(lines[2:])})
    return cues


# ---------------------------------------------------------------- segments
def _video_filter(width: int, height: int, fps: int, *, ken_burns: bool,
                  caption_path: Optional[str]) -> str:
    parts = [
        f"scale={width}:{height}:force_original_aspect_ratio=increase",
        f"crop={width}:{height}",
        "setsar=1",
    ]
    if ken_burns:
        parts.append(
            f"zoompan=z='min(zoom+0.0007,1.12)':x='iw/2-(iw/zoom/2)':"
            f"y='ih/2-(ih/zoom/2)':d=1:s={width}x{height}:fps={fps}"
        )
    parts.append("format=yuv420p")
    font = font_path()
    if caption_path and font and filter_available("drawtext") and os.path.exists(caption_path):
        parts.append(
            f"drawtext=fontfile={font}:textfile={caption_path}:fontcolor=white:"
            f"fontsize={max(22, width // 30)}:box=1:boxcolor=black@0.45:"
            f"boxborderw=18:x=(w-text_w)/2:y=h-{max(120, height // 7)}:line_spacing=10"
        )
    return ",".join(parts)


def make_segment(image: str, audio: str, out_path: str, *, width: int, height: int,
                 fps: int, seconds: float, caption: str = "",
                 watermark: str = "",
                 ken_burns: bool = False, preset: str = PRESET_DEFAULT,
                 crf: int = 23) -> str:
    if not os.path.exists(image):
        raise RenderError(f"missing scene image: {image}")
    if not os.path.exists(audio):
        raise RenderError(f"missing scene audio: {audio}")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    caption_path = None
    if caption.strip():
        caption_path = out_path + ".caption.txt"
        with open(caption_path, "w") as f:
            f.write(wrap_text(caption))
    vf = _video_filter(width, height, fps, ken_burns=ken_burns,
                       caption_path=caption_path)
    watermark_path = None
    font = font_path()
    if watermark.strip():
        # Synthetic runs must be unmistakable in the pixels, not only in metadata.
        if font and filter_available("drawtext"):
            watermark_path = out_path + ".watermark.txt"
            with open(watermark_path, "w") as f:
                f.write(watermark.strip()[:32])
            vf += (
                f",drawtext=fontfile={font}:textfile={watermark_path}:fontcolor=white@0.9:"
                f"fontsize={max(16, width // 40)}:box=1:boxcolor=black@0.55:boxborderw=12:"
                f"x=(w-text_w)/2:y={max(12, height // 45)}"
            )
        else:
            # No freetype in this build: draw an unmistakable red band instead.
            vf += (f",drawbox=x=0:y=0:w={width}:h={max(8, height // 16)}:"
                   f"color=red@0.8:t=fill")
    cmd = [
        ffmpeg_bin(), "-y", "-loglevel", "error",
        "-loop", "1", "-framerate", str(fps), "-i", image,
        "-i", audio,
        "-filter_complex",
        f"[0:v]{vf}[v];"
        f"[1:a]apad,aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a]",
        "-map", "[v]", "-map", "[a]",
        "-t", f"{max(0.5, seconds):.3f}",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-r", str(fps),
        "-c:a", "aac", "-b:a", "128k", "-ar", str(AUDIO_RATE),
        "-movflags", "+faststart",
        out_path,
    ]
    _run(cmd, timeout=1200)
    if caption_path and os.path.exists(caption_path):
        os.remove(caption_path)
    if watermark_path and os.path.exists(watermark_path):
        os.remove(watermark_path)
    return out_path


def concat_segments(segments: Sequence[str], out_path: str) -> str:
    if not segments:
        raise RenderError("no segments to concat")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        listing = f.name
        for seg in segments:
            f.write(f"file '{os.path.abspath(seg)}'\n")
    try:
        _run([ffmpeg_bin(), "-y", "-loglevel", "error", "-f", "concat",
              "-safe", "0", "-i", listing, "-c", "copy",
              "-movflags", "+faststart", out_path], timeout=600)
    finally:
        os.remove(listing)
    return out_path


def make_thumbnail(video: str, out_png: str, at_seconds: float = 1.0) -> str:
    os.makedirs(os.path.dirname(out_png) or ".", exist_ok=True)
    _run([ffmpeg_bin(), "-y", "-loglevel", "error", "-ss", f"{at_seconds:.2f}",
          "-i", video, "-frames:v", "1", out_png], timeout=120)
    return out_png


# ---------------------------------------------------------------- validation
def validate(video: str, *, width: int, height: int, min_seconds: float,
             max_seconds: float, srt_path: Optional[str] = None,
             require_audio: bool = True) -> Dict[str, Any]:
    from . import media  # local import keeps module import cheap

    report: Dict[str, Any] = {
        "path": video, "status": "failed", "errors": [], "checks": [],
        "width": None, "height": None, "duration": 0.0,
        "video_codec": None, "audio_codec": None, "audio_duration": 0.0,
        "size_bytes": os.path.getsize(video) if os.path.exists(video) else 0,
        "sha256": sha256_file(video) if os.path.exists(video) else "",
    }
    if not os.path.exists(video):
        report["errors"].append("file missing")
        return report
    if report["size_bytes"] <= 0:
        report["errors"].append("empty file")
        return report

    data = probe(video)
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    report["duration"] = round(float(data.get("format", {}).get("duration", 0) or 0), 3)
    if v:
        report["width"], report["height"] = v.get("width"), v.get("height")
        report["video_codec"] = v.get("codec_name")
    if a:
        report["audio_codec"] = a.get("codec_name")
        report["audio_duration"] = round(float(a.get("duration", 0) or 0), 3)

    def check(name: str, ok: bool, detail: str = "") -> None:
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            report["errors"].append(detail or name)

    check("video_stream", v is not None, "no video stream")
    if require_audio:
        check("audio_stream", a is not None, "no audio stream")
        check("audio_duration", report["audio_duration"] > 0.1,
              f"audio duration {report['audio_duration']}s")
    check("h264", report["video_codec"] == "h264", f"video codec {report['video_codec']}")
    if require_audio:
        check("aac", report["audio_codec"] == "aac", f"audio codec {report['audio_codec']}")
    check("width", report["width"] == width, f"width {report['width']} != {width}")
    check("height", report["height"] == height, f"height {report['height']} != {height}")
    check("min_duration", report["duration"] >= min_seconds,
          f"duration {report['duration']} < {min_seconds}")
    check("max_duration", report["duration"] <= max_seconds,
          f"duration {report['duration']} > {max_seconds}")

    if srt_path and os.path.exists(srt_path):
        cues = read_srt(srt_path)
        check("subtitle_cues", len(cues) > 0, "no subtitle cues")
        if cues:
            check("subtitle_start", abs(cues[0]["start"]) < 0.2,
                  f"first cue starts at {cues[0]['start']}")
            check("subtitle_sync", cues[-1]["end"] <= report["duration"] + 0.25,
                  f"last cue ends at {cues[-1]['end']} > media {report['duration']}")

    # black frames and silence
    try:
        scan = _run([ffmpeg_bin(), "-hide_banner", "-i", video,
                     "-vf", "blackdetect=d=1:pix_th=0.10",
                     "-af", "silencedetect=n=-50dB:d=2", "-f", "null", "-"],
                    timeout=600)
        stderr = scan.stderr or ""
        black = re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", stderr)
        silence = re.findall(r"silence_duration: ([\d.]+)", stderr)
        total_black = sum(max(0.0, float(b[1]) - float(b[0])) for b in black)
        total_silence = sum(float(s) for s in silence)
        report["black_seconds"] = round(total_black, 2)
        report["silent_seconds"] = round(total_silence, 2)
        check("no_long_black", total_black < max(3.0, report["duration"] * 0.1),
              f"{total_black:.1f}s black frames")
        if require_audio:
            check("not_silent", total_silence < max(3.0, report["duration"] * 0.5),
                  f"{total_silence:.1f}s silence")
    except RenderError as exc:
        report["errors"].append(f"scan failed: {sanitize(exc)[:120]}")

    report["status"] = "passed" if not report["errors"] else "failed"
    return report


# ---------------------------------------------------------------- episode
def render_episode(scenes: Sequence[Dict[str, Any]], out_path: str, *,
                   width: int, height: int, fps: int = FPS_DEFAULT,
                   ken_burns: bool = False, preset: str = PRESET_DEFAULT,
                   crf: int = 23, workdir: Optional[str] = None,
                   watermark: str = "") -> Dict[str, Any]:
    """Render ordered scenes into one validated MP4 with a sidecar SRT."""
    if not scenes:
        raise RenderError("no scenes to render")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    work = workdir or os.path.join(os.path.dirname(out_path) or ".", "work")
    os.makedirs(work, exist_ok=True)

    segments: List[str] = []
    cues: List[Dict[str, Any]] = []
    clock = 0.0
    for i, scene in enumerate(scenes, start=1):
        duration = float(scene.get("seconds") or 0)
        if duration <= 0:
            raise RenderError(f"scene {i} has no duration")
        image = scene.get("image")
        audio = scene.get("audio")
        if not image or not audio:
            raise RenderError(f"scene {i} is missing image or audio")
        seg = os.path.join(work, f"seg_{i:03d}.mp4")
        make_segment(image, audio, seg, width=width, height=height, fps=fps,
                     seconds=duration, caption=str(scene.get("caption") or ""),
                     watermark=watermark,
                     ken_burns=ken_burns, preset=preset, crf=crf)
        segments.append(seg)
        cues.append({"start": round(clock, 3), "end": round(clock + duration, 3),
                     "text": str(scene.get("narration") or scene.get("caption") or "")})
        clock += duration

    srt_path = os.path.splitext(out_path)[0] + ".srt"
    write_srt(cues, srt_path)
    concat_segments(segments, out_path)

    report = validate(out_path, width=width, height=height,
                      min_seconds=max(1.0, clock - 0.5),
                      max_seconds=clock + 1.5, srt_path=srt_path,
                      require_audio=True)
    report["srt_path"] = srt_path
    if report["status"] != "passed":
        raise RenderError("render validation failed: " + "; ".join(report["errors"][:6]))

    thumb = os.path.splitext(out_path)[0] + ".thumb.png"
    try:
        make_thumbnail(out_path, thumb, at_seconds=min(1.0, max(0.0, clock / 2)))
        report["thumbnail"] = thumb
    except RenderError:
        report["thumbnail"] = None
    report["scenes"] = len(scenes)
    report["fps"] = fps
    report["captions_burned"] = bool(font_path() and filter_available("drawtext"))
    report["watermark_mode"] = (
        ("text" if filter_available("drawtext") and font_path() else "bar")
        if watermark.strip() else "none")
    return report
