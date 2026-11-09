"""Gemini adapter: research synthesis, scripts, storyboards, editorial.

Design rules:
  * model names are discovered, never hardcoded to one obsolete release
  * JSON responses are parsed and validated before the next stage sees them
  * 429/5xx retry with exponential backoff; 401/403 fail immediately
  * every call is budgeted and recorded in the usage ledger
  * the API key never appears in an error, log or return value
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

from ..redact import sanitize
from ..usage import BudgetExceeded, UsageLedger
from .base import Provider, ProviderError, classify_status

Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], "tuple[int, str]"]

BASE = "https://generativelanguage.googleapis.com/v1beta"

# Model families we accept, newest first. Discovery decides what actually exists.
_PREFERRED = (
    "gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash",
    "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest",
)
_BLOCKED_TOKENS = ("embedding", "image", "tts", "live", "native-audio", "vision")


def _default_transport(method: str, url: str, headers: Dict[str, str],
                       body: Optional[bytes], timeout: float) -> "tuple[int, str]":
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - classified by caller
        raise ProviderError(f"transport error: {type(exc).__name__}",
                            retryable=True, provider="gemini") from None


def validate_schema(payload: Any, schema: Optional[Dict[str, Any]]) -> List[str]:
    """Minimal structural validation: required keys and primitive types."""
    if not schema:
        return []
    errors: List[str] = []
    if not isinstance(payload, dict):
        return ["response must be a JSON object"]
    for key in schema.get("required", []):
        if key not in payload or payload[key] in (None, "", [], {}):
            errors.append(f"missing required key: {key}")
    for key, expected in (schema.get("types") or {}).items():
        if key not in payload:
            continue
        value = payload[key]
        checks = {
            "list": lambda v: isinstance(v, list),
            "dict": lambda v: isinstance(v, dict),
            "str": lambda v: isinstance(v, str),
            "int": lambda v: isinstance(v, int),
            "number": lambda v: isinstance(v, (int, float)),
            "bool": lambda v: isinstance(v, bool),
        }
        check = checks.get(expected)
        if check and not check(value):
            errors.append(f"{key} must be {expected}")
    for key, minimum in (schema.get("min_items") or {}).items():
        value = payload.get(key)
        if isinstance(value, list) and len(value) < int(minimum):
            errors.append(f"{key} needs at least {minimum} items")
    return errors


class GeminiProvider(Provider):
    name = "gemini"
    required_env = ("GEMINI_API_KEY",)

    def __init__(self, env: Optional[Dict[str, str]] = None, *,
                 transport: Optional[Transport] = None,
                 ledger: Optional[UsageLedger] = None,
                 sleeper: Callable[[float], None] = time.sleep,
                 attempts: int = 3,
                 timeout: float = 90.0):
        super().__init__(env)
        self.transport = transport or _default_transport
        self.ledger = ledger
        self.sleeper = sleeper
        self.attempts = max(1, int(attempts))
        self.timeout = float(timeout)
        self._models: Optional[List[str]] = None
        self.last_usage: Dict[str, Any] = {}

    # ---- helpers -------------------------------------------------------
    @property
    def key(self) -> str:
        return str(self.env.get("GEMINI_API_KEY", "") or "").strip()

    def _secrets(self) -> List[str]:
        return [self.key]

    def _url(self, path: str) -> str:
        return f"{BASE}/{path}?key={urllib.parse.quote(self.key)}"

    def _error(self, status: int, body: str) -> ProviderError:
        reason, retryable = classify_status(status)
        detail = sanitize(body, self._secrets())[:220]
        return ProviderError(f"{reason}: {detail}", status=status,
                            retryable=retryable, provider=self.name)

    # ---- discovery / readiness ----------------------------------------
    def models(self, *, refresh: bool = False) -> List[str]:
        if self._models is not None and not refresh:
            return list(self._models)
        if not self.configured():
            return []
        status, text = self.transport("GET", f"{BASE}/models?pageSize=100&key={urllib.parse.quote(self.key)}",
                                      {"User-Agent": "opshub-phase3/1.0"}, None, self.timeout)
        if status != 200:
            raise self._error(status, text)
        try:
            data = json.loads(text)
        except ValueError:
            raise ProviderError("models response was not JSON", provider=self.name) from None
        usable = []
        for model in data.get("models", []):
            name = str(model.get("name", "")).split("/")[-1]
            methods = model.get("supportedGenerationMethods") or []
            if "generateContent" not in methods:
                continue
            if any(tag in name.lower() for tag in _BLOCKED_TOKENS):
                continue
            usable.append(name)
        # keep a deterministic preference order
        ranked = [m for m in _PREFERRED if m in usable]
        ranked += [m for m in sorted(usable) if m not in ranked]
        self._models = ranked
        return list(ranked)

    def choose_model(self) -> str:
        override = str(self.env.get("GEMINI_MODEL", "") or "").strip()
        available = self.models()
        if override:
            if available and override not in available:
                raise ProviderError(f"configured model {override!r} is not available to this key",
                                    provider=self.name)
            return override
        if not available:
            raise ProviderError("no generateContent model is available to this key",
                                provider=self.name)
        return available[0]

    def verify(self) -> bool:
        try:
            return bool(self.models(refresh=True))
        except ProviderError:
            return False

    # ---- generation ----------------------------------------------------
    def generate_json(self, prompt: str, *, schema: Optional[Dict[str, Any]] = None,
                      job_id: str = "unassigned", model: Optional[str] = None,
                      temperature: float = 0.4, max_output_tokens: int = 4096,
                      max_attempts: Optional[int] = None) -> Dict[str, Any]:
        if not self.configured():
            raise ProviderError("missing GEMINI_API_KEY", provider=self.name)
        chosen = model or self.choose_model()
        attempts = self.attempts if max_attempts is None else max(1, int(max_attempts))
        estimate = max(256, min(8000, len(prompt) // 4)) + max_output_tokens
        if self.ledger:
            self.ledger.check(job_id, estimated_tokens=estimate)

        body = json.dumps({
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": float(temperature),
                "maxOutputTokens": int(max_output_tokens),
            },
        }).encode()
        url = f"{BASE}/models/{urllib.parse.quote(chosen)}:generateContent?key={urllib.parse.quote(self.key)}"
        headers = {"Content-Type": "application/json", "User-Agent": "opshub-phase3/1.0"}

        last: Optional[ProviderError] = None
        started = time.time()
        for attempt in range(1, attempts + 1):
            try:
                status, text = self.transport("POST", url, headers, body, self.timeout)
            except ProviderError as exc:
                last = exc
            else:
                if status == 200:
                    payload = self._parse(text)
                    self.last_usage = dict(payload.get("_usage") or {})
                    errors = validate_schema(payload.get("data"), schema)
                    if errors:
                        raise ProviderError("schema validation failed: " + "; ".join(errors[:5]),
                                            provider=self.name, retryable=False)
                    if self.ledger:
                        self.ledger.record(
                            job_id, self.name, chosen,
                            prompt_tokens=self.last_usage.get("prompt_tokens", 0),
                            completion_tokens=self.last_usage.get("completion_tokens", 0),
                            latency_ms=int((time.time() - started) * 1000),
                            attempts=attempt, ok=True)
                    return {
                        "data": payload.get("data"),
                        "provider": self.name,
                        "model": chosen,
                        "usage": self.last_usage,
                        "attempts": attempt,
                        "latency_ms": int((time.time() - started) * 1000),
                    }
                last = self._error(status, text)
                if not last.retryable:
                    break
            if attempt < attempts:
                self.sleeper(min(8.0, 0.6 * (2 ** (attempt - 1))))

        if self.ledger:
            self.ledger.record(job_id, self.name, chosen, latency_ms=int((time.time() - started) * 1000),
                               attempts=attempts, ok=False)
        raise last or ProviderError("generation failed", provider=self.name)

    def _parse(self, text: str) -> Dict[str, Any]:
        try:
            raw = json.loads(text)
        except ValueError:
            raise ProviderError("response was not JSON", provider=self.name) from None
        candidates = raw.get("candidates") or []
        if not candidates:
            feedback = raw.get("promptFeedback") or {}
            reason = sanitize(feedback.get("blockReason", "no candidates"), self._secrets())
            raise ProviderError(f"generation refused: {reason}", provider=self.name)
        parts = (((candidates[0] or {}).get("content") or {}).get("parts") or [])
        text_out = "".join(str(p.get("text", "")) for p in parts).strip()
        if not text_out:
            raise ProviderError("empty generation", provider=self.name)
        try:
            data = json.loads(text_out)
        except ValueError:
            # tolerate fenced JSON
            start, end = text_out.find("{"), text_out.rfind("}")
            if start == -1 or end <= start:
                raise ProviderError("model output was not JSON", provider=self.name) from None
            try:
                data = json.loads(text_out[start:end + 1])
            except ValueError:
                raise ProviderError("model output was not JSON", provider=self.name) from None
        usage = raw.get("usageMetadata") or {}
        return {
            "data": data,
            "_usage": {
                "prompt_tokens": int(usage.get("promptTokenCount", 0) or 0),
                "completion_tokens": int(usage.get("candidatesTokenCount", 0) or 0),
                "total_tokens": int(usage.get("totalTokenCount", 0) or 0),
            },
        }
