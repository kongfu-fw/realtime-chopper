import type { Lang, ModuleId } from '../types'
import { currentLang, t, translate } from '../i18n/index.ts'
import { isAppleMobile } from './device.ts'

/**
 * Speech-recognition module registry.
 *
 * Everything that M0 (technical validation) may need to tune lives in this one
 * file: module ids, download URLs, expected sizes. The routing decision from the
 * plan is fixed — one single-language model per source language, loaded
 * lazily, never more than one resident at a time.
 *
 * The registry is keyed by *module*, not by language. The two used to differ —
 * Korean rode on the Chinese module, because SenseVoice is multilingual and there
 * was no Korean model good enough to be worth a second download. Korean has one
 * now (see `ASR_MODULES.ko`), so today the ids and the languages line up; the
 * indirection stays because "which bytes answer this language" is a decision, not
 * an identity, and `moduleIdFor` is where that decision is written down.
 *
 * There were more modules here and there might not be, on purpose: `en-nemo`
 * (NVIDIA Parakeet TDT-CTC 110M int8 on the sherpa runtime) was built, measured
 * against Moonshine on the same audio, and removed — see `types.ts` for what the
 * numbers said. Its ids, cache bucket and crash-note spelling are still handled
 * here, because a phone that installed it is holding the leftovers.
 */

export type AsrEngineId = 'moonshine' | 'sherpa'

/**
 * The language a module transcribes.
 *
 * One module per language, which is what the earlier shared-module arrangement
 * (`zh` answering Korean too) gave up: those bytes exist for Chinese, and using
 * them for Korean was a way to answer a language without a model of its own.
 */
export type ModuleLang = 'en' | 'ko' | 'zh'

/** Every module, in the order the install dialog shows them (smallest first). */
export const MODULE_IDS: readonly ModuleId[] = ['en', 'ko', 'zh']

/**
 * Title of each module in the install dialog.
 *
 * The tables below hold the Chinese *source* text; the accessors around them are
 * what the interface actually prints, so the names follow the interface language
 * (`lib/i18n`) without every caller having to remember to translate. Markup hands
 * `$uiLang` in as the accessors' last argument, so a name on screen follows a
 * language switch; see the note on `t` in `lib/i18n`.
 */
export const MODULE_NAME: Record<ModuleId, string> = {
  en: '英文识别模块',
  ko: '韩语识别模块',
  zh: '中文识别模块',
}

/** Shorter form, for the settings list where a size sits next to it. */
export const MODULE_SHORT: Record<ModuleId, string> = {
  en: '英文 · Moonshine',
  ko: '韩语 · Zipformer',
  zh: '中文 · SenseVoice',
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

/**
 * Modules this build no longer ships, spelled the way the id is spelled.
 *
 * `en-nemo` is the live example. A crash note is written by whatever build was
 * running at the time — which can be an older one — so a module that has since
 * been removed has to survive the lookup as words instead of indexing the table
 * to `undefined` and printing that.
 */
const RETIRED_MODULE_NAME: Record<string, string> = {
  'en-nemo': '英文识别模块（Parakeet，已移除）',
}

/**
 * A module id from a crash note, in words.
 *
 * Never throws on an unknown id: the caller is already reporting a failure, and
 * "那个模块" is a worse answer than the raw id.
 */
export function moduleName(id: string, uiLang: Lang = currentLang()): string {
  const table = MODULE_NAME as Record<string, string | undefined>
  return translate(uiLang, table[id] ?? RETIRED_MODULE_NAME[id] ?? id)
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
  ko: {
    id: 'ko',
    lang: 'ko',
    engine: 'sherpa',
    label: '韩语识别模块（Zipformer Korean int8）',
    // k2-fsa's own Korean zipformer, the same runtime as the Chinese module —
    // no new engine, no new download of wasm, just 72 MB of weights.
    //
    // Chosen by measurement, on the four Korean clips k2-fsa ships with it
    // (`test_wavs/`, 16.2 s of real speech): **1.3% CER**, against 3.9% for
    // SenseVoice Small on the same audio and 18.4% for Moonshine Base-KO — the
    // model this app tried first and rejected, which turned out to be the app's
    // own token budget (6/s, calibrated for English) cutting every Korean
    // utterance short rather than the model reading Korean badly. A transducer
    // does not decode token by token, so that budget never applies here.
    //
    // It is non-autoregressive and CPU-only, ~0.05 RTF single-threaded, punctuates
    // sentence ends, and keeps the spaces between words. That last one is worth
    // spelling out because the runtime decides it rather than the model: the
    // pinned build (static/sherpa-asr.worker.js) answers ` 그는 괜찮은 척하려고
    // 애쓰는 것 같았다.` — measured through the app's own worker on k2-fsa's four
    // clips — while *later* sherpa-onnx builds run `RemoveSpaceBetweenCjk` over
    // every transducer result, and its CJK ranges (0xA840–0xD7AF) include Hangul,
    // which turns the same audio into one run-together string. Translation does not
    // care either way (measured: the same Chinese for both spellings), but the
    // "原文" line does, so an upgrade of that pin has to be checked against Korean
    // output rather than only against Chinese. The token stream itself is right on
    // both, which is how the two can be told apart at all.
    //
    // A leading space is part of that output too (the first token carries its word
    // boundary) and is trimmed in the worker before it becomes a line.
    source: 'sherpa-onnx-zipformer-korean-2024-06-24',
    approxBytes: 70784728 + 2844692 + 2581421 + 60246 + 11722172 + 95308 + 47391,
    version: 'zipformer-korean-int8-2024-06-24',
  },
  zh: {
    id: 'zh',
    lang: 'zh',
    engine: 'sherpa',
    label: '中文识别模块（SenseVoice Small int8）',
    // SenseVoice-Small int8 on sherpa-onnx's own WASM build. That runtime brings
    // the Kaldi fbank feature extraction the ONNX graph expects, which is why no
    // feature-extraction code of ours exists anywhere.
    //
    // The model is multilingual (zh/en/ja/ko/yue) and non-autoregressive: measured
    // at RTF ~0.40 here, against ~0.9 for Whisper-base on the same audio, and it is
    // the only one of the three that survives a sentence mixing Chinese with
    // English words. Its "auto" language mode means it can still read Korean —
    // worse than the Korean module does — which is why the picker maps Korean to
    // `ko` and this stays the Chinese download. Where the runtime comes from — and
    // why it is a runtime problem rather than a model problem — is documented in
    // static/sherpa-asr.worker.js.
    source: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    approxBytes: 239233841 + 11722172 + 95308 + 47391 + 315894,
    version: 'sensevoice-small-int8-2024-07-17',
  },
}

/**
 * Which module transcribes a given source language.
 *
 * One language, one module — and written as a table rather than an expression
 * because this used to be `lang === 'en' ? 'en' : 'zh'`, with Korean sharing the
 * Chinese bytes. That sharing is what the table exists to make visible: a lookup
 * keyed by language answers "which download do I need", and for two years the
 * honest answer for Korean was "the Chinese one".
 *
 * The consequence of the split: switching between Chinese and Korean now swaps
 * one model for another, so the old engine is released (see `session.prepare`)
 * instead of the switch being free.
 */
export function moduleIdFor(lang: Lang): ModuleId {
  return MODULE_FOR_LANG[lang]
}

const MODULE_FOR_LANG: Record<Lang, ModuleId> = {
  en: 'en',
  ko: 'ko',
  zh: 'zh',
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
 * That ceiling is below what the big module needs before the recogniser even
 * exists: the 228 MB Chinese model arrives as one array we hold ourselves, and the
 * runtime then copies it into a session. So on an iPhone that install cannot
 * succeed, and the only honest thing to do is say so *before* the tap that kills
 * the page — which is what this answers, and why the threshold sits below the
 * module rather than near it. The count is not a precise device budget (there is no
 * API for one on iOS) but the gap is not close: what this catches is twice the
 * *high* end of the measurement.
 *
 * Korean is the other side of the line and the reason the number is where it is:
 * at ~84 MB it is the largest module a phone is allowed to try, three times
 * smaller than the one an iPhone 12 was measured losing its page to. Whether that
 * is small enough is not knowable from here — the heap checkpoints in
 * static/sherpa-asr.worker.js are what a real device answers with, and the log
 * tail survives the page being killed.
 */
export function moduleTooBigForDevice(spec: AsrModuleSpec): boolean {
  return isAppleMobile() && spec.approxBytes >= 150 * 1024 * 1024
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
  if (isMemoryFailure(message)) return t('这个设备内存不够装这个模块：关掉其他应用，或先装英文模块')
  if (/fetch|network|load failed|offline|connection/.test(text)) return t('下载中断了，检查网络后重试')
  if (/401|403|unauthor|forbidden|denied/.test(text)) return t('下载被拒绝，换个网络重试')
  if (/404|not found/.test(text)) return t('找不到模块文件，可能需要更新版本')
  if (/timeout|timed out/.test(text)) return t('下载太久没动静，重试一次')
  if (/quota|space|storage/.test(text)) return t('手机存储空间不够，清理后重试')
  if (/caches|indexeddb|cache storage/.test(text)) return t('浏览器不让存文件，用 https 打开再试')
  // WebAssembly failures read like nothing else in this file, and they are the
  // ones a phone actually hits: Emscripten reports an out-of-memory as a bare
  // `abort()`, which is the same text as a dozen other faults.
  if (/instantiate|webassembly|wasm|linkerror|compileerror/.test(text))
    return t('识别引擎没能在浏览器里启动，换个浏览器再试')
  if (/not allowed|securityerror|permission|blocked/.test(text)) return t('浏览器拦住了加载，用 https 或换个浏览器打开')
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
  ko: ['rc-model-ko-sherpa-zipformer'],
  zh: ['rc-model-zh-sherpa-zh'],
}

/**
 * Cache buckets this build no longer reads.
 *
 * Two modules are gone and their bytes are still on disk: the Korean model that
 * came and went before this one (~62 MB, a transformers.js Moonshine that read
 * Korean badly) and the Parakeet English module (~126 MB). Nothing will ever open
 * either of them again, and on a phone that is most of a quota.
 *
 * Matched as a prefix, so a bucket this worker created with a suffix still goes.
 * That is also the trap: the Korean module is *back*, and its bucket is spelled
 * `rc-model-ko-…`, which starts with a retired prefix. `purgeRetiredModuleCaches`
 * skips live buckets for exactly that reason — a startup cleanup that deleted a
 * module the registry still reads would make the app download it again on every
 * load, which is the kind of bug that looks like a network problem.
 */
const RETIRED_CACHE_PREFIXES = ['rc-model-ko-', 'rc-model-en-sherpa-nemo']

/** Every bucket the modules above read today. Retirement must not touch these. */
const LIVE_CACHE_KEYS = new Set<string>(Object.values(MODULE_CACHE_KEYS).flat())

/** Deletes caches from retired modules; returns what went, so it can be logged. */
export async function purgeRetiredModuleCaches(): Promise<string[]> {
  if (typeof caches === 'undefined') return []
  const gone: string[] = []
  try {
    for (const key of await caches.keys()) {
      if (LIVE_CACHE_KEYS.has(key)) continue
      if (!RETIRED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
      if (await caches.delete(key)) gone.push(key)
    }
  } catch {
    /* storage blocked — never worth failing startup over */
  }
  return gone
}
