"""Deterministic mock providers for the offline build/test phase.

Nothing here touches the network. Mock outputs are fixture-shaped, clearly
labelled as mocks, and must never be presented as live AI generation.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import struct
import wave
from typing import Any, Dict, List, Optional

from .base import Provider

# 1x1 opaque PNG (valid image bytes, ~70 bytes).
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8Dict"
    "wHAAgBAQABs1w6AAAAAElFTkSuQmCC"
)


def silent_wav(seconds: float = 1.0, rate: int = 24000) -> bytes:
    """Valid mono 16-bit PCM WAV of silence."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return buf.getvalue()


class MockLLM(Provider):
    name = "mock-llm"
    required_env: tuple = ()

    def __init__(self, env: Optional[Dict[str, str]] = None, topic: str = "mock topic"):
        super().__init__(env)
        self.topic = topic
        self.calls: List[str] = []

    def verify(self) -> bool:
        return True

    def complete_json(self, prompt: str, *, schema: str = "script") -> Dict[str, Any]:
        self.calls.append(prompt[:200])
        digest = hashlib.sha256((self.topic + schema).encode()).hexdigest()[:8]
        if schema == "research":
            return {
                "mock": True,
                "topic": self.topic,
                "sources": [
                    {"id": f"mock-src-{digest}-1", "title": "Mock primary source",
                     "url": "https://example.invalid/mock-primary", "kind": "primary",
                     "claims_supported": 1},
                    {"id": f"mock-src-{digest}-2", "title": "Mock independent source",
                     "url": "https://example.invalid/mock-independent", "kind": "reporting",
                     "claims_supported": 1},
                ],
                "claims": [
                    {"claim": "Mock claim A", "sources": [f"mock-src-{digest}-1",
                                                          f"mock-src-{digest}-2"]},
                ],
            }
        if schema == "qa":
            return {"mock": True, "notes": ["fixture review"]}
        return {
            "mock": True,
            "title": f"Mock production: {self.topic}",
            "hook": "A fixture hook, not a real editorial decision.",
            "scenes": [
                {"index": i, "narration": f"Mock narration line {i}.",
                 "caption": f"Mock caption {i}", "visual": "mock still"}
                for i in range(1, 4)
            ],
            "hashtags": ["#mock"],
        }


class MockImage(Provider):
    name = "mock-image"
    required_env: tuple = ()

    def __init__(self, env: Optional[Dict[str, str]] = None):
        super().__init__(env)
        self.generated = 0

    def verify(self) -> bool:
        return True

    def generate(self, prompt: str, out_path: str) -> str:
        # Deterministic bytes derived from the prompt so checksums vary per scene.
        payload = PNG_1X1 + hashlib.sha256(prompt.encode()).digest()
        with open(out_path, "wb") as f:
            f.write(payload)
        self.generated += 1
        return out_path


class MockTTS(Provider):
    name = "mock-tts"
    required_env: tuple = ()

    def verify(self) -> bool:
        return True

    def synthesize(self, text: str, out_path: str, seconds: float = 1.0) -> str:
        with open(out_path, "wb") as f:
            f.write(silent_wav(seconds))
        return out_path


class MockStock(Provider):
    name = "mock-stock"
    required_env: tuple = ()

    def verify(self) -> bool:
        return True

    def search(self, query: str, limit: int = 3) -> List[Dict[str, Any]]:
        return [
            {"id": f"mock-stock-{i}", "query": query,
             "url": f"https://example.invalid/stock/{i}",
             "license": "mock", "mock": True}
            for i in range(1, limit + 1)
        ]


class MockPublisher(Provider):
    """Records publish intent; refuses unless explicitly authorized."""

    name = "mock-publisher"
    required_env: tuple = ("PUBLISH_AUTHORIZED",)

    def __init__(self, env: Optional[Dict[str, str]] = None):
        super().__init__(env)
        self.published: List[Dict[str, Any]] = []

    def verify(self) -> bool:
        return True

    def publish(self, platform: str, asset: str, *, authorized: bool = False) -> Dict[str, Any]:
        if not authorized:
            raise PermissionError("publishing is disabled until explicitly authorized")
        rec = {"platform": platform, "asset": asset, "mock": True}
        self.published.append(rec)
        return rec
