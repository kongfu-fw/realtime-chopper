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
  // Not "the Chinese module" any more: it transcribes Korean too, and on every
  // device that can hold it, Korean is routed here. See `moduleIdFor`.
  zh: '中韩识别模块',
}

/** Shorter form, for the settings list where a size sits next to it. */
export const MODULE_SHORT: Record<ModuleId, string> = {
  en: '英文 · Moonshine',
  ko: '韩语 · Moonshine',
  zh: '中韩 · SenseVoice',
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
   * Output tokens per second of audio this module is allowed, when its engine
   * needs a budget at all (Moonshine only).
   *
   * Left unset for English on purpose: Moonshine's own paper rate (6/s) is the
   * default and it is calibrated on English. Korean measured at 12/s — at 6/s the
   * same clips come out at 35.5% CER because every utterance is truncated. The
   * numbers are in `moonshine.ts` next to the constant.
   */
  tokensPerSecond?: number
  /**
   * How much *speech* one utterance of this module's language needs before the
   * engine can be believed, in ms. Unset (or zero) means "no floor".
   *
   * Korean is why this exists, and the measurement is blunt: handed an utterance
   * with less than about a second of speech in it, `moonshine-base-ko-ONNX` does
   * not report that it heard nothing — it answers with a sentence it memorised
   * while being trained. Measured on this repo (q8, the app's own call options,
   * 16 kHz mono, macOS TTS Korean as the speech):
   *
   *   0.6 s of clear Korean speech  → "audiotext", at every level, −48…−8 dBFS
   *   "네." (0.26 s), "맞아요." (0.61 s), "질문이 있어요." (1.06 s) → "audiotext"
   *   1.20 s                        → the sentence, word for word
   *   1.5 s of silence              → "언망 언망 언"
   *   4.0 s of room noise           → "다음 영상에서 만나요."
   *
   * It is not monotonic — a 1.35 s slice was invented while a 1.2 s one was read —
   * so this is a floor to *join short utterances to*, not a threshold to discard
   * at. The segmenter holds anything shorter and sends it with the next utterance,
   * and the transcript guard refuses whatever comes out of the segments no join
   * could fix. Both layers are needed: the floor removes most of the failures, and
   * only the screen can catch the rest.
   *
   * English leaves it unset on purpose: the same 0.6 s of speech through
   * `moonshine-base-ONNX` comes back as its first three words, and silence comes
   * back as an empty string, which the pipeline already filters.
   */
  coalesceMs?: number
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
    engine: 'moonshine',
    label: '韩语识别模块（Moonshine Base）',
    // The Korean model that survived a real recording — and the one this app first
    // tried and wrongly rejected. The history is worth keeping straight:
    //
    //   1. Moonshine Base-KO was the Korean module. It measured 18.4% CER on
    //      k2-fsa's clips and was replaced by a dedicated Korean model.
    //   2. That dedicated model (k2-fsa's Zipformer Korean int8) measured 1.3% CER
    //      on the same clips, so Korean got its own 73 MB sherpa pack.
    //   3. On a real 2.47 s recording from this app's microphone the Zipformer
    //      returned one syllable (`음`) for a whole sentence, while Moonshine —
    //      both at the same time — read it. The 18.4% in step 1 was the app's own
    //      token budget (6/s, calibrated for English) cutting Korean short, not the
    //      model: at the Korean rate measured here the same clips land at 11.8%.
    //
    // The clips and the recording disagree in the way benchmark domains always do.
    // k2-fsa's Korean weights are all conversions of KsponSpeech, i.e. scripted
    // read speech in a quiet room — 90–98% of its energy below 1 kHz — and full
    // measurements of both sides are in `moduleIdFor` below and in DOCS.md.
    //
    // So this module is the phone's Korean: 64 MB installed, against the 84 MB the
    // Zipformer pack occupied once its share of the shared runtime was counted —
    // q8, and running on the engine already proven on an iPhone, since the English
    // module is the same architecture through the same path. Every device that can
    // hold SenseVoice uses that instead (see `moduleIdFor`).
    hfModelId: 'onnx-community/moonshine-base-ko-ONNX',
    approxBytes: 20656286 + 42752973 + 3761751 + 135803 + 988 + 215 + 184 + 3 + 310,
    version: 'moonshine-base-ko-onnx',
    /** Korean is not English's token rate; see the field's comment and `moonshine.ts`. */
    tokensPerSecond: 12,
    /**
     * The one measured floor in the registry. 1.2 s is where the probes stop
     * inventing and start reading; below it, every input tried — speech at any
     * level, silence, room noise, a single word — came back as memorised text.
     */
    coalesceMs: 1200,
  },
  zh: {
    id: 'zh',
    lang: 'zh',
    engine: 'sherpa',
    label: '中韩识别模块（SenseVoice Small int8）',
    // SenseVoice-Small int8 on sherpa-onnx's own WASM build. That runtime brings
    // the Kaldi fbank feature extraction the ONNX graph expects, which is why no
    // feature-extraction code of ours exists anywhere.
    //
    // The model is multilingual (zh/en/ja/ko/yue) and non-autoregressive: measured
    // at RTF ~0.40 here, against ~0.9 for Whisper-base on the same audio, and it is
    // the only one of the three that survives a sentence mixing Chinese with
    // English words. Its "auto" language mode is what makes it usable for Korean at
    // all — and on real recordings it beats the model that was built for Korean,
    // which is why the picker routes Korean here rather than to `ko` (the
    // measurement is on `moduleIdFor`). Where the runtime comes from — and why it is
    // a runtime problem rather than a model problem — is documented in
    // static/sherpa-asr.worker.js.
    source: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    approxBytes: 239233841 + 11722172 + 95308 + 47391 + 315894,
    version: 'sensevoice-small-int8-2024-07-17',
  },
}

/**
 * Which module transcribes a given source language.
 *
 * A lookup keyed by language answering "which download do I need" — with one
 * exception, and it is a measured one. Korean has two models that can do the job,
 * and the one that was *built* for Korean is not the one that reads Korean best.
 *
 * The evidence came from a real recording rather than a benchmark: 2.47 s of
 * clear Korean speech from this app's own microphone (`우리는 교회를 다니는 사람이
 * 아니.`), 16 kHz mono, run through the app's own workers:
 *
 *     ko  Zipformer Korean int8 (73 MB)   →  "음"                    155 ms
 *     ko  Moonshine Base-KO q8 (64 MB)    →  the sentence                174 ms
 *     zh  SenseVoice Small int8 (228 MB)  →  the sentence exactly       419 ms
 *
 * The Zipformer got here on its own benchmark first: CER 1.3% on k2-fsa's four
 * clips, against 3.9% for SenseVoice and 11.8% for Moonshine-at-a-Korean-token-rate.
 * Those clips are scripted read speech in a quiet room — k2-fsa's Korean models are
 * all conversions of KsponSpeech — and the recording is not that domain: its loud
 * frames carry ~70% of their energy at 2–3 kHz with the consonant frames as loud as
 * the vowels, where the clips it was trained on are 90–98% below 1 kHz. It is not a
 * level problem: k2-fsa's own clip still transcribes perfectly when attenuated to
 * rms 0.004, while the recording fails at every gain from 1× to 24×.
 *
 * So Korean prefers SenseVoice here, and falls back to Moonshine — smaller than the
 * module it replaced (64 MB against 84 MB), and running on the engine this app
 * already trusts on an iPhone, since the English module is the same architecture
 * through the same path. `moduleTooBigForDevice` refuses 228 MB on an Apple-mobile
 * page before the download starts; on those devices the fallback is the difference
 * between Korean working and Korean not existing. Devices that can hold SenseVoice
 * never load it (see `moduleUsedOnThisDevice`, which is what lets the lists say so).
 */
export function moduleIdFor(lang: Lang): ModuleId {
  const preferred = MODULE_FOR_LANG[lang]
  const fallback = FALLBACK_MODULE_FOR_LANG[lang]
  if (fallback && moduleTooBigForDevice(ASR_MODULES[preferred])) return fallback
  return preferred
}

const MODULE_FOR_LANG: Record<Lang, ModuleId> = {
  en: 'en',
  // SenseVoice is multilingual; it answers Korean too, and better. See above.
  ko: 'zh',
  zh: 'zh',
}

/**
 * What a language uses when its preferred module cannot be installed here.
 *
 * Only Korean has one, because only Korean has two models that can do the job and
 * only Korean's preferred model is too big for a phone. Every other language's
 * single module is the answer on every device.
 */
const FALLBACK_MODULE_FOR_LANG: Partial<Record<Lang, ModuleId>> = {
  ko: 'ko',
}

/**
 * Whether any language on *this* device routes to this module.
 *
 * The Korean module is why this exists. On a desktop it is never loaded — SenseVoice
 * is — yet it is still a real module and the only one an iPhone can use. A row the
 * app will never load has to say so, or the list reads as "install this and Korean
 * will work" while the app has already decided otherwise, and 64 MB is not a
 * rounding error on a phone plan.
 */
export function moduleUsedOnThisDevice(id: ModuleId): boolean {
  return (Object.keys(MODULE_FOR_LANG) as Lang[]).some((lang) => moduleIdFor(lang) === id)
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
 * at 64 MB it is the largest module a phone is allowed to try, three times smaller
 * than the one an iPhone 12 was measured losing its page to. (That module used to
 * be the Korean sherpa pack, 84 MB installed; the line did not move, the model did.)
 * Whether that is small enough is not knowable from here — the heap checkpoints in
 * static/sherpa-asr.worker.js are what a real device answers with, and the log
 * tail survives the page being killed.
 *
 * It is also read by `moduleIdFor`, so it does not only decide what the install
 * dialog warns about: on a device that answers true, Korean is routed to the small
 * module instead of the accurate one. A guard that says "this cannot work here"
 * should change what the app does, not just what it prints.
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
  // Same bucket as English, and that is correct rather than sloppy: both are
  // transformers.js models and that library caches everything under one name. It
  // also means the retired `rc-model-ko-…` prefix can sweep the Korean Zipformer's
  // 73 MB — nothing live is spelled that way any more.
  ko: ['transformers-cache'],
  zh: ['rc-model-zh-sherpa-zh'],
}

/**
 * Cache buckets this build no longer reads.
 *
 * Two modules are gone and their bytes are still on disk: the Korean Zipformer
 * pack this build replaces (~73 MB, the one that collapsed on real recordings) and
 * the Parakeet English module (~126 MB). Nothing will ever open either of them
 * again, and on a phone that is most of a quota.
 *
 * Matched as a prefix, so a bucket this worker created with a suffix still goes.
 * `LIVE_CACHE_KEYS` is the other half of that: a startup cleanup that deleted a
 * bucket the registry still reads would make the app download it again on every
 * load, which is the kind of bug that looks like a network problem. The prefix
 * above is only safe to retire because the Korean module moved back to
 * transformers.js, whose bucket is named `transformers-cache` — spelled nothing
 * like the pack it replaces.
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
