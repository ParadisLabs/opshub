"""Task-based provider chain: try each configured provider in order.

Every response is schema-validated by the adapter before it reaches the next
stage. Failures are collected with sanitized reasons so a readiness report can
explain what happened without exposing credentials.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..redact import sanitize
from .base import ProviderError


class ProviderChain:
    def __init__(self, providers: List[Any], *, name: str = "chain"):
        self.providers = [p for p in providers if p is not None]
        self.name = name

    def configured(self) -> bool:
        return any(getattr(p, "configured", lambda: True)() for p in self.providers)

    def generate_json(self, prompt: str, *, schema: Optional[Dict[str, Any]] = None,
                      job_id: str = "unassigned", **kwargs: Any) -> Dict[str, Any]:
        failures: List[str] = []
        for provider in self.providers:
            try:
                if not getattr(provider, "configured", lambda: True)():
                    continue
                result = provider.generate_json(prompt, schema=schema,
                                                job_id=job_id, **kwargs)
                if failures:
                    result["fallbacks"] = failures
                return result
            except ProviderError as exc:
                failures.append(sanitize(f"{getattr(provider, 'name', 'provider')}: {exc.reason}",
                                         getattr(provider, "_secrets", lambda: [])())[:220])
            except Exception as exc:  # noqa: BLE001 - never leak a raw message
                failures.append(sanitize(f"{getattr(provider, 'name', 'provider')}: "
                                         f"{type(exc).__name__}")[:160])
        raise ProviderError("all providers failed: " + " | ".join(failures[:4]),
                            provider=self.name)
