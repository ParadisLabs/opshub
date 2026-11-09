"""Deterministic synthetic LLM used offline and in CI.

It produces contract-shaped, clearly-labelled synthetic content so the full
pipeline can be exercised without any API key. Nothing here pretends to be a
real model: every payload carries ``"synthetic": true`` and provider metadata
records ``synthetic``.
"""
from __future__ import annotations

from typing import Any, Dict, Optional


class SyntheticLLM:
    name = "synthetic"
    model = "deterministic-fixture"

    def __init__(self, topic: str = "test topic"):
        self.topic = topic
        self.calls = 0

    def verify(self) -> bool:
        return True

    def generate_json(self, prompt: str, *, schema: Optional[Dict[str, Any]] = None,
                      job_id: str = "unassigned", **_: Any) -> Dict[str, Any]:
        self.calls += 1
        stage = str((schema or {}).get("stage", ""))
        if stage == "research":
            if "historical" in prompt.lower() or "chronology" in prompt.lower():
                data = self._history_research()
            else:
                data = self._trend_research()
        elif stage == "dossier":
            data = self._dossier()
        elif stage == "script":
            if "turkish" in prompt.lower() or "investigative" in prompt.lower():
                data = self._tr_script()
            elif "long-form" in prompt.lower() or "chapters" in prompt.lower():
                data = self._history_script()
            else:
                data = self._trend_script()
        else:
            data = {"synthetic": True}
        return {"data": data, "provider": self.name, "model": self.model,
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "attempts": 1, "latency_ms": 1}

    # ---- payloads ------------------------------------------------------
    def _trend_research(self) -> Dict[str, Any]:
        return {
            "synthetic": True,
            "topic": self.topic,
            "sources": [
                {"id": "src-a", "title": "Synthetic primary report", "kind": "primary"},
                {"id": "src-b", "title": "Synthetic independent analysis", "kind": "reporting"},
                {"id": "src-c", "title": "Synthetic vendor documentation", "kind": "primary"},
            ],
            "claims": [
                {"claim": "Synthetic claim one", "sources": ["src-a", "src-b"],
                 "status": "confirmed"},
                {"claim": "Synthetic claim two", "sources": ["src-b", "src-c"],
                 "status": "developing"},
                {"claim": "Synthetic claim three", "sources": ["src-a", "src-c"],
                 "status": "analysis"},
            ],
        }

    def _trend_script(self) -> Dict[str, Any]:
        return {
            "synthetic": True,
            "title": f"Synthetic trend: {self.topic}",
            "hook": "A synthetic hook used only for pipeline testing.",
            "scenes": [
                {"narration": f"Synthetic narration line {i} describing the trend.",
                 "visual": f"Synthetic visual {i}", "caption": f"Synthetic caption {i}",
                 "claim_ids": ["src-a", "src-b"]}
                for i in range(1, 7)
            ],
        }

    def _dossier(self) -> Dict[str, Any]:
        return {
            "synthetic": True,
            "case_title": "Synthetic case dossier",
            "sources": [
                {"id": "case-src-a", "title": "Synthetic court record", "kind": "primary"},
                {"id": "case-src-b", "title": "Synthetic official statement", "kind": "primary"},
            ],
            "allegations": [
                {"claim": "Synthetic allegation one", "status": "allegation",
                 "sources": ["case-src-a"]},
                {"claim": "Synthetic charge one", "status": "charge",
                 "sources": ["case-src-b"]},
            ],
            "victims_protected": True,
            "minors_protected": True,
            "sensational": False,
        }

    def _tr_script(self) -> Dict[str, Any]:
        return {
            "synthetic": True,
            "title": "Sentetik vaka anlatımı",
            "scenes": [
                {"narration": f"Sentetik anlatım satırı {i}.", "visual": f"Sentetik görsel {i}",
                 "caption": f"Sentetik altyazı {i}"}
                for i in range(1, 7)
            ],
        }

    def _history_research(self) -> Dict[str, Any]:
        return {
            "synthetic": True,
            "topic": self.topic,
            "narrator": {"name": "The Cartographer", "persona": "calm archival narrator"},
            "sources": [
                {"id": "hist-a", "title": "Synthetic archive A"},
                {"id": "hist-b", "title": "Synthetic academic survey B"},
            ],
            "timeline": [
                {"order": 1, "year": "1200", "event": "Synthetic event one", "source_id": "hist-a"},
                {"order": 2, "year": "1250", "event": "Synthetic event two", "source_id": "hist-b"},
                {"order": 3, "year": "1300", "event": "Synthetic event three", "source_id": "hist-a"},
                {"order": 4, "year": "1350", "event": "Synthetic event four", "source_id": "hist-b"},
            ],
        }

    def _history_script(self) -> Dict[str, Any]:
        return {
            "synthetic": True,
            "title": f"Synthetic history: {self.topic}",
            "chapters": [
                {"narration": f"Synthetic chapter {i} narration for the long-form documentary.",
                 "caption": f"Synthetic chapter {i}", "source_ids": ["hist-a", "hist-b"]}
                for i in range(1, 7)
            ],
        }
