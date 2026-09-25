import type { Lang, ModuleId } from '../types'
import { isAppleMobile } from './device'

/**
 * Speech-recognition module registry.
 *
 * Everything that M0 (technical validation) may need to tune lives in this one
 * file: module ids, download URLs, expected sizes. The routing decision from the
 * plan is fixed — one single-language model per source language, loaded
 * lazily, never more than one resident at a time.
 *
 * The registry is keyed by *module*, not by language, and that distinction has
 * become load-bearing: `zh` and `ko` are one module (so the same download serves
 * both), while `en` has two (Moonshine on transformers.js, and a sherpa NeMo CTC
 * model with punctuation). A lookup keyed by language cannot express either case.
 */

export type AsrEngineId = 'moonshine' | 'sherpa-zh' | 'sherpa-nemo'

/**
 * The language a module transcribes.
 *
 * Korean deliberately is not one of them — she `moduleIdFor`.
 */
export type ModuleLang = 'en' | 'zh'

/** Every module, in the order the install dialog shows them (smallest first). */
export const MODULE_IDS: readonly ModuleId[] = ['en', 'en-nemo', 'zh']

/** Title of each module in the install dialog. */
export const MODULE_NAME: Record<ModuleId, string> = {
  en: '英文识别模块',
  'en-nemo': '英文识别模块（Parakeet）',
  zh: '中文和韩语识别模块',
}

/** Shorter form, for the settings list where a size sits next to it. */
export const MODULE_SHORT: Record<ModuleId, string> = {
  en: '英文 · Moonshine',
  'en-nemo': '英文 · Parakeet',
  zh: '中文 / 韩语',
}

/**
 * A module id from a crash note, in words.
 *
 * The note is written by an *older* build's `localStorage` as often as by this
 * one, so an id we no longer ship has to survive the lookup instead of indexing
 * it to `undefined` and printing that.
 */
export function moduleName(id: string): string {
  return (MODULE_NAME as Record<string, string | undefined>)[id] ?? id
}

export interface AsrModuleSpec {
  id: ModuleId
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
   * Asset URLs for the sherpa engines live in `static/sherpa-asr.worker.js`, not
   * here: that worker is a hand-written classic script (it has to be, see the
   * header comment there) so it cannot import a module. This string is kept
   * purely so the app can say where a download comes from.
   */
  source?: string
  /**
   * Whether this model emits punctuation and capitalisation on its own.
   *
   * Worth a field rather than prose in a label: downstream, the source text feeds
   * both the translator and the reader, and a punctuated transcript is better for
   * both — sentence splitting for translation and prosody for the read-out. It is
   * the only reason the second English module exists, so the UI is allowed to say
   * so out loud.
   */
  punctuated?: boolean
}

export const ASR_MODULES: Record<ModuleId, AsrModuleSpec> = {
  en: {
    id: 'en',
    lang: 'en',
    engine: 'moonshine',
    label: '英文识别模块（Moonshine Base）',
    hfModelId: 'onnx-community/moonshine-base-ONNX',
    approxBytes: 62 * 1024 * 1024,
    version: 'moonshine-base-onnx',
  },
  'en-nemo': {
    id: 'en-nemo',
    lang: 'en',
    engine: 'sherpa-nemo',
    label: '英文识别模块（Parakeet TDT-CTC 110M int8）',
    // NVIDIA's Parakeet TDT-CTC 110M, quantised to int8 and re-exported for
    // sherpa-onnx, so it runs on the *same* WASM runtime the Chinese module
    // already uses — the one whose glue and binary were verified to carry both
    // `nemoCtc` and `OfflineNemoEncDecCtcModelConfig`. That is the whole point of
    // choosing this model over a transformers.js one on a phone: no WebGPU, no
    // onnxruntime-web, and a single 126 MB graph instead of a 458 MB fp32 one.
    //
    // It is the *only* English module here whose output is punctuated and cased.
    //
    // Sizes are the measured bytes of the two files it fetches:
    //   model.int8.onnx 131,652,171 + tokens.txt 9,953
    // The publisher also lists SHA-256 for both, and ships the quantisation
    // script pinned to the fp32 revision it was built from — see DOCS.md, which
    // is where the supply-chain story for this file lives.
    source: 'VocaHQ/sherpa-onnx-nemo-parakeet-tdt-ctc-110m-en-int8',
    approxBytes: 131652171 + 9953,
    version: 'parakeet-tdt-ctc-110m-int8-2026-09-19',
    punctuated: true,
  },
  zh: {
    id: 'zh',
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
    // rather than a model problem — is documented in static/sherpa-asr.worker.js.
    source: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    approxBytes: 239233841 + 11722172 + 95308 + 47391 + 315894,
    version: 'sensevoice-small-int8-2024-07-17',
  },
}

/**
 * Which English module to use.
 *
 * `auto` is the interesting value and the default: it resolves per device rather
 * than per user, because the two modules trade download size against output
 * quality and the trade lands differently on a phone than on a desktop.
 */
export type EnAsrModel = 'auto' | 'moonshine' | 'parakeet'

/**
 * Turns the preference into a concrete choice.
 *
 * `auto` picks the NeMo module on Apple's mobile WebKit — not because the phone
 * needs a smaller model (it is the *larger* of the two, 126 MB against 62 MB) but
 * because of what it does *not* need: the transformers.js path is the only one
 * that can reach for WebGPU, and on iOS that request is what takes the whole page
 * down (see `device.ts`). Running English on the sherpa runtime removes that
 * failure mode by construction instead of guarding against it, and pays for it
 * with a bigger one-time download. It also happens to be the only English module
 * that produces punctuation.
 */
export function resolveEnModel(choice: EnAsrModel): 'moonshine' | 'parakeet' {
  if (choice === 'moonshine' || choice === 'parakeet') return choice
  return isAppleMobile() ? 'parakeet' : 'moonshine'
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
export function moduleIdFor(lang: Lang, enModel: EnAsrModel = 'auto'): ModuleId {
  if (lang !== 'en') return 'zh'
  return resolveEnModel(enModel) === 'parakeet' ? 'en-nemo' : 'en'
}

export function moduleSpec(id: ModuleId): AsrModuleSpec {
  return ASR_MODULES[id]
}

export function moduleFor(lang: Lang, enModel: EnAsrModel = 'auto'): AsrModuleSpec {
  return ASR_MODULES[moduleIdFor(lang, enModel)]
}

/** The English modules, in the order the settings picker shows them. */
export const EN_MODULE_CHOICES: readonly { id: Exclude<EnAsrModel, 'auto'>; module: ModuleId }[] = [
  { id: 'moonshine', module: 'en' },
  { id: 'parakeet', module: 'en-nemo' },
]

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
 * Written out rather than derived, because the engines do not share a convention:
 * sherpa-onnx names its own bucket (the same literal appears in
 * `static/sherpa-asr.worker.js`, which cannot import from here), while Moonshine
 * goes through transformers.js, whose browser cache is the fixed bucket
 * `transformers-cache`. A formula that "looks right" — `rc-model-en-moonshine` —
 * describes a bucket that has never existed, which is how clearing the English
 * module silently deleted nothing while the self-check reported it as not
 * installed.
 *
 * Keyed by *module*, not language: two languages sharing one module must not end
 * up downloading the same 240 MB twice.
 */
export const MODULE_CACHE_KEYS: Record<ModuleId, readonly string[]> = {
  en: ['transformers-cache'],
  'en-nemo': ['rc-model-en-sherpa-nemo'],
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
