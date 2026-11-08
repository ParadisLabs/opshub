"""Provider registry: builds adapters from env and reports readiness.

Readiness is derived from configuration presence first. Network verification is
strictly opt-in (`verify=True`) so offline builds never claim connectivity.
"""
from __future__ import annotations

import json
import urllib.request
from typing import Any, Dict, List, Optional

from .base import Provider, ProviderError, ProviderReport, ProviderState, retry_call


def _http_json(url: str, headers: Optional[Dict[str, str]] = None,
               data: Optional[bytes] = None, timeout: float = 10.0) -> Any:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


class _HttpProvider(Provider):
    """Real adapter skeleton: only reports OPERATIONAL after an explicit check."""

    verify_url = ""

    def __init__(self, env: Optional[Dict[str, str]] = None):
        super().__init__(env)
        self._verified = False

    def verify(self) -> bool:
        if not self.configured() or not self.verify_url:
            return False
        try:
            retry_call(lambda: _http_json(self.verify_url, self._headers()),
                       attempts=2, provider=self.name)
            self._verified = True
            return True
        except ProviderError:
            return False

    def _headers(self) -> Dict[str, str]:
        return {}


class GroqProvider(_HttpProvider):
    name = "groq"
    required_env = ("GROQ_API_KEY",)
    verify_url = "https://api.groq.com/openai/v1/models"

    def _headers(self):
        return {"Authorization": f"Bearer {self.env.get('GROQ_API_KEY', '')}"}


class GeminiProvider(_HttpProvider):
    name = "gemini"
    required_env = ("GEMINI_API_KEY",)

    def verify(self) -> bool:
        if not self.configured():
            return False
        url = ("https://generativelanguage.googleapis.com/v1beta/models?key="
               + self.env.get("GEMINI_API_KEY", ""))
        try:
            retry_call(lambda: _http_json(url), attempts=2, provider=self.name)
            return True
        except ProviderError:
            return False


class CloudflareAIProvider(_HttpProvider):
    name = "cloudflare-ai"
    required_env = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")

    def verify(self) -> bool:
        if not self.configured():
            return False
        acct = self.env.get("CLOUDFLARE_ACCOUNT_ID", "")
        url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/models/search"
        try:
            retry_call(lambda: _http_json(url, {"Authorization":
                                                 f"Bearer {self.env.get('CLOUDFLARE_API_TOKEN', '')}"}),
                       attempts=2, provider=self.name)
            return True
        except ProviderError:
            return False


class _KeyedProvider(Provider):
    """Providers whose only requirement is an API key (verification skipped)."""


class PixabayProvider(_KeyedProvider):
    name = "pixabay"
    required_env = ("PIXABAY_API_KEY",)


class WikipediaProvider(_KeyedProvider):
    name = "wikipedia"
    required_env = ()          # keyless; always available


class YouTubeProvider(_KeyedProvider):
    name = "youtube"
    required_env = ("YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN")


class TikTokProvider(_KeyedProvider):
    name = "tiktok"
    required_env = ("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN")


class MetaProvider(_KeyedProvider):
    name = "meta"
    required_env = ("META_APP_ID", "META_APP_SECRET", "META_ACCESS_TOKEN")


class OpsHubProvider(_KeyedProvider):
    name = "opshub"
    required_env = ("HUB_URL", "HUB_WEBHOOK_SECRET")


PROVIDER_CLASSES = [
    GroqProvider, GeminiProvider, CloudflareAIProvider, PixabayProvider,
    WikipediaProvider, YouTubeProvider, TikTokProvider, MetaProvider,
    OpsHubProvider,
]


def build_registry(env: Dict[str, str], *, verify: bool = False) -> Dict[str, Provider]:
    providers: Dict[str, Provider] = {}
    for cls in PROVIDER_CLASSES:
        p = cls(env)
        if verify and p.configured():
            p.verify()
        providers[p.name] = p
    return providers


def readiness_report(env: Dict[str, str], *, verify: bool = False) -> Dict[str, Any]:
    """The API readiness screen payload. Contains env NAMES, never values."""
    providers = build_registry(env, verify=verify)
    reports: List[ProviderReport] = [p.report(verify=verify) for p in providers.values()]
    ready = [r.name for r in reports if r.state == ProviderState.OPERATIONAL.value]
    configured = [r.name for r in reports
                  if r.state in (ProviderState.CONFIGURED.value,
                                 ProviderState.OPERATIONAL.value)]
    return {
        "schema_version": "1.0",
        "verified": bool(verify),
        "providers": [r.to_dict() for r in reports],
        "configured": configured,
        "operational": ready,
        "publishing_enabled": False,
        "note": "publishing stays disabled until explicitly authorized",
    }
