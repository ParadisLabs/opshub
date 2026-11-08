"""Quality scoring with non-overridable safety/factual gates."""
from __future__ import annotations

import time
from typing import Any, Dict, Iterable, List, Optional

WEIGHTS = {
    "research": 0.20,
    "script": 0.20,
    "visuals": 0.15,
    "narration": 0.10,
    "audio": 0.10,
    "subtitles": 0.05,
    "rendering": 0.10,
    "compliance": 0.10,
}

# A high weighted score can never outvote these.
MANDATORY_DIMENSIONS = ("compliance", "research")

DEFAULT_THRESHOLD = 80.0


def _clamp(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(100.0, f))


def evaluate(
    scores: Dict[str, Any],
    *,
    blocking_failures: Optional[Iterable[str]] = None,
    threshold: float = DEFAULT_THRESHOLD,
    job_id: str = "",
    require_mandatory: bool = True,
) -> Dict[str, Any]:
    """Return a structured QA verdict.

    Rules:
      * any blocking failure -> verdict "blocked" regardless of score
      * a missing/zero mandatory dimension -> verdict "blocked"
      * otherwise score >= threshold -> "pass", else "revise"
      * publishing_enabled is always False here; approval is a separate step
    """
    normalized = {k: _clamp(scores.get(k, 0)) for k in WEIGHTS}
    weighted = round(sum(normalized[k] * WEIGHTS[k] for k in WEIGHTS), 2)
    blockers: List[str] = [str(b) for b in (blocking_failures or []) if str(b).strip()]

    if require_mandatory:
        for dim in MANDATORY_DIMENSIONS:
            if normalized.get(dim, 0) <= 0:
                blockers.append(f"mandatory dimension not scored: {dim}")

    if blockers:
        verdict = "blocked"
    elif weighted >= threshold:
        verdict = "pass"
    else:
        verdict = "revise"

    return {
        "job_id": job_id,
        "status": "quality_review",
        "scores": normalized,
        "weighted_score": weighted,
        "threshold": threshold,
        "blocking_failures": blockers,
        "verdict": verdict,
        "approval_required": True,
        "publishing_enabled": False,
        "evaluated_at": int(time.time()),
    }


def overall_pass(report: Dict[str, Any]) -> bool:
    return report.get("verdict") == "pass" and not report.get("blocking_failures")
