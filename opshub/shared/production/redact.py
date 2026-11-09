"""Redaction helpers: no provider error, log line or artifact may carry a key.

`sanitize` does two things:
  1. replaces every value of a known secret with ``[redacted]``
  2. scrubs key-shaped tokens that leak through URLs/headers/messages

It is intentionally dependency free and safe to call on any string.
"""
from __future__ import annotations

import re
from typing import Iterable

_PLACEHOLDER = "[redacted]"

# key=..., api_key: ..., Authorization: Bearer ...
_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|"
    r"authorization|bearer|key)\b(\s*[:=]\s*)([\"']?)([A-Za-z0-9._\-]{8,})\3"
)
# well-known key shapes
_KEY_SHAPES = [
    re.compile(r"AIza[0-9A-Za-z_\-]{20,}"),          # Google API key
    re.compile(r"gsk_[0-9A-Za-z]{20,}"),             # Groq
    re.compile(r"github_pat_[0-9A-Za-z_]{20,}"),     # GitHub fine grained
    re.compile(r"gh[pousr]_[0-9A-Za-z]{20,}"),       # GitHub classic
    re.compile(r"xox[baprs]-[0-9A-Za-z\-]{10,}"),    # Slack
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{30,}\b"),  # Telegram bot token
]
# query-string credentials in URLs (?key=..., &token=...)
_URL_PARAM = re.compile(r"(?i)([?&](?:key|api_key|token|access_token)=)([^&\s]+)")


def sanitize(text: object, secrets: Iterable[str] = ()) -> str:
    """Return a printable string with every credential removed."""
    out = str(text)
    for value in secrets:
        value = str(value or "")
        if len(value) >= 6:
            out = out.replace(value, _PLACEHOLDER)
    for pattern in _KEY_SHAPES:
        out = pattern.sub(_PLACEHOLDER, out)
    out = _ASSIGNMENT.sub(lambda m: f"{m.group(1)}{m.group(2)}{_PLACEHOLDER}", out)
    out = _URL_PARAM.sub(lambda m: f"{m.group(1)}{_PLACEHOLDER}", out)
    return out


def redact_env(env: dict) -> dict:
    """A copy of an env mapping with secret-looking values masked.

    Used by readiness/diagnostic payloads that must never carry values.
    """
    masked = {}
    for key, value in (env or {}).items():
        upper = str(key).upper()
        if any(tag in upper for tag in ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")):
            masked[key] = _PLACEHOLDER if str(value or "").strip() else ""
        else:
            masked[key] = value
    return masked
