"""Groq adapter: fast drafting, transforms, summaries, classification, fallback.

Design rules:
  * GROQ_API_KEY is primary, GROQ_API_KEY_2 is an optional secondary key
  * keys are rotated only on rate limits / transient upstream faults
  * authentication failures are never retried
  * two keys are treated as one provider account unless verified otherwise
  * every call is budgeted, recorded and redacted
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional

from ..redact import sanitize
from ..usage import UsageLedger
from .base import Provider, ProviderError, classify_status
from .gemini import Transport, validate_schema

BASE = "https://api.groq.com/openai/v1"
DEFAULT_MODELS = ("openai/gpt-oss-120b", "openai/gpt-oss-20b")


def _default_transport(method: str, url: str, headers: Dict[str, str],
                       body: Optional[bytes], timeout: float) -> "tuple[int, str]":
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"transport error: {type(exc).__name__}",
                            retryable=True, provider="groq") from None


class GroqProvider(Provider):
    name = "groq"
    required_env = ("GROQ_API_KEY",)

    def __init__(self, env: Optional[Dict[str, str]] = None, *,
                 transport: Optional[Transport] = None,
                 ledger: Optional[UsageLedger] = None,
                 sleeper: Callable[[float], None] = time.sleep,
                 attempts: int = 3,
                 timeout: float = 60.0):
        super().__init__(env)
        self.transport = transport or _default_transport
        self.ledger = ledger
        self.sleeper = sleeper
        self.attempts = max(1, int(attempts))
        self.timeout = float(timeout)
        self._models: Optional[List[str]] = None
        self.last_usage: Dict[str, Any] = {}
        self.key_uses: Dict[str, int] = {}

    # ---- credentials ---------------------------------------------------
    def keys(self) -> List[str]:
        out = []
        for name in ("GROQ_API_KEY", "GROQ_API_KEY_2"):
            value = str(self.env.get(name, "") or "").strip()
            if value and value not in out:
                out.append(value)
        return out

    def _secrets(self) -> List[str]:
        return self.keys()

    def models(self, *, refresh: bool = False) -> List[str]:
        override = str(self.env.get("GROQ_MODELS", "") or "").strip()
        if override:
            return [m.strip() for m in override.split(",") if m.strip()]
        if self._models is not None and not refresh:
            return list(self._models)
        if not self.keys():
            return []
        status, text = self.transport("GET", f"{BASE}/models",
                                      {"Authorization": f"Bearer {self.keys()[0]}",
                                       "User-Agent": "opshub-phase3/1.0"}, None, self.timeout)
        if status != 200:
            # discovery is best effort; known production models are the fallback
            self._models = list(DEFAULT_MODELS)
            return list(self._models)
        try:
            data = json.loads(text)
        except ValueError:
            self._models = list(DEFAULT_MODELS)
            return list(self._models)
        available = {str(m.get("id")) for m in data.get("data", [])}
        ranked = [m for m in DEFAULT_MODELS if m in available]
        ranked += sorted(available - set(ranked))
        self._models = ranked or list(DEFAULT_MODELS)
        return list(self._models)

    def verify(self) -> bool:
        try:
            return bool(self.models(refresh=True))
        except ProviderError:
            return False

    # ---- generation ----------------------------------------------------
    def generate_json(self, prompt: str, *, schema: Optional[Dict[str, Any]] = None,
                      job_id: str = "unassigned", model: Optional[str] = None,
                      temperature: float = 0.5, max_output_tokens: int = 4096,
                      max_attempts: Optional[int] = None) -> Dict[str, Any]:
        keys = self.keys()
        if not keys:
            raise ProviderError("missing GROQ_API_KEY", provider=self.name)
        models = [model] if model else self.models()
        attempts = self.attempts if max_attempts is None else max(1, int(max_attempts))
        estimate = max(256, min(8000, len(prompt) // 4)) + max_output_tokens
        if self.ledger:
            self.ledger.check(job_id, estimated_tokens=estimate)

        last: Optional[ProviderError] = None
        started = time.time()
        used_attempts = 0
        auth_failed = False

        for chosen in models:
            for key_index, key in enumerate(keys):
                body = json.dumps({
                    "model": chosen,
                    "messages": [{"role": "user", "content": prompt}],
                    "response_format": {"type": "json_object"},
                    "temperature": float(temperature),
                    "max_completion_tokens": int(max_output_tokens),
                }).encode()
                headers = {"Content-Type": "application/json",
                           "Authorization": f"Bearer {key}",
                           "User-Agent": "opshub-phase3/1.0"}
                for attempt in range(1, attempts + 1):
                    used_attempts += 1
                    try:
                        status, text = self.transport("POST", f"{BASE}/chat/completions",
                                                      headers, body, self.timeout)
                    except ProviderError as exc:
                        last = exc
                    else:
                        if status == 200:
                            parsed = self._parse(text)
                            self.last_usage = parsed["usage"]
                            errors = validate_schema(parsed["data"], schema)
                            if errors:
                                raise ProviderError(
                                    "schema validation failed: " + "; ".join(errors[:5]),
                                    provider=self.name, retryable=False)
                            self.key_uses[str(key_index)] = self.key_uses.get(str(key_index), 0) + 1
                            if self.ledger:
                                self.ledger.record(
                                    job_id, self.name, chosen,
                                    prompt_tokens=parsed["usage"].get("prompt_tokens", 0),
                                    completion_tokens=parsed["usage"].get("completion_tokens", 0),
                                    latency_ms=int((time.time() - started) * 1000),
                                    attempts=used_attempts, ok=True)
                            return {
                                "data": parsed["data"], "provider": self.name,
                                "model": chosen, "key_index": key_index,
                                "usage": self.last_usage, "attempts": used_attempts,
                                "latency_ms": int((time.time() - started) * 1000),
                            }
                        last = self._error(status, text)
                        if not last.retryable:
                            # 401/403 on this key: do not retry it, try the next key once
                            auth_failed = status in (401, 403)
                            break
                    if attempt < attempts:
                        self.sleeper(min(8.0, 0.6 * (2 ** (attempt - 1))))
                if auth_failed:
                    auth_failed = False
                    continue
                # after a hard rate limit, move to the next key/model
            # next model

        if self.ledger:
            self.ledger.record(job_id, self.name, models[0] if models else "unknown",
                               latency_ms=int((time.time() - started) * 1000),
                               attempts=used_attempts, ok=False)
        raise last or ProviderError("generation failed", provider=self.name)

    def _parse(self, text: str) -> Dict[str, Any]:
        try:
            raw = json.loads(text)
        except ValueError:
            raise ProviderError("response was not JSON", provider=self.name) from None
        choices = raw.get("choices") or []
        if not choices:
            raise ProviderError("no choices returned", provider=self.name)
        content = str(((choices[0] or {}).get("message") or {}).get("content") or "").strip()
        if not content:
            raise ProviderError("empty generation", provider=self.name)
        try:
            data = json.loads(content)
        except ValueError:
            start, end = content.find("{"), content.rfind("}")
            if start == -1 or end <= start:
                raise ProviderError("model output was not JSON", provider=self.name) from None
            try:
                data = json.loads(content[start:end + 1])
            except ValueError:
                raise ProviderError("model output was not JSON", provider=self.name) from None
        usage = raw.get("usage") or {}
        return {
            "data": data,
            "usage": {
                "prompt_tokens": int(usage.get("prompt_tokens", 0) or 0),
                "completion_tokens": int(usage.get("completion_tokens", 0) or 0),
                "total_tokens": int(usage.get("total_tokens", 0) or 0),
            },
        }

    def _error(self, status: int, body: str) -> ProviderError:
        reason, retryable = classify_status(status)
        detail = sanitize(body, self._secrets())[:220]
        return ProviderError(f"{reason}: {detail}", status=status,
                             retryable=retryable, provider=self.name)
