# Android app: build it in Android Studio and publish it on Google Play

GitHub does not build the Android app and no APK is made. You build a signed app bundle (`.aab`) on your own computer and upload it to the Google Play Console. This guide gives the steps. Google's own rules change over time, so where it says "check the Play Console", the Console is the source of truth.

## 0. What you need

- A Google Play developer account (made at https://play.google.com/console; Google charges a one-time registration fee and may verify your identity).
- Node 22 or newer (https://nodejs.org).
- Android Studio Otter 2025.2.1 or newer (https://developer.android.com/studio). It brings its own Java, so you do not install Java separately.
- An Android phone with a USB cable, or the emulator that comes with Android Studio.

## 1. Check the app id now

The app id is `app.studydesk.planner`. It identifies the app on Google Play and **cannot be changed after your first upload**. If you want a different one, tell Claude before you build.

## 2. Prepare the project

In a terminal inside the project's `mobile` folder:

```
npm install
npm run sync
```

`npm install` fetches the Capacitor parts the Android project needs (do this once, and again if a `node_modules` folder is missing). `npm run sync` copies the current Study Desk page into the Android project. Run `npm run sync` again whenever `app/index.html` changes.

## 3. Open it in Android Studio and run it

1. Start Android Studio, choose **Open**, and pick the folder `mobile/android` (not `mobile`).
2. Wait for **Gradle sync** to finish (the first time it downloads a lot and can take several minutes). If it asks to install a missing SDK platform or tool, accept.
3. Pick your phone or an emulator in the device list at the top and press the green **Run** button.
4. Go through `TEST-CHECKLIST.md`, section D.

## 3b. A quick installable file for your own phone (no Google Play)

Handy for testing or for using the app yourself before it is on Google Play:

1. In Android Studio choose **Build**, then **Build Bundle(s) / APK(s)**, then **Build APK(s)**.
2. When the notice "APK(s) generated successfully" appears, click **locate**. The file is called `app-debug` (its type is APK).
3. Copy it to your phone (USB cable, Google Drive, e-mail to yourself) and open it there. Android asks you to allow **Install unknown apps** for the app you opened it from (Files, Chrome, Drive); allow it once and tap **Install**. Google Play Protect may show a warning for an app that is not from the Play Store; choose **Install anyway**.
4. This file is signed with Android's automatic debug key. It works on your own phone but Google Play does not accept it; for Google Play use the signed bundle in section 5. If you later install the Play Store version, **uninstall** the debug one first, because the two are signed differently.

## 4. Version numbers

Google Play rejects an upload whose `versionCode` is not higher than the last one. For each upload edit `mobile/version.json` (`versionName` like `1.0.1`, `versionCode` a whole number higher than before) and apply it with `py scripts/set-android-version.py` on Windows (`python3 scripts/set-android-version.py` on Mac or Linux; needs Python 3). Without Python, change the `versionCode` and `versionName` lines in `mobile/android/app/build.gradle` **and** the two values in `mobile/version.json` to the same numbers. The GitHub tests fail if the two disagree.

## 5. Make your upload key and build the signed bundle

1. In Android Studio: **Build**, then **Generate Signed App Bundle / APK...**, choose **Android App Bundle**, **Next**.
2. Under Key store path click **Create new...**. Save the key file **outside the project folder** (for example in a private folder in Documents), choose passwords and an alias, and fill in the form.
3. **Back up the key file and the passwords** somewhere safe (a password manager and a copy on another drive). Never put them in GitHub, in this project or in a chat. This is your *upload key*. If you lose it Google can usually reset it for you, but it takes time.
4. Choose the **release** build variant and click **Create**. Android Studio shows a notice with a **locate** link to the finished `.aab` file.

You use **Play App Signing**: the Play Console offers it when you upload the first bundle, and Google keeps the final app signing key. Accept it.

## 6. Publish on Google Play

In the Play Console create the app (name "Study Desk"), then upload the `.aab`. Try an **internal testing** release first and install it from the Play Store on your phone.

The Console asks for several things before production. Typical ones (the Console shows the current requirements checklist, follow that):

- Store listing: short and full description, app icon (512 x 512; `desktop/icon.png` is that size), a feature graphic and phone screenshots.
- A **privacy policy** page address.
- The **data safety** form (what data the app collects or shares; see the AI note below).
- Content rating questionnaire, target audience, ads declaration.
- New developer accounts may need a **closed test** with a minimum number of testers for a **testing period** before production access. Check the current rule in the Console.
- The minimum Android target level Google requires for new apps. This project targets API level 36 (Android 16). Check in the Console that this still meets the current requirement.

## 7. The AI Tutor and Google Play

The app contains the AI Tutor. It sends the user's text to the AI service the user chooses, with the user's own key. Google Play has its own rules for apps that offer **AI-generated content** (for example a way for users to report offensive output) and for declaring data sent to third parties in the **data safety** form. Meeting them may need a small change to the app. That change is not part of this project; decide before you submit. Ask Claude for help with it. The Android app has only the API key way of using the AI Tutor: there is no Local and no CLI AI on Android (they need the Windows or Mac program), so the Local and CLI screens never appear there.

## 8. After it is published: link it on the download page

1. Copy your app's Play Store address. It looks like `https://play.google.com/store/apps/details?id=app.studydesk.planner`.
2. In `site/index.html` find the line `const PLAY_STORE_URL = "";` and put the address between the quotes.
3. Run `node scripts/check.js --stamp` in the project folder (updates the page's security hash).
4. Commit it and push it to GitHub (the `main` branch). The page is republished automatically; no new version tag is needed.

Only an address for exactly this app id is accepted by the page.

## Keep out of GitHub

The key file, its passwords, and `local.properties`. The `.gitignore` already skips key files, and a test fails if one appears in the project.
