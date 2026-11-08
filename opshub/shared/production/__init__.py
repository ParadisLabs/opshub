"""Shared production infrastructure for the OpsHub media ecosystem.

Vendored into each studio. Stdlib only; no network at import time.
"""

from .contracts import (  # noqa: F401
    FORMATS,
    Job,
    JobStatus,
    LANGUAGES,
    SCHEMA_VERSION,
    STUDIOS,
    Stage,
    build_event,
    canonical_studio,
    new_job_id,
    validate_event,
)

__all__ = [
    "FORMATS",
    "Job",
    "JobStatus",
    "LANGUAGES",
    "SCHEMA_VERSION",
    "STUDIOS",
    "Stage",
    "build_event",
    "canonical_studio",
    "new_job_id",
    "validate_event",
]
