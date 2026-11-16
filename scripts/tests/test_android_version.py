import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "set-android-version.py"


def run(mobile: Path):
    return subprocess.run([sys.executable, "-I", str(SCRIPT), "--mobile", str(mobile)],
                          capture_output=True, text=True)


class AndroidVersion(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.mobile = self.tmp / "mobile"
        (self.mobile / "android" / "app").mkdir(parents=True)
        src = (ROOT / "mobile" / "android" / "app" / "build.gradle").read_text()
        self.gradle = self.mobile / "android" / "app" / "build.gradle"
        self.gradle.write_text(src)
        self.version = self.mobile / "version.json"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_applies_both_values(self):
        self.version.write_text(json.dumps({"versionName": "1.2.3", "versionCode": 7}))
        r = run(self.mobile)
        self.assertEqual(r.returncode, 0, r.stderr)
        g = self.gradle.read_text()
        self.assertIn("versionCode 7\n", g)
        self.assertIn('versionName "1.2.3"\n', g)
        self.assertEqual(g.count("versionCode"), 1)

    def test_rejects_bad_input_and_leaves_gradle_alone(self):
        before = self.gradle.read_text()
        for body in ['{"versionName":"v1","versionCode":0}',
                     '{"versionName":"1.0.0","versionCode":"2"}',
                     '{"versionName":"1.0.0","versionCode":1.5}',
                     '{"versionName":"1.0.0","versionCode":true}',
                     '{"versionName":"1.0.0"}',
                     '{"versionName":"1.0.0","versionCode":2100000001}',
                     '{not json', '[]']:
            self.version.write_text(body)
            r = run(self.mobile)
            self.assertEqual(r.returncode, 1, body)
            self.assertEqual(self.gradle.read_text(), before, body)

    def test_missing_version_file(self):
        r = run(self.mobile)
        self.assertEqual(r.returncode, 1)
        self.assertIn("version.json", r.stderr)


if __name__ == "__main__":
    unittest.main()
