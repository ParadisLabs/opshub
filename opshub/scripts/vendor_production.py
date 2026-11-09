#!/usr/bin/env python3
"""Copy shared/production into each studio repository.

The shared package is dependency-free stdlib Python, so vendoring keeps the
studios runnable on their own GitHub Actions runners without a submodule.
"""
from __future__ import annotations

import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE = os.path.dirname(ROOT)
SOURCE = os.path.join(ROOT, "shared", "production")
STUDIOS = ("faceless-studio", "faceless-turkce-studio", "deep-history-studio")


def ignore(_dir, names):
    return [n for n in names if n in ("__pycache__",) or n.endswith(".pyc")]


def main() -> int:
    if not os.path.isdir(SOURCE):
        print(f"missing source package: {SOURCE}")
        return 1
    for studio in STUDIOS:
        target_root = os.path.join(WORKSPACE, studio, "shared")
        target = os.path.join(target_root, "production")
        if not os.path.isdir(os.path.join(WORKSPACE, studio)):
            print(f"skip missing repo: {studio}")
            continue
        if os.path.isdir(target):
            shutil.rmtree(target)
        os.makedirs(target_root, exist_ok=True)
        shutil.copytree(SOURCE, target, ignore=ignore)
        with open(os.path.join(target_root, "__init__.py"), "w") as f:
            f.write('"""Vendored shared production package (generated)."""\n')
        count = sum(len(files) for _, _, files in os.walk(target))
        print(f"vendored {count} files -> {studio}/shared/production")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
