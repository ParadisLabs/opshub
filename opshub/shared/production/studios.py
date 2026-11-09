"""Editorial pipelines for the three studios.

Each pipeline enforces its own editorial contract before rendering:

  trendscope   every claim needs two independent sources; confirmed vs developing
  true-crime   case dossier + legal/editorial gate; allegations must be labelled;
               victims and minors must be protected; blocks before render
  deep-history chronology validation + recurring narrator continuity; produces a
               vertical short and a landscape long-form, not stitched shorts

A blocked result is a real outcome, not an exception: nothing is rendered and the
QA report carries the blocking reasons.
"""
from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Callable, Dict, List, Optional, Sequence

from . import media, qa
from .assets import AssetStore
from .contracts import Job
from .narration import synthesize
from .render import ffmpeg_bin, make_still, probe_duration, render_episode

FORMAT_SHORT = {"width": 1080, "height": 1920, "min_s": 30, "max_s": 60}
FORMAT_LANDSCAPE = {"width": 1920, "height": 1080, "min_s": 480, "max_s": 900}

ALLOWED_CLAIM_STATUS = {"confirmed", "developing", "analysis"}
ALLOWED_CASE_STATUS = {"allegation", "charge", "conviction", "unresolved"}
TRENDSCOPE_STYLE = "clean editorial technology imagery; no fabricated product screenshots"
TRUE_CRIME_STYLE = ("restrained evidence-led documentary: maps, courthouse exteriors and "
                    "public exhibits; never victims, minors or gore")
DEEP_HISTORY_STYLE = ("restrained archival documentary: maps, artefacts, architecture and "
                      "public-domain photographs; muted palette; no gore, no reenactment violence")
MIN_WORDS_PER_SECOND = 2.0  # 120 wpm floor; short scripts must be rejected, not padded


class ModerationBlocked(RuntimeError):
    """Provider safety refusal. Never retry the same rejected prompt."""


def _is_moderation_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return any(token in text for token in ("8007", "moderation", "blocked", "safety", "refused"))


def _deep_generate(llm: Any, prompt: str, *, schema: Dict[str, Any], job_id: str) -> Dict[str, Any]:
    try:
        return llm.generate_json(prompt, schema=schema, job_id=job_id)["data"]
    except Exception as exc:  # noqa: BLE001 - classify, never retry a refused prompt
        if _is_moderation_error(exc):
            return {"_moderation_blocked": True,
                    "reason": "provider moderation refusal (8007/safety); prompt was not retried"}
        raise


def _word_count(chapters: Sequence[Dict[str, Any]]) -> int:
    return sum(len(str(ch.get("narration") or ch.get("text") or "").split())
               for ch in chapters)


def _educational_fallback(job: Job, ctx: Dict[str, Any], report: Report) -> Dict[str, Any]:
    """Safe, non-publishable fallback after a provider moderation refusal.

    It makes no historical claims, shows no archival-looking reenactment, and
    carries a visible marker. Approval is blocked by design.
    """
    outdir = os.path.join(ctx["outdir"], "deep-history-fallback")
    dims = _dims(ctx, "short")
    topic = (job.topic or "the requested topic")[:160]
    lines = [
        "This is an educational fallback. A provider safety filter blocked the requested historical material, so no claims or reconstructed scenes are presented.",
        f"The requested topic was: {topic}. Consult primary sources and archives before drawing any conclusion.",
        "No historical footage is shown. Every visual in this clip is a labelled educational card, not evidence.",
    ]
    report("qa", 95, "moderation fallback")
    scenes = _make_scenes(
        {"scenes": [{"narration": line, "caption": line, "visual": "educational card"}
                    for line in lines]},
        os.path.join(outdir, "images"), os.path.join(outdir, "audio"),
        width=dims["width"], height=dims["height"], total_seconds=dims["seconds"],
        voice=str(ctx.get("voice") or "en-US-GuyNeural"),
        allow_tts=ctx.get("allow_tts", True), asset_sources=[],
        job_id=job.job_id, visual_style="flat educational card")
    video = render_episode(
        scenes, os.path.join(outdir, "educational_fallback.mp4"),
        width=dims["width"], height=dims["height"], fps=dims["fps"],
        watermark="EDUCATIONAL FALLBACK — NO HISTORICAL CLAIMS",
        ken_burns=False, preset="veryfast")
    scores = {"research": 0, "script": 20, "visuals": 10, "narration": 40,
              "audio": 60, "subtitles": 60, "rendering": 60, "compliance": 100}
    return _finish(
        job, "deep-history", outdir, video, scenes, scores,
        blocking=["moderation refusal: fallback contains no verified historical claims"],
        extra_qa={"studio": "deep-history", "language": "en", "topic": job.topic,
                  "synthetic": True, "publishable": False, "moderation_fallback": True,
                  "moderation_reason": "provider safety refusal (8007); prompt not retried",
                  "research": {"sources": [], "narrator": None},
                  "production_mode": job.production_mode})

Report = Callable[[str, int, str], None]


def _noop(stage: str, progress: int, detail: str = "") -> None:
    return None


def _coverage(scenes: Sequence[Dict[str, Any]]) -> float:
    """Fraction of the timeline actually covered by spoken narration."""
    total = sum(float(s.get("seconds") or 0) for s in scenes)
    spoken = sum(float(s.get("narration_seconds") or 0) for s in scenes)
    return round(spoken / total, 3) if total else 0.0


def _synthetic_image(path: str, width: int, height: int, label: str, index: int) -> str:
    return make_still(path, width, height, label=label, index=index)


def _sources_ok(sources: Sequence[Dict[str, Any]],
                claims: Sequence[Dict[str, Any]]) -> List[str]:
    errors: List[str] = []
    ids = {str(s.get("id")) for s in sources if s.get("id")}
    if len(ids) < 2:
        errors.append("fewer than two independent sources")
    for i, claim in enumerate(claims, start=1):
        refs = [str(r) for r in (claim.get("sources") or [])]
        if len(set(refs)) < 2:
            errors.append(f"claim {i} has fewer than two sources")
        missing = [r for r in refs if r not in ids]
        if missing:
            errors.append(f"claim {i} cites unknown sources {missing}")
        status = str(claim.get("status", "confirmed")).lower()
        if status not in ALLOWED_CLAIM_STATUS:
            errors.append(f"claim {i} has unknown status {status!r}")
    return errors


def _dims(ctx: Dict[str, Any], which: str) -> Dict[str, int]:
    base = FORMAT_SHORT if which == "short" else FORMAT_LANDSCAPE
    return {
        "width": int(ctx.get(f"{which}_width") or base["width"]),
        "height": int(ctx.get(f"{which}_height") or base["height"]),
        "fps": int(ctx.get(f"{which}_fps") or (30 if which == "short" else 24)),
        "seconds": float(ctx.get(f"{which}_seconds") or (42 if which == "short" else 480)),
    }


def _pad_with_bed(path: str, seconds: float) -> None:
    """Fill a short narration track with a quiet bed instead of dead silence."""
    tmp = path + ".bed.wav"
    cmd = [
        ffmpeg_bin(), "-y", "-loglevel", "error", "-i", path,
        "-f", "lavfi", "-t", f"{seconds:.3f}", "-i",
        "sine=frequency=110:sample_rate=48000",
        "-filter_complex",
        "[0:a]apad[a0];[1:a]volume=0.12[a1];"
        "[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]",
        "-map", "[a]", "-t", f"{seconds:.3f}",
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", tmp,
    ]
    subprocess.run(cmd, capture_output=True, text=True, check=True)
    os.replace(tmp, path)


def _make_scenes(script: Dict[str, Any], image_dir: str, audio_dir: str, *,
                 width: int, height: int, total_seconds: float,
                 voice: str, allow_tts: bool,
                 pixabay: Any = None, asset_sources: Optional[Sequence[Any]] = None,
                 job_id: str = "", visual_style: str = "") -> List[Dict[str, Any]]:
    raw = script.get("scenes") or script.get("chapters") or []
    if not raw:
        raise ValueError("script has no scenes")
    per = max(2.0, total_seconds / len(raw))
    scenes: List[Dict[str, Any]] = []
    for i, item in enumerate(raw, start=1):
        narration = str(item.get("narration") or item.get("text") or "").strip()
        caption = str(item.get("caption") or narration)[:180]
        visual = str(item.get("visual") or caption)
        query = (visual + (" " + visual_style if visual_style else "")).strip()
        image = None
        image_source, image_license, image_sha, image_error = "synthetic", "", "", ""
        image_author, image_page, image_retrieved = "", "", 0
        sources: List[Any] = []
        for source in [pixabay, *(asset_sources or [])]:
            if source is None or source in sources:
                continue
            if getattr(source, "configured", lambda: False)():
                sources.append(source)
        for source in sources:
            try:
                asset = source.resolve(query, image_dir, kind="photo", job_id=job_id)
                image = str(asset["path"])
                image_source = str(asset.get("source") or getattr(source, "name", "")
                                     or ("pixabay" if source is pixabay else "stock"))
                image_license = str(asset.get("license") or "")
                image_sha = str(asset.get("sha256") or "")
                image_author = str(asset.get("author") or "")
                image_page = str(asset.get("page_url") or "")
                image_retrieved = int(asset.get("retrieved_at") or 0)
                break
            except Exception as exc:  # noqa: BLE001 - stock is optional, fallback is labelled
                image_error = type(exc).__name__
        if not image:
            image = _synthetic_image(os.path.join(image_dir, f"scene_{i:02d}.png"),
                                     width, height, visual, i)
        audio = os.path.join(audio_dir, f"scene_{i:02d}.wav")
        spoken = synthesize(narration, audio, voice=voice, allow_network=allow_tts)
        target = round(max(per, float(spoken["seconds"]) + 0.35), 3)
        actual = probe_duration(audio)
        if actual < target - 0.2:
            _pad_with_bed(audio, target)
            actual = probe_duration(audio)
        scenes.append({
            "index": i, "narration": narration, "caption": caption,
            "visual": str(item.get("visual") or ""), "image": image,
            "image_source": image_source, "image_license": image_license,
            "image_sha256": image_sha, "image_author": image_author,
            "image_page_url": image_page, "image_retrieved_at": image_retrieved,
            "image_style": visual_style, "historical_evidence": False,
            "image_error": image_error,
            "audio": audio, "seconds": round(max(target, actual), 3),
            "narration_seconds": float(spoken["seconds"]),
            "narration_mode": spoken["mode"],
        })
    return scenes


def _finish(job: Job, studio: str, outdir: str, video_report: Dict[str, Any],
            scenes: Sequence[Dict[str, Any]], scores: Dict[str, Any], *,
            extra_qa: Optional[Dict[str, Any]] = None,
            blocking: Optional[Sequence[str]] = None,
            extra_artifacts: Optional[Sequence[Dict[str, Any]]] = None,
            extra_videos: Optional[Sequence[Dict[str, Any]]] = None) -> Dict[str, Any]:
    store = AssetStore(os.path.join(outdir, "manifests"), studio)
    for scene in scenes:
        if os.path.exists(scene["image"]):
            store.add_file("image", scene["image"], {
                "scene": scene["index"],
                "source": scene.get("image_source", "synthetic"),
                "license": scene.get("image_license", ""),
                "author": scene.get("image_author", ""),
                "page_url": scene.get("image_page_url", ""),
                "retrieved_at": scene.get("image_retrieved_at", 0),
                "historical_evidence": False,
                "style": scene.get("image_style", ""),
                "sha256": scene.get("image_sha256", ""),
            })
        if os.path.exists(scene["audio"]):
            store.add_file("audio", scene["audio"],
                           {"scene": scene["index"],
                            "narration_mode": scene["narration_mode"]})
    video = video_report["path"]
    store.add_file("video", video, {"width": video_report["width"],
                                    "height": video_report["height"],
                                    "duration": video_report["duration"]})
    if video_report.get("srt_path") and os.path.exists(video_report["srt_path"]):
        store.add_file("subtitles", video_report["srt_path"], {})
    if video_report.get("thumbnail") and os.path.exists(video_report["thumbnail"]):
        store.add_file("thumbnail", video_report["thumbnail"], {})
    for extra in extra_videos or []:
        if not extra.get("path") or not os.path.exists(extra["path"]):
            continue
        store.add_file("video", extra["path"], {
            "width": extra.get("width"), "height": extra.get("height"),
            "duration": extra.get("duration"),
            "format": "landscape" if int(extra.get("width") or 0) > int(extra.get("height") or 0) else "vertical",
        })
        if extra.get("srt_path") and os.path.exists(extra["srt_path"]):
            store.add_file("subtitles", extra["srt_path"], {"format": "landscape"})
        if extra.get("thumbnail") and os.path.exists(extra["thumbnail"]):
            store.add_file("thumbnail", extra["thumbnail"], {"format": "landscape"})

    # Every studio gets the same non-optional media QA, not a hardcoded score.
    video_qa = media.validate_video(
        video, expected_width=video_report.get("width"), expected_height=video_report.get("height"),
        min_seconds=max(1.0, float(video_report.get("duration") or 0) * 0.9),
        max_seconds=max(60.0, float(video_report.get("duration") or 0) * 1.2))
    blockers = list(blocking or [])
    if video_qa["status"] != "passed":
        blockers.append("media QA failed: " + "; ".join(video_qa["errors"][:3]))
    report = qa.evaluate(scores, blocking_failures=blockers, job_id=job.job_id)
    report["media_validation"] = video_qa
    report.update(extra_qa or {})
    report["artifacts"] = [{
        "type": "video", "path": video, "bytes": video_report["size_bytes"],
        "sha256": video_report["sha256"], "duration": video_report["duration"],
        "width": video_report["width"], "height": video_report["height"],
        "video_codec": video_report["video_codec"],
        "audio_codec": video_report["audio_codec"],
        "subtitles": video_report.get("srt_path"),
        "thumbnail": video_report.get("thumbnail"),
    }] + list(extra_artifacts or [])
    report["manifest"] = {"path": store.manifest_path,
                          "assets": len(store.all()),
                          "problems": store.verify()}
    report["publishing_enabled"] = False
    return report


# ---------------------------------------------------------------- trendscope
def trendscope(job: Job, ctx: Dict[str, Any], report: Report = _noop) -> Dict[str, Any]:
    llm = ctx["llm"]
    outdir = os.path.join(ctx["outdir"], "trendscope")
    report("research", 5, "researching trend")
    research = llm.generate_json(
        "STAGE:research\nResearch this technology/trend topic with at least two "
        "independent sources. Distinguish confirmed facts, developing stories and "
        "analysis. Never invent quotes or statistics.\nTOPIC: " + (job.topic or "AI agents"),
        schema={"stage": "research", "required": ["sources", "claims"],
                "types": {"sources": "list", "claims": "list"},
                "min_items": {"sources": 2, "claims": 2}},
        job_id=job.job_id)["data"]
    errors = _sources_ok(research.get("sources", []), research.get("claims", []))
    if errors:
        raise RuntimeError("trendscope research gate: " + "; ".join(errors))

    report("writing", 30, "writing script")
    script = llm.generate_json(
        "STAGE:script\nWrite a 35-55 second vertical script. JSON only.\n"
        "RESEARCH:\n" + json.dumps(research)[:6000],
        schema={"stage": "script", "required": ["title", "scenes"],
                "types": {"title": "str", "scenes": "list"},
                "min_items": {"scenes": 4}},
        job_id=job.job_id)["data"]
    for item in script.get("scenes", []):
        item.setdefault("caption", item.get("narration", ""))

    dims = _dims(ctx, "short")
    report("assets", 55, "building visuals and narration")
    scenes = _make_scenes(script, os.path.join(outdir, "images"),
                          os.path.join(outdir, "audio"), width=dims["width"],
                          height=dims["height"], total_seconds=dims["seconds"],
                          voice=ctx.get("voice", "en-US-GuyNeural"),
                          allow_tts=ctx.get("allow_tts", True),
                          pixabay=ctx.get("pixabay"),
                          asset_sources=ctx.get("asset_sources"),
                          job_id=job.job_id, visual_style=TRENDSCOPE_STYLE)
    coverage = _coverage(scenes)
    synthetic = bool(research.get("synthetic") or script.get("synthetic"))
    if not synthetic and coverage < 0.5:
        raise RuntimeError(f"narration covers only {coverage:.0%} of the timeline; refusing a padded production")

    report("rendering", 75, "rendering vertical MP4")
    video = render_episode(scenes, os.path.join(outdir, "trendscope_vertical.mp4"),
                           width=dims["width"], height=dims["height"], fps=dims["fps"],
                           watermark="SYNTHETIC TEST" if synthetic else "",
                           ken_burns=ctx.get("ken_burns", True), preset="veryfast")

    narration_mode = scenes[0]["narration_mode"] if scenes else "unavailable"
    scores = {
        "research": 90 if len({str(s.get("id")) for s in research.get("sources", [])}) >= 2 else 40,
        "script": 86,
        "visuals": 78 if narration_mode == "edge-tts" else 74,
        "narration": 80 if narration_mode == "edge-tts" else 55,
        "audio": 90, "subtitles": 90 if video.get("srt_path") else 40,
        "rendering": 95 if video["status"] == "passed" else 30, "compliance": 100,
    }
    report("qa", 95, "scoring QA")
    return _finish(job, "trendscope", outdir, video, scenes, scores, extra_qa={
        "studio": "trendscope", "language": "en", "topic": job.topic,
        "research": {"sources": research.get("sources", []),
                     "claims": research.get("claims", [])},
        "narration_mode": narration_mode,
        "synthetic": synthetic,
        "narration_coverage": coverage,
        "padded_seconds": round(sum(s["seconds"] for s in scenes) - sum(s["narration_seconds"] for s in scenes), 1),
        "production_mode": job.production_mode,
    })


# ---------------------------------------------------------------- true crime
def true_crime(job: Job, ctx: Dict[str, Any], report: Report = _noop) -> Dict[str, Any]:
    llm = ctx["llm"]
    outdir = os.path.join(ctx["outdir"], "true-crime")
    report("research", 5, "building case dossier")
    dossier = llm.generate_json(
        "STAGE:dossier\nBuild a Turkish true-crime case dossier from official and "
        "primary sources. Every allegation must be labelled allegation, charge, "
        "conviction or unresolved. Protect victims, minors and private individuals. "
        "No sensationalism and no invented facts.\nCASE: " + (job.topic or "cold case"),
        schema={"stage": "dossier",
                "required": ["case_title", "sources", "allegations"],
                "types": {"case_title": "str", "sources": "list", "allegations": "list"},
                "min_items": {"sources": 2, "allegations": 1}},
        job_id=job.job_id)["data"]

    blockers: List[str] = []
    if len({str(s.get("id")) for s in dossier.get("sources", [])}) < 2:
        blockers.append("fewer than two independent sources")
    for i, item in enumerate(dossier.get("allegations", []), start=1):
        status = str(item.get("status", "")).lower()
        if status not in ALLOWED_CASE_STATUS:
            blockers.append(f"allegation {i} has unlabelled legal status")
        if not item.get("sources"):
            blockers.append(f"allegation {i} has no source")
    if not dossier.get("victims_protected", False):
        blockers.append("victim protection not confirmed")
    if not dossier.get("minors_protected", False):
        blockers.append("minor protection not confirmed")
    if dossier.get("sensational", False):
        blockers.append("sensational framing rejected")

    if blockers:
        report("qa", 100, "blocked by legal/editorial gate")
        result = qa.evaluate({"research": 30, "script": 0, "visuals": 0, "narration": 0,
                              "audio": 0, "subtitles": 0, "rendering": 0,
                              "compliance": 0},
                             blocking_failures=blockers, job_id=job.job_id)
        result.update({"studio": "true-crime", "language": "tr",
                       "publishing_enabled": False, "artifacts": [],
                       "blocked_reasons": blockers, "topic": job.topic})
        return result

    report("writing", 30, "writing Turkish script")
    script = llm.generate_json(
        "STAGE:script\nTurkish investigative narration, 40-55 seconds, neutral tone, "
        "no sensationalism. JSON only.\nDOSSIER:\n" + json.dumps(dossier)[:6000],
        schema={"stage": "script", "required": ["title", "scenes"],
                "types": {"title": "str", "scenes": "list"},
                "min_items": {"scenes": 4}},
        job_id=job.job_id)["data"]
    for item in script.get("scenes", []):
        item.setdefault("caption", item.get("narration", ""))

    dims = _dims(ctx, "short")
    report("assets", 55, "building evidence visuals")
    scenes = _make_scenes(script, os.path.join(outdir, "images"),
                          os.path.join(outdir, "audio"), width=dims["width"],
                          height=dims["height"], total_seconds=dims["seconds"],
                          voice=ctx.get("voice_tr", "tr-TR-AhmetNeural"),
                          allow_tts=ctx.get("allow_tts", True),
                          pixabay=ctx.get("pixabay"),
                          asset_sources=ctx.get("asset_sources"),
                          job_id=job.job_id, visual_style=TRUE_CRIME_STYLE)
    coverage = _coverage(scenes)
    synthetic = bool(dossier.get("synthetic") or script.get("synthetic"))
    if not synthetic and coverage < 0.5:
        raise RuntimeError(f"narration covers only {coverage:.0%} of the timeline; refusing a padded production")

    report("rendering", 75, "rendering vertical MP4")
    video = render_episode(scenes, os.path.join(outdir, "true_crime_vertical.mp4"),
                           width=dims["width"], height=dims["height"], fps=dims["fps"],
                           watermark="SYNTHETIC TEST" if synthetic else "",
                           ken_burns=ctx.get("ken_burns", True), preset="veryfast")

    narration_mode = scenes[0]["narration_mode"] if scenes else "unavailable"
    scores = {"research": 92, "script": 86,
              "visuals": 78 if narration_mode == "edge-tts" else 74,
              "narration": 80 if narration_mode == "edge-tts" else 55,
              "audio": 90, "subtitles": 90 if video.get("srt_path") else 40,
              "rendering": 95 if video["status"] == "passed" else 30, "compliance": 100}
    report("qa", 95, "legal/editorial QA")
    return _finish(job, "true-crime", outdir, video, scenes, scores, extra_qa={
        "studio": "true-crime", "language": "tr", "topic": job.topic,
        "case_dossier": dossier, "narration_mode": narration_mode,
        "synthetic": synthetic, "narration_coverage": coverage,
        "padded_seconds": round(sum(s["seconds"] for s in scenes) - sum(s["narration_seconds"] for s in scenes), 1),
        "production_mode": job.production_mode,
    })


# ---------------------------------------------------------------- deep history
def deep_history(job: Job, ctx: Dict[str, Any], report: Report = _noop) -> Dict[str, Any]:
    llm = ctx["llm"]
    outdir = os.path.join(ctx["outdir"], "deep-history")
    language = str(job.language or "en").strip().lower()
    if language not in ("en", "en-us", "english"):
        raise RuntimeError(f"deep-history language gate: expected English, got {job.language!r}")
    voice = str(ctx.get("voice") or "en-US-GuyNeural")
    if not voice.lower().startswith("en-"):
        raise RuntimeError(f"deep-history voice gate: expected an English voice, got {voice!r}")
    short = _dims(ctx, "short")
    long = _dims(ctx, "landscape")
    required_words = max(120, int(round(long["seconds"] * MIN_WORDS_PER_SECOND)))
    report("research", 5, "validating chronology")
    research = _deep_generate(
        llm,
        "STAGE:research\nEvidence-based historical research. Return a timeline with "
        "explicit ordering, sources and a fixed narrator persona for continuity.\n"
        "LANGUAGE: English only. Every claim must be traceable to a named source.\n"
        "VISUAL STYLE: " + DEEP_HISTORY_STYLE + "\n"
        "TOPIC: " + (job.topic or "the Silk Road"),
        schema={"stage": "research",
                "required": ["topic", "timeline", "sources", "narrator"],
                "types": {"topic": "str", "timeline": "list", "sources": "list",
                          "narrator": "dict"},
                "min_items": {"timeline": 4, "sources": 2}},
        job_id=job.job_id)
    if research.get("_moderation_blocked"):
        return _educational_fallback(job, ctx, report)

    order = [int(item.get("order", i))
             for i, item in enumerate(research.get("timeline", []), start=1)]
    if order != sorted(order):
        raise RuntimeError("deep-history chronology gate: timeline is out of order")
    if len({str(s.get("id")) for s in research.get("sources", [])}) < 2:
        raise RuntimeError("deep-history research gate: fewer than two sources")
    narrator = research.get("narrator") or {}
    if not narrator.get("name"):
        raise RuntimeError("deep-history continuity gate: narrator persona missing")

    report("writing", 25, "writing long-form narrative")
    narrator = research.get("narrator") or {}
    script_prompt = (
        "STAGE:script\nWrite one coherent long-form documentary narrative with "
        "chapters, not separate shorts. Keep the same narrator. English only. "
        f"At least {required_words} spoken words for the {int(long['seconds'])}-second "
        "landscape cut; do not pad with silence. JSON only.\n"
        "VISUAL STYLE: " + DEEP_HISTORY_STYLE + "\n"
        "NARRATOR: " + str(narrator.get("name") or "the recurring explorer") + "\n"
        "RESEARCH:\n" + json.dumps(research)[:6000]
    )
    script = _deep_generate(
        llm, script_prompt,
        schema={"stage": "script", "required": ["title", "chapters"],
                "types": {"title": "str", "chapters": "list"},
                "min_items": {"chapters": 5}},
        job_id=job.job_id)
    if script.get("_moderation_blocked"):
        return _educational_fallback(job, ctx, report)
    for chapter in script.get("chapters", []):
        chapter.setdefault("caption", chapter.get("narration", ""))
        if not chapter.get("visual"):
            chapter["visual"] = (f"archival documentary scene with {narrator.get('name') or 'the explorer'}, "
                                 f"{DEEP_HISTORY_STYLE}")

    synthetic = bool(research.get("synthetic") or script.get("synthetic"))
    allow_tts = ctx.get("allow_tts", True)
    script_words = _word_count(script.get("chapters", []))
    if not synthetic and script_words < required_words:
        raise RuntimeError(
            f"deep-history length gate: {script_words} spoken words for {int(long['seconds'])}s; "
            f"need at least {required_words}. Short scripts are rejected, not padded.")

    report("assets", 40, "building vertical short")
    short_scenes = _make_scenes(
        {"scenes": script["chapters"][:3]}, os.path.join(outdir, "images_short"),
        os.path.join(outdir, "audio_short"), width=short["width"],
        height=short["height"], total_seconds=short["seconds"], voice=voice,
        allow_tts=allow_tts, pixabay=ctx.get("pixabay"),
        asset_sources=ctx.get("asset_sources"), job_id=job.job_id,
        visual_style=DEEP_HISTORY_STYLE)
    report("rendering", 55, "rendering vertical short")
    short_coverage = _coverage(short_scenes)
    if not synthetic and short_coverage < 0.5:
        raise RuntimeError(f"narration covers only {short_coverage:.0%} of the short; refusing a padded production")
    short_video = render_episode(
        short_scenes, os.path.join(outdir, "deep_history_vertical.mp4"),
        width=short["width"], height=short["height"], fps=short["fps"],
        watermark="SYNTHETIC TEST" if synthetic else "",
        ken_burns=ctx.get("ken_burns", True), preset="veryfast")

    report("assets", 70, "building landscape long-form")
    long_scenes = _make_scenes(
        {"scenes": script["chapters"]}, os.path.join(outdir, "images_long"),
        os.path.join(outdir, "audio_long"), width=long["width"],
        height=long["height"], total_seconds=long["seconds"], voice=voice,
        allow_tts=allow_tts, pixabay=ctx.get("pixabay"),
        asset_sources=ctx.get("asset_sources"), job_id=job.job_id,
        visual_style=DEEP_HISTORY_STYLE)
    report("rendering", 85, "rendering landscape documentary")
    long_coverage = _coverage(long_scenes)
    if not synthetic and long_coverage < 0.5:
        raise RuntimeError(f"narration covers only {long_coverage:.0%} of the long-form; refusing a padded production")
    long_video = render_episode(
        long_scenes, os.path.join(outdir, "deep_history_landscape.mp4"),
        width=long["width"], height=long["height"], fps=long["fps"],
        watermark="SYNTHETIC TEST" if synthetic else "",
        ken_burns=False, preset="ultrafast")

    narration_mode = short_scenes[0]["narration_mode"] if short_scenes else "unavailable"
    short_media = media.validate_video(
        short_video["path"], expected_width=short["width"], expected_height=short["height"],
        min_seconds=short["seconds"] * 0.9,
        max_seconds=max(short["seconds"] * 1.15, 30))
    long_media = media.validate_video(
        long_video["path"], expected_width=long["width"], expected_height=long["height"],
        min_seconds=long["seconds"] * 0.9,
        max_seconds=max(long["seconds"] * 1.15, 60))
    blocking: List[str] = []
    if short_media["status"] != "passed":
        blocking.append("short media QA failed: " + "; ".join(short_media["errors"][:3]))
    if long_media["status"] != "passed":
        blocking.append("long-form media QA failed: " + "; ".join(long_media["errors"][:3]))
    scores = {"research": 92, "script": 88, "visuals": 78,
              "narration": 80 if narration_mode == "edge-tts" else 55,
              "audio": 90, "subtitles": 90, "rendering": 95, "compliance": 100}
    report("qa", 95, "scoring QA")
    return _finish(job, "deep-history", outdir, short_video, short_scenes, scores,
                   blocking=blocking,
                   extra_qa={
                       "studio": "deep-history", "language": "en", "topic": job.topic,
                       "research": {"sources": research.get("sources", []),
                                    "narrator": narrator},
                       "narration_mode": narration_mode,
                       "synthetic": synthetic,
                       "publishable": bool(not synthetic and not blocking),
                       "script_words": script_words, "required_words": required_words,
                       "words_per_second": MIN_WORDS_PER_SECOND,
                       "visual_style": DEEP_HISTORY_STYLE,
                       "narrator_name": narrator.get("name"),
                       "negative_prompt": "no gore, no reenactment violence, no fake historical footage",
                       "media_qa": {"short": short_media, "long": long_media},
                       "narration_coverage": short_coverage,
                       "long_form_narration_coverage": long_coverage,
                       "production_mode": job.production_mode,
                   },
                   extra_artifacts=[{
                       "type": "video_landscape", "path": long_video["path"],
                       "bytes": long_video["size_bytes"],
                       "sha256": long_video["sha256"],
                       "duration": long_video["duration"],
                       "width": long_video["width"], "height": long_video["height"],
                       "video_codec": long_video["video_codec"],
                       "audio_codec": long_video["audio_codec"],
                       "subtitles": long_video.get("srt_path"),
                   }],
                   extra_videos=[long_video])
