import { writable, get } from 'svelte/store'
import type { Lang, ModuleId, SourceLang, TargetLang } from '../types'
import { ASR_MODULES, moduleIdFor, setAsrBackendChoice } from '../asr/models'
import { APP_ICONS, DEFAULT_APP_ICON, type AppIconId } from '../brand/logo'
import { EDGE_TTS_DEFAULT_PROXY } from '../tts/edge'
import type { TtsEngineId } from '../tts/engine'
import { SUPPORTED_LANGS, currentLang, translate, type UiLangSetting } from '../i18n/index.ts'

/**
 * User-facing settings (requirement 10).
 *
 * Field names are technical; the *labels and help text* live in the settings
 * view, where they are written in plain language with a bubble explanation.
 * Everything here is persisted to localStorage as `rc.settings.v1`.
 */

export type MtProviderId = 'google' | 'microsoft' | 'llm'
export type Precision = 'high' | 'eco'
/**
 * Where the languages that have both routings get recognised.
 *
 * `auto` is the recommended one and it is deliberately not "the network": what
 * it means is written down in `networkAsrPreferred` (`asr/models.ts`), and the
 * short version is "on the device whose local model is the small one" — the
 * iPhone, whose Korean is Moonshine Base-KO because the better model does not fit
 * an Apple page. A desktop already runs SenseVoice, which is both faster and
 * already there, so `auto` leaves it alone.
 *
 * `network` is the escape hatch for the case the guess gets wrong (a desktop that
 * wants the big model, a phone on a good connection), and `local` is the "no
 * dependence on anything" setting. Neither is a downgrade: the local model is the
 * only thing that works with the machine across the room switched off.
 */
export type AsrBackend = 'auto' | 'network' | 'local'
export type Accelerator = 'auto' | 'webgpu' | 'wasm'
export type LlmFormat = 'openai' | 'anthropic' | 'gemini'
export type LogLevelSetting = 'debug' | 'info' | 'warn' | 'error'

export interface Settings {
  /** Appearance */
  appIcon: AppIconId
  /**
   * Which language the interface speaks, in every language we have.
   *
   * Separate from `sourceLang`/`targetLang` on purpose: those are what goes *in*
   * and *out* of the pipeline, this is the language the app talks to its user in
   * — the three are independent, and a Chinese speaker translating English into
   * Korean wants their buttons in Chinese.
   */
  uiLang: UiLangSetting

  /** Recognition */
  sourceLang: SourceLang
  silenceMs: number
  minSegMs: number
  maxSegMs: number
  precision: Precision
  accelerator: Accelerator
  /** Where a language that has a network recogniser gets recognised; see `AsrBackend`. */
  asrBackend: AsrBackend
  /**
   * Address of the recogniser service, for the languages that have one.
   *
   * A path on the app's own origin (`/asr`) is the recommended form and the
   * default, because it is the only one that cannot be blocked: a page served over
   * HTTPS may not call `http://…`, and this app is opened over HTTPS on a phone.
   * An absolute address is accepted for a service reached directly — see
   * `addressProblem` in `asr/koasr.ts`, which is what turns that mistake into a
   * sentence instead of a silent fallback.
   *
   * An empty address disables the whole route without changing the setting, which
   * is what `'auto'` reads to decide there is nothing to try.
   */
  asrBaseUrl: string

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
  uiLang: 'auto',

  sourceLang: 'en',
  silenceMs: 500,
  minSegMs: 600,
  maxSegMs: 8000,
  precision: 'high',
  accelerator: 'auto',
  asrBackend: 'auto',
  // Where the recogniser service is served *next to this app*. One command on the
  // machine the app is served from puts it here (`tailscale serve --set-path`, see
  // DOCS.md); until then the path 404s, the phone notices in one round trip and
  // uses its own model, which is the same behaviour as this setting being off.
  asrBaseUrl: '/asr',

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
    // And the recognition backend, for the same reason: an id this build does not
    // know must not leave the picker empty while the app quietly uses the default.
    const backend = (parsed as Partial<Settings>).asrBackend
    if (backend !== undefined && backend !== 'auto' && backend !== 'network' && backend !== 'local') {
      delete (parsed as Record<string, unknown>).asrBackend
    }
    // And the interface language, for a sharper reason than a blank picker: an
    // unknown language is used as an index into the dictionaries, so a
    // hand-edited `'jp'` would throw on the first string the app renders.
    const uiLang = (parsed as Partial<Settings>).uiLang
    if (
      uiLang !== undefined &&
      uiLang !== 'auto' &&
      !SUPPORTED_LANGS.includes(uiLang)
    ) {
      delete (parsed as Record<string, unknown>).uiLang
    }
    return parsed as Partial<Settings>
  } catch {
    return {}
  }
}

export const settings = writable<Settings>({ ...DEFAULT_SETTINGS, ...readStored() })

/**
 * Whether the network recogniser may be used at all, from a settings snapshot.
 *
 * Two conditions, and both are needed: the user has to allow it (`'local'` is a
 * no), and there has to be somewhere to call. The address is what makes the second
 * condition real — with the field cleared, turning the picker to `'network'` is a
 * statement about a service nobody has named, and the honest reading of that is
 * "off" rather than a request to a guessed hostname. That is also why the settings
 * screen prints a warning in exactly that state instead of quietly doing nothing.
 */
export function networkAsrAllowed(settings: Settings): boolean {
  return settings.asrBackend !== 'local' && settings.asrBaseUrl.trim() !== ''
}

// The routing tables in `asr/models.ts` cannot read this store (`isLangInstalled`
// below goes the other way, and an import in both directions is a cycle), so the
// choice is pushed to them — the same shape as `setUiLang` in `lib/i18n`.
// Subscribing also runs the callback once, which is what seeds it at startup.
settings.subscribe((value) =>
  setAsrBackendChoice(networkAsrAllowed(value) ? value.asrBackend : 'local'),
)

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
  // A module that is a service has nothing installed and cannot be stale: the
  // question this answers is "would a download be needed", and for `ko-net` the
  // answer is no whether or not anything was ever installed. Without this, routing
  // Korean over the network would make the status bar offer a 64 MB download for
  // the model it is deliberately not using.
  if (ASR_MODULES[module].remote) return true
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
 * The install records are keyed by *module*, not by language, so callers must not
 * index the map themselves: the two happened to differ for a while (Korean was
 * answered by the Chinese download), and a caller that assumed one id per
 * language would have read that as "not installed" and offered a 240 MB download
 * the user already had. The lookup goes through `moduleIdFor` for the same reason
 * today, when the ids do line up.
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
export function formatBytes(bytes: number | undefined, uiLang: Lang = currentLang()): string {
  if (!bytes || bytes <= 0) return translate(uiLang, '未知大小')
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

/**
 * How a language is named *inside a sentence* (“识别语言切换为英文”).
 *
 * A function, not a table: the name of a language changes with the language the
 * UI is in, so a frozen record would go stale the moment the picker moves. (The
 * picker itself shows `LANG_NAMES`, where every language names itself.) Markup
 * passes `$uiLang` in as the second argument — see the note on `t` in `lib/i18n`
 * for why the call site has to hand the reactive value over.
 */
export function langLabel(lang: Lang, uiLang: Lang = currentLang()): string {
  return translate(uiLang, LANG_LABEL[lang])
}

const LANG_LABEL: Record<Lang, string> = {
  en: '英文',
  zh: '中文',
  ko: '韩语',
}

export const SOURCE_ORDER: SourceLang[] = ['en', 'zh', 'ko']
export const TARGET_ORDER: TargetLang[] = ['zh', 'ko', 'en']
