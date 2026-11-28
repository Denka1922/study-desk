# Study Desk privacy policy

Last updated: 2026-11-28

Study Desk is a free, open-source student planner for Windows, Mac and Android. This page says what leaves your device and why. The short version: **your planner stays on your device, there are no accounts, and nothing is collected about you.**

## What Study Desk does not do

- There is **no account** and no login to us. We run **no server** and receive nothing from you.
- There is **no analytics, no tracking, no advertising and no crash reporting**.
- Your calendar, to-dos, grades and saved lessons are **stored on your own device**. They are not uploaded anywhere unless you turn on Sync (below).
- The program does not update itself and does not change your system settings. To remove it, uninstall it (on Android, remove the app or clear its data); that deletes what it stored.

## When something does leave your device

Each of these happens only when you use that feature, or when the program starts (fonts).

**Fonts.** When the app page opens with an internet connection, it asks Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) for its three typefaces. Google can see your IP address and your browser type, as for any website. Without internet the program works and uses ordinary system fonts.

**AI Tutor, with your own key.** If you choose Anthropic, OpenAI or Google Gemini, the topic you ask for, the lesson text, and the questions and answers you type are sent to that company (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`) using the key you entered. That company's privacy policy then applies. Your calendar, to-dos and grades are not part of what is sent. We never see your key. By default the key is kept only until you close the program; it is stored on your computer only if you tick "Remember on this computer".

**AI Tutor, on this computer (Local or CLI).** A Local model runs on your computer and nothing is sent. A command-line tool you connect (for example one of the AI command-line programs) runs on your computer and talks to its own service under its own privacy policy.

**Downloads.** The program downloads models and the engine only when you press Download, from `github.com` (and `githubusercontent.com`), `huggingface.co` (and `hf.co`), and the package registry `registry.npmjs.org`. Those sites see your IP address, like any download. Every file is checked against a fixed fingerprint before it is used.

**Voice tutor.** The spoken voice is made on your computer. If you use the optional VoiceStudio program, Study Desk talks to it only on your own computer (`127.0.0.1`). **Speaking your answers:** when you press the microphone, or when you chose Mic open and it is your turn, your voice is turned into text **on your computer**. The recording is **never sent anywhere** and is not saved after it has been understood. The microphone is used only while the Voice tutor is listening, and your system asks for your permission first.

**Sync.** If you turn on Sync, your own devices exchange your planner data, encrypted, either directly on your Wi-Fi (the port `47821`) or through a relay that you deploy yourself on your own Cloudflare account. We do not run a relay and cannot read your data.

**Links you click.** Shortcut buttons open the websites you chose in your browser. Those sites have their own policies.

**This website and feedback.** The download page is hosted on GitHub Pages and asks the GitHub API for the latest release, so GitHub sees your IP address. The report and review forms open on GitHub; what you write there is **public**, together with your GitHub name, and is covered by GitHub's policy. Please never write passwords, API keys or personal details there. Reviews are shown on the page without the writer's name, and only after the owner approves them.

## Children and students

Study Desk is made for students and collects no personal information from anyone.

## Your choices

You can use the planner without internet and without any of the features above. You can delete everything by uninstalling the program or clearing its data. You can remove a downloaded model or listener in the program, under More.

## Contact and changes

Ask questions or report a problem in this project's [Issues](https://github.com/Denka1922/study-desk/issues) on GitHub. If this policy changes, the date at the top changes, and the old versions stay visible in the project's history.
