"""Asset manifest: ids, checksums, metadata, retention planning.

The store writes a JSON manifest next to the assets and refuses to silently
overwrite different bytes for an existing asset id. GitHub Actions workspaces
are explicitly flagged as non-durable.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from typing import Any, Dict, List, Optional


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class AssetConflict(RuntimeError):
    pass


class AssetStore:
    def __init__(self, root: str, studio: str):
        self.root = os.path.join(root, studio)
        self.manifest_path = os.path.join(self.root, "manifest.json")
        os.makedirs(self.root, exist_ok=True)
        self._manifest: Dict[str, Any] = self._load()

    # ---- persistence ---------------------------------------------------
    def _load(self) -> Dict[str, Any]:
        if os.path.exists(self.manifest_path):
            with open(self.manifest_path) as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("assets"), dict):
                return data
        return {"schema_version": "1.0", "studio": os.path.basename(self.root),
                "assets": {}}

    def save(self) -> None:
        tmp = self.manifest_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self._manifest, f, indent=1, sort_keys=True)
        os.replace(tmp, self.manifest_path)

    # ---- writes --------------------------------------------------------
    def add_bytes(self, kind: str, name: str, data: bytes,
                  meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        digest = sha256_bytes(data)
        asset_id = f"{kind}-{digest[:12]}"
        existing = self._manifest["assets"].get(asset_id)
        if existing:
            if existing.get("sha256") != digest:
                raise AssetConflict(f"asset id collision for {asset_id}")
            return existing
        rel = os.path.join("files", kind, name)
        dest = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data)
        rec = {
            "id": asset_id,
            "kind": kind,
            "path": rel,
            "sha256": digest,
            "bytes": len(data),
            "created_at": int(time.time()),
            "durable": True,
            "meta": dict(meta or {}),
        }
        self._manifest["assets"][asset_id] = rec
        self.save()
        return rec

    def add_file(self, kind: str, src: str, meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        with open(src, "rb") as f:
            data = f.read()
        return self.add_bytes(kind, os.path.basename(src), data, meta)

    # ---- reads ---------------------------------------------------------
    def get(self, asset_id: str) -> Optional[Dict[str, Any]]:
        return self._manifest["assets"].get(asset_id)

    def all(self) -> List[Dict[str, Any]]:
        return sorted(self._manifest["assets"].values(), key=lambda r: r["created_at"])

    def total_bytes(self) -> int:
        return sum(int(r.get("bytes", 0)) for r in self._manifest["assets"].values())

    def verify(self) -> List[str]:
        """Return problems; empty list means the manifest matches the bytes."""
        problems: List[str] = []
        for rec in self._manifest["assets"].values():
            path = os.path.join(self.root, rec["path"])
            if not os.path.exists(path):
                problems.append(f"missing file: {rec['path']}")
            elif sha256_file(path) != rec["sha256"]:
                problems.append(f"checksum mismatch: {rec['path']}")
        return problems

    # ---- retention -----------------------------------------------------
    def retention_candidates(self, max_age_days: int = 90,
                             keep_kinds: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        cutoff = int(time.time()) - max_age_days * 86400
        keep = set(keep_kinds or [])
        return [r for r in self._manifest["assets"].values()
                if r["created_at"] < cutoff and r["kind"] not in keep]

    def delete(self, asset_id: str) -> bool:
        rec = self._manifest["assets"].pop(asset_id, None)
        if not rec:
            return False
        path = os.path.join(self.root, rec["path"])
        if os.path.exists(path):
            os.remove(path)
        self.save()
        return True


def workspace_durability_warning(env: Dict[str, str]) -> Optional[str]:
    """True when running inside an ephemeral CI workspace."""
    if env.get("GITHUB_ACTIONS") == "true" or env.get("CI") == "true":
        return ("running in an ephemeral CI workspace: artifacts must be copied to "
                "durable storage before the job ends")
    return None
