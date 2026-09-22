import type { Lang } from '../types'

/**
 * Speech output through the browser's own TTS (requirement 4).
 *
 * Why not Edge TTS: Microsoft's read-aloud endpoint requires a handshake header
 * (`Sec-MS-GEC`) that a page cannot set — browsers forbid custom headers on
 * `WebSocket`, and `Origin` is not ours to choose. Extensions can work around
 * that; a web app cannot. `speechSynthesis` needs no server, cannot be
 * rate-limited by a third party, and — the decisive part for requirement 6 —
 * exposes the speaking rate as a live property, so following the queue backlog
 * costs nothing (with Edge TTS every rate change would mean re-synthesising
 * audio).
 *
 * What we give up, and therefore must design around:
 *  - **No audio buffer.** The synthesised audio cannot be captured as a Blob or
 *    a MediaStream, so only live playback is possible.
 *  - **Rate applies to the next sentence**, never to the one already speaking.
 *  - **Voices are the platform's.** iOS offers only pre-installed system
 *    voices, Chrome desktop uses Google's network voices, and Safari stops
 *    speaking when the tab is backgrounded.
 *  - **Long utterances get truncated** (Chrome cuts around 200–250 characters),
 *    so everything is split at punctuation before it goes out.
 */

/** Chrome truncates long utterances; keep well under the observed limit. */
const MAX_CHUNK_CHARS = 150

export interface VoiceOption {
  voiceURI: string
  name: string
  lang: string
  localService: boolean
  default: boolean
}

export interface SpeakOptions {
  voiceURI?: string
  rate: number
  lang: Lang
}

export type SpeakOutcome = 'done' | 'cancelled' | 'error'

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export class SpeechEngine {
  private cancelRequested = false
  /** Set while we deliberately stopped so 'cancelled' is not logged as a bug. */
  private speakingFlag = false

  get speaking(): boolean {
    return this.speakingFlag
  }

  /**
   * Waits for the voice list. On iOS `getVoices()` is empty until some time
   * after load, and on Chrome the list arrives with `voiceschanged`, so a
   * timeout-bounded wait is the only reliable way to get a usable list.
   */
  async waitForVoices(timeoutMs = 2000): Promise<VoiceOption[]> {
    if (!speechSupported()) return []
    const synth = window.speechSynthesis
    const immediate = synth.getVoices()
    if (immediate.length > 0) return immediate.map(toOption)
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        synth.onvoiceschanged = null
        resolve(synth.getVoices().map(toOption))
      }
      synth.onvoiceschanged = finish
      setTimeout(finish, timeoutMs)
    })
  }

  /** Voices that can speak `lang`, best candidates first. */
  async voicesFor(lang: Lang, timeoutMs = 2000): Promise<VoiceOption[]> {
    const all = await this.waitForVoices(timeoutMs)
    const prefix = langPrefixes(lang)
    const matching = all.filter((voice) => prefix.some((p) => voice.lang.toLowerCase().startsWith(p)))
    // Locally-installed voices work offline and are far more responsive.
    return matching.sort((a, b) => Number(b.localService) - Number(a.localService))
  }

  /**
   * Must be called from a user gesture. iOS refuses to speak at all until the
   * page has produced speech inside a gesture handler.
   */
  unlock(lang: Lang = 'en'): void {
    if (!speechSupported()) return
    try {
      const utterance = new SpeechSynthesisUtterance(' ')
      utterance.volume = 0
      utterance.lang = lang === 'zh' ? 'zh-CN' : lang
      window.speechSynthesis.speak(utterance)
    } catch {
      /* nothing to do — the real speak() call will surface the problem */
    }
  }

  /**
   * Speaks `text` to completion. Resolves 'done', 'cancelled' (stop() called or
   * this utterance superseded) or 'error'.
   */
  async speak(text: string, options: SpeakOptions): Promise<SpeakOutcome> {
    if (!speechSupported()) return 'error'
    const chunks = chunkForSpeech(text)
    if (chunks.length === 0) return 'done'
    this.cancelRequested = false
    for (const chunk of chunks) {
      if (this.cancelRequested) return 'cancelled'
      const outcome = await this.speakChunk(chunk, options)
      if (outcome !== 'done') return outcome
    }
    return 'done'
  }

  stop(): void {
    if (!speechSupported()) return
    this.cancelRequested = true
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
    this.speakingFlag = false
  }

  private speakChunk(text: string, options: SpeakOptions): Promise<SpeakOutcome> {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis
      // iOS silently queues an utterance and never fires `end` unless the queue
      // is cleared first — this cancel() is load-bearing, not a formality.
      try {
        synth.cancel()
      } catch {
        /* ignore */
      }
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = clampRate(options.rate)
      utterance.lang = langTag(options.lang)
      const voice = this.findVoice(options.voiceURI)
      if (voice) utterance.voice = voice
      let settled = false
      const settle = (outcome: SpeakOutcome) => {
        if (settled) return
        settled = true
        this.speakingFlag = false
        resolve(outcome)
      }
      utterance.onend = () => settle('done')
      utterance.onerror = (event) => {
        // 'interrupted'/'canceled' arrive when we replaced or stopped the queue.
        const reason = (event as SpeechSynthesisErrorEvent).error
        settle(reason === 'interrupted' || reason === 'canceled' ? 'cancelled' : 'error')
      }
      this.speakingFlag = true
      try {
        synth.speak(utterance)
      } catch {
        settle('error')
      }
    })
  }

  private findVoice(voiceURI: string | undefined): SpeechSynthesisVoice | undefined {
    if (!voiceURI || !speechSupported()) return undefined
    return window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === voiceURI)
  }
}

/**
 * Splits text at sentence boundaries, then hard-wraps anything still too long.
 * Truncation is silent when it happens, so the split has to happen before the
 * browser sees the string.
 */
export function chunkForSpeech(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return []
  const sentences = trimmed.split(/(?<=[。！？!?；;])\s*/).flatMap((part) => hardWrap(part, maxChars))
  return sentences.map((s) => s.trim()).filter((s) => s.length > 0)
}

function hardWrap(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    // Prefer a comma inside the window; fall back to a space; last resort is a
    // hard cut, which is still better than the browser's silent truncation.
    const window = rest.slice(0, maxChars)
    const breakAt = Math.max(window.lastIndexOf(', '), window.lastIndexOf(' '), window.lastIndexOf('，'))
    const cut = breakAt > maxChars * 0.4 ? breakAt + 1 : maxChars
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) out.push(rest)
  return out
}

function langPrefixes(lang: Lang): string[] {
  switch (lang) {
    case 'zh':
      return ['zh', 'cmn']
    case 'ko':
      return ['ko']
    case 'en':
      return ['en']
  }
}

function langTag(lang: Lang): string {
  return lang === 'zh' ? 'zh-CN' : lang
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.min(2, Math.max(0.5, rate))
}

function toOption(voice: SpeechSynthesisVoice): VoiceOption {
  return {
    voiceURI: voice.voiceURI,
    name: voice.name,
    lang: voice.lang,
    localService: voice.localService,
    default: voice.default,
  }
}
