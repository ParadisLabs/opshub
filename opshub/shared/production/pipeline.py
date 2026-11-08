"""Resumable, idempotent production lifecycle runner.

State is persisted after every stage so a crashed run resumes instead of
repeating finished work. Stage functions must themselves be idempotent.
"""
from __future__ import annotations

import json
import os
import time
import traceback
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .contracts import JobStatus, Stage

StageFn = Callable[[], Any]
StageSpec = Tuple[str, StageFn]


@dataclass
class StageOutcome:
    name: str
    status: str          # complete | failed | skipped
    started_at: int
    ended_at: int
    error: str = ""
    result: Any = None


class StageRunner:
    def __init__(self, state_path: str, job_id: str,
                 on_progress: Optional[Callable[[Dict[str, Any]], None]] = None):
        self.state_path = state_path
        self.job_id = job_id
        self.on_progress = on_progress
        self.state = self._load()

    # ---- state ---------------------------------------------------------
    def _load(self) -> Dict[str, Any]:
        if os.path.exists(self.state_path):
            try:
                with open(self.state_path) as f:
                    data = json.load(f)
                if isinstance(data, dict) and data.get("job_id") == self.job_id:
                    data.setdefault("stages", {})
                    return data
            except Exception:  # noqa: BLE001 - corrupt state is rebuilt
                pass
        return {"job_id": self.job_id, "created_at": int(time.time()),
                "stages": {}, "current": None, "status": JobStatus.RUNNING.value}

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.state_path) or ".", exist_ok=True)
        tmp = self.state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.state, f, indent=1, default=str)
        os.replace(tmp, self.state_path)

    def completed(self) -> List[str]:
        return [name for name, rec in self.state["stages"].items()
                if rec.get("status") == "complete"]

    def failed(self) -> List[str]:
        return [name for name, rec in self.state["stages"].items()
                if rec.get("status") == "failed"]

    # ---- execution -----------------------------------------------------
    def run(self, stages: Sequence[StageSpec], *, resume: bool = True,
            retry_failed: bool = True) -> Dict[str, Any]:
        """Run stages in order. Returns a summary; raises on unrecoverable failure."""
        total = len(stages)
        for idx, (name, fn) in enumerate(stages, start=1):
            rec = self.state["stages"].get(name) or {}
            if resume and rec.get("status") == "complete":
                self._progress(idx, total, name, "skipped")
                continue
            if rec.get("status") == "failed" and not retry_failed:
                self._progress(idx, total, name, "skipped")
                continue

            started = int(time.time())
            self.state["current"] = name
            self._progress(idx, total, name, "running")
            try:
                result = fn()
            except Exception as exc:  # noqa: BLE001 - recorded then re-raised
                self.state["stages"][name] = {
                    "status": "failed", "started_at": started,
                    "ended_at": int(time.time()),
                    "error": f"{exc.__class__.__name__}: {exc}",
                    "traceback": traceback.format_exc()[-1200:],
                }
                self.state["status"] = JobStatus.FAILED.value
                self.save()
                self._progress(idx, total, name, "failed")
                raise
            self.state["stages"][name] = {
                "status": "complete", "started_at": started,
                "ended_at": int(time.time()), "error": "",
                "result": _safe(result),
            }
            self.save()
            self._progress(idx, total, name, "complete")

        self.state["current"] = None
        self.state["status"] = JobStatus.COMPLETE.value
        self.save()
        return {"job_id": self.job_id, "status": self.state["status"],
                "completed": self.completed(), "failed": self.failed(),
                "progress": 100}

    def _progress(self, idx: int, total: int, name: str, status: str) -> None:
        if not self.on_progress:
            return
        try:
            self.on_progress({
                "job_id": self.job_id,
                "stage": name,
                "index": idx,
                "total": total,
                "progress": int(round(100 * (idx - 1) / max(1, total))),
                "stage_status": status,
            })
        except Exception:  # noqa: BLE001 - progress reporting must never kill a run
            pass


def _safe(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)[:500]


def default_stages() -> List[str]:
    return [s.value for s in Stage]
