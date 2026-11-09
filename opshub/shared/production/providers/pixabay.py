"""Pixabay asset discovery with licence metadata, caching and checksums.

Rules honoured here:
  * results are cached for 24h (Pixabay asks clients not to hammer the API)
  * safesearch is always on
  * every download records source id, page URL, author, licence note and SHA-256
  * identical bytes are stored once (content-addressed)
  * when the key is absent or the API fails, a synthetic gradient asset is used
    and explicitly labelled `synthetic`
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional

from ..redact import sanitize
from ..usage import UsageLedger
from .base import Provider, ProviderError

CACHE_TTL = 86400
BASE = "https://pixabay.com/api/"

Transport = Callable[[str, float], "tuple[int, bytes]"]
BinaryTransport = Callable[[str, float], "tuple[int, bytes]"]


def _default_get(url: str, timeout: float) -> "tuple[int, bytes]":
    req = urllib.request.Request(url, headers={"User-Agent": "opshub-phase3/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"transport error: {type(exc).__name__}",
                            retryable=True, provider="pixabay") from None


class PixabayProvider(Provider):
    name = "pixabay"
    required_env = ("PIXABAY_API_KEY",)

    def __init__(self, env: Optional[Dict[str, str]] = None, *,
                 cache_path: Optional[str] = None,
                 transport: Optional[Transport] = None,
                 downloader: Optional[BinaryTransport] = None,
                 ledger: Optional[UsageLedger] = None,
                 timeout: float = 20.0):
        super().__init__(env)
        self.cache_path = cache_path or os.path.join(".cache", "pixabay.json")
        self.transport = transport or _default_get
        self.downloader = downloader or _default_get
        self.ledger = ledger
        self.timeout = float(timeout)
        self.cache: Dict[str, Any] = self._load_cache()

    @property
    def key(self) -> str:
        return str(self.env.get("PIXABAY_API_KEY", "") or "").strip()

    def _secrets(self) -> List[str]:
        return [self.key]

    # ---- cache ---------------------------------------------------------
    def _load_cache(self) -> Dict[str, Any]:
        try:
            with open(self.cache_path) as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("entries"), dict):
                return data
        except Exception:  # noqa: BLE001
            pass
        return {"schema_version": "1.0", "entries": {}}

    def _save_cache(self) -> None:
        os.makedirs(os.path.dirname(self.cache_path) or ".", exist_ok=True)
        tmp = self.cache_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.cache, f, indent=1, sort_keys=True)
        os.replace(tmp, self.cache_path)

    # ---- search --------------------------------------------------------
    def search(self, query: str, *, kind: str = "photo", per_page: int = 5,
               job_id: str = "unassigned") -> List[Dict[str, Any]]:
        if not self.configured():
            raise ProviderError("missing PIXABAY_API_KEY", provider=self.name)
        cache_key = f"{kind}:{query.strip().lower()}:{per_page}"
        cached = self.cache["entries"].get(cache_key)
        if cached and time.time() - float(cached.get("at", 0)) < CACHE_TTL:
            return list(cached.get("results", []))

        endpoint = BASE + ("videos/" if kind == "video" else "")
        params = {
            "key": self.key, "q": query, "per_page": max(3, min(20, per_page)),
            "safesearch": "true", "lang": "en", "order": "relevant",
        }
        if kind == "photo":
            params["image_type"] = "photo"
        url = endpoint + "?" + urllib.parse.urlencode(params)
        if self.ledger:
            self.ledger.check(job_id, calls=1)
        status, payload = self.transport(url, self.timeout)
        if status != 200:
            raise ProviderError(f"search failed: HTTP {status}", status=status,
                                retryable=status == 429 or status >= 500, provider=self.name)
        try:
            data = json.loads(payload.decode("utf-8", "replace"))
        except ValueError:
            raise ProviderError("search response was not JSON", provider=self.name) from None
        results = []
        for hit in data.get("hits", []):
            results.append({
                "asset_id": str(hit.get("id")),
                "kind": kind,
                "tags": str(hit.get("tags", ""))[:200],
                "page_url": hit.get("pageURL", ""),
                "author": hit.get("user", ""),
                "license": "Pixabay Content License (see page_url)",
                "download_url": hit.get("largeImageURL") or hit.get("webformatURL")
                                or (hit.get("videos", {}).get("medium") or {}).get("url", ""),
                "width": hit.get("imageWidth") or hit.get("videoWidth"),
                "height": hit.get("imageHeight") or hit.get("videoHeight"),
                "synthetic": False,
            })
        self.cache["entries"][cache_key] = {"at": int(time.time()), "query": query,
                                            "kind": kind, "results": results}
        self._save_cache()
        if self.ledger:
            self.ledger.record(job_id, self.name, "search", attempts=1, ok=True)
        return results

    # ---- download ------------------------------------------------------
    def download(self, result: Dict[str, Any], dest_dir: str, *,
                 job_id: str = "unassigned") -> Dict[str, Any]:
        os.makedirs(dest_dir, exist_ok=True)
        url = str(result.get("download_url") or "")
        if not url:
            raise ProviderError("asset has no download url", provider=self.name)
        if self.ledger:
            self.ledger.check(job_id, calls=1)
        status, data = self.downloader(url, self.timeout)
        if status != 200 or not data:
            raise ProviderError(f"download failed: HTTP {status}", status=status,
                                retryable=status == 429 or status >= 500, provider=self.name)
        digest = hashlib.sha256(data).hexdigest()
        ext = os.path.splitext(urllib.parse.urlparse(url).path)[1] or ".jpg"
        path = os.path.join(dest_dir, f"{digest[:16]}{ext}")
        if not os.path.exists(path):
            with open(path, "wb") as f:
                f.write(data)
        if self.ledger:
            self.ledger.record(job_id, self.name, "download", attempts=1, ok=True)
        return {
            **{k: result.get(k) for k in ("asset_id", "page_url", "author", "license", "kind")},
            "path": path, "sha256": digest, "bytes": len(data),
            "source": "pixabay", "synthetic": False,
        }

    def resolve(self, query: str, dest_dir: str, *, kind: str = "photo",
                job_id: str = "unassigned") -> Dict[str, Any]:
        """Search + download one asset, or raise so the caller can fall back."""
        hits = self.search(query, kind=kind, per_page=5, job_id=job_id)
        if not hits:
            raise ProviderError("no assets matched", provider=self.name)
        return self.download(hits[0], dest_dir, job_id=job_id)
