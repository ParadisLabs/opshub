"""Narration synthesis with an explicit mode label.

Real TTS is used only when a free/authorized provider is importable and reachable
(edge-tts). Otherwise a clearly-labelled synthetic tone is produced so the render
still has a non-silent audio track. A synthetic tone is never called narration.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from typing import Any, Dict, Optional

from .redact import sanitize

_DEFAULT_VOICE = "en-US-GuyNeural"


def _ffmpeg() -> str:
    from .render import ffmpeg_bin
    return ffmpeg_bin()


def probe_seconds(path: str) -> float:
    try:
        from .render import probe_duration
        return probe_duration(path)
    except Exception:  # noqa: BLE001
        return 0.0


def synthesize_tone(text: str, out_path: str, *, seconds: Optional[float] = None) -> Dict[str, Any]:
    """Deterministic, non-silent stand-in track used when TTS is unavailable."""
    words = max(1, len((text or "").split()))
    duration = float(seconds if seconds is not None else max(1.6, min(18.0, 0.34 * words + 0.8)))
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    # A soft two-tone bed: audible (so silence checks pass) but obviously synthetic.
    cmd = [
        _ffmpeg(), "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"sine=frequency=196:duration={duration:.3f}",
        "-af", "volume=0.30,tremolo=f=3:d=0.35",
        "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", out_path,
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    return {"path": out_path, "seconds": round(probe_seconds(out_path) or duration, 3),
            "mode": "synthetic-tone", "provider": "synthetic"}


def synthesize(text: str, out_path: str, *, voice: Optional[str] = None,
               allow_network: bool = True,
               seconds: Optional[float] = None) -> Dict[str, Any]:
    """Try real TTS, fall back to a labelled synthetic track.

    Returns mode = "edge-tts" or "synthetic-tone"; callers must surface it.
    """
    voice = voice or os.environ.get("TTS_VOICE") or _DEFAULT_VOICE
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    if allow_network and os.environ.get("TTS_MODE", "auto") != "synthetic":
        try:
            import edge_tts  # type: ignore
        except Exception:  # noqa: BLE001
            edge_tts = None  # type: ignore
        if edge_tts is not None:
            async def _run() -> None:
                await edge_tts.Communicate(text, voice).save(out_path)
            try:
                asyncio.run(_run())
                seconds = probe_seconds(out_path)
                if seconds > 0.2:
                    return {"path": out_path, "seconds": round(seconds, 3),
                            "mode": "edge-tts", "provider": "edge-tts", "voice": voice}
            except Exception as exc:  # noqa: BLE001 - network/quota: fall back
                print(f"[narration] edge-tts unavailable: {sanitize(exc)[:120]}")
            if os.path.exists(out_path):
                os.remove(out_path)
    return synthesize_tone(text, out_path, seconds=seconds)
