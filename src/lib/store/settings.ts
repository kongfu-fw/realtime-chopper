import { writable, get } from 'svelte/store'
import type { Lang, ModuleId, SourceLang, TargetLang } from '../types'
import { ASR_MODULES, moduleIdFor } from '../asr/models'
import { APP_ICONS, DEFAULT_APP_ICON, type AppIconId } from '../brand/logo'
import { EDGE_TTS_DEFAULT_PROXY } from '../tts/edge'
import type { TtsEngineId } from '../tts/engine'

/**
 * User-facing settings (requirement 10).
 *
 * Field names are technical; the *labels and help text* live in the settings
 * view, where they are written in plain language with a bubble explanation.
 * Everything here is persisted to localStorage as `rc.settings.v1`.
 */

export type MtProviderId = 'google' | 'microsoft' | 'llm'
export type Precision = 'high' | 'eco'
export type Accelerator = 'auto' | 'webgpu' | 'wasm'
export type LlmFormat = 'openai' | 'anthropic' | 'gemini'
export type LogLevelSetting = 'debug' | 'info' | 'warn' | 'error'

export interface Settings {
  /** Appearance */
  appIcon: AppIconId

  /** Recognition */
  sourceLang: SourceLang
  silenceMs: number
  minSegMs: number
  maxSegMs: number
  precision: Precision
  accelerator: Accelerator

  /** Translation */
  targetLang: TargetLang
  mtProvider: MtProviderId
  mtBatchWindowMs: number
  mtCache: boolean
  googleApiKey: string
  llmFormat: LlmFormat
  llmBaseUrl: string
  llmModel: string
  llmApiKey: string

  /** Speech output */
  /**
   * Which read-aloud engine to use (see `tts/engine.ts`).
   *
   * `system` is the default and stays the default: it needs no network, no proxy
   * and no quota, and it is the only one that works offline. `edge` is the
   * opt-in route to Microsoft's neural voices through the user's own proxy.
   */
  ttsEngine: TtsEngineId
  /** Base URL of the Edge TTS proxy; only read when `ttsEngine` is `edge`. */
  ttsProxyUrl: string
  /** Voice for the *system* engine, as the platform's `voiceURI`. */
  voiceURI: string
  /** Voice for the *Edge* engine, as a `ShortName`. '' means the engine default. */
  edgeVoice: string
  baseRate: number
  autoSpeedup: boolean
  maxRate: number

  /** Capture */
  keepAudio: boolean
  audioRetentionMin: number

  /** Diagnostics */
  debugMode: boolean
  logLevel: LogLevelSetting
  logRing: number

  /**
   * Which speech modules the user has installed (model files live in Cache
   * Storage). `version` is part of the record because these models get replaced:
   * an install made from different bytes is not an install.
   */
  installedModels: Record<string, { at: number; bytes?: number; version?: string }>
}

export const DEFAULT_SETTINGS: Settings = {
  appIcon: DEFAULT_APP_ICON,

  sourceLang: 'en',
  silenceMs: 500,
  minSegMs: 600,
  maxSegMs: 8000,
  precision: 'high',
  accelerator: 'auto',

  targetLang: 'zh',
  mtProvider: 'google',
  mtBatchWindowMs: 300,
  mtCache: true,
  googleApiKey: '',
  llmFormat: 'openai',
  llmBaseUrl: 'https://api.openai.com/v1',
  llmModel: 'gpt-4o-mini',
  llmApiKey: '',

  ttsEngine: 'system',
  ttsProxyUrl: EDGE_TTS_DEFAULT_PROXY,
  voiceURI: '',
  edgeVoice: '',
  baseRate: 1,
  autoSpeedup: true,
  maxRate: 1.8,

  // On by default: the recording is what makes every later decision reversible
  // (a sentence cut badly can still be re-cut and recognised), and with the file
  // written straight to disk it costs no memory.
  keepAudio: true,
  audioRetentionMin: 60,

  debugMode: false,
  logLevel: 'info',
  logRing: 1000,

  installedModels: {},
}

const STORAGE_KEY = 'rc.settings.v1'

function readStored(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    // `halfDuplex` is gone: the app is always full-duplex now. Drop the stored
    // key instead of carrying dead state around forever.
    delete (parsed as Record<string, unknown>).halfDuplex
    // So is `enAsrModel`: English has one module again (see `types.ts`), and a
    // stored `'parakeet'` would otherwise travel forever in every later write as
    // a preference nothing reads.
    delete (parsed as Record<string, unknown>).enAsrModel
    // So are the icon ids this app used to draw itself (`paper`, `mustard`, …).
    // An unknown id would leave the picker with nothing selected while the page
    // quietly showed the default, so drop it and let the default apply.
    const icon = (parsed as Partial<Settings>).appIcon
    if (icon !== undefined && !APP_ICONS.some((choice) => choice.id === icon)) {
      delete (parsed as Record<string, unknown>).appIcon
    }
    // Same reasoning for the read-aloud engine: an id this build does not know
    // (a hand-edited store, or a future one downgraded back) must not leave the
    // picker with nothing selected while the app quietly speaks with the default.
    const engine = (parsed as Partial<Settings>).ttsEngine
    if (engine !== undefined && engine !== 'system' && engine !== 'edge') {
      delete (parsed as Record<string, unknown>).ttsEngine
    }
    return parsed as Partial<Settings>
  } catch {
    return {}
  }
}

export const settings = writable<Settings>({ ...DEFAULT_SETTINGS, ...readStored() })

let persistTimer: ReturnType<typeof setTimeout> | undefined

settings.subscribe((value) => {
  // Coalesce writes: dragging a slider must not hit localStorage per pixel.
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch {
      /* storage full or blocked — non-fatal, the session keeps running */
    }
  }, 120)
})

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  settings.update((s) => ({ ...s, [key]: value }))
}

export function getSettings(): Settings {
  return get(settings)
}

export function resetSettings(): void {
  settings.set({ ...DEFAULT_SETTINGS, installedModels: get(settings).installedModels })
}

export function markModelInstalled(key: string, bytes?: number, version?: string): void {
  settings.update((s) => ({
    ...s,
    installedModels: {
      ...s.installedModels,
      [key]: { at: Date.now(), ...(bytes ? { bytes } : {}), ...(version ? { version } : {}) },
    },
  }))
}

/**
 * True only when the installed bytes are the ones this build expects. Records
 * written before versions existed (or for a model we have since swapped) read as
 * not installed, which is the honest answer: the files on disk are not ours.
 *
 * Deliberately takes the record instead of reading the store: a component that
 * asks this question must pass it in from the outside (see `isLangInstalled` for
 * the version that does the module lookup) so it keeps its subscription. Reading
 * the store through `get()` inside a template renders once and then never
 * updates — which is exactly how the badge failed to appear after a successful
 * install the first time this existed.
 *
 * Takes a *module* id, because "is this language installed?" and "is this module
 * installed?" are different questions for `zh` and `ko`.
 */
export function isModuleCurrent(module: ModuleId, record?: { version?: string }): boolean {
  return !!record && record.version === ASR_MODULES[module].version
}

/**
 * The voice the read-aloud engine that is selected should use.
 *
 * Two engines, two voice namespaces: a platform `voiceURI` and an Edge
 * `ShortName` mean nothing to each other, and both choices are kept side by side
 * so that switching engines back and forth does not forget either of them.
 */
export function ttsVoiceFor(settings: Settings): string {
  return settings.ttsEngine === 'edge' ? settings.edgeVoice : settings.voiceURI
}

/**
 * Whether the module that serves `lang` is installed.
 *
 * The install records are keyed by *module*, not by language (Chinese and Korean
 * are one download), so callers must not index the map themselves — asking "is
 * Korean installed?" by looking up `installedModels.ko` is how a shared module
 * ends up looking missing.
 */
export function isLangInstalled(lang: Lang, installed: Settings['installedModels']): boolean {
  const module = moduleIdFor(lang)
  return isModuleCurrent(module, installed[module])
}

export function forgetModel(key: string): void {
  settings.update((s) => {
    const next = { ...s.installedModels }
    delete next[key]
    return { ...s, installedModels: next }
  })
}

/** Human-readable size for the install dialog and settings list. */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '未知大小'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

export const LANG_LABEL: Record<Lang, string> = {
  en: '英文',
  zh: '中文',
  ko: '韩语',
}

export const SOURCE_ORDER: SourceLang[] = ['en', 'zh', 'ko']
export const TARGET_ORDER: TargetLang[] = ['zh', 'ko', 'en']
