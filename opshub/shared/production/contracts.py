"""Shared production contracts used by OpsHub and every studio.

The contract is deliberately plain-stdlib and dependency free so the exact same
file can be vendored into a studio repo and imported by the worker-side tests.

Design rules:
  * one schema version, validated on both ends
  * jobs are identified by a caller-supplied id and are idempotent on that id
  * a dispatched job is NOT a production; status must advance explicitly
  * unknown studios are rejected instead of silently accepted
"""
from __future__ import annotations

import json
import secrets
import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = "1.0"

# Canonical studio ids plus the aliases Telegram users actually type.
STUDIO_ALIASES = {
    "english": "trendscope",
    "trendscope": "trendscope",
    "trend": "trendscope",
    "faceless": "trendscope",
    "turkce": "true-crime",
    "türkçe": "true-crime",
    "truecrime": "true-crime",
    "true-crime": "true-crime",
    "true_crime": "true-crime",
    "history": "deep-history",
    "deep-history": "deep-history",
    "deep_history": "deep-history",
    "deephistory": "deep-history",
}

STUDIOS = ("trendscope", "true-crime", "deep-history")

FORMATS = {
    "short": {"aspect": "9:16", "width": 1080, "height": 1920, "min_s": 30, "max_s": 60},
    "documentary": {"aspect": "16:9", "width": 1920, "height": 1080, "min_s": 480, "max_s": 900},
}

LANGUAGES = {"trendscope": "en", "true-crime": "tr", "deep-history": "en"}


def canonical_studio(value: str) -> Optional[str]:
    """Map a user-typed studio name onto a canonical id, or None."""
    if not isinstance(value, str):
        return None
    return STUDIO_ALIASES.get(value.strip().lower())


class Stage(str, Enum):
    RESEARCH = "research"
    VERIFICATION = "verification"
    WRITING = "writing"
    PREPRODUCTION = "preproduction"
    ASSETS = "assets"
    RENDERING = "rendering"
    QA = "qa"
    APPROVAL = "approval"
    PUBLISHING = "publishing"
    DONE = "done"


class JobStatus(str, Enum):
    DISPATCHED = "dispatched"
    ACCEPTED = "accepted"
    RUNNING = "running"
    QUALITY_REVIEW = "quality_review"
    AWAITING_APPROVAL = "awaiting_approval"
    APPROVED = "approved"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"
    COMPLETE = "complete"


TERMINAL = {JobStatus.COMPLETE.value, JobStatus.FAILED.value, JobStatus.CANCELLED.value}
ACTIVE = {
    JobStatus.DISPATCHED.value,
    JobStatus.ACCEPTED.value,
    JobStatus.RUNNING.value,
    JobStatus.QUALITY_REVIEW.value,
    JobStatus.AWAITING_APPROVAL.value,
}


@dataclass
class Job:
    job_id: str
    studio: str
    topic: str = ""
    language: str = "en"
    format: str = "short"
    requested_by: str = "telegram"
    production_mode: str = "test"
    approval_required: bool = True
    status: str = JobStatus.DISPATCHED.value
    stage: str = Stage.RESEARCH.value
    progress: int = 0
    detail: str = ""
    output: str = ""
    qa: Dict[str, Any] = field(default_factory=dict)
    created_at: int = field(default_factory=lambda: int(time.time()))
    updated_at: int = field(default_factory=lambda: int(time.time()))

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def new_job_id(studio: str) -> str:
    """Unique, sortable, collision-safe job id."""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    return f"{studio}-{stamp}-{secrets.token_hex(3)}"


def build_event(job: Job) -> Dict[str, Any]:
    """The dispatch payload posted to a studio repository_dispatch."""
    return {
        "schema_version": SCHEMA_VERSION,
        "event": "opshub.produce",
        "job_id": job.job_id,
        "studio": job.studio,
        "topic": job.topic,
        "language": job.language,
        "format": job.format,
        "requested_by": job.requested_by,
        "production_mode": job.production_mode,
        "approval_required": bool(job.approval_required),
    }


def validate_event(payload: Any) -> List[str]:
    """Return a list of human-readable contract violations (empty = valid)."""
    errors: List[str] = []
    if not isinstance(payload, dict):
        return ["payload must be an object"]
    if str(payload.get("schema_version")) != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION!r}")
    event = payload.get("event", "opshub.produce")
    if event not in ("opshub.produce", "opshub.run"):
        errors.append("event must be opshub.produce or opshub.run")
    studio = canonical_studio(str(payload.get("studio", "")))
    if not studio:
        errors.append("unknown studio")
    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or not job_id.strip():
        errors.append("job_id is required")
    elif len(job_id) > 128:
        errors.append("job_id is too long")
    fmt = payload.get("format", "short")
    if fmt not in FORMATS:
        errors.append(f"format must be one of {sorted(FORMATS)}")
    mode = payload.get("production_mode", "test")
    if mode not in ("test", "live"):
        errors.append("production_mode must be test or live")
    return errors


def parse_json(text: str) -> Any:
    """Strict JSON parse used by status uploads (raises ValueError)."""
    try:
        return json.loads(text)
    except Exception as exc:  # noqa: BLE001 - surfaced as ValueError
        raise ValueError(f"invalid json: {exc}") from exc
