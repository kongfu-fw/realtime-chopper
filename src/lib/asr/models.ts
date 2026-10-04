import type { Lang, ModuleId } from '../types'
import { currentLang, t, translate } from '../i18n/index.ts'
import { isAppleMobile } from './device.ts'

/**
 * Speech-recognition module registry — one module, every language.
 *
 * There used to be three live modules here and a routing table between them:
 * Moonshine Base for English, Moonshine Base-KO for the phone's Korean, and a
 * service (koasr) over HTTP that Korean could ride on a desktop or a phone. All
 * of that is gone by request, and what replaced it is this file's whole answer:
 *
 *   every source language → `zh` (SenseVoice Small int8, sherpa-onnx WASM)
 *
 * SenseVoice is multilingual (zh/en/ja/ko/yue) with `language: 'auto'`, so the
 * bytes do not need to know what is being spoken, and the model that was built
 * for Chinese reads Korean better than the model that was built for Korean —
 * measured on this app's own microphone (see the numbers in DOCS.md). Keeping
 * three models to answer what one answers is what the downloads, the routing
 * table and the network dependency all existed for; this build has none of them.
 *
 * The registry is still keyed by *module* rather than by language, because a
 * module is a set of bytes and a language is what the user says, and the lookup
 * is where "which bytes answer this language" is written down. Today that
 * decision is the same for every language; `moduleIdFor` is the function that
 * says so.
 *
 * Retired modules are still *parsed* rather than deleted: `en` and `ko`
 * (Moonshine downloads), `ko-net` (the network service), and `en-nemo` (the
 * Parakeet module removed an age ago). A phone that installed one of them is
 * holding the bytes, an install record, and possibly a crash note, so the ids
 * survive in exactly two places — the retired-cache cleanup below and
 * `moduleName` — and are never resolved to a module.
 */

/**
 * A module id from an install record, a cache sweep or a crash note, in words.
 *
 * Never throws on an unknown id: the caller is already reporting a failure, and
 * "那个模块" is a worse answer than the raw id.
 */
const RETIRED_MODULE_NAME: Record<string, string> = {
  en: '英文识别模块（Moonshine，已移除）',
  ko: '韩语识别模块（Moonshine，已移除）',
  'ko-net': '韩语识别服务（koasr，已移除）',
  'en-nemo': '英文识别模块（Parakeet，已移除）',
}

export function moduleName(id: string, uiLang: Lang = currentLang()): string {
  const table = MODULE_NAME as Record<string, string | undefined>
  return translate(uiLang, table[id] ?? RETIRED_MODULE_NAME[id] ?? id)
}

/**
 * Every module that has bytes to install. One, and the lists that iterate it
 * (the install dialog, the settings list, the self-check) are talking about
 * storage: there is one download and one bucket.
 */
export const MODULE_IDS: readonly ModuleId[] = ['zh']

/** Title of the module in the install dialog. */
export const MODULE_NAME: Record<ModuleId, string> = {
  zh: '识别模块（SenseVoice Small int8）',
}

/** Shorter form, for the settings list where a size sits next to it. */
export const MODULE_SHORT: Record<ModuleId, string> = {
  zh: 'SenseVoice · 中英韩日粤',
}

export function moduleTitle(id: ModuleId, uiLang: Lang = currentLang()): string {
  return translate(uiLang, MODULE_NAME[id])
}

export function moduleShort(id: ModuleId, uiLang: Lang = currentLang()): string {
  return translate(uiLang, MODULE_SHORT[id])
}

/** One module's own name, in the language the interface is speaking. */
export function moduleLabel(spec: AsrModuleSpec, uiLang: Lang = currentLang()): string {
  return translate(uiLang, spec.label)
}

export interface AsrModuleSpec {
  id: ModuleId
  label: string
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
}

export const ASR_MODULES: Record<ModuleId, AsrModuleSpec> = {
  zh: {
    id: 'zh',
    label: '识别模块（SenseVoice Small int8）',
    // SenseVoice-Small int8 on sherpa-onnx's own WASM build. That runtime brings
    // the Kaldi fbank feature extraction the ONNX graph expects, which is why no
    // feature-extraction code of ours exists anywhere.
    //
    // The model is multilingual (zh/en/ja/ko/yue) and non-autoregressive: measured
    // at RTF ~0.40 here, against ~0.9 for Whisper-base on the same audio, and it is
    // the only one of the three that survived a sentence mixing Chinese with
    // English words. Its "auto" language mode is what lets one download answer
    // every language the app offers — which is why this is now the only module.
    // Where the runtime comes from — and why it is a runtime problem rather than a
    // model problem — is documented in static/sherpa-asr.worker.js.
    source: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    approxBytes: 239233841 + 11722172 + 95308 + 47391 + 315894,
    version: 'sensevoice-small-int8-2024-07-17',
  },
}

/**
 * Which module transcribes a given source language.
 *
 * The same one for all of them, and that is the whole routing decision now. The
 * argument stays because "which bytes answer this language" is a question the
 * callers genuinely have — `isLangInstalled`, the startup log, the diagnostic
 * report — and because the answer being constant today does not make the
 * question meaningless: the two used to differ, and if a second module ever
 * comes back, this is the one function that would say so.
 */
export function moduleIdFor(_lang: Lang): ModuleId {
  return 'zh'
}

export function moduleSpec(id: ModuleId): AsrModuleSpec {
  return ASR_MODULES[id]
}

export function moduleFor(lang: Lang): AsrModuleSpec {
  return ASR_MODULES[moduleIdFor(lang)]
}

/**
 * Whether a module's install is beyond what an Apple-mobile web page can hold.
 *
 * A page on iOS gets an order of magnitude less memory than the same page in a
 * desktop browser, and what it gets is measured in *hundreds* of megabytes: a
 * developer filling a page with strings to find the ceiling crashed it at about
 * 100 MB on a 4 GB iPhone and 200 MB on an iPad (lapcatsoftware.com, 2026-01-22,
 * iOS 26.2) — and a page that dies this way dies *silently*, with no exception to
 * catch and nothing written down.
 *
 * That ceiling is below what this module needs before the recogniser even
 * exists: the 228 MB SenseVoice model arrives as one array we hold ourselves,
 * and the runtime then copies it into a session. So on an iPhone this install
 * cannot succeed, and the only honest thing to do is say so *before* the tap
 * that kills the page — which is what this answers, and why the threshold sits
 * below the module rather than near it. The count is not a precise device budget
 * (there is no API for one on iOS) but the gap is not close: what this catches is
 * twice the *high* end of the measurement.
 *
 * There used to be a way out on a phone — smaller Moonshine modules for English
 * and Korean, and a Korean recogniser on the network — and both are gone. So a
 * device that answers true here has no recogniser at all any more, and `prepare`
 * refuses in words rather than letting the page be killed to prove it.
 */
export function moduleTooBigForDevice(spec: AsrModuleSpec): boolean {
  return isAppleMobile() && spec.approxBytes >= 150 * 1024 * 1024
}

/**
 * Turns a module-download failure into one short sentence.
 *
 * The runtime fails in its own English ("Failed to fetch", "Unauthorized access
 * to file") because that is what the libraries throw. That text is kept in the
 * log — it is what makes a bug report useful — but the dialog the user is looking
 * at should say what happened and what to do about it.
 */
export function describeModuleError(message: string): string {
  if (isMemoryFailure(message)) return t('这个设备内存不够装这个模块：关掉其他应用再试一次')
  if (/fetch|network|load failed|offline|connection/.test(message.toLowerCase())) return t('下载中断了，检查网络后重试')
  if (/401|403|unauthor|forbidden|denied/.test(message.toLowerCase())) return t('下载被拒绝，换个网络重试')
  if (/404|not found/.test(message.toLowerCase())) return t('找不到模块文件，可能需要更新版本')
  if (/timeout|timed out/.test(message.toLowerCase())) return t('下载太久没动静，重试一次')
  if (/quota|space|storage/.test(message.toLowerCase())) return t('手机存储空间不够，清理后重试')
  if (/caches|indexeddb|cache storage/.test(message.toLowerCase())) return t('浏览器不让存文件，用 https 打开再试')
  // WebAssembly failures read like nothing else in this file, and they are the
  // ones a phone actually hits: Emscripten reports an out-of-memory as a bare
  // `abort()`, which is the same text as a dozen other faults.
  if (/instantiate|webassembly|wasm|linkerror|compileerror/.test(message.toLowerCase()))
    return t('识别引擎没能在浏览器里启动，换个浏览器再试')
  if (/not allowed|securityerror|permission|blocked/.test(message.toLowerCase())) return t('浏览器拦住了加载，用 https 或换个浏览器打开')
  return t('模块没能装好，再试一次')
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
 * Written out rather than derived. The sherpa runtime names its own bucket (the
 * same literal appears in `static/sherpa-asr.worker.js`, which cannot import
 * from here), and the Moonshine modules that used to sit in transformers.js's
 * shared `transformers-cache` are gone — that bucket is retired below rather
 * than guessed at.
 */
export const MODULE_CACHE_KEYS: Record<ModuleId, readonly string[]> = {
  zh: ['rc-model-zh-sherpa-zh'],
}

/**
 * Cache buckets this build no longer reads.
 *
 * `transformers-cache` is where both Moonshine modules lived (en ~62 MB, ko
 * ~64 MB): one bucket for both, because that library caches everything under one
 * name. Nothing in this build opens it again, so it is deleted at startup.
 *
 * Matched as a prefix, so a bucket an older worker created with a suffix still
 * goes. `LIVE_CACHE_KEYS` is the other half of that: a startup cleanup that
 * deleted a bucket the registry still reads would make the app download it again
 * on every load, which is the kind of bug that looks like a network problem.
 */
const RETIRED_CACHE_PREFIXES = ['rc-model-ko-', 'rc-model-en-sherpa-nemo']
const RETIRED_CACHE_KEYS = ['transformers-cache']

/** Every bucket the module above reads today. Retirement must not touch these. */
const LIVE_CACHE_KEYS = new Set<string>(Object.values(MODULE_CACHE_KEYS).flat())

/** Deletes caches from retired modules; returns what went, so it can be logged. */
export async function purgeRetiredModuleCaches(): Promise<string[]> {
  if (typeof caches === 'undefined') return []
  const gone: string[] = []
  try {
    for (const key of await caches.keys()) {
      if (LIVE_CACHE_KEYS.has(key)) continue
      const retired =
        RETIRED_CACHE_KEYS.includes(key) || RETIRED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))
      if (!retired) continue
      if (await caches.delete(key)) gone.push(key)
    }
  } catch {
    /* storage blocked — never worth failing startup over */
  }
  return gone
}
