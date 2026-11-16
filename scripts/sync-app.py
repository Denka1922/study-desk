#!/usr/bin/env python3
"""Rebuild the planner page and copy it to app/index.html.

Run this only where the planner sources exist (not on GitHub):
    python3 scripts/sync-app.py [--planner DIR]
"""
import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--planner", default=str(ROOT.parent / "planner"),
                    help="folder with build.py and study-desk-local.html")
    args = ap.parse_args()
    planner = Path(args.planner).resolve()
    if not (planner / "build.py").is_file():
        print(f"planner folder not found: {planner}", file=sys.stderr)
        return 1
    subprocess.run([sys.executable, "build.py"], cwd=planner, check=True)
    src = planner / "study-desk-local.html"
    dst = ROOT / "app" / "index.html"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    data = dst.read_bytes()
    print(f"{hashlib.sha256(data).hexdigest()}  {len(data)} bytes  {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
