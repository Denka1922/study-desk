# Study Desk

A personal student planner: calendar, exams and grades, deadlines, to-dos, shortcuts and an AI Tutor.
Your planner data stays on your own device.

Study Desk is one web page (`app/index.html`) that is packaged three ways:

| Platform | How it is packaged | Where it comes from |
|---|---|---|
| Windows | Electron program (installer and portable `.exe`) | built by GitHub Actions from a version tag |
| Mac | Electron program (`.dmg` and `.zip`, Apple Silicon and Intel; not signed by Apple) | built by GitHub Actions from a version tag |
| Android | Capacitor project | you build it in Android Studio (no APK is published on GitHub) |
| Web | a download page (`site/index.html`) | published with GitHub Pages |

See [INSTALLATION.md](INSTALLATION.md) to install or build it.

## Features

- **Calendar and deadlines** with to-dos and shortcuts to the sites you use.
- **Exams and grades** with averages.
- **Light and dark themes.**
- **AI Tutor** that can make a course outline, lessons, practice exams and revision, and answer questions. It has three ways to run (see below).
- **No account and no server.** Everything is stored on your device.

## The AI Tutor: three ways to run

Choose one on the Tutor setup screen.

| Mode | Where | How it works | Does your text leave the computer? |
|---|---|---|---|
| **Local** | Windows and Mac program only | Downloads a small open model (NVIDIA Nemotron) and the open-source [llama.cpp](https://github.com/ggml-org/llama.cpp) engine once, then answers on your computer. | No |
| **CLI** | Windows and Mac program only | Uses an AI command-line tool you already have installed and signed in to: OpenAI Codex CLI, Gemini CLI or goose. | Usually yes: these tools mostly use a cloud service. The screen says so for each tool. |
| **Online key** | Everywhere, including Android and the web page | Your own API key for Gemini, OpenAI or Anthropic. | Yes, to the provider you choose |

Local mode details:

- It reads your computer (memory, processor cores, graphics card) and suggests a model.
- Five power levels (Light, Medium, High, Extra high, Max) limit how much memory and processor it may use.
- A token counter shows the last answer and the session total.
- Downloads are pinned to exact files and checked with a SHA-256 fingerprint before use.
- Qwen3 and GLM models are in the catalog but switched off until their fingerprints are verified.

Left out on purpose because they cannot be used safely in a one-question mode: GitHub Copilot CLI, opencode, Crush and aider.

Your API key is stored only on your device. Never share a key, and never commit one to a repository.

## Project layout

| Path | What it is |
|---|---|
| `app/` | `index.html`, the finished page. It is generated from source parts that are kept outside this repository (see Contributing). |
| `desktop/` | The Electron program. `main.js` (window and startup), `preload.js` (the only bridge to the page), `security.js` (link rules). |
| `desktop/ai/` | The Local and CLI AI. It runs in the main process only; the page never gets a file path, command or port. |
| `mobile/` | The Android project (Capacitor). Open `mobile/android` in Android Studio. |
| `site/` | The download page. |
| `scripts/` | Helper scripts and all tests. |
| `.github/workflows/build.yml` | Tests every push, publishes the download page, and builds the Windows and Mac files and the Release from a version tag. |
| `.github/workflows/verify-catalog.yml` | Manual run **Verify AI catalog**: re-checks the model and engine fingerprints. |
| `INSTALLATION.md` | How to install, run and build. |
| `FIRST-BUILD.md` | From an empty repository to the first release. |
| `PLAY-STORE.md` | Android Studio and Google Play. |
| `TEST-CHECKLIST.md` | What to click through on each platform. |
| `PROJECT-MAP.md` | A short map of the code for contributors. |

## Tests

```
node scripts/check.js --ci     # Node 22 and Python 3 only (this is what GitHub runs)
node scripts/check.js          # all tests, including browser tests (needs Playwright)
```

## Status: what has and has not been tested

Automatic tests cover the page, settings, link rules, version handling, the download page, the workflow file and the whole Local/CLI code path.

**Not yet tested on real hardware:**

- starting the Windows program, the installer and the portable file;
- the Mac app (built on Linux, never run on a Mac);
- building the Android project and running it on a phone;
- the Local and CLI AI on a real Windows PC or Mac. Tests use fakes: no real model download, graphics card or signed-in command-line tool.

Use [TEST-CHECKLIST.md](TEST-CHECKLIST.md) to check these, and please open an issue if something fails.

## Security notes

- The programs are **not code-signed** with a paid certificate. Windows shows "unknown publisher" and macOS asks you to allow the app once. See [INSTALLATION.md](INSTALLATION.md).
- No key, password or signing file belongs in this repository. `.gitignore` excludes keystores and `*.apk`, and a test fails if a keystore file appears.
- Local AI listens only on `127.0.0.1` with a random port and a one-time token.
- CLI mode runs the tool in read-only, one-question mode. Some tools can still read files on your computer, so never put passwords or other secrets in your questions.

## Contributing

`app/index.html` is generated from a set of page source parts and a build script that are **not part of this repository yet**. Until they are added, changes to the page itself are made by the maintainer; everything else (the Electron program, the AI code in `desktop/ai/`, the Android project, the download page, the scripts and the tests) can be changed here directly.

Write a failing test first, then the fix, and run `node scripts/check.js --ci` before opening a pull request.

## Licence

No licence file has been added yet. Until one is added, all rights are reserved by the owner.
