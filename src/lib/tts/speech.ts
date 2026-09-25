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
 *
 * None of the iOS failure modes throw, and every one of them looks the same from
 * the outside — "朗读坏掉了". They are enumerated here because each needs a
 * different answer, and the three the page *can* answer are answered below:
 *
 *  1. The platform leaves the synthesizer **paused**. iOS pauses speech
 *     synthesis when the page is backgrounded or the screen locks mid-sentence,
 *     and `cancel()` does not clear that flag: every later `speak()` is accepted,
 *     queued and never played, and `onend` never fires. `resume()` is the only
 *     way back, so it runs before every chunk.
 *  2. The completion callback never arrives — with or without (1) — which used to
 *     wedge the read pump forever, because `speak()` resolves only on `onend`.
 *     A watchdog now bounds both "never started" and "never ended".
 *  3. An utterance queued in the same task as the `cancel()` that made room for
 *     it can be dropped by WebKit. The cancel is therefore only issued when
 *     there is actually something to clear, and is followed by a real delay.
 *  4. The audio session is *demoted*, not paused. A page that holds the
 *     microphone open (this app is full-duplex by design) puts iOS in
 *     `play-and-record`, and Safari routes `speechSynthesis` — "system speech" —
 *     through the receiver at a whisper. Nothing in the API reports it: `onend`
 *     fires normally, the queue drains, and the user hears nothing. The page
 *     cannot fix this; it can only say so (see `snapshot()` and DOCS.md).
 *  5. The speaker is muted on the hardware switch. Also invisible from here.
 *  6. **Another app owns the system speech engine.** Screen reading (旁白),
 *     dictation and some third-party TTS engines serialise access to it: a
 *     `speak()` issued while one of them is talking is accepted and then dropped
 *     — no `start`, no `error`, nothing. This is the failure the "never started"
 *     watchdog below exists for; the old code waited for it forever.
 *
 * (1)–(3) and (6) are handled; (4)–(5) are diagnosed and explained to the user.
 *
 * Worth knowing before blaming this file, because the question comes up: what the
 * user hears is the *platform's* voice list, and the platform is not the browser
 * they think it is. Desktop Edge/Chrome are Chromium and attach a set of online
 * voices of their own (the ones the picker marks 网络) — that is where "Edge TTS"
 * sounds like it does. On iOS every browser is a WebKit shell (Apple requires it),
 * so Edge there enumerates exactly the iOS system voices Safari does, and the
 * Microsoft set does not exist in this API at all. The Edge *service* endpoint is
 * not reachable from a page on any platform — see the header note above about
 * `Sec-MS-GEC` — so nothing here ever asks it for anything.
 */

/** Chrome truncates long utterances; keep well under the observed limit. */
const MAX_CHUNK_CHARS = 150

/**
 * How long a chunk may go without a `start` event before we call it dropped.
 * Short on purpose: the cost of guessing wrong is a re-read of one sentence, and
 * the cost of waiting is a silent gap the user reads as "broken".
 */
const START_TIMEOUT_MS = 2500

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

/**
 * `stalled` is separate from `error` because the platform said nothing at all:
 * no `error` event, no `end` event, just silence. It is the one outcome that used
 * to hang the reader permanently, so it has to be nameable in the log.
 */
export type SpeakOutcome = 'done' | 'cancelled' | 'error' | 'stalled'

/**
 * Everything the platform will tell us about why reading out loud did or did not
 * work, in one object, so a phone report can carry it.
 *
 * `paused` and `session` are the two that matter on iOS. `session` is
 * `navigator.audioSession.type` — `play-and-record` while the microphone is open
 * is the state in which Safari demotes speech synthesis to the receiver (see the
 * failure-mode list above), and it is the one piece of that story that is
 * readable from a page (see `speechSnapshot`).
 */
export interface SpeechSnapshot {
  paused: boolean
  speaking: boolean
  pending: boolean
  voices: number
  session: string
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * What the platform's speech state is right now, for the log. Never throws:
 * `getVoices()` does throw before the list is ready on some builds, and a
 * diagnostic surface that can fail is worse than no diagnostic at all.
 */
export function speechSnapshot(): SpeechSnapshot {
  const session = audioSessionType()
  if (!speechSupported()) {
    return { paused: false, speaking: false, pending: false, voices: 0, session }
  }
  const synth = window.speechSynthesis
  let voices = 0
  try {
    voices = synth.getVoices().length
  } catch {
    /* not ready yet — the count stays 0 and says so by being 0 */
  }
  return {
    paused: synth.paused,
    speaking: synth.speaking,
    pending: synth.pending,
    voices,
    session,
  }
}

/** `navigator.audioSession.type` where the platform has the Audio Session API. */
function audioSessionType(): string {
  if (typeof navigator === 'undefined') return '未提供'
  const session = (navigator as { audioSession?: { type?: string } }).audioSession
  return session?.type ?? '未提供'
}

/**
 * One macrotask, so a `cancel()` and the `speak()` that follows it cannot land in
 * the same task.
 */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * How long a chunk is allowed to speak before we stop believing in its `end`
 * event. Deliberately generous — the bound is four times a slow reading of the
 * same text, plus five seconds — because a too-tight bound re-reads a sentence
 * that was fine, and a too-loose one only delays the recovery.
 */
function speechBudgetMs(text: string, rate: number): number {
  const cjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(text)
  // Roughly: 5 Chinese characters or 15 latin characters per second at rate 1.
  const perSecond = (cjk ? 5 : 15) * clampRate(rate)
  return Math.round(5000 + (text.length / perSecond) * 1000 * 4)
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
   * Must be called from inside a user gesture, and *synchronously* within it.
   * iOS refuses to produce speech until the page has spoken inside a gesture
   * handler, and an `await` in between is enough to lose the gesture — which is
   * why this is called from the tap itself (see `App.svelte`) and not from
   * `Session.start()`, whose first real work happens after the model download.
   */
  unlock(lang: Lang = 'en'): void {
    if (!speechSupported()) return
    const synth = window.speechSynthesis
    // Never stack blank utterances on top of a sentence that is being read: the
    // unlock only has to happen once, and this keeps a later tap harmless.
    if (synth.speaking || synth.pending) return
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
   * this utterance superseded), 'error' (the platform reported a failure) or
   * 'stalled' (no completion callback ever arrived — see the header).
   */
  async speak(text: string, options: SpeakOptions): Promise<SpeakOutcome> {
    if (!speechSupported()) return 'error'
    const chunks = chunkForSpeech(text)
    if (chunks.length === 0) return 'done'
    this.cancelRequested = false
    this.resumeIfPaused()
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

  /**
   * iOS leaves the synthesizer paused after the page comes back from the
   * background (or the screen was locked while it was speaking), and `cancel()`
   * does not clear that flag. A paused synthesizer accepts `speak()` and never
   * plays it, so this has to run before every chunk — not once per session. It is
   * always safe: the app itself never calls `pause()`.
   */
  private resumeIfPaused(): void {
    if (!speechSupported()) return
    const synth = window.speechSynthesis
    if (!synth.paused) return
    try {
      synth.resume()
    } catch {
      /* nothing else to try — a stall here is reported as 'stalled' */
    }
  }

  private async speakChunk(text: string, options: SpeakOptions): Promise<SpeakOutcome> {
    return new Promise((finish) => {
      void this.runChunk(text, options, finish)
    })
  }

  /**
   * The body of `speakChunk`, split out so the cancel-then-wait part can `await`
   * without the promise executor having to be `async` (an async executor would
   * swallow a throw into a promise nobody holds).
   */
  private async runChunk(
    text: string,
    options: SpeakOptions,
    finish: (outcome: SpeakOutcome) => void,
  ): Promise<void> {
    const synth = window.speechSynthesis
    this.resumeIfPaused()
    // Clear leftovers — but only when there are any. A `cancel()` with nothing to
    // clear buys nothing and costs the one WebKit behaviour worth avoiding (an
    // utterance queued in the same task as the cancel that made room for it can
    // be dropped), so when it *is* needed it comes with a task boundary after it.
    if (synth.speaking || synth.pending) {
      try {
        synth.cancel()
      } catch {
        /* ignore */
      }
      await nextTask()
      if (this.cancelRequested) {
        finish('cancelled')
        return
      }
    }
    const rate = clampRate(options.rate)
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = rate
    utterance.lang = langTag(options.lang)
    const voice = this.findVoice(options.voiceURI)
    if (voice) utterance.voice = voice
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const settle = (outcome: SpeakOutcome) => {
      if (settled) return
      settled = true
      if (watchdog) clearTimeout(watchdog)
      this.speakingFlag = false
      finish(outcome)
    }
    utterance.onend = () => settle('done')
    utterance.onerror = (event) => {
      // 'interrupted'/'canceled' arrive when we replaced or stopped the queue.
      const reason = (event as SpeechSynthesisErrorEvent).error
      settle(reason === 'interrupted' || reason === 'canceled' ? 'cancelled' : 'error')
    }
    // Two deadlines, because "never started" and "never finished" need different
    // answers: the first means the utterance was dropped, the second means the
    // platform stopped calling back. Both end as 'stalled' — the pump must never
    // wait on a platform that has gone quiet.
    const startupTimeout = () => {
      if (synth.speaking) return armEndTimeout() // `start` never fired, but it is talking
      try {
        synth.cancel()
      } catch {
        /* ignore */
      }
      settle('stalled')
    }
    const armEndTimeout = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        try {
          synth.cancel()
        } catch {
          /* ignore */
        }
        settle('stalled')
      }, speechBudgetMs(text, rate))
    }
    utterance.onstart = armEndTimeout
    watchdog = setTimeout(startupTimeout, START_TIMEOUT_MS)
    this.speakingFlag = true
    try {
      synth.speak(utterance)
    } catch {
      settle('error')
    }
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
