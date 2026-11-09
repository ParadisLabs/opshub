"""Internet Archive image discovery with rights and provenance metadata.

Only public metadata endpoints are used. API access is not proof of rights:
the result keeps the item identifier, file page, creator and rights/licence
statement for a human editorial check.
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

from .base import Provider, ProviderError

SEARCH = "https://archive.org/advancedsearch.php"
Transport = Callable[[str, float], "tuple[int, bytes]"]
UA = "OpsHub-Studio/1.0 (educational archival research)"


def _default_get(url: str, timeout: float) -> "tuple[int, bytes]":
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"transport error: {type(exc).__name__}",
                            retryable=True, provider="internet-archive") from None


class InternetArchiveProvider(Provider):
    name = "internet-archive"
    required_env = ()

    def __init__(self, env: Optional[Dict[str, str]] = None, *,
                 transport: Optional[Transport] = None,
                 downloader: Optional[Transport] = None,
                 timeout: float = 25.0):
        super().__init__(env)
        self.transport = transport or _default_get
        self.downloader = downloader or _default_get
        self.timeout = float(timeout)

    def configured(self) -> bool:
        return True

    def _json(self, url: str) -> Dict[str, Any]:
        status, payload = self.transport(url, self.timeout)
        if status != 200:
            raise ProviderError(f"HTTP {status}", status=status,
                                retryable=status == 429 or status >= 500,
                                provider=self.name)
        try:
            return json.loads(payload.decode("utf-8", "replace"))
        except ValueError:
            raise ProviderError("response was not JSON", provider=self.name) from None

    def search(self, query: str, *, per_page: int = 5,
               job_id: str = "unassigned") -> List[Dict[str, Any]]:
        params = [
            ("q", f"mediatype:(image) AND ({query})"),
            ("fl[]", "identifier"), ("fl[]", "title"), ("fl[]", "licenseurl"),
            ("rows", str(max(3, min(20, per_page)))), ("page", "1"), ("output", "json"),
        ]
        data = self._json(SEARCH + "?" + urllib.parse.urlencode(params))
        docs = ((data.get("response") or {}).get("docs") or [])
        return [{
            "asset_id": "archive:" + str(doc.get("identifier")),
            "identifier": str(doc.get("identifier")),
            "title": str(doc.get("title") or ""),
            "license_url": str(doc.get("licenseurl") or ""),
            "kind": "photo", "source": "internet-archive", "synthetic": False,
            "page_url": "https://archive.org/details/" + urllib.parse.quote(str(doc.get("identifier"))),
        } for doc in docs if doc.get("identifier")]

    def _metadata(self, identifier: str) -> Dict[str, Any]:
        return self._json("https://archive.org/metadata/" + urllib.parse.quote(identifier))

    def resolve(self, query: str, dest_dir: str, *, kind: str = "photo",
                job_id: str = "unassigned") -> Dict[str, Any]:
        os.makedirs(dest_dir, exist_ok=True)
        for hit in self.search(query, job_id=job_id):
            try:
                meta = self._metadata(hit["identifier"])
            except ProviderError:
                continue
            files = meta.get("files") or []
            image = next((f for f in files
                          if str(f.get("format", "")).upper() in ("JPEG", "PNG")
                          or str(f.get("name", "")).lower().endswith((".jpg", ".jpeg", ".png"))), None)
            if not image:
                continue
            name = str(image.get("name"))
            url = "https://archive.org/download/" + urllib.parse.quote(hit["identifier"]) + "/" + urllib.parse.quote(name)
            status, data = self.downloader(url, self.timeout)
            if status != 200 or not data:
                continue
            digest = hashlib.sha256(data).hexdigest()
            ext = os.path.splitext(name)[1].lower() or ".jpg"
            path = os.path.join(dest_dir, f"{digest[:16]}{ext}")
            if not os.path.exists(path):
                with open(path, "wb") as f:
                    f.write(data)
            md = meta.get("metadata") or {}
            return {
                **hit,
                "path": path, "sha256": digest, "bytes": len(data),
                "author": str(md.get("creator") or "")[:300],
                "license": str(hit.get("license_url") or md.get("rights") or "See Internet Archive item")[:300],
                "retrieved_at": int(__import__("time").time()),
                "provenance": f"{hit.get('page_url', '')} | {md.get('creator', '')} | {md.get('rights', '')}",
            }
        raise ProviderError("no downloadable image matched", provider=self.name)
