"""Signed job-contract client used by studios to report progress to OpsHub."""
from __future__ import annotations

import hashlib
import hmac
import json
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Tuple

Transport = Callable[[str, str, Dict[str, str], bytes], Tuple[int, str]]


class Misconfigured(RuntimeError):
    """Raised when HUB_URL / HUB_WEBHOOK_SECRET are missing (fail closed)."""


def _default_transport(method: str, url: str, headers: Dict[str, str],
                       body: bytes) -> Tuple[int, str]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


class JobClient:
    def __init__(self, base_url: str, secret: str, *,
                 transport: Optional[Transport] = None):
        self.base_url = (base_url or "").rstrip("/")
        self.secret = (secret or "").strip()
        self.transport = transport or _default_transport

    def configured(self) -> bool:
        return bool(self.base_url and self.secret)

    def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self.configured():
            raise Misconfigured("HUB_URL and HUB_WEBHOOK_SECRET are required")
        body = json.dumps(payload, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json",
                   "x-hub-signature-256": sign(self.secret, body),
                   "User-Agent": "studio-jobclient/1.0"}
        status, text = self.transport("POST", self.base_url + path, headers, body)
        if status < 200 or status >= 300:
            raise RuntimeError(f"hub rejected status update: {status} {text[:200]}")
        try:
            return json.loads(text)
        except ValueError:
            return {"status": "ok"}

    def create(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/jobs", payload)

    def update(self, job_id: str, *, status: str, stage: str, progress: int = 0,
               detail: str = "", output: str = "",
               qa: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._post(f"/jobs/{job_id}/status", {
            "schema_version": "1.0",
            "job_id": job_id,
            "status": status,
            "stage": stage,
            "progress": int(progress),
            "detail": str(detail)[:1000],
            "output": str(output)[:500],
            "qa": qa or {},
            "reported_at": __import__("time").time(),
        })
