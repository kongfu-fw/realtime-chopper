import type { Lang } from '../types'
import type { Settings } from '../store/settings'
import { currentLang, translate } from '../i18n/index.ts'
import { SystemSpeechEngine } from './speech'
import { EdgeTtsEngine } from './edge'

/**
 * The read-aloud contract, and the one place that decides who fills it.
 *
 * Two engines exist and they are different in kind, not in tuning:
 *
 *  - `system` is the platform's own `speechSynthesis` — offline, instant, and
 *    whatever voices the OS happens to have. It is the default because it costs
 *    nothing and works with no network at all.
 *  - `edge` is Microsoft's neural Edge TTS, reached through a proxy the user
 *    runs (see `edge.ts` for why a proxy is unavoidable) — network per sentence,
 *    but real neural voices on every platform, including the ones where the
 *    system voice list is thin.
 *
 * Everything downstream — the reading pump, the rate controller, the queue — only
 * ever sees this interface, so swapping engines cannot change how the pipeline
 * behaves. The only visible difference is which voice list the picker shows.
 */
export type TtsEngineId = 'system' | 'edge'

/**
 * How a read-aloud engine is named in the log, the report and the settings list.
 *
 * A function rather than a table, because the name is interface text and follows
 * the interface language (`lib/i18n`). The engines expose it through a getter for
 * the same reason: one built while the interface was Chinese must not keep
 * calling itself 系统朗读 after the picker has moved. (A getter is still read at
 * a moment in time, so markup calls this and hands `$uiLang` in.)
 */
export function ttsEngineLabel(id: TtsEngineId, uiLang: Lang = currentLang()): string {
  return translate(uiLang, TTS_ENGINE_SOURCE[id])
}

/** The Chinese source strings, so the two names live in one place. */
const TTS_ENGINE_SOURCE: Record<TtsEngineId, string> = {
  system: '系统朗读',
  edge: 'Edge TTS 代理',
}

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
 * no error, no completion, just silence. It is the one outcome that used to hang
 * the reader permanently, so it has to be nameable in the log. Both engines
 * produce it — for different reasons, documented where each arms its watchdog.
 */
export type SpeakOutcome = 'done' | 'cancelled' | 'error' | 'stalled'

export interface TtsEngine {
  readonly id: TtsEngineId
  readonly label: string
  /** Whether this engine can speak at all on this device with this config. */
  readonly available: boolean
  readonly speaking: boolean
  /**
   * Arms playback from inside a user gesture; see each engine for what exactly
   * has to happen before the platform will make a sound.
   */
  unlock(lang?: Lang): void
  speak(text: string, options: SpeakOptions): Promise<SpeakOutcome>
  stop(): void
  /** Voices that can speak `lang`, best candidates first. May hit the network. */
  voicesFor(lang: Lang, timeoutMs?: number): Promise<VoiceOption[]>
}

/** What the factory needs to build either engine. */
export interface TtsConfig {
  engine: TtsEngineId
  /** Base URL of the Edge TTS proxy; ignored by the system engine. */
  proxyUrl: string
}

/** Reads the engine choice out of settings. */
export function ttsConfigFrom(settings: Settings): TtsConfig {
  return { engine: settings.ttsEngine, proxyUrl: settings.ttsProxyUrl }
}

export function createTtsEngine(config: TtsConfig): TtsEngine {
  if (config.engine === 'edge') return new EdgeTtsEngine({ proxyUrl: config.proxyUrl })
  return new SystemSpeechEngine()
}

/**
 * Splits text at sentence boundaries, then hard-wraps anything still too long.
 *
 * Shared by both engines because both need it for different reasons. The system
 * one is truncated silently by Chrome past roughly 200–250 characters, so the
 * split has to happen before the browser sees the string. The Edge one pays a
 * round trip per request, so sentence-sized requests are what keep the first
 * sound close to the sentence being spoken — and what let a rate change take
 * effect on the next sentence rather than on the next paragraph.
 */
const MAX_CHUNK_CHARS = 150

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

/** The language prefixes a voice's tag may start with, per target language. */
export function langPrefixes(lang: Lang): string[] {
  switch (lang) {
    case 'zh':
      return ['zh', 'cmn']
    case 'ko':
      return ['ko']
    case 'en':
      return ['en']
  }
}

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.min(2, Math.max(0.5, rate))
}
