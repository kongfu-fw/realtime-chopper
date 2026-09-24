# Realtime Chopper

English | [简体中文](README.zh-CN.md)

---

## Name
**Realtime Chopper** is named after Tony Tony Chopper from *One Piece*, the reindeer doctor who understands both human and animal languages. 

It is a zero-backend, privacy-first, and serverless real-time speech translation web application. All speech recognition runs directly inside your browser: audio is processed on-device and never uploaded to any server.

## Features
- **On-Device Speech Recognition**: Runs AI models directly in the browser via WebGPU / WASM (Moonshine Base ~62MB for English, SenseVoice Small int8 ~240MB for Chinese & Korean). Models are cached locally after the first download.
- **Multi-Provider Cloud Translation**: Built-in Google Translate with automatic fallback to Microsoft Translator, along with support for custom AI / LLM API keys.
- **Real-Time Dual-Column Subtitles**: Displays original and translated text side-by-side with synchronized scrolling (automatically adapts to a top-and-bottom stacked layout on mobile).
- **Adaptive Speech Synthesis (TTS)**: Reads translations aloud in real time using the browser's native Speech Synthesis API, with smart speed acceleration (up to 1.8x) to keep up with fast speech without dropping sentences.
- **Audio History & Segment Re-decode**: Stores in-session audio in local memory so you can replay or re-transcribe any specific segment if recognition was inaccurate.
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
