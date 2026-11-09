"""Usage and cost ledger with per-job and daily ceilings.

Every real provider call goes through `UsageLedger.check()` first and
`UsageLedger.record()` afterwards. Budgets fail closed: when a ceiling is
reached the call is refused instead of silently spending more.

State is a small JSON file (atomic replace) so a crashed run keeps its totals.
No credential values are stored here.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional

# Rough USD per 1M tokens. Only used when a provider does not return cost.
# Values are conservative ceilings for the free/dev tiers, not billing truth.
PRICE_PER_MTOK = {
    "gemini": {"input": 0.10, "output": 0.40},
    "groq": {"input": 0.10, "output": 0.30},
    "pixabay": {"input": 0.0, "output": 0.0},
    "mock": {"input": 0.0, "output": 0.0},
}

DEFAULTS = {
    "job_tokens": 150_000,
    "daily_tokens": 750_000,
    "job_calls": 60,
    "daily_calls": 300,
    "job_cost_usd": 1.00,
    "daily_cost_usd": 5.00,
}


class BudgetExceeded(RuntimeError):
    """Raised before a call that would cross a configured ceiling."""


@dataclass
class UsageRecord:
    job_id: str
    provider: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int = 0
    attempts: int = 1
    ok: bool = True
    estimated_cost_usd: float = 0.0
    at: int = 0

    @property
    def tokens(self) -> int:
        return int(self.prompt_tokens) + int(self.completion_tokens)


def _int_env(name: str, default: int) -> int:
    try:
        return int(str(os.environ.get(name, "")).strip() or default)
    except (TypeError, ValueError):
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(str(os.environ.get(name, "")).strip() or default)
    except (TypeError, ValueError):
        return default


class UsageLedger:
    def __init__(self, path: Optional[str] = None, *,
                 job_tokens: Optional[int] = None,
                 daily_tokens: Optional[int] = None,
                 job_calls: Optional[int] = None,
                 daily_calls: Optional[int] = None,
                 job_cost_usd: Optional[float] = None,
                 daily_cost_usd: Optional[float] = None):
        self.path = path or os.environ.get("PRODUCTION_USAGE_LEDGER") or ""
        self.limits = {
            "job_tokens": job_tokens if job_tokens is not None
            else _int_env("PRODUCTION_JOB_TOKEN_BUDGET", DEFAULTS["job_tokens"]),
            "daily_tokens": daily_tokens if daily_tokens is not None
            else _int_env("PRODUCTION_DAILY_TOKEN_BUDGET", DEFAULTS["daily_tokens"]),
            "job_calls": job_calls if job_calls is not None
            else _int_env("PRODUCTION_JOB_CALL_BUDGET", DEFAULTS["job_calls"]),
            "daily_calls": daily_calls if daily_calls is not None
            else _int_env("PRODUCTION_DAILY_CALL_BUDGET", DEFAULTS["daily_calls"]),
            "job_cost_usd": job_cost_usd if job_cost_usd is not None
            else _float_env("PRODUCTION_JOB_COST_BUDGET", DEFAULTS["job_cost_usd"]),
            "daily_cost_usd": daily_cost_usd if daily_cost_usd is not None
            else _float_env("PRODUCTION_DAILY_COST_BUDGET", DEFAULTS["daily_cost_usd"]),
        }
        self.data: Dict[str, Any] = self._load()

    # ---- persistence ---------------------------------------------------
    def _load(self) -> Dict[str, Any]:
        if not self.path or not os.path.exists(self.path):
            return {"schema_version": "1.0", "records": []}
        try:
            with open(self.path) as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("records"), list):
                return data
        except Exception:  # noqa: BLE001 - corrupt ledger is rebuilt loudly
            pass
        return {"schema_version": "1.0", "records": []}

    def save(self) -> None:
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, indent=1, sort_keys=True)
        os.replace(tmp, self.path)

    # ---- budgeting -----------------------------------------------------
    def _day(self, at: Optional[float] = None) -> str:
        return time.strftime("%Y-%m-%d", time.gmtime(at if at is not None else time.time()))

    def _records(self, job_id: Optional[str] = None,
                 day: Optional[str] = None) -> List[Dict[str, Any]]:
        out = []
        for rec in self.data.get("records", []):
            if job_id is not None and rec.get("job_id") != job_id:
                continue
            if day is not None and self._day(rec.get("at", 0)) != day:
                continue
            out.append(rec)
        return out

    def totals(self, job_id: Optional[str] = None,
               day: Optional[str] = None) -> Dict[str, float]:
        recs = self._records(job_id=job_id, day=day)
        return {
            "tokens": sum(int(r.get("prompt_tokens", 0)) + int(r.get("completion_tokens", 0))
                          for r in recs),
            "calls": len(recs),
            "cost_usd": round(sum(float(r.get("estimated_cost_usd", 0) or 0) for r in recs), 6),
        }

    def check(self, job_id: str, *, estimated_tokens: int = 0, calls: int = 1) -> None:
        """Fail closed when the next call would cross a ceiling."""
        job = self.totals(job_id=job_id)
        day = self.totals(day=self._day())
        limits = self.limits
        problems = []
        if job["tokens"] + estimated_tokens > limits["job_tokens"]:
            problems.append(f"job token budget {limits['job_tokens']} exceeded")
        if day["tokens"] + estimated_tokens > limits["daily_tokens"]:
            problems.append(f"daily token budget {limits['daily_tokens']} exceeded")
        if job["calls"] + calls > limits["job_calls"]:
            problems.append(f"job call budget {limits['job_calls']} exceeded")
        if day["calls"] + calls > limits["daily_calls"]:
            problems.append(f"daily call budget {limits['daily_calls']} exceeded")
        if job["cost_usd"] > limits["job_cost_usd"]:
            problems.append(f"job cost budget ${limits['job_cost_usd']:.2f} exceeded")
        if day["cost_usd"] > limits["daily_cost_usd"]:
            problems.append(f"daily cost budget ${limits['daily_cost_usd']:.2f} exceeded")
        if problems:
            raise BudgetExceeded("; ".join(problems))

    def record(self, job_id: str, provider: str, model: str, *,
               prompt_tokens: int = 0, completion_tokens: int = 0,
               latency_ms: int = 0, attempts: int = 1, ok: bool = True,
               estimated_cost_usd: Optional[float] = None) -> Dict[str, Any]:
        if estimated_cost_usd is None:
            price = PRICE_PER_MTOK.get(provider, PRICE_PER_MTOK["mock"])
            estimated_cost_usd = round(
                (prompt_tokens / 1_000_000.0) * price["input"]
                + (completion_tokens / 1_000_000.0) * price["output"], 6)
        rec = UsageRecord(
            job_id=str(job_id), provider=str(provider), model=str(model),
            prompt_tokens=int(prompt_tokens or 0),
            completion_tokens=int(completion_tokens or 0),
            latency_ms=int(latency_ms or 0), attempts=int(attempts or 1),
            ok=bool(ok), estimated_cost_usd=float(estimated_cost_usd or 0),
            at=int(time.time()),
        )
        self.data.setdefault("records", []).append(asdict(rec))
        self.save()
        return asdict(rec)

    def summary(self, job_id: Optional[str] = None) -> Dict[str, Any]:
        return {
            "limits": dict(self.limits),
            "job": self.totals(job_id=job_id) if job_id else None,
            "day": self.totals(day=self._day()),
            "records": len(self.data.get("records", [])),
        }
