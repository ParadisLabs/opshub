"""Signed upload of finished artifacts to the OpsHub R2 binding.

The Worker's /files contract signs `METHOD\\n<key>\\nsha256(body)`, so no
credential is ever put in a URL. Uploads are best-effort and never fail a
production; the local manifest remains authoritative for the run.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

Transport = Callable[[str, str, Dict[str, str], bytes], "tuple[int, str]"]


def _default_transport(method: str, url: str, headers: Dict[str, str], body: bytes):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(type(exc).__name__) from None


def _env(env: Optional[Dict[str, str]], key: str) -> str:
    source = os.environ if env is None else env
    return str(source.get(key) or "").strip()


def upload_artifacts(job_id: str, result: Dict[str, Any], *,
                     env: Optional[Dict[str, str]] = None,
                     transport: Optional[Transport] = None) -> Dict[str, Any]:
    hub = (_env(env, "HUB_URL") or _env(env, "OPSHUB_URL")).rstrip("/")
    secret = _env(env, "HUB_WEBHOOK_SECRET")
    if not hub or not secret:
        return {"enabled": False, "uploaded": [], "errors": [],
                "reason": "HUB_URL/HUB_WEBHOOK_SECRET not configured"}

    items: List[Dict[str, Any]] = []
    for art in result.get("artifacts") or []:
        if art.get("path"):
            items.append({"kind": art.get("type") or "artifact", "path": art["path"]})
        for key in ("subtitles", "thumbnail"):
            if art.get(key):
                items.append({"kind": key, "path": art[key]})
    manifest = (result.get("manifest") or {}).get("path")
    if manifest:
        items.append({"kind": "manifest", "path": manifest})

    fn = transport or _default_transport
    uploaded, errors = [], []
    seen = set()
    for item in items:
        path = str(item["path"])
        if not path or path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        with open(path, "rb") as f:
            body = f.read()
        digest = hashlib.sha256(body).hexdigest()
        name = os.path.basename(path)
        key = f"jobs/{urllib.parse.quote(job_id, safe='')}/{item['kind']}/{urllib.parse.quote(name, safe='')}"
        canonical = f"POST\n{key}\n{digest}".encode()
        signature = "sha256=" + hmac.new(secret.encode(), canonical, hashlib.sha256).hexdigest()
        headers = {
            "content-type": "application/octet-stream",
            "x-hub-signature-256": signature,
            "user-agent": "studio-artifact-upload/1.0",
        }
        try:
            status, text = fn("POST", hub + "/files/" + key, headers, body)
            if 200 <= int(status) < 300:
                uploaded.append({"key": key, "sha256": digest, "bytes": len(body)})
            else:
                errors.append({"key": key, "status": status, "detail": text[:160]})
        except Exception as exc:  # noqa: BLE001 - never abort a render
            errors.append({"key": key, "error": type(exc).__name__})
    return {"enabled": True, "uploaded": uploaded, "errors": errors,
            "verified": bool(uploaded) and not errors}
