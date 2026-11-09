"""Wikimedia Commons image discovery with attribution metadata.

Commons is keyless but requires a descriptive User-Agent. Every result keeps
the file page, author, licence label/link and the retrieved timestamp so the
manifest can carry attribution into publishing metadata.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

from ..redact import sanitize
from .base import Provider, ProviderError

API = "https://commons.wikimedia.org/w/api.php"
Transport = Callable[[str, float], "tuple[int, bytes]"]
UA = "OpsHub-Studio/1.0 (educational archival use; contact via repository)"


def _default_get(url: str, timeout: float) -> "tuple[int, bytes]":
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"transport error: {type(exc).__name__}",
                            retryable=True, provider="wikimedia") from None


def _strip_html(value: Any) -> str:
    return re.sub(r"<[^>]+>", "", str(value or "")).strip()[:300]


class WikimediaProvider(Provider):
    name = "wikimedia"
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

    def _get_json(self, url: str) -> Dict[str, Any]:
        status, payload = self.transport(url, self.timeout)
        if status != 200:
            raise ProviderError(f"search failed: HTTP {status}", status=status,
                                retryable=status == 429 or status >= 500,
                                provider=self.name)
        try:
            return json.loads(payload.decode("utf-8", "replace"))
        except ValueError:
            raise ProviderError("response was not JSON", provider=self.name) from None

    def search(self, query: str, *, per_page: int = 5,
               job_id: str = "unassigned") -> List[Dict[str, Any]]:
        search = f"filetype:bitmap {query}".strip()
        params = {
            "action": "query", "format": "json", "generator": "search",
            "gsrsearch": search, "gsrnamespace": "6",
            "gsrlimit": str(max(3, min(20, per_page))),
            "prop": "imageinfo", "iiprop": "url|mime|size|extmetadata",
            "iiurlwidth": "1280",
        }
        data = self._get_json(API + "?" + urllib.parse.urlencode(params))
        results: List[Dict[str, Any]] = []
        pages = ((data.get("query") or {}).get("pages") or {})
        for page in pages.values():
            info = (page.get("imageinfo") or [{}])[0]
            mime = str(info.get("mime") or "")
            if not mime.startswith("image/") or mime == "image/svg+xml":
                continue
            meta = info.get("extmetadata") or {}
            license_name = _strip_html((meta.get("LicenseShortName") or {}).get("value"))
            license_url = _strip_html((meta.get("LicenseUrl") or {}).get("value"))
            author = _strip_html((meta.get("Artist") or {}).get("value"))
            results.append({
                "asset_id": "commons:" + str(page.get("pageid")),
                "kind": "photo",
                "page_url": info.get("descriptionurl") or "",
                "author": author,
                "license": license_name or "See Wikimedia Commons file page",
                "license_url": license_url,
                "download_url": info.get("thumburl") or info.get("url") or "",
                "width": info.get("thumbwidth") or info.get("width"),
                "height": info.get("thumbheight") or info.get("height"),
                "source": "wikimedia",
                "synthetic": False,
            })
        return results

    def download(self, result: Dict[str, Any], dest_dir: str, *,
                 job_id: str = "unassigned") -> Dict[str, Any]:
        os.makedirs(dest_dir, exist_ok=True)
        url = str(result.get("download_url") or "")
        if not url:
            raise ProviderError("asset has no download url", provider=self.name)
        status, data = self.downloader(url, self.timeout)
        if status != 200 or not data:
            raise ProviderError(f"download failed: HTTP {status}", status=status,
                                retryable=status == 429 or status >= 500,
                                provider=self.name)
        digest = hashlib.sha256(data).hexdigest()
        ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp"):
            ext = ".jpg"
        path = os.path.join(dest_dir, f"{digest[:16]}{ext}")
        if not os.path.exists(path):
            with open(path, "wb") as f:
                f.write(data)
        return {
            **result, "path": path, "sha256": digest, "bytes": len(data),
            "retrieved_at": int(__import__("time").time()),
            "provenance": sanitize(f"{result.get('page_url', '')} | {result.get('author', '')} | {result.get('license', '')}", []),
        }

    def resolve(self, query: str, dest_dir: str, *, kind: str = "photo",
                job_id: str = "unassigned") -> Dict[str, Any]:
        hits = self.search(query, job_id=job_id)
        if not hits:
            raise ProviderError("no assets matched", provider=self.name)
        return self.download(hits[0], dest_dir, job_id=job_id)
