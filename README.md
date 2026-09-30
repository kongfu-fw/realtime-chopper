# Realtime Chopper

English | [简体中文](README.zh-CN.md)

---

## Name
**Realtime Chopper** is named after Tony Tony Chopper from *One Piece*, the reindeer doctor who understands both human and animal languages. 

It is a zero-backend, privacy-first, and serverless real-time speech translation web application. All speech recognition runs directly inside your browser: audio is processed on-device and never uploaded to any server.

## Features
- **On-Device Speech Recognition**: Runs AI models directly in the browser via WebGPU / WASM (Moonshine Base ~62MB for English, SenseVoice Small int8 ~240MB for Chinese and Korean, and a ~64MB Moonshine Korean model for phones where the 240MB one cannot be held). Models are cached locally after the first download; one module is resident at a time.
- **Multi-Provider Cloud Translation**: Built-in Google Translate with automatic fallback to Microsoft Translator, along with support for custom AI / LLM API keys.
- **Real-Time Dual-Column Subtitles**: Displays original and translated text side-by-side with synchronized scrolling (automatically adapts to a top-and-bottom stacked layout on mobile).
- **Adaptive Speech Synthesis (TTS)**: Reads translations aloud in real time using the browser's native Speech Synthesis API, with smart speed acceleration (up to 1.8x) to keep up with fast speech without dropping sentences. An optional **Edge TTS proxy** engine can be selected in Settings for cross-platform neural voices; it starts fetching a sentence's audio as soon as its translation exists (bounded concurrency plus a small cache of unplayed chunks), so reading a backlog does not wait on the network per sentence (see `DOCS.md`).
- **The Screen Stays Awake While Recording**: on a phone, a screen that locks freezes the page and takes the microphone with it — and nobody touches the screen during a lesson. Recording now holds a Screen Wake Lock (Safari 16.4+, or iOS 18.4+ for a Home Screen app) and re-takes it every time the page comes back; when the system refuses (Low Power Mode), the log says so and names the setting that fixes it. If the screen does go dark once, the session continues with a gap it tells you about, or stops cleanly rather than pretending to record.
- **An Open App Updates Itself**: the service worker only picks up a new shell on a navigation, and iOS can leave an installed app suspended for days without one — so the phone runs an old build while every check from outside says the deployment is current (a “wake lock did not work” report can be exactly that). The page now reads its own version out of the served `index.html` at startup, on every return to the foreground, and every five minutes while open: it reloads itself when nothing would be lost, writes one line to the log while a session is on screen, and never reloads twice for one version.
- **A Draggable Split Between Original and Translation**: the handle between the two panels can be dragged (it turns horizontal in portrait, and the arrow keys work too), and the proportion is remembered on the device. Translations wear one of four sizes by recency — the newest is the largest, and older ones step down — and a line whose translation has not arrived yet renders nothing, fading in when the text lands.
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
```

### How to Use
1. Click the center control button to launch.
2. On first run, confirm to download the required speech recognition model (cached in browser storage).
3. Grant microphone permission and speak naturally.

> **Important Notes**:
> - Microphone access requires `localhost`, `127.0.0.1`, or `https://` due to browser security restrictions.
> - Wearing headphones is strongly recommended to avoid audio loopback between your speakers and microphone.

## License
This project is licensed under the [Apache-2.0 License](LICENSE).  
Copyright © 2026 Kongfu-fw
