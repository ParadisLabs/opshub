"""Provider adapter base: connection state, retries, error classification."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Iterable, List, Optional


class ProviderState(str, Enum):
    NOT_CONFIGURED = "not_configured"
    CONFIGURED = "configured"
    VERIFIED = "verified"
    QUOTA_AVAILABLE = "quota_available"
    OPERATIONAL = "operational"
    DEGRADED = "degraded"
    FAILED = "failed"


class ProviderError(RuntimeError):
    """Classified provider failure. Never carries secret values."""

    def __init__(self, reason: str, *, status: Optional[int] = None,
                 retryable: bool = False, provider: str = ""):
        super().__init__(f"{provider or 'provider'}: {reason}")
        self.reason = reason
        self.status = status
        self.retryable = retryable
        self.provider = provider


@dataclass
class ProviderReport:
    name: str
    state: str
    required_env: List[str] = field(default_factory=list)
    missing_env: List[str] = field(default_factory=list)
    detail: str = ""
    checked_at: int = field(default_factory=lambda: int(time.time()))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "state": self.state,
            "required_env": list(self.required_env),
            "missing_env": list(self.missing_env),
            "detail": self.detail,
            "checked_at": self.checked_at,
        }


def classify_status(status: int) -> tuple[str, bool]:
    """Map an HTTP status onto (reason, retryable)."""
    if status == 401:
        return "invalid credential", False
    if status == 403:
        return "permission denied", False
    if status == 404:
        return "endpoint or model not found", False
    if status == 408:
        return "upstream timeout", True
    if status == 413:
        return "payload too large", False
    if status == 429:
        return "rate limited", True
    if 500 <= status <= 599:
        return "upstream error", True
    if 400 <= status <= 499:
        return "bad request", False
    return "unexpected status", False


def retry_call(
    fn: Callable[[], Any],
    *,
    attempts: int = 3,
    base_delay: float = 0.5,
    max_delay: float = 8.0,
    sleeper: Callable[[float], None] = time.sleep,
    provider: str = "",
) -> Any:
    """Retry only classified-retryable failures, with exponential backoff.

    `sleeper` is injectable so tests never actually sleep.
    """
    last: Optional[Exception] = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except ProviderError as exc:
            last = exc
            if not exc.retryable or attempt == attempts:
                raise
        except Exception as exc:  # network/transport: treat as retryable
            last = ProviderError(str(exc), retryable=True, provider=provider)
            if attempt == attempts:
                raise last
        delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
        sleeper(delay)
    raise ProviderError(str(last), retryable=True, provider=provider)


class Provider:
    """Minimal adapter contract every real/mock provider implements."""

    name = "base"
    required_env: Iterable[str] = ()

    def __init__(self, env: Optional[Dict[str, str]] = None):
        self.env = dict(env or {})

    # ---- readiness -----------------------------------------------------
    def missing_env(self) -> List[str]:
        return [k for k in self.required_env if not str(self.env.get(k, "")).strip()]

    def configured(self) -> bool:
        return not self.missing_env()

    def verify(self) -> bool:
        """Cheap authenticated round-trip. Real adapters override."""
        return self.configured()

    def report(self, verify: bool = False) -> ProviderReport:
        """Readiness snapshot. Never touches the network unless verify=True."""
        missing = self.missing_env()
        if missing:
            return ProviderReport(self.name, ProviderState.NOT_CONFIGURED.value,
                                  list(self.required_env), missing,
                                  "missing credentials")
        if not verify:
            return ProviderReport(self.name, ProviderState.CONFIGURED.value,
                                  list(self.required_env), [],
                                  "configured; not verified")
        try:
            ok = self.verify()
        except ProviderError as exc:
            state = ProviderState.DEGRADED.value if exc.retryable else ProviderState.FAILED.value
            return ProviderReport(self.name, state, list(self.required_env), [],
                                  exc.reason)
        return ProviderReport(
            self.name,
            ProviderState.OPERATIONAL.value if ok else ProviderState.CONFIGURED.value,
            list(self.required_env), [], "" if ok else "configured; not verified",
        )
