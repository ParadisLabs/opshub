#!/usr/bin/env python3
"""Prove `/run all` isolation: one studio fails, the other two still finish.

Renders real MP4s at reduced dimensions so the check is fast, then asserts that
the failing studio is recorded as failed without touching the other two.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OPSHUB = os.path.dirname(HERE)
sys.path.insert(0, OPSHUB)
sys.path.insert(0, os.path.join(OPSHUB, "shared"))

from production import runner  # noqa: E402
from production.synthetic import SyntheticLLM  # noqa: E402
from production.usage import UsageLedger  # noqa: E402


def main() -> int:
    outdir = os.path.join(os.path.dirname(OPSHUB), "artifacts", "phase3",
                          "run-all-isolation")
    os.makedirs(outdir, exist_ok=True)
    original = runner.STUDIO_FUNCS["true-crime"]

    def outage(*args, **kwargs):
        raise RuntimeError("simulated true-crime outage for isolation test")

    runner.STUDIO_FUNCS["true-crime"] = outage
    try:
        ctx = {
            "llm": SyntheticLLM("isolation check"), "outdir": outdir,
            "ledger": UsageLedger(os.path.join(outdir, "usage.json")),
            "allow_tts": False, "ken_burns": False,
            "short_width": 540, "short_height": 960, "short_fps": 12,
            "short_seconds": 30, "landscape_width": 960, "landscape_height": 540,
            "landscape_fps": 10, "landscape_seconds": 60,
            "production_mode": "test",
        }
        summary = runner.run_all(ctx, topic="isolation check", dedupe=False)
    finally:
        runner.STUDIO_FUNCS["true-crime"] = original

    print(json.dumps(summary, indent=1, default=str))
    statuses = summary["statuses"]
    ok = (statuses.get("trendscope") == "complete"
          and statuses.get("deep-history") == "complete"
          and statuses.get("true-crime") == "failed"
          and summary["publishing_enabled"] is False)
    print("ISOLATION_CHECK:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
