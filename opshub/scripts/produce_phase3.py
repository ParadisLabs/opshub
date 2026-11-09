#!/usr/bin/env python3
"""Phase 3 production CLI.

Examples:
  python scripts/produce_phase3.py --studio trendscope --out artifacts/phase3
  python scripts/produce_phase3.py --studio all --topic "AI agents" --json
  python scripts/produce_phase3.py --studio deep-history --landscape-seconds 480

No credential is read from a file or printed. Providers are enabled only when
their environment variable is present; otherwise the synthetic adapter is used
and every artifact records that fact.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
OPSHUB = os.path.dirname(HERE)
sys.path.insert(0, OPSHUB)
sys.path.insert(0, os.path.join(OPSHUB, "shared"))

from production import runner  # noqa: E402
from production.providers.chain import ProviderChain  # noqa: E402
from production.providers.gemini import GeminiProvider  # noqa: E402
from production.providers.groq import GroqProvider  # noqa: E402
from production.providers.pixabay import PixabayProvider  # noqa: E402
from production.render import ensure_tools  # noqa: E402
from production.synthetic import SyntheticLLM  # noqa: E402
from production.usage import UsageLedger  # noqa: E402


def build_llm(env: Dict[str, str], mode: str, topic: str) -> Any:
    if mode == "synthetic":
        return SyntheticLLM(topic)
    providers = []
    if str(env.get("GROQ_API_KEY", "")).strip():
        providers.append(GroqProvider(env))
    if str(env.get("GEMINI_API_KEY", "")).strip():
        providers.append(GeminiProvider(env))
    if not providers:
        print("[phase3] no AI credential present - using deterministic synthetic content",
              file=sys.stderr)
        return SyntheticLLM(topic)
    return ProviderChain(providers)


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="Phase 3 real media production")
    parser.add_argument("--studio", default="all",
                        choices=["trendscope", "true-crime", "deep-history", "all"])
    parser.add_argument("--topic", default="")
    parser.add_argument("--out", default=os.path.join("artifacts", "phase3"))
    parser.add_argument("--mode", default="auto", choices=["auto", "synthetic", "live"])
    parser.add_argument("--landscape-seconds", type=float, default=480)
    parser.add_argument("--short-seconds", type=float, default=42)
    parser.add_argument("--landscape-fps", type=int, default=24)
    parser.add_argument("--short-fps", type=int, default=30)
    parser.add_argument("--no-tts", action="store_true")
    parser.add_argument("--no-ken-burns", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    ensure_tools()
    env = dict(os.environ)
    outdir = os.path.abspath(args.out)
    os.makedirs(outdir, exist_ok=True)

    ledger = UsageLedger(os.path.join(outdir, "usage.json"))
    llm = build_llm(env, args.mode, args.topic)
    pixabay = PixabayProvider(env, cache_path=os.path.join(outdir, "pixabay-cache.json"),
                              ledger=ledger) if str(env.get("PIXABAY_API_KEY", "")).strip() else None

    ctx: Dict[str, Any] = {
        "llm": llm, "pixabay": pixabay, "ledger": ledger, "outdir": outdir,
        "allow_tts": not args.no_tts,
        "ken_burns": not args.no_ken_burns,
        "landscape_seconds": args.landscape_seconds,
        "short_seconds": args.short_seconds,
        "landscape_fps": args.landscape_fps,
        "short_fps": args.short_fps,
        "production_mode": "test",
        "voice": env.get("TTS_VOICE", "en-US-GuyNeural"),
        "voice_tr": env.get("TTS_VOICE_TR", "tr-TR-AhmetNeural"),
    }

    targets = list(runner.STUDIOS) if args.studio == "all" else [args.studio]
    summary = runner.run_all(ctx, topic=args.topic, studios_to_run=targets, dedupe=False)

    if args.json:
        print(json.dumps(summary, indent=1, default=str))
    else:
        for job in summary["jobs"]:
            print(f"\n[{job['studio']}] {job['status']} job={job['job_id']}")
            if job.get("error"):
                print(f"  error: {job['error']}")
            result = job.get("result") or {}
            for art in result.get("artifacts", []):
                print(f"  {art['type']}: {art['path']}")
                print(f"    {art.get('width')}x{art.get('height')} "
                      f"{art.get('duration')}s {art.get('video_codec')}/"
                      f"{art.get('audio_codec')} {art.get('bytes')} bytes")
            if result.get("blocked_reasons"):
                print("  blocked: " + "; ".join(result["blocked_reasons"]))
        print("\nstatuses:", summary["statuses"])
        print("publishing_enabled:", summary["publishing_enabled"])

    failed = [j for j in summary["jobs"] if j["status"] == "failed"]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
