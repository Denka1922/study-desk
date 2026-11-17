# Study Desk: project map

Read this first. It says where things are, so you can open the one right file instead of searching.
Study Desk = a personal student planner (calendar, exams and grades, deadlines, to-dos, shortcuts, AI Tutor) shipped as one HTML page inside a Windows/Mac program (Electron), an Android app (Capacitor) and a download page.

## The one rule that saves the most effort
`app/index.html` is **generated**. Never edit it by hand and never read it whole (it is huge: it contains the planner, GSAP and the AI code). Change the page *sources* (below), rebuild, then sync.

## Page sources (kept in the working folder `planner/`, not in the project ZIP)
`python3 build.py` (run inside `planner/`) joins the parts into `study-desk-local.html` (the no-login build with the AI Tutor), `study-desk-login.html`, `study-desk.html` and `test-ai.html`. Then `python3 study-desk/scripts/sync-app.py` copies the local build to `app/index.html`, and the same file must be copied to `mobile/android/app/src/main/assets/public/index.html` (a test enforces they match).

| Part | What it holds |
|---|---|
| `p1-head.html`, `p2-css.html`, `p3-body.html` | head, base CSS (theme variables), page skeleton |
| `p4-core.html` to `p7-app.html` | planner logic and views (calendar, grades, deadlines, to-dos, shortcuts) |
| `p8-auth.*`, `p9-devices.*` | login build only; device linking and QR |
| `p10-polish.*`, `p11-gsap.*` | motion and polish (GSAP pinned to 3.15.0) |
| `p12-ai.css` | all AI Tutor styles |
| `p12a-ai-validate.js` | `aiParseTagged(kind,text)` turns the AI's tagged lines (TITLE:, LESSON:, TIP:, Q: ...) into the same objects that `aiCheck*` validate; a JSON reply still works (`aiExtractJson`) |
| `p12b-ai-render.js` | safe rendering of AI text; TIP/NOTE/WARN lines become boxes, FORMULA a block, STEP a numbered list |
| `p12c-ai-prompts.js` | prompts: `aiBuildPrompt(kind,params)`, kinds outline, lesson, exam, revision, chat. Outline, lesson, exam and revision ask for tagged lines, not JSON |
| `p12d-ai-providers.js` | the three online providers; `aiSend(o)`, `aiErr(kind,status,message)` |
| `p12e-ai-store.js` | settings, key and course storage; `aiCleanSettings` |
| `p12f-ai-ui.js` | Tutor screens and flow; `aiRun`, `aiScreen`, `aiErrorText`, click handler `aiAct` |
| `p12g-ai-local.js` | desktop bridge client, token counter, `aiSendBridge` |
| `p12h-ai-local-ui.js` | Local and CLI setup screens |
| `p12z-ai-test-export.js` | test-only export used by the old test pages |

Page code rules: classic script, ES5 style (`var`, `function`), everything inside one function, so names are shared by all parts. **Check a new top-level name does not already exist** (an `AI_LEVELS` clash once wiped course levels). No inline event handlers (use `data-act`). Colors only from theme variables. No key or secret anywhere in the code.

## This ZIP
| Path | What it is |
|---|---|
| `app/index.html` | the finished page (generated, see above) |
| `desktop/` | Electron program. `main.js` window and startup, `preload.js` the only bridge to the page (`window.studyDesk.ai`), `security.js` link rules |
| `desktop/ai/` | the Local and CLI AI, main process only (below) |
| `mobile/` | Android (Capacitor); open `mobile/android` in Android Studio. Android has the API key only |
| `site/index.html` | download page |
| `scripts/` | `check.js` (all tests), `make-zip.py`, `sync-app.py`, icons, version scripts |
| `scripts/tests/` | all tests; `helpers.js` has `pageWithExports(names)` to reach the page's inner functions without touching the shipped file |
| `.github/workflows/` | `build.yml` (test, build Windows and Mac, publish), `verify-catalog.yml` (manual: re-check model file fingerprints) |
| `README.md`, `FIRST-BUILD.md`, `PLAY-STORE.md`, `TEST-CHECKLIST.md` | guides for the owner |

## Local and CLI AI (`desktop/ai/`)
Flow: page -> `preload.js` -> `ipc.js` (checks the sender and every argument) -> `service.js` (one place that decides) -> the parts below. The page never gets a path, command, port or token.

| File | Job |
|---|---|
| `catalog.json`, `catalog.js` | pinned engine (llama.cpp tag b12360) and models with SHA-256; only https hosts of GitHub and Hugging Face; Qwen3 and GLM are `enabled:false` until verified |
| `levels.js` | the five power levels: memory share, threads, context size |
| `hardware.js`, `picker.js` | read the PC; choose the model and engine build; fit rule `size + KV + 600 MB` |
| `download.js` | verified, resumable download (`DownloadError` codes host, http, network, disk, checksum, cancelled) |
| `engine.js` | install and run `llama-server` on 127.0.0.1 with random port and token; pid file and `reapStale` for a killed app |
| `localchat.js`, `usage.js` | one chat request, thinking-text stripping, token estimates |
| `cli.js`, `cli-tools.json` | Codex, Gemini CLI, goose in read-only one-shot mode; prompt on stdin only; `augmentPath` for Mac |
| `service.js` | `createAiService`: install, start (serialised), chat, CLI, idle stop, errors with plain messages |
| `ipc.js` | the 12 channels and progress throttle |
| `tools/` | maintainer scripts (`pin-catalog.js`), not shipped |

Error kinds seen by the page: auth, quota, rate, network, timeout, cancelled, bad, disk, checksum, ram, engine, nocli.

## Commands
- All tests: `node scripts/check.js` (needs Playwright); no browser: `node scripts/check.js --ci`.
- One file: `node --test scripts/tests/<name>.test.js`. Files ending `.pw.test.js` need Playwright.
- Old page suites (working folder): `bash run-suite.sh $(cat /tmp/suites.txt)`.
- Secret scan, must print nothing: `grep -rIl "AQ\.Ab8RN6" study-desk planner`.
- Project ZIP: `python3 scripts/make-zip.py --out <file>`.
- Windows installer: in `desktop/`, `npm ci` then `npx electron-builder --win nsis --x64 --publish never`. Mac zips: `--mac zip --arm64 --x64`, then ad-hoc sign the `.app` with `rcodesign sign` and re-zip with `zip -ry` (keeps links).

## Test habits
- Write the test, watch it fail for the right reason, then fix.
- Tests of the Local/CLI parts use fakes (fake spawn, fake downloads, a fake llama-server script). Nothing has run on a real Windows or Mac PC, GPU or signed-in CLI; say so when reporting.
- Legacy page tests must keep passing: with no desktop bridge the Tutor works exactly as before (first visit opens the key setup, Gemini preselected).

## Facts about the owner's choices
Unsigned Windows program; Mac ad-hoc signed; Android built by the owner in Android Studio and published to Google Play (no APK from GitHub); installers are handed over as files (GitHub Pages is not used because of cost); Local AI uses the built-in engine, not Ollama; reply in simple English, the owner is Turkish.
