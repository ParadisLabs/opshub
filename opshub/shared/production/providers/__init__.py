"""Provider adapters (real + mock). Import-safe: no network on import."""

from .base import (  # noqa: F401
    Provider,
    ProviderError,
    ProviderReport,
    ProviderState,
    classify_status,
    retry_call,
)

__all__ = [
    "Provider",
    "ProviderError",
    "ProviderReport",
    "ProviderState",
    "classify_status",
    "retry_call",
]
