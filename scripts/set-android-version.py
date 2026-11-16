#!/usr/bin/env python3
"""Write mobile/version.json into the Android project (versionCode and versionName).

    python3 scripts/set-android-version.py [--mobile DIR]

Raise versionCode for every upload to Google Play. Nothing is written if the file is invalid.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_CODE = 2100000000  # Google Play's upper limit


def fail(msg: str) -> int:
    print(msg, file=sys.stderr)
    return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mobile", default=str(ROOT / "mobile"))
    mobile = Path(ap.parse_args().mobile)
    vfile = mobile / "version.json"
    gradle = mobile / "android" / "app" / "build.gradle"
    if not vfile.is_file():
        return fail(f"missing {vfile}")
    if not gradle.is_file():
        return fail(f"missing {gradle}; run 'npx cap add android' in mobile/")
    try:
        v = json.loads(vfile.read_text(encoding="utf-8"))
    except ValueError as e:
        return fail(f"version.json is not valid JSON: {e}")
    if not isinstance(v, dict):
        return fail("version.json must be an object with versionName and versionCode")
    name, code = v.get("versionName"), v.get("versionCode")
    if not isinstance(name, str) or not re.fullmatch(r"\d+\.\d+\.\d+", name):
        return fail('versionName must look like "1.2.3"')
    if type(code) is not int or not 1 <= code <= MAX_CODE:
        return fail(f"versionCode must be a whole number from 1 to {MAX_CODE}")
    text = gradle.read_text(encoding="utf-8")
    code_re = re.compile(r"^(\s*)versionCode\s+\d+\s*$", re.M)
    name_re = re.compile(r'^(\s*)versionName\s+"[^"]*"\s*$', re.M)
    if len(code_re.findall(text)) != 1 or len(name_re.findall(text)) != 1:
        return fail("could not find exactly one versionCode and one versionName line in build.gradle")
    text = code_re.sub(lambda m: f"{m.group(1)}versionCode {code}", text)
    text = name_re.sub(lambda m: f'{m.group(1)}versionName "{name}"', text)
    gradle.write_text(text, encoding="utf-8")
    print(f"android version set to {name} ({code})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
