import type { Lang } from '../types'

/**
 * Speech-recognition module registry.
 *
 * Everything that M0 (technical validation) may need to tune lives in this one
 * file: model ids, download URLs, expected sizes. The routing decision from the
 * plan is fixed — one single-language model per source language, loaded
 * lazily, never more than one resident at a time.
 */

export type AsrEngineId = 'moonshine' | 'sherpa-zh'

/**
 * The languages that have a downloadable module of their own.
 *
 * Korean deliberately is not one of them — see `moduleLangFor`.
 */
export type ModuleLang = 'en' | 'zh'

/** Every module, in the order the install dialog shows them (smallest first). */
export const MODULE_LANGS: readonly ModuleLang[] = ['en', 'zh']

/** Title of each module in the install dialog. */
export const MODULE_NAME: Record<ModuleLang, string> = {
  en: '英文识别模块',
  zh: '中文和韩语识别模块',
}

/** Shorter form, for the settings list where a size sits next to it. */
export const MODULE_SHORT: Record<ModuleLang, string> = {
  en: '英文',
  zh: '中文 / 韩语',
}

export interface AsrModuleSpec {
  lang: ModuleLang
  engine: AsrEngineId
  label: string
  /** transformers.js repo id, for the moonshine engine. */
  hfModelId?: string
  /** Approximate download size shown in the install dialog before we know better. */
  approxBytes: number
  /**
   * Identity of the bytes this module installs.
   *
   * An install is only valid for the version it was made from: swapping the
   * Chinese model from the demo's zipformer pack to SenseVoice int8 is exactly
   * the kind of change that must resurface the download button instead of leaving
   * a stale "installed" badge pointing at different files.
   */
  version: string
  /**
   * Asset URLs for the sherpa engine live in `static/zh-asr.worker.js`, not
   * here: that worker is a hand-written classic script (it has to be, see the
   * header comment there) so it cannot import a module. This string is kept
   * purely so the app can say where a download comes from.
   */
  source?: string
}

export const ASR_MODULES: Record<ModuleLang, AsrModuleSpec> = {
  en: {
    lang: 'en',
    engine: 'moonshine',
    label: '英文识别模块（Moonshine Base）',
    hfModelId: 'onnx-community/moonshine-base-ONNX',
    approxBytes: 62 * 1024 * 1024,
    version: 'moonshine-base-onnx',
  },
  zh: {
    lang: 'zh',
    engine: 'sherpa-zh',
    label: '中文和韩语识别模块（SenseVoice Small int8）',
    // SenseVoice-Small int8 on sherpa-onnx's own WASM build. That runtime brings
    // the Kaldi fbank feature extraction the ONNX graph expects, which is why no
    // feature-extraction code of ours exists anywhere.
    //
    // The model is multilingual (zh/en/ja/ko/yue) and non-autoregressive: measured
    // at RTF ~0.40 here, against ~0.9 for Whisper-base on the same audio, and it is
    // the only one of the three that survives a sentence mixing Chinese with
    // English words. Where the runtime comes from — and why it is a runtime problem
    // rather than a model problem — is documented in static/zh-asr.worker.js.
    source: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    approxBytes: 239233841 + 11722172 + 95308 + 47391 + 315894,
    version: 'sensevoice-small-int8-2024-07-17',
  },
}

/**
 * Which module transcribes a given source language.
 *
 * Korean runs on the Chinese module, and that is a deliberate choice rather than
 * a shortcut: the dedicated Korean model (Moonshine Base-KO) read Korean
 * noticeably worse, while SenseVoice Small is multilingual (zh/en/ja/ko/yue) and
 * non-autoregressive — so Korean rides on a download the user may already have
 * instead of adding a second, worse, 62 MB one.
 *
 * The consequence worth knowing: `zh` and `ko` are the same bytes, so they share
 * one cache entry, one install record and one resident model — switching between
 * them costs nothing, not even a reload, because the model decides the language
 * of each utterance from the audio itself.
 */
export function moduleLangFor(lang: Lang): ModuleLang {
  return lang === 'ko' ? 'zh' : lang
}

export function moduleFor(lang: Lang): AsrModuleSpec {
  return ASR_MODULES[moduleLangFor(lang)]
}

/**
 * Turns a module-download failure into one short sentence.
 *
 * The two engines fail in their own English ("Failed to fetch", "Unauthorized
 * access to file") because that is what the runtime library throws. That text is
 * kept in the log — it is what makes a bug report useful — but the dialog the
 * user is looking at should say what happened and what to do about it.
 */
export function describeModuleError(message: string): string {
  const text = message.toLowerCase()
  if (isMemoryFailure(message)) return '这个设备内存不够装这个模块：关掉其他应用，或先装英文模块'
  if (/fetch|network|load failed|offline|connection/.test(text)) return '下载中断了，检查网络后重试'
  if (/401|403|unauthor|forbidden|denied/.test(text)) return '下载被拒绝，换个网络重试'
  if (/404|not found/.test(text)) return '找不到模块文件，可能需要更新版本'
  if (/timeout|timed out/.test(text)) return '下载太久没动静，重试一次'
  if (/quota|space|storage/.test(text)) return '手机存储空间不够，清理后重试'
  if (/caches|indexeddb|cache storage/.test(text)) return '浏览器不让存文件，用 https 打开再试'
  // WebAssembly failures read like nothing else in this file, and they are the
  // ones a phone actually hits: Emscripten reports an out-of-memory as a bare
  // `abort()`, which is the same text as a dozen other faults.
  if (/instantiate|webassembly|wasm|linkerror|compileerror/.test(text))
    return '识别引擎没能在浏览器里启动，换个浏览器再试'
  if (/not allowed|securityerror|permission|blocked/.test(text)) return '浏览器拦住了加载，用 https 或换个浏览器打开'
  return '模块没能装好，再试一次'
}

/**
 * Whether the failure is the device running out of memory.
 *
 * Worth its own function because it is the one failure with a fix the user can
 * apply (`关掉别的应用`) and the one an iPhone hits first on the 228 MB model.
 * Emscripten's `abort()` and WebKit's jetsam both surface as strings that never
 * contain the word "memory", so they are matched explicitly.
 */
export function isMemoryFailure(message: string): boolean {
  return /out of memory|cannot enlarge|allocation failed|memory access out of bounds|unreachable|aborted|abort\(|rangeerror|allocation size|oom/i.test(
    message,
  )
}

/**
 * The Cache Storage buckets a module's assets actually live in.
 *
 * Written out rather than derived, because the two engines do not share a
 * convention: sherpa-onnx names its own bucket (the same literal appears in
 * `static/zh-asr.worker.js`, which cannot import from here), while Moonshine goes
 * through transformers.js, whose browser cache is the fixed bucket
 * `transformers-cache`. A formula that "looks right" — `rc-model-en-moonshine` —
 * describes a bucket that has never existed, which is how clearing the English
 * module silently deleted nothing while the self-check reported it as not
 * installed.
 *
 * Keyed by *module*, not language: two languages sharing one module must not end
 * up downloading the same 240 MB twice.
 */
export const MODULE_CACHE_KEYS: Record<ModuleLang, readonly string[]> = {
  en: ['transformers-cache'],
  zh: ['rc-model-zh-sherpa-zh'],
}

/**
 * Cache prefixes this build no longer reads.
 *
 * The dedicated Korean model is gone (Korean runs on the Chinese module now), so
 * anyone who installed it is holding ~62 MB that nothing will ever open again.
 */
const RETIRED_CACHE_PREFIXES = ['rc-model-ko-']

/** Deletes caches from retired modules; returns what went, so it can be logged. */
export async function purgeRetiredModuleCaches(): Promise<string[]> {
  if (typeof caches === 'undefined') return []
  const gone: string[] = []
  try {
    for (const key of await caches.keys()) {
      if (!RETIRED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
      if (await caches.delete(key)) gone.push(key)
    }
  } catch {
    /* storage blocked — never worth failing startup over */
  }
  return gone
}
