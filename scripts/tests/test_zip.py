import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "make-zip.py"

KEEP = ["app/index.html", "desktop/package.json", "mobile/android/app/build.gradle", "site/index.html",
        ".github/workflows/build.yml", ".gitignore", "README.md"]
DROP = ["node_modules/x/y.js", "desktop/node_modules/z.js", "a.jks", "mobile/my.keystore", "mobile/android/local.properties",
        ".sdd/progress.md", "mobile/android/app/build/out.txt", "mobile/android/build/o.txt", "mobile/android/.gradle/c.bin",
        "desktop/dist/Study-Desk-Setup-1.0.0.exe", "release.apk", "release.aab", "keystore.properties", "scripts/__pycache__/x.pyc"]


class Zip(unittest.TestCase):
    def test_zip_has_the_project_and_none_of_the_private_or_generated_files(self):
        with tempfile.TemporaryDirectory() as t:
            src = Path(t) / "src"
            for rel in KEEP + DROP:
                p = src / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("x")
            out = Path(t) / "out.zip"
            r = subprocess.run([sys.executable, "-I", str(SCRIPT), "--src", str(src), "--out", str(out)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            names = set(zipfile.ZipFile(out).namelist())
            for rel in KEEP:
                self.assertIn("study-desk/" + rel, names)
            for rel in DROP:
                self.assertNotIn("study-desk/" + rel, names)
            self.assertTrue(all(n.startswith("study-desk/") for n in names))


if __name__ == "__main__":
    unittest.main()
