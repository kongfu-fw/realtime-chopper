import type { Lang } from '../types'
import {
  chunkForSpeech,
  clampRate,
  langPrefixes,
  type SpeakOptions,
  type SpeakOutcome,
  type TtsEngine,
  type VoiceOption,
} from './engine'

/**
 * Microsoft Edge TTS, through a proxy the user runs.
 *
 * Why a proxy is not optional: the read-aloud service needs a handshake header
 * (`Sec-MS-GEC`) that a page is not allowed to set — browsers forbid custom
 * headers on `WebSocket`, and `Origin` is not ours to choose. That is the whole
 * reason this app shipped with the platform's own `speechSynthesis` instead (see
 * `speech.ts`). A tiny server-side component that can set those headers turns the
 * same service back into something a web page can use, which is what
 * `cloudflare-edge-tts` is: three routes, no keys, CORS open.
 *
 * What the proxy buys, beyond voice quality:
 *
 *  - Real neural voices on every platform. iOS exposes only the system voices
 *    (see DOCS.md on why Edge on iOS is a WebKit shell), and this route does not
 *    care which browser or OS is asking.
 *  - Playback through the media path instead of "system speech", which is what
 *    iOS demotes to the receiver while the microphone is held open. Measured on
 *    an open mic, the system engine can be *correct and inaudible*; this engine
 *    cannot be, because it is ordinary media.
 *
 * What it costs, all of it deliberate:
 *
 *  - A network round trip per sentence. The next chunk is synthesised while the
 *    current one plays, which hides most of it, but this engine can never be as
 *    instant as the local one.
 *  - The service is a third party. The proxy is the user's own, and the app never
 *    falls back to it silently — switching engines is a setting a person makes.
 *  - Rate is applied locally rather than asked for in the request, because the
 *    proxy takes text and voice only. `preservesPitch` on the audio element is
 *    what keeps a 1.8x read-out from sounding like a chipmunk, and it is also why
 *    the rate can change mid-sentence without re-synthesising anything.
 */

/** The proxy this build points at until the user says otherwise. */
export const EDGE_TTS_DEFAULT_PROXY = 'https://cloudflare-edge-tts.fushao2406.workers.dev'

/**
 * The voice each language falls back to, by `ShortName`.
 *
 * Only a fallback: the real list comes from the proxy (`GET /voices`, ~320
 * entries), and if a name here is missing from that list the first voice of the
 * language is used instead — so a proxy with a different voice set still works.
 */
export const EDGE_TTS_DEFAULT_VOICE: Record<Lang, string> = {
  zh: 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-AvaMultilingualNeural',
  ko: 'ko-KR-SunHiNeural',
}

/**
 * The voice list is 130 KB and identical for every instance, so it is fetched
 * once per proxy URL and shared. Failures are not cached: a proxy that was
 * briefly down must be able to answer on the next look.
 */
const voiceCache = new Map<string, Promise<VoiceOption[]>>()

interface EdgeVoiceEntry {
  ShortName?: string
  Name?: string
  Locale?: string
}

/**
 * Voice-list budget.
 *
 * The 2.5 s the callers pass is calibrated for the platform's *local* list, which
 * is why it is raised rather than honoured here: 130 KB over a phone connection
 * legitimately takes longer than that, and a timeout that fires early would
 * report "没有可用音色" for a proxy that is working fine.
 */
const VOICES_TIMEOUT_MS = 10_000

/** Synthesis budget for one chunk. The first byte can take a while; 20 s cannot. */
const SYNTH_TIMEOUT_MS = 20_000

/** Used when the element reports no usable duration for a chunk. */
const ASSUMED_CHUNK_SECONDS = 30

export class EdgeTtsEngine implements TtsEngine {
  readonly id = 'edge'
  readonly label = 'Edge TTS 代理'
  private readonly proxyUrl: string
  private audio: HTMLAudioElement | null = null
  private primed = false
  /** Every request still in flight — two can be, because of the prefetch below. */
  private readonly inFlight = new Set<AbortController>()
  /** Set while a chunk is being played, so `stop()` can settle it as cancelled. */
  private finishCurrent: ((outcome: SpeakOutcome) => void) | null = null
  private cancelRequested = false
  private speakingFlag = false

  constructor(options: { proxyUrl: string }) {
    // Trailing slashes are the one thing a hand-typed URL gets wrong, and
    // `//tts` on a Worker returns the router's 404.
    this.proxyUrl = options.proxyUrl.trim().replace(/\/+$/, '')
  }

  get available(): boolean {
    return this.proxyUrl.length > 0
  }

  get speaking(): boolean {
    return this.speakingFlag
  }

  /**
   * iOS will not let an `<audio>` element start from outside a user gesture, and
   * read-aloud is driven by the pipeline rather than by a tap — so the element is
   * primed here, inside the first tap, with a silent WAV that is *generated*: no
   * request, no asset to keep in sync with the code, and it is guaranteed
   * decodable because the bytes are built to spec below.
   */
  unlock(): void {
    if (!this.available || this.primed) return
    const audio = this.ensureAudio()
    this.primed = true
    audio.muted = true
    audio.src = silentWavUrl()
    void audio
      .play()
      .then(() => {
        audio.pause()
        audio.removeAttribute('src')
        audio.muted = false
      })
      .catch(() => {
        // A refused prime is not fatal: the real playback will surface it, and
        // `speaking`/the log are where that shows up.
        this.primed = false
        audio.muted = false
      })
  }

  async speak(text: string, options: SpeakOptions): Promise<SpeakOutcome> {
    if (!this.available) return 'error'
    const chunks = chunkForSpeech(text)
    if (chunks.length === 0) return 'done'
    this.cancelRequested = false
    const voice = await this.voiceFor(options.lang, options.voiceURI)
    if (this.cancelRequested) return 'cancelled'
    let ahead: Promise<Blob> | null = null
    // An abandoned prefetch that rejects later must not surface as an unhandled
    // rejection: it was nobody's answer any more the moment we gave up.
    const discard = () => void ahead?.catch(() => undefined)
    for (let i = 0; i < chunks.length; i++) {
      if (this.cancelRequested) {
        discard()
        return 'cancelled'
      }
      const current = ahead ?? this.synthesize(chunks[i], voice)
      // The request is the slow half and it does not depend on playback, so the
      // next chunk is synthesised while this one is being read. Without that,
      // every sentence pays the whole round trip in silence after it.
      ahead = i + 1 < chunks.length ? this.synthesize(chunks[i + 1], voice) : null
      let bytes: Blob
      try {
        bytes = await current
      } catch (err) {
        discard()
        // An abort is a stop, not a failure: `stop()` is what asked for it.
        if (this.cancelRequested) return 'cancelled'
        throw err instanceof Error ? err : new Error(String(err))
      }
      const outcome = await this.playChunk(bytes, options.rate)
      if (outcome !== 'done') {
        discard()
        return outcome
      }
    }
    return 'done'
  }

  stop(): void {
    this.cancelRequested = true
    for (const controller of this.inFlight) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    this.inFlight.clear()
    const audio = this.audio
    if (audio) {
      audio.pause()
      try {
        audio.removeAttribute('src')
      } catch {
        /* ignore */
      }
    }
    // Settle the chunk that is waiting, or the read pump would sit on a promise
    // that only an `ended` event can resolve — and no event is coming.
    this.finishCurrent?.('cancelled')
    this.speakingFlag = false
  }

  async voicesFor(lang: Lang, _timeoutMs?: number): Promise<VoiceOption[]> {
    if (!this.available) return []
    const all = await voices(this.proxyUrl)
    const prefix = langPrefixes(lang)
    return all.filter((voice) => prefix.some((p) => voice.lang.toLowerCase().startsWith(p)))
  }

  /** The `ShortName` to synthesise with, resolving the fallback chain. */
  private async voiceFor(lang: Lang, requested?: string): Promise<string> {
    const explicit = requested?.trim()
    if (explicit) return explicit
    const preferred = EDGE_TTS_DEFAULT_VOICE[lang]
    try {
      const list = await this.voicesFor(lang)
      if (list.some((voice) => voice.voiceURI === preferred)) return preferred
      if (list.length > 0) return list[0].voiceURI
    } catch {
      // Offline or proxy down: the built-in name is still the best guess, and
      // the request that follows will report the real problem.
    }
    return preferred
  }

  private async synthesize(text: string, voice: string): Promise<Blob> {
    const controller = new AbortController()
    this.inFlight.add(controller)
    const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.proxyUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(await failureText(response))
      return await response.blob()
    } finally {
      clearTimeout(timer)
      this.inFlight.delete(controller)
    }
  }

  /**
   * Plays one chunk through an `<audio>` element, with the same two watchdogs the
   * system engine needs and for one of the same reasons: a platform that never
   * fires its completion event must not be able to wedge the reading pump.
   *
   * The element is not a stylistic choice. `playbackRate` on media preserves
   * pitch, so the backlog-driven speed-up stays intelligible; doing the same on
   * an `AudioBufferSourceNode` would resample the audio and hand the user a
   * chipmunk.
   */
  private playChunk(bytes: Blob, rate: number): Promise<SpeakOutcome> {
    const audio = this.ensureAudio()
    const url = URL.createObjectURL(bytes)
    return new Promise<SpeakOutcome>((finish) => {
      let settled = false
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const settle = (outcome: SpeakOutcome) => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        audio.onended = null
        audio.onerror = null
        this.finishCurrent = null
        this.speakingFlag = false
        URL.revokeObjectURL(url)
        finish(outcome)
      }
      this.finishCurrent = settle
      audio.onended = () => settle('done')
      // The element reports nothing useful about *why* it failed; the log line
      // that follows this outcome is what a bug report can act on.
      audio.onerror = () => settle('error')
      audio.muted = false
      audio.src = url
      audio.playbackRate = clampRate(rate)
      audio.preservesPitch = true
      this.speakingFlag = true
      audio
        .play()
        .then(() => {
          // Duration is known once playback starts, so the watchdog is exact
          // rather than estimated: the chunk's own length divided by the rate,
          // plus room for the last frames to drain.
          const seconds = Number.isFinite(audio.duration) ? audio.duration : ASSUMED_CHUNK_SECONDS
          watchdog = setTimeout(() => settle('stalled'), (seconds / clampRate(rate)) * 1000 + 5000)
        })
        .catch(() => settle('error'))
    })
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      const audio = new Audio()
      // Playback is started by the pipeline, not by a click on the media itself,
      // and this element is never shown.
      audio.preload = 'auto'
      this.audio = audio
    }
    return this.audio
  }
}

async function voices(proxyUrl: string): Promise<VoiceOption[]> {
  const cached = voiceCache.get(proxyUrl)
  if (cached) return cached
  const load = fetchVoices(proxyUrl)
  voiceCache.set(proxyUrl, load)
  load.catch(() => voiceCache.delete(proxyUrl))
  return load
}

async function fetchVoices(proxyUrl: string): Promise<VoiceOption[]> {
  const response = await fetch(`${proxyUrl}/voices`, { signal: AbortSignal.timeout(VOICES_TIMEOUT_MS) })
  if (!response.ok) throw new Error(await failureText(response))
  const body = (await response.json()) as { voices?: EdgeVoiceEntry[] }
  const entries = Array.isArray(body.voices) ? body.voices : []
  return entries
    .filter((entry) => typeof entry.ShortName === 'string' && entry.ShortName.length > 0)
    .map((entry) => ({
      voiceURI: entry.ShortName as string,
      // The ShortName is the honest label: the proxy speaks `ShortName`s, and
      // inventing a friendlier name here would only make a mismatch with the
      // picked value harder to see.
      name: entry.ShortName as string,
      lang: entry.Locale ?? (entry.ShortName as string).slice(0, 5),
      // Synthesised on a server, so the picker labels it 「（网络）」 — the same
      // flag the desktop browsers' network voices carry.
      localService: false,
      default: false,
    }))
}

/** Turns an error response into one line the log can quote. */
async function failureText(response: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    if (body.error?.message) detail = `：${body.error.message}`
  } catch {
    /* not JSON, or already consumed — the status alone still helps */
  }
  return `TTS 代理返回 HTTP ${response.status}${detail}`
}

/**
 * A silent WAV as a `data:` URI, built rather than shipped.
 *
 * 100 ms of 16-bit mono at 8 kHz is enough for the platform to consider the
 * element played, which is the whole point of the prime in `unlock`.
 */
function silentWavUrl(ms = 100): string {
  const rate = 8000
  const samples = Math.round((rate * ms) / 1000)
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)
  // Samples stay zero: silence is the entire payload.
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:audio/wav;base64,${btoa(binary)}`
}
