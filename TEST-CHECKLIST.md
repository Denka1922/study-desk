# Study Desk: test checklist

Nobody could run the Windows program or the Android app while they were being built, so these checks are the real test. Do them once after the first GitHub build (Windows) and once after you build the app in Android Studio (Android). Tick each box. If something fails, write down the step number and what you saw, then send me that (plus the GitHub log or the Android Studio error if there is one).

## A. Windows installer (`Study-Desk-Setup-<version>.exe`)

Use a Windows 64-bit PC. Download the file from the Release page or the download page.

- [ ] A1. Double-click the file. Windows may show "Windows protected your PC" (the "unknown publisher" warning). Click **More info**, then **Run anyway**. This is expected, because the program is not signed with a paid certificate. If Windows 11 blocks it with no "Run anyway" button, **Smart App Control** is on: turn it off under Windows Security, App & browser control (it cannot be turned back on), or test on another PC.
- [ ] A2. The installer finishes without asking for an administrator password.
- [ ] A3. A **Study Desk** icon appears on the desktop and in the Start menu, and it shows the Study Desk icon (not a blank or default icon).
- [ ] A4. The program opens in its own window titled "Study Desk". There is no menu bar.
- [ ] A5. Resize the window as small as it goes. It stops at a small phone-like size (about 360 x 600) and nothing is cut off or overlapping.
- [ ] A6. Add a to-do, a deadline and an exam. They all show up.
- [ ] A7. Close the program with the X. Open it again from the desktop icon. **Everything you added is still there.**
- [ ] A8. Try to open a second copy while the first is running. No second window appears; the first one comes to the front.
- [ ] A9. Click any shortcut or link in the app that goes to a website. It opens in your normal browser, and the Study Desk window stays where it was.
- [ ] A10. Open the **Tutor** page. The page opens and shows the "add your API key" setup (the AI Tutor itself still needs your own key until the local AI step is built).
- [ ] A11. Restart the PC (or sign out and in), open Study Desk again. Your data is still there.
- [ ] A12. Uninstall it: Windows **Settings > Apps > Installed apps > Study Desk > Uninstall**. It is removed, and the desktop and Start menu icons are gone.
- [ ] A13. Install it again. Check if your old data is still there (the uninstall may keep or remove it; just note which).

## B. Windows portable (`Study-Desk-<version>-portable.exe`)

- [ ] B1. Put the file in any folder (for example `Documents`, or a folder with a space or a Turkish letter in its name, like `Çalışma Dosyaları`). Double-click it. After the same "unknown publisher" warning (A1), the program opens.
- [ ] B2. Nothing was installed: no new desktop or Start menu icon.
- [ ] B3. Do A4, A6, A7 (add data, close, reopen from the same file). Data is still there.
- [ ] B4. Do A9 and A10 (links and Tutor page).
- [ ] B5. Move the portable file to a different folder and open it. Say whether your data is still there or not (it is fine either way, but I need to know).

## C. Download page (after the first tag is built and GitHub Pages is on)

- [ ] C1. Open the page address `https://<your-github-name>.github.io/<repository-name>/`.
- [ ] C2. It shows the version number, the date, and two buttons: **installer** and **portable**.
- [ ] C3. Both buttons download the right file (names match the Release page).
- [ ] C4. The Android card says "coming soon on Google Play" until you publish. There is **no** APK link anywhere.
- [ ] C5. Open the page on your phone. Nothing is cut off at the sides, and the dark mode follows the phone's setting.

## D. Android app (after you build it in Android Studio, before uploading to Google Play)

Run it on a real phone (USB cable, with Developer options and USB debugging turned on) or in the Android Studio emulator. Use the **debug** run first. After you build the signed `.aab`, repeat D4 to D12 through a Play Console **internal testing** release if you can, because that is the build users will get.

- [ ] D1. In the `mobile` folder you ran `npm install` and `npm run sync` (see `PLAY-STORE.md`). Android Studio opens the `mobile/android` folder and Gradle sync finishes without errors.
- [ ] D2. The app installs and opens. The launcher icon is the Study Desk icon and looks right in both the square and round shapes.
- [ ] D3. The app name under the icon is "Study Desk".
- [ ] D4. The planner opens full screen, nothing is cut off by the camera notch or the bottom bar.
- [ ] D5. Add a to-do, a deadline and an exam. They show up.
- [ ] D6. Close the app fully (swipe it away from recent apps). Open it again. **Your data is still there.**
- [ ] D7. Turn the phone sideways and back. Nothing breaks or is lost.
- [ ] D8. Tap a link that goes to a website. It opens in the phone's browser, not inside the app.
- [ ] D9. Open the **Tutor** page. It opens and shows the key setup. With airplane mode on, the app still opens and your data is visible (only the AI needs internet).
- [ ] D10. Press the phone's Back button on the main screen. The app closes or goes back sensibly and does not crash.
- [ ] D11. Open **Settings > Apps > Study Desk > Permissions**. The only access it lists is internet (that one is not shown as a permission to allow). No camera, location, contacts or storage access is requested.
- [ ] D12. Uninstall it and check the icon is gone.

## E. Before you press "Publish" in Google Play

- [ ] E1. The `versionCode` in `mobile/version.json` is higher than any version you uploaded before (Google Play rejects a repeated number).
- [ ] E2. You kept your upload key file and its passwords in a safe place **outside** the project folder, and have a backup.
- [ ] E3. You read the Play Console's current requirements list (account verification, testing period for new accounts, minimum Android target level, data safety form, content rating, privacy policy page). `PLAY-STORE.md` explains each one.
- [ ] E4. You decided what to do about the AI Tutor's Google Play rules (AI-generated content and data sent to a third party). `PLAY-STORE.md` explains this.

## F. If something fails

Send me:
1. The step number (for example "A7").
2. What you expected and what happened (a screenshot is great).
3. For a GitHub build problem: the red step's log text from the **Actions** tab.
4. For an Android problem: the error text from Android Studio's **Build** or **Logcat** panel.
Do not send any API key or keystore password.

## G. Mac app (`Study-Desk-<version>-mac-arm64.zip` for M1 or newer, `-x64.zip` for Intel)

- [ ] G1. Unzip, drag Study Desk to Applications. On the first open the Mac blocks it: macOS 15 or newer: System Settings > Privacy & Security > Open Anyway; older macOS: right-click the app > Open. It must start after that.
- [ ] G2. The window opens with the planner; the Study Desk menu is at the top of the screen.
- [ ] G3. Add a to-do, press Cmd+C and Cmd+V in a text field (copy and paste work), then quit with Cmd+Q and open again: the to-do is still there.
- [ ] G4. A link in the planner opens in your browser, not inside the app.
- [ ] G5. If macOS says the app is "damaged": run `xattr -cr "/Applications/Study Desk.app"` in Terminal once and try again.

## H. Local AI (Windows and Mac program only; needs about 3 to 7 GB free disk space and an internet connection for the one-time download)

- [ ] H1. AI Tutor > Local. The screen shows your computer: memory in GB, number of cores and your graphics card (or "no separate graphics card"). Compare with Task Manager (Windows) or About This Mac. It says what it will recommend and why.
- [ ] H2. Press each power level (Light, Medium, High, Extra high, Max). The recommended model line updates each time, and the "may use up to ... of memory" text grows with the level. On a small PC a low level may offer only the smaller model.
- [ ] H3. Press Download. You see the license link first. The progress bar moves; press Cancel, then Download again: it continues, it does not start over. Let it finish.
- [ ] H4. Windows only: antivirus or SmartScreen may react to the downloaded engine (`llama-server`). If it asks, choose to allow it, and tell me exactly what it said.
- [ ] H5. Mac only: if macOS blocks `llama-server` the first time, System Settings > Privacy & Security > Open Anyway, then press Start again.
- [ ] H6. Press Start. After up to a minute you land on the Tutor. Build a course in English and a lesson. Check that it answers in plain, sensible text (not empty, not cut off).
- [ ] H7. While it answers, open Task Manager (Windows) or Activity Monitor (Mac). Memory use of `llama-server` must stay below the level's limit at Light, Medium, High, Extra high and Max (try two of them). With a graphics card, GPU use should rise (Vulkan on Windows, Metal on Apple Silicon).
- [ ] H8. The token counter under the chat shows "Last answer" and "This session" and grows with each answer. Roughly compare the numbers with the length of the text.
- [ ] H9. Choose another language (for example Turkish): a weak-language warning must appear for the 4B model.
- [ ] H10. Quit the program. In Task Manager or Activity Monitor no `llama-server` may remain after a few seconds. Open it again: Start works without downloading again.
- [ ] H11. Back on the Local screen press Delete downloaded model: Start becomes disabled and the disk space is freed.

## I. CLI AI (Windows and Mac program only; only for tools you have installed)

- [ ] I1. AI Tutor > CLI. Every tool is listed: OpenAI Codex CLI, Gemini CLI, goose. Installed ones say Found with a version, the others say Not found, show how to install them and cannot be chosen. Install one in a terminal and press Check again: it turns to Found.
- [ ] I2. Each tool says where your questions go (cloud or your PC). Confirm that matches how you set the tool up; for goose it depends on the provider you chose in `goose configure`.
- [ ] I3. For each tool you have, sign in once in a terminal (the screen shows the command), choose the tool, build a course and ask a chat question. The answer must be plain text and the tool must not change any file in your folders.
- [ ] I4. If you are not signed in, the error must say to sign in (login), not show a stack trace.
- [ ] I5. Press Stop during a long answer: it stops, and nothing keeps running in Task Manager or Activity Monitor afterwards.
- [ ] I6. The token counter appears. Compare its numbers with the tool's own usage numbers if it shows any (CLI numbers are estimates and say "about").
- [ ] I7. Online key: Use an online key instead still works as before (key, test, save, build a course).
- [ ] I8. Run the manual GitHub run **Verify AI catalog** once (see `FIRST-BUILD.md`) and tell me the result.
