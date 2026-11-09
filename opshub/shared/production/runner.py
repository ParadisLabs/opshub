"""Independent studio runner and the `/run all` orchestrator.

Guarantees:
  * every studio gets its own job id and its own state file
  * one studio failing never prevents the other two from running
  * duplicate triggers are idempotent on (studio, topic, day)
  * cancellation is cooperative and final
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Callable, Dict, List, Optional

from . import studios
from .contracts import Job, new_job_id
from .pipeline import StageRunner
from .storage import upload_artifacts

STUDIO_FUNCS: Dict[str, Callable[..., Dict[str, Any]]] = {
    "trendscope": studios.trendscope,
    "true-crime": studios.true_crime,
    "deep-history": studios.deep_history,
}
STUDIOS = tuple(STUDIO_FUNCS)


class Cancelled(RuntimeError):
    """Raised cooperatively when an operator cancels a job."""


def _day() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


class RunRegistry:
    """Idempotency map for repeated `/run` triggers."""

    def __init__(self, path: str):
        self.path = path
        self.data = self._load()

    def _load(self) -> Dict[str, Any]:
        try:
            with open(self.path) as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("runs"), dict):
                return data
        except Exception:  # noqa: BLE001
            pass
        return {"schema_version": "1.0", "runs": {}}

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, indent=1, sort_keys=True)
        os.replace(tmp, self.path)

    def key(self, studio: str, topic: str) -> str:
        return f"{studio}:{(topic or '').strip().lower()}:{_day()}"

    def existing(self, studio: str, topic: str) -> Optional[Dict[str, Any]]:
        return self.data["runs"].get(self.key(studio, topic))

    def remember(self, studio: str, topic: str, record: Dict[str, Any]) -> None:
        self.data["runs"][self.key(studio, topic)] = record
        self.save()


def run_studio(studio: str, job: Job, ctx: Dict[str, Any], *,
               cancel: Optional[Callable[[], bool]] = None,
               on_progress: Optional[Callable[[Dict[str, Any]], None]] = None) -> Dict[str, Any]:
    """Run one studio in isolation. Never raises: returns a status record."""
    state_dir = os.path.join(ctx["outdir"], "state")
    os.makedirs(state_dir, exist_ok=True)
    runner = StageRunner(os.path.join(state_dir, f"{job.job_id}.json"), job.job_id,
                         on_progress=on_progress)

    def report(stage: str, progress: int, detail: str = "") -> None:
        if cancel and cancel():
            raise Cancelled("cancelled by operator")
        runner.state["current"] = stage
        runner.state["status"] = "running"
        runner.state["progress"] = int(progress)
        runner.state["stages"].setdefault(stage, {})
        runner.state["stages"][stage]["status"] = "running"
        runner.save()

    started = time.time()
    try:
        result = STUDIO_FUNCS[studio](job, ctx, report)
        if cancel and cancel():
            raise Cancelled("cancelled by operator")
        # Durable storage is best-effort: a hub/R2 outage never fails a render.
        result["durable_uploads"] = upload_artifacts(job.job_id, result)
        verdict = str(result.get("verdict") or "")
        status = "blocked" if verdict == "blocked" else "complete"
        runner.state["status"] = status
        runner.state["current"] = None
        runner.state["progress"] = 100
        runner.save()
        return {
            "job_id": job.job_id, "studio": studio, "status": status,
            "verdict": verdict, "result": result,
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    except Cancelled as exc:
        runner.state["status"] = "cancelled"
        runner.state["current"] = None
        runner.state["error"] = str(exc)
        runner.save()
        return {"job_id": job.job_id, "studio": studio, "status": "cancelled",
                "error": str(exc), "elapsed_ms": int((time.time() - started) * 1000)}
    except Exception as exc:  # noqa: BLE001 - isolation is the whole point
        runner.state["status"] = "failed"
        runner.state["current"] = None
        runner.state["error"] = f"{type(exc).__name__}: {exc}"[:1000]
        runner.save()
        return {"job_id": job.job_id, "studio": studio, "status": "failed",
                "error": f"{type(exc).__name__}: {exc}"[:1000],
                "elapsed_ms": int((time.time() - started) * 1000)}


def run_all(ctx: Dict[str, Any], *, topic: str = "",
            studios_to_run: Optional[List[str]] = None,
            cancel: Optional[Callable[[], bool]] = None,
            dedupe: bool = True,
            job_id: Optional[str] = None,
            on_progress: Optional[Callable[[Dict[str, Any]], None]] = None) -> Dict[str, Any]:
    """Dispatch three independent jobs; failures stay isolated."""
    targets = list(studios_to_run or STUDIOS)
    for name in targets:
        if name not in STUDIO_FUNCS:
            raise ValueError(f"unknown studio: {name}")

    registry = RunRegistry(os.path.join(ctx["outdir"], "runs.json"))
    jobs: List[Dict[str, Any]] = []

    for name in targets:
        previous = registry.existing(name, topic) if dedupe else None
        if previous and previous.get("status") in ("complete", "blocked"):
            jobs.append({**previous, "duplicate": True})
            continue
        # A dispatched job must keep the hub-issued id so QA and approval land
        # on the same row; manual runs mint a fresh unique id.
        chosen_id = job_id if job_id and len(targets) == 1 else new_job_id(name)
        job = Job(job_id=chosen_id, studio=name, topic=topic,
                  production_mode=ctx.get("production_mode", "test"))
        record = run_studio(name, job, ctx, cancel=cancel, on_progress=on_progress)
        record["duplicate"] = False
        registry.remember(name, topic, {"job_id": record["job_id"], "studio": name,
                                        "status": record["status"],
                                        "at": int(time.time())})
        jobs.append(record)

    statuses = {j["studio"]: j["status"] for j in jobs}
    ok = [s for s, st in statuses.items() if st in ("complete", "blocked")]
    failed = [s for s, st in statuses.items() if st in ("failed", "cancelled")]
    return {
        "schema_version": "1.0",
        "dispatched": len(jobs),
        "jobs": jobs,
        "statuses": statuses,
        "completed_or_blocked": ok,
        "failed_or_cancelled": failed,
        "independent": all(j.get("independent", True) for j in jobs),
        "publishing_enabled": False,
        "ran_at": int(time.time()),
    }
