# Realtime Chopper

English | [简体中文](README.zh-CN.md)

---

## Name
**Realtime Chopper** is named after Tony Tony Chopper from *One Piece*, the reindeer doctor who understands both human and animal languages. 

It is a zero-backend, privacy-first, and serverless real-time speech translation web application. All speech recognition runs directly inside your browser: audio is processed on-device and never uploaded to any server.

## Features
- **On-Device Speech Recognition**: One model answers every source language — SenseVoice Small int8 (~240 MB), running directly in the browser via WASM (Chinese, English, Korean, Japanese and Cantonese, with the language picked per utterance). It is cached locally after the first download. iOS hands a web page far less memory than this needs, so recognition is available on desktop browsers (and any device that can hold it) only.
- **Multi-Provider Cloud Translation**: Built-in Google Translate with automatic fallback to Microsoft Translator, along with support for custom AI / LLM API keys.
- **Real-Time Dual-Column Subtitles**: Displays original and translated text side-by-side with synchronized scrolling (automatically adapts to a top-and-bottom stacked layout on mobile).
- **Adaptive Speech Synthesis (TTS)**: Reads translations aloud in real time using the browser's native Speech Synthesis API, with smart speed acceleration (up to 1.8x) to keep up with fast speech without dropping sentences. An optional **Edge TTS proxy** engine can be selected in Settings for cross-platform neural voices; it starts fetching a sentence's audio as soon as its translation exists (bounded concurrency plus a small cache of unplayed chunks), so reading a backlog does not wait on the network per sentence (see `DOCS.md`).
- **The Screen Stays Awake While Recording**: on a phone, a screen that locks freezes the page and takes the microphone with it — and nobody touches the screen during a lesson. Recording now holds a Screen Wake Lock (Safari 16.4+, or iOS 18.4+ for a Home Screen app) and re-takes it every time the page comes back; when the system refuses (Low Power Mode), the log says so and names the setting that fixes it. If the screen does go dark once, the session continues with a gap it tells you about, or stops cleanly rather than pretending to record.
- **An Open App Updates Itself**: the service worker only picks up a new shell on a navigation, and iOS can leave an installed app suspended for days without one — so the phone runs an old build while every check from outside says the deployment is current (a “wake lock did not work” report can be exactly that). The page now reads its own version out of the served `index.html` at startup, on every return to the foreground, and every five minutes while open: it reloads itself when nothing would be lost, writes one line to the log while a session is on screen, and never reloads twice for one version.
- **A Start Page**: a cold launch opens on the app's name and two square cards: **Start recording** and **History**. The card opens the recording screen and nothing else; the record button there starts (the same button pauses, resumes and cancels), and a missing module is downloaded in the dialog that button raises. When the recording actually begins the page fades into the transcript.
- **A Pause With Three Ways Out**: the footer button says Pause, and pausing brings up a panel that draws the header's own clock — voiceprint and time, enlarged and centred (it grows into place), deliberately without the header's download button, which would be a fourth and wordless way out of a panel that has three — above three buttons: **Save** (name it first, then file it into the history and go look at it; the note is badged as new), **Resume**, and **Start a new recording** (file this one, clear the transcript, open the microphone on the next). The clock keeps counting across a pause.
- **Recording Notes**: what a session leaves behind is a note, not just text — the audio (16 kHz WAV), the recognised sentences and their translations all live on the device in OPFS (`rc-history/`), newest first. The list is headed by a small title and carries no back button (the drawer behind the logo is the way between destinations, and the system's own back key retraces the step that was actually taken); open a note and its own screen keeps a `Back`, with the player and its download on one row. Read it sentence by sentence, play or download its recording, or rename it (the date and the place are fields, so a rename keeps them). The title is generated from date, time and place, with the place resolved by position → reverse geocoding → timezone. `Select` mode deletes in batches, the way a phone's photo library does.
- **A Draggable Split Between Original and Translation**: the handle between the two panels can be dragged (it turns horizontal in portrait, and the arrow keys work too), and the proportion is remembered on the device. Translations wear one of three sizes by recency — the newest is the largest, and older ones step down — and a line whose translation has not arrived yet renders nothing, fading in when the text lands.
- **Everything about how it speaks in one dialog**: the button beside the read-aloud switch in the footer holds the translator, the read-aloud engine and the voice — the three settings that decide what comes out of the phone, reachable mid-lesson.
- **Settings in three layers**: what changes every lesson (language, translator, voice) sits on the panels and in the read-aloud dialog; what is set once (interface language, icon, keep-audio) sits in Settings; what is for tuning (recognition, AI keys, speed, logs) only appears once debug mode is on.
- **The Back Key, One Layer at a Time**: every screen and panel that is open registers itself as a layer (`lib/app/back.ts`), and the browser's history is kept in step with that stack — one entry per open layer, never one more. A back press closes the top layer and only the top layer (a dialog goes, the note behind it stays), a drawer shuts without moving the screen under it, and the list of notes returns to the screen it was opened from, because the app remembers the screen it came from instead of trying to guess it. The app's own `Back` buttons leave through the same door and hand their entry back on the way out. With nothing open the app holds no entries at all, so the back key belongs to the browser again — on Android the app goes to the background, as it does in everything else.
- **Every Screen Has Its Own Address**: `/` is the start page (or the transcript while a session is running), `#/settings` is Settings, `#/history` is the list of notes and `#/history/<id>` is one note (`lib/app/route.ts` says how a screen is spelled, and `lib/app/back.ts` keeps the bar in step with the layer stack). A refresh stays on the screen it was taken on, and a link from anywhere — a bookmark, a chat message, a Home Screen shortcut — opens that screen directly, in a page that never saw the rest. The same stack answers the back key out of a link: the note, the list it came from, then home. The window's own title carries the screen too (`记录详情 · 乔巴 · 录音笔记`), so four of these open in a tab strip are four distinguishable windows. The address is a `#` fragment on purpose: this app is a static folder that works from a sub-path, and only the fragment never reaches the server.
- **A Clock, a Voiceprint and the Recording**: the middle of the header shows how long this recording has been running, with a five-bar voiceprint driven by the microphone; once the recording pauses or stops a download button appears between the voiceprint and the clock and saves the session as a `.wav` on the phone. Both panels export their own column as a `.txt`.
- **A Microphone the System Takes Away Comes Back by Itself**: iOS can reclaim the device while the page stays on screen (a call, another app opening the microphone), and nothing fires when it does. Recording checks liveness once a second and waits for two consecutive dead looks before believing it; when the microphone cannot be repaired the session stops cleanly and remembers that the stop was not the user's — coming back to the app starts recording again.
- **Audio History & Segment Re-decode**: Stores in-session audio in local memory so you can replay or re-transcribe any specific segment if recognition was inaccurate.
- **Trilingual Interface (中文 / English / 한국어)**: The whole interface — including log lines and the diagnostic report — follows the browser language automatically, with a manual override in Settings (or `?lang=en`).
- **PWA & Privacy-First**: 100% client-side architecture with zero account requirement. Can be installed as a PWA on mobile and desktop. Only text is sent to translation providers.

## Quick Start

### Requirements
- Node.js 20+
- A modern browser with microphone support (Chrome, Edge, Safari, Firefox)

### Development
```bash
# Install dependencies
npm ci

# Start the dev server
npm run dev

# End-to-end run: builds, then drives the built app in headless Chrome (needs Chrome and network)
npm run e2e
```

### How to Use
1. The app opens on its start page: two cards, **Start recording** and **History**. Tap the first one to open the recording screen, then press the record button at the bottom left. On the first run that button raises the install dialog and downloads the speech model from there (it is cached in browser storage afterwards).
2. A first run also asks you to put your headphones on — do it, or the microphone will hear the phone reading translations back.
3. Grant microphone permission and the session starts; the page fades into the two columns. Tap the footer button again to leave a start that is waiting on the permission prompt.
4. To put the phone down mid-lesson, tap that button again — it says Pause — and pick one of the three things on the panel: **Save** (into the history, with a chance to rename it first), **Resume**, or **Start a new recording**.
5. Everything recorded before is in **History**: the start page's second card, or the same row in the drawer behind the logo at the top left (that drawer, with `Home` at the top of its destinations, is also the way out of the list). Open a note to read it, play it, download it, rename it, or select several and delete them. The system's back key works as well, one layer at a time (note → list → the screen you came from).
6. Languages live on the two panel headers (「说 / 译」), and the voice, the read-aloud engine and the translator live behind the settings button beside the read-aloud switch in the footer.

> **Important Notes**:
> - Microphone access requires `localhost`, `127.0.0.1`, or `https://` due to browser security restrictions.
> - Wearing headphones is strongly recommended to avoid audio loopback between your speakers and microphone.

## License
This project is licensed under the [Apache-2.0 License](LICENSE).  
Copyright © 2026 Kongfu-fw
