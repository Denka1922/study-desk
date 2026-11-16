import re
import unittest
from pathlib import Path

try:
    import yaml
except ImportError:  # the GitHub verify job has no PyYAML; these checks then only run on a developer machine
    yaml = None

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / ".github" / "workflows" / "build.yml"
TEXT = PATH.read_text(encoding="utf-8") if PATH.exists() else ""

PINS = {
    "actions/checkout": ("3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"),
    "actions/setup-node": ("949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"),
    "actions/upload-artifact": ("cf430e030ddbb5b0abf93d22962f4752f3646cd9", "v7.0.2"),
    "actions/download-artifact": ("9000827ccba6bdab643e8b6fd33ac0654aef8333", "v8.0.2"),
    "actions/configure-pages": ("45bfe0192ca1faeb007ade9deae92b16b8254a0d", "v6.0.0"),
    "actions/upload-pages-artifact": ("fc324d3547104276b827a68afc52ff2a11cc49c9", "v5.0.0"),
    "actions/deploy-pages": ("368f82528645a54fb793d4d04e342629a3f51346", "v5.0.1"),
}


@unittest.skipIf(yaml is None, "PyYAML not installed")
class Workflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.wf = yaml.safe_load(TEXT)
        cls.jobs = cls.wf["jobs"]

    def steps(self):
        for name, job in self.jobs.items():
            for s in job["steps"]:
                yield name, s

    def test_triggers(self):
        on = self.wf.get("on", self.wf.get(True))
        self.assertEqual(set(on), {"push", "workflow_dispatch"})
        self.assertEqual(on["push"], {"branches": ["main"], "tags": ["v*"]})

    def test_jobs_and_permissions(self):
        self.assertEqual(self.wf["permissions"], {})
        self.assertEqual(set(self.jobs), {"verify", "windows", "macos", "release", "pages"})
        self.assertEqual(self.jobs["windows"]["needs"], "verify")
        self.assertEqual(self.jobs["macos"]["needs"], "verify")
        self.assertEqual(set(self.jobs["release"]["needs"]), {"windows", "macos"})
        self.assertEqual(self.jobs["pages"]["needs"], "verify")
                # Windows files: tags and manual runs only (not every push to main)
        self.assertIn("workflow_dispatch", self.jobs["windows"]["if"])
        self.assertIn("refs/tags/v", self.jobs["windows"]["if"])
        # The page is deployed from the default branch (the github-pages environment refuses tags)
        self.assertEqual(self.jobs["pages"]["if"], "github.ref == 'refs/heads/main'")
        writers = {n for n, j in self.jobs.items() if "write" in j["permissions"].values()}
        self.assertEqual(writers, {"release", "pages"})
        self.assertEqual(self.jobs["release"]["permissions"], {"contents": "write"})
        self.assertEqual(self.jobs["pages"]["permissions"], {"contents": "read", "pages": "write", "id-token": "write"})
        self.assertEqual(self.jobs["verify"]["permissions"], {"contents": "read"})
        self.assertEqual(self.jobs["windows"]["permissions"], {"contents": "read"})
        self.assertEqual(self.jobs["macos"]["permissions"], {"contents": "read"})

    def test_actions_are_pinned_to_the_resolved_commits(self):
        seen = set()
        for _, s in self.steps():
            if "uses" in s:
                action, _, ref = s["uses"].partition("@")
                self.assertIn(action, PINS, s["uses"])
                self.assertEqual(ref, PINS[action][0])
                seen.add(action)
        for action, (sha, tag) in PINS.items():
            self.assertIn(f"uses: {action}@{sha} # {tag}", TEXT)
        self.assertEqual(seen, set(PINS))

    def test_checkout_keeps_no_credentials(self):
        for _, s in self.steps():
            if s.get("uses", "").startswith("actions/checkout"):
                self.assertIs(s["with"]["persist-credentials"], False)

    def test_untrusted_values_never_sit_inside_run_scripts(self):
        for _, s in self.steps():
            run = s.get("run", "")
            self.assertNotRegex(run, r"\$\{\{")
        self.assertIn("REF: ${{ github.ref }}", TEXT)

    def test_windows_job(self):
        j = self.jobs["windows"]
        self.assertEqual(j["runs-on"], "windows-latest")
        self.assertEqual(j["defaults"]["run"]["shell"], "bash")
        runs = "\n".join(s.get("run", "") for s in j["steps"])
        self.assertIn("node scripts/version-from-tag.js", runs)
        self.assertIn("npm ci", runs)
        self.assertIn("--allow-same-version", runs)
        self.assertIn("npm run dist", runs)
        self.assertEqual(self.jobs["verify"]["steps"][-1]["run"], "node scripts/check.js --ci")
        up = [s for s in j["steps"] if s.get("uses", "").startswith("actions/upload-artifact")][0]
        self.assertEqual(up["with"]["path"], "desktop/dist/*.exe")
        self.assertEqual(up["with"]["if-no-files-found"], "error")

    def test_macos_job_and_release_does_not_depend_on_it_succeeding(self):
        m = self.jobs["macos"]
        self.assertEqual(m["runs-on"], "macos-latest")
        self.assertIn("workflow_dispatch", m["if"])
        self.assertIn("refs/tags/v", m["if"])
        runs = "\n".join(s.get("run", "") for s in m["steps"])
        self.assertIn("node scripts/version-from-tag.js", runs)
        self.assertIn("npm ci", runs)
        self.assertIn("npm run dist:mac", runs)
        env = [s.get("env", {}) for s in m["steps"] if "npm run dist:mac" in s.get("run", "")][0]
        self.assertEqual(env.get("CSC_IDENTITY_AUTO_DISCOVERY"), "false")
        up = [s for s in m["steps"] if s.get("uses", "").startswith("actions/upload-artifact")][0]
        self.assertEqual(up["with"]["name"], "mac-files")
        self.assertIn("desktop/dist/*.dmg", up["with"]["path"])
        self.assertIn("desktop/dist/*.zip", up["with"]["path"])
        rel = self.jobs["release"]
        # a Mac problem must not stop the Windows Release
        self.assertIn("needs.windows.result == 'success'", rel["if"])
        self.assertIn("refs/tags/v", rel["if"])
        dl = [s for s in rel["steps"] if s.get("uses", "").startswith("actions/download-artifact") and s["with"]["name"] == "mac-files"][0]
        self.assertIs(dl.get("continue-on-error"), True)
        run = [s for s in rel["steps"] if "gh release create" in s.get("run", "")][0]["run"]
        self.assertIn("Study-Desk-*-mac-*", run)

    def test_release_needs_both_files_and_writes_checksums(self):
        run = [s for s in self.jobs["release"]["steps"] if "gh release create" in s.get("run", "")][0]["run"]
        self.assertLess(run.index("Study-Desk-Setup-*.exe"), run.index("gh release create"))
        self.assertLess(run.index("Study-Desk-*-portable.exe"), run.index("gh release create"))
        self.assertIn("sha256sum", run)
        self.assertIn("set -euo pipefail", run)
        # A Release created by hand in the browser must work too: attach the files instead of failing
        self.assertIn("gh release view", run)
        self.assertIn("gh release upload", run)
        self.assertIn("--clobber", run)

    def test_no_android_no_apk_no_secrets(self):
        low = TEXT.lower()
        self.assertNotIn("apk", low)
        self.assertNotIn("android", low)
        self.assertNotIn("secrets.", low)
        self.assertNotIn("keystore", low)

    def test_pages_publishes_the_site_folder(self):
        up = [s for s in self.jobs["pages"]["steps"] if s.get("uses", "").startswith("actions/upload-pages-artifact")][0]
        self.assertEqual(up["with"]["path"], "site")


if __name__ == "__main__":
    unittest.main()
