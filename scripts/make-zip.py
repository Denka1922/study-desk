#!/usr/bin/env python3
"""Pack the project into a ZIP that is safe to share and upload.

    python3 scripts/make-zip.py [--src DIR] [--out PATH]

Leaves out installed packages, build output, the work ledger and anything that looks like
a signing key or a local Android setting.
"""
import argparse
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOP = "study-desk"

SKIP_DIR_NAMES = {"node_modules", ".sdd", "dist", ".gradle", "__pycache__"}
SKIP_DIR_PATHS = {"mobile/android/build", "mobile/android/app/build"}
SKIP_FILE_NAMES = {"local.properties", "keystore.properties"}
SKIP_SUFFIXES = (".jks", ".keystore", ".p12", ".pfx", ".apk", ".aab", ".pyc")


def wanted(rel: Path) -> bool:
    parts = rel.parts
    if any(p in SKIP_DIR_NAMES for p in parts[:-1]):
        return False
    posix = rel.as_posix()
    if any(posix.startswith(d + "/") for d in SKIP_DIR_PATHS):
        return False
    name = parts[-1]
    return name not in SKIP_FILE_NAMES and not name.lower().endswith(SKIP_SUFFIXES)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(ROOT))
    ap.add_argument("--out", default=str(ROOT.parent / "study-desk-project.zip"))
    a = ap.parse_args()
    src, out = Path(a.src).resolve(), Path(a.out).resolve()
    files = sorted(p for p in src.rglob("*") if p.is_file() and wanted(p.relative_to(src)) and p != out)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, f"{TOP}/{p.relative_to(src).as_posix()}")
    print(f"{out}: {len(files)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
