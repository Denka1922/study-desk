# Installation

Pick your platform:

- [Windows](#windows)
- [Mac](#mac)
- [Android](#android)
- [Setting up the AI Tutor](#setting-up-the-ai-tutor)
- [Building from source](#building-from-source)
- [Publishing a release on GitHub](#publishing-a-release-on-github)
- [Troubleshooting](#troubleshooting)

Replace `<your-username>` below with the GitHub account that owns the repository.

---

## Windows

**Requirements:** Windows 10 or 11, 64-bit.

1. Open the repository's **Releases** page: `https://github.com/<your-username>/study-desk/releases`.
2. Download one of:
   - `Study-Desk-Setup-<version>.exe`: the installer (installs for your user only, adds a Start menu and desktop shortcut).
   - `Study-Desk-<version>-portable.exe`: runs without installing.
3. Optional check: compare the file's fingerprint with the SHA-256 value in the release notes.
   ```
   certutil -hashfile Study-Desk-Setup-<version>.exe SHA256
   ```
4. Run the file.

**"Windows protected your PC" / "unknown publisher".** The program is not signed with a paid certificate. Click **More info**, then **Run anyway**.

On some new Windows 11 PCs **Smart App Control** blocks unsigned programs completely and offers no "Run anyway". Either turn Smart App Control off (Windows Security, App and browser control, Smart App Control settings; this cannot be turned back on without resetting Windows) or use the web version.

**Installing a new version** over an old one keeps your data.

**If you received the installer in pieces** (`.001`, `.002`, ...): put all pieces in one folder and join them in Command Prompt, then check the fingerprint against the value that came with them.
```
copy /b Study-Desk-Setup-<version>.exe.001 + Study-Desk-Setup-<version>.exe.002 + ... Study-Desk-Setup-<version>.exe
```
(List every piece in order.) 7-Zip can also join them: right-click the `.001` file, 7-Zip, Extract Here.

---

## Mac

**Requirements:** a recent macOS (the exact minimum follows the bundled Electron 45; see the Electron documentation). Apple Silicon (M1 and later) and Intel are both supported, with separate files.

1. Find your chip: Apple menu, **About This Mac**.
   - "Chip: Apple M..." means download the `arm64` file.
   - "Processor: Intel..." means download the `x64` file.
2. From the **Releases** page, download `Study-Desk-<version>-mac-arm64` or `Study-Desk-<version>-mac-x64` (each comes as a `.dmg` and a `.zip`; use either one).
3. Open the `.dmg` (or double-click the `.zip`), then drag **Study Desk** into **Applications**.
4. First open. The app is signed with a free "ad-hoc" signature, not by Apple, so macOS blocks it once:
   - **macOS 15 or newer:** double-click Study Desk, press **Done** on the warning, then open **System Settings, Privacy & Security**, scroll down, click **Open Anyway** and enter your password.
   - **macOS 14 or older:** right-click (or Control-click) Study Desk, choose **Open**, then **Open**.
   - If macOS says the app is "damaged", run this once in Terminal and try again:
     ```
     xattr -cr "/Applications/Study Desk.app"
     ```
5. After this one time it opens normally.

**If the file came in parts** (`.part00`, `.part01`, ...): put all parts in one folder and run (change `arm64` to `x64` for Intel):
```
cd ~/Downloads
cat Study-Desk-<version>-mac-arm64.zip.part* > Study-Desk-<version>-mac-arm64.zip
shasum -a 256 Study-Desk-<version>-mac-arm64.zip
```
The printed number must match the fingerprint that came with the files.

> The Mac build was made on a Linux machine and has not been run on a real Mac yet. Please report anything that fails.

---

## Android

Android is **not** distributed as an APK on GitHub. You build it yourself in Android Studio.

**Requirements:** [Android Studio](https://developer.android.com/studio) (current stable), Node.js 22 or newer.

1. Get the project: `git clone https://github.com/<your-username>/study-desk.git`
2. Prepare the web assets:
   ```
   cd study-desk/mobile
   npm ci
   npx cap sync android
   ```
3. In Android Studio choose **Open** and select the `mobile/android` folder. Wait for the Gradle sync to finish.
4. To try it: pick an emulator or a phone with USB debugging on, then press **Run**.
5. To publish on Google Play, build a signed app bundle (`.aab`). The full steps are in [PLAY-STORE.md](PLAY-STORE.md).

**Keep your signing key private.** The upload keystore and its passwords must stay on your own computer and must never be committed (`.gitignore` excludes `*.jks`, `*.keystore` and `keystore.properties`).

The Android app uses the **Online key** AI mode only. Local and CLI are for Windows and Mac.

---

## Setting up the AI Tutor

Open the **AI Tutor** page and choose how it should run.

### Online key (all platforms)

1. Choose a provider: Gemini, OpenAI or Anthropic.
2. Create an API key in that provider's own console and paste it into the Tutor setup screen.
3. The key is stored only on your device. Never post it anywhere. If you think a key leaked, delete it in the provider's console and create a new one.

### Local (Windows and Mac program)

1. Choose **Local**. The screen shows your computer's memory, processor and graphics card and suggests a model.
2. Press **Download**. The program downloads the llama.cpp engine and the model once, checks their SHA-256 fingerprints, and keeps them in its own folder.
   - **Disk space:** the small model is about 2.8 GB; the larger one is about 6.5 GB. Make sure there is room, and an internet connection for the first download only.
3. Pick a power level (Light, Medium, High, Extra high, Max). Higher levels use more memory and processor and answer faster; lower levels leave your computer free for other work.
4. Press **Start**. After this, questions are answered on your computer and nothing leaves it.
5. An interrupted download continues where it stopped.

### CLI (Windows and Mac program)

1. Install one supported tool and sign in to it in a terminal first:
   - OpenAI Codex CLI
   - Gemini CLI
   - goose
2. Choose **CLI** in Study Desk and pick the tool. The program finds it on your computer.
3. These tools usually send your question to a cloud service, so do not type passwords or other secrets into the Tutor.

---

## Building from source

**Requirements:** Node.js 22 or newer, Python 3, and a computer of the system you are building for (the Windows installer is best built on Windows, the Mac app on a Mac; GitHub Actions does both for you).

### Run the tests

```
node scripts/check.js --ci     # Node and Python only
node scripts/check.js          # also browser tests (needs: npx playwright install chromium)
```

### Windows program

```
cd desktop
npm ci
npm run dist          # installer and portable .exe in desktop/dist
```

### Mac program

```
cd desktop
npm ci
npm run dist:mac      # on a Mac; output in desktop/dist
```

Without a paid Apple certificate the result is not notarised, so it needs the "Open Anyway" step above.

### Try the desktop program without packaging

```
cd desktop
npm ci
npx electron .
```

---

## Publishing a release on GitHub

The workflow `.github/workflows/build.yml` builds the Windows and Mac files and creates the Release when you push a **version tag**. The tag must look like `v1.2.3`.

1. Turn on Pages once: repository **Settings, Pages, Source: GitHub Actions** (needs a public repository on the free plan).
2. Push the project to the `main` branch. Every push runs the tests and publishes the download page.
3. Tag and push:
   ```
   git tag v1.0.0
   git push origin v1.0.0
   ```
4. Open the **Actions** tab and watch **Build Study Desk**. When it is green, the files and their SHA-256 values are on the **Releases** page.
5. Once, and whenever the model or engine files change, run **Verify AI catalog** (Actions, pick it on the left, **Run workflow**) so the pinned fingerprints are re-checked.

More detail, including the browser-only upload route, is in [FIRST-BUILD.md](FIRST-BUILD.md).

**Do not commit installers or build output** (`dist/`, `.exe`, `.zip`, `.dmg`). Files over 100 MB are refused by GitHub, and installers make the repository slow for everyone. Attach them to a Release instead.

---

## Troubleshooting

| Problem | What to try |
|---|---|
| Windows says "unknown publisher" | More info, then Run anyway. If there is no such button, see Smart App Control above. |
| Mac says the app cannot be opened or is "damaged" | Use Open Anyway (macOS 15) or right-click, Open (macOS 14 and older). Then `xattr -cr "/Applications/Study Desk.app"`. |
| Local AI download fails or stops | Check free disk space and the connection, then press Download again. It resumes. A "checksum" error means the file was damaged; try again. |
| Local AI says the model does not fit in memory | Close other programs, lower the power level, or pick the smaller model. |
| CLI tool is "not found" | Install it, sign in to it in a terminal, then restart Study Desk. |
| The AI says the key was rejected | Check the key in the provider's console, and that it belongs to the provider you picked. |
| A GitHub Actions step is red | Open the run, open the red step and read the log. Include that text (never a key or password) when you open an issue. |
| Android Gradle sync fails | In Android Studio use File, Sync Project with Gradle Files; make sure the JDK that Android Studio bundles is selected. |

Your planner data lives in the app's own storage on your device; uninstalling the program or clearing the app's data removes it.
