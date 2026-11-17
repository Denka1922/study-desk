# First build: from this folder to your first Windows download

You need a free GitHub account (https://github.com). GitHub's free plan only publishes the download page (GitHub Pages) from a **public** repository, so make the repository public. It contains no secrets.

## 1. Create the repository

1. On GitHub click **+** (top right), then **New repository**.
2. Name it, for example `study-desk`. Choose **Public**. Do **not** add a README, `.gitignore` or licence.
3. Click **Create repository**.

## 2. Turn on GitHub Pages (do this before you upload)

Repository **Settings**, then **Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**. Nothing else to do there. (If you forget, the first page job turns red when you upload; turn Pages on and click **Re-run** on that run.)

## 3. Upload the project

Unzip `study-desk-project.zip`. Inside is a folder `study-desk`. What goes to GitHub is the **contents of the study-desk folder** (the folders `app`, `desktop`, `mobile`, `site`, `scripts`, the hidden `.github` folder, and the files), not the folder itself. When you are done, the file `.github/workflows/build.yml` must sit at the top level of the repository.

**Option A, with Git (recommended, it handles many files and hidden folders):** install Git for Windows from https://git-scm.com, open a terminal inside the `study-desk` folder and run (replace the address with the one GitHub shows you, and the name and e-mail with yours):

```
git init
git config user.name "Your Name"
git config user.email "you@example.com"
git add .
git commit -m "Study Desk"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/study-desk.git
git push -u origin main
```

**Option B, in the browser:** on the empty repository page click **uploading an existing file** and drag everything from inside the `study-desk` folder into the page. The page limits how many files it takes at once; if it refuses, use Option A. If the hidden `.github` folder does not arrive, click **Add file**, then **Create new file**, type `.github/workflows/build.yml` as the name (typing `/` makes the folders), paste the contents of `build.yml` from this project, and click **Commit changes**.

Check: in the repository you can open `.github/workflows/build.yml`.

## 4. The download page goes live

Every push to the `main` branch tests the project and publishes the download page. Open the **Actions** tab: the run **Build Study Desk** has a green check after a minute or two. The page is at `https://YOUR-NAME.github.io/study-desk/` (your own name and repository name). Until the first version exists it says "No version has been published yet".

## 5. Publish the first version (the Windows files)

**With Git (Option A):**

```
git tag v1.0.0
git push origin v1.0.0
```

**In the browser (Option B):** open **Releases**, click **Draft a new release**, click **Choose a tag**, type `v1.0.0`, click **Create new tag: v1.0.0 on publish**, give it any title, and click **Publish release**. The release looks empty at first. A few minutes later the build attaches the two Windows files to it and adds the checksums.

Either way the tag must look like `v1.2.3`.

## 6. Watch the Windows build

Open the **Actions** tab. The new run is called **Build Study Desk**. It runs the tests, builds the two Windows files and creates (or fills) the Release. It takes a few minutes; when every step has a green check the files are ready.

## 7. Where the files are

- **Releases**: on the right side of the repository page click **Releases**, then the newest one. You will see `Study-Desk-Setup-1.0.0.exe` (installer), `Study-Desk-1.0.0-portable.exe` (no install) and their SHA-256 checksums in the notes.
- **Download page**: `https://YOUR-NAME.github.io/study-desk/` (use your own name and repository name). It shows the version and two download buttons.

Windows will warn "unknown publisher" because the program is not signed with a paid certificate. Click **More info**, then **Run anyway**. On some new Windows 11 PCs **Smart App Control** blocks unsigned programs completely and offers no "Run anyway"; it is under Windows Security, App & browser control, and once turned off it cannot be turned back on.

Now go through `TEST-CHECKLIST.md`, sections A to C.

## 8. Once: check the AI model files (Verify AI catalog)

The Local AI downloads exact pinned model and engine files. Before the first release, and whenever those files change, run the check once: on GitHub open **Actions**, pick **Verify AI catalog** on the left, **Run workflow**, **Run workflow**. A green run means every pinned file still matches its fingerprint. A red run means a file moved or changed: send Claude the log text. This covers every downloadable model (Nemotron, GLM and Qwen3). The three giant models (Nemotron 3 Super and Ultra) are list-only, have no download and are not checked.

## If a step turns red

Click the run, click the red step, copy the log text and send it to Claude. First builds sometimes need a small fix that only the real GitHub machines show.

## Later

- New version: change nothing, push a new tag (`git tag v1.0.1`, then `git push origin v1.0.1`) or draft a new release in the browser. Tags must look like `v1.2.3`; anything else is refused on purpose (after you push it, the run turns red with a message).
- Changing only the download page (for example the Google Play link): push the change to `main`; the page is republished, no new tag needed.
- Try a build without publishing: **Actions**, **Build Study Desk**, **Run workflow**. The files are kept as downloads on that run, and no Release is made.
- When Study Desk itself changes, ask Claude for a fresh project ZIP and upload it again.
