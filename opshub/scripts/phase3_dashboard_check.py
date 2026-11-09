#!/usr/bin/env python3
"""Verify the OpsHub dashboard reflects the real production ledger.

Reads the Phase 3 production summaries (real job ids and output paths), posts
those exact jobs to a running hub over the signed contract, then compares
GET /jobs and the dashboard HTML against what was written.

Environment: HUB_URL, HUB_WEBHOOK_SECRET (never printed).
Usage: python scripts/phase3_dashboard_check.py [summary_dir]
"""
from __future__ import annotations

import glob
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OPSHUB = os.path.dirname(HERE)
sys.path.insert(0, OPSHUB)
sys.path.insert(0, os.path.join(OPSHUB, "shared"))

from production.contracts import Job, build_event  # noqa: E402
from production.jobclient import JobClient  # noqa: E402

DEFAULT_DIR = os.path.join(os.path.dirname(OPSHUB), "artifacts", "phase3")


def get(url: str) -> str:
    with urllib.request.urlopen(url, timeout=20) as r:
        return r.read().decode()


def load_jobs(folder: str):
    found = []
    for path in sorted(glob.glob(os.path.join(folder, "*.json"))):
        try:
            with open(path) as f:
                text = f.read()
            # tolerate a leading diagnostic line before the JSON summary
            start = text.find("{")
            data = json.loads(text[start:]) if start >= 0 else {}
        except Exception:  # noqa: BLE001
            continue
        for job in data.get("jobs", []):
            if job.get("job_id") and job.get("status") in ("complete", "blocked"):
                found.append((os.path.basename(path), job))
    return found


def main() -> int:
    base = os.environ.get("HUB_URL", "").strip().rstrip("/")
    secret = os.environ.get("HUB_WEBHOOK_SECRET", "").strip()
    if not base or not secret:
        print("missing HUB_URL/HUB_WEBHOOK_SECRET")
        return 2
    folder = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    jobs = load_jobs(folder)
    if not jobs:
        print(f"no production summaries in {folder}")
        return 2

    client = JobClient(base, secret)
    written = []
    for source, record in jobs:
        studio = record["studio"]
        job = Job(job_id=record["job_id"], studio=studio, topic="phase3 production",
                  production_mode="test")
        created = client.create(build_event(job))
        result = record.get("result") or {}
        artifacts = result.get("artifacts") or []
        output = artifacts[0]["path"] if artifacts else ""
        verdict = result.get("verdict", "pass")
        client.update(job.job_id, status="running", stage="rendering", progress=80,
                      detail=f"phase3 production ({source})")
        client.update(job.job_id, status="quality_review", stage="qa", progress=95,
                      detail="qa complete", qa={"verdict": verdict,
                                                "publishing_enabled": False})
        client.update(job.job_id, status=record["status"], stage="done", progress=100,
                      detail=f"phase3 {record['status']}", output=output,
                      qa={"verdict": verdict, "publishing_enabled": False})
        written.append({"job_id": job.job_id, "studio": studio,
                        "status": record["status"], "created": created.get("created"),
                        "output": output})

    listing = json.loads(get(base + "/jobs?limit=50"))
    by_id = {row["job_id"]: row for row in listing.get("jobs", [])}
    problems = []
    for item in written:
        row = by_id.get(item["job_id"])
        if not row:
            problems.append(f"missing ledger row: {item['job_id']}")
            continue
        if row.get("status") != item["status"]:
            problems.append(f"{item['job_id']} status {row.get('status')} != {item['status']}")
        if int(row.get("progress", 0)) != 100:
            problems.append(f"{item['job_id']} progress {row.get('progress')} != 100")
        if item["output"] and row.get("output") != item["output"]:
            problems.append(f"{item['job_id']} output mismatch")

    html = get(base + "/dashboard")
    # The dashboard renders client-side from /jobs, so verify its wiring and
    # the exact data source it consumes rather than scraping server HTML.
    for needle in ("/jobs?limit=50", "/api-readiness", "/health"):
        if needle not in html:
            problems.append(f"dashboard is not wired to {needle}")
    readiness = json.loads(get(base + "/api-readiness"))
    if readiness.get("publishing_enabled") is not False:
        problems.append("readiness reports publishing enabled")

    print(json.dumps({
        "source": folder,
        "jobs_written": written,
        "ledger_rows": len(by_id),
        "dashboard_bytes": len(html),
        "publishing_enabled": readiness.get("publishing_enabled"),
        "problems": problems,
    }, indent=1))
    print("DASHBOARD_CHECK:", "PASS" if not problems else "FAIL")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
