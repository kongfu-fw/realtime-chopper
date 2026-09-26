import { writable } from 'svelte/store'
import { EN } from './en.ts'
import { KO } from './ko.ts'

/**
 * Three languages — Chinese, English, Korean — over the whole app, including the
 * log lines and the diagnostic report (a report in a language its reader cannot
 * read is not a report).
 *
 * ## Strings are keyed by their Chinese text
 *
 * `t('原文')`, not `t('panel.original')`. There are two reasons, and they are
 * both about a project whose working language is Chinese:
 *
 * - the source text stays visible in the code, so a reader never has to jump to
 *   a table to find out what a screen actually says;
 * - Chinese is also the **fallback**. A string the dictionaries have not caught
 *   up with renders as the Chinese it was written as — the app degrades to what
 *   it does today rather than to a key name or an empty box.
 *
 * The cost is that a missing translation is silent, so `src/lib/i18n/messages.test.ts`
 * scans every `t('…')` in the source tree and fails when one of them has no
 * English or Korean entry. That test is what keeps this honest; without it the
 * fallback would quietly turn into "half the app is Chinese".
 *
 * ## Rules that follow from it
 *
 * - Write the Chinese source as a **single-quoted string** with `{placeholders}`,
 *   never a template literal: the scan above has to be able to read the key out
 *   of the source text, and an interpolated string cannot be one.
 * - Interpolate through `params`, so translators can move the placeholder:
 *   `t('已清理 {n} 个模块', { n: gone.length })`.
 * - A translation may use `单数|复数` for English agreement (`'{n} line|{n} lines'`);
 *   Korean and Chinese need only one form.
 */

export type Lang = 'zh' | 'en' | 'ko'

/**
 * What settings store: a language, or `auto` — which follows the browser.
 *
 * `auto` is the default and the recommended setting; naming a language is the
 * escape hatch for a browser whose language is not the language the user reads
 * (an English system used in Korean, a phone bought abroad).
 */
export type UiLangSetting = 'auto' | Lang

export const SUPPORTED_LANGS: readonly Lang[] = ['zh', 'en', 'ko']

/**
 * How a language names *itself*.
 *
 * A language picker is the one list that is never translated: someone whose
 * phone is stuck in a language they cannot read has to be able to find their way
 * out of it by recognizing their own language's name.
 */
export const LANG_NAMES: Record<Lang, string> = {
  zh: '中文',
  en: 'English',
  ko: '한국어',
}

/**
 * What an unrecognised browser language gets.
 *
 * Chinese, because it is the project's own language: a browser asking for
 * German or Spanish is likelier to be a Chinese-speaking user who never changed
 * their locale than a German speaker looking for this app.
 */
export const DEFAULT_LANG: Lang = 'zh'

export type Params = Record<string, string | number>

const DICTS: Record<Exclude<Lang, 'zh'>, Record<string, string>> = { en: EN, ko: KO }

/** One language tag → one of ours, or `null` when it is not one we speak. */
function match(tag: string): Lang | null {
  const lower = tag.trim().toLowerCase()
  if (lower.startsWith('zh')) return 'zh'
  if (lower.startsWith('ko')) return 'ko'
  if (lower.startsWith('en')) return 'en'
  return null
}

/**
 * Everything the browser is willing to say about the languages its user reads,
 * most preferred first.
 *
 * `navigator.languages` is the useful one — it is an ordered list, so a phone set
 * to Korean with English as a second choice lands on Korean — and
 * `navigator.language` is the fallback for browsers that only report one.
 */
function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return []
  const list = [...(navigator.languages ?? []), navigator.language]
  return list.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
}

/** The first language we speak out of the ones the browser offers. */
export function detectLang(candidates?: readonly string[]): Lang {
  for (const tag of candidates ?? browserLanguages()) {
    const hit = match(tag)
    if (hit) return hit
  }
  return DEFAULT_LANG
}

/**
 * `?lang=ko`, for handing someone a link in a known language.
 *
 * It exists for support as much as for testing: "open it with `?lang=en` and tell
 * me what you see" is easier to explain than any settings path, and it works on a
 * phone where the app has not been set up yet. Read once, at load.
 */
export function urlLang(): Lang | null {
  if (typeof location === 'undefined') return null
  try {
    const tag = new URLSearchParams(location.search).get('lang')
    return tag ? match(tag) : null
  } catch {
    return null
  }
}

/**
 * The link's language, good until the picker is used.
 *
 * It outranks a stored choice — the person most likely to be handed such a link
 * is the one whose interface language came out wrong, and they may well have
 * pinned it already — but it is retired the moment the picker is touched, so it
 * can never fight with a choice made there.
 */
let urlOverride: Lang | null = urlLang()

/** The picker's next choice retires `?lang=`; see `urlOverride`. */
export function dropUrlOverride(): void {
  urlOverride = null
}

const initial = urlOverride ?? detectLang()

let current: Lang = initial

/**
 * The language the UI is in right now.
 *
 * A store, because components have to re-render when it changes, *and* a plain
 * module variable, because the log lines and error messages that are built
 * outside Svelte (in the pipeline, the workers' message handlers, the diagnostic
 * report) still need the current answer without subscribing to anything.
 */
export const uiLang = writable<Lang>(initial)

function applyHtmlLang(lang: Lang): void {
  if (typeof document === 'undefined') return
  // `zh-CN`, not `zh`: the recogniser and the translator are now both set to
  // Simplified, and the tag is what hyphenation and font fallback read.
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang
}

applyHtmlLang(initial)

export function setUiLang(lang: Lang): void {
  if (lang === current) return
  current = lang
  uiLang.set(lang)
  applyHtmlLang(lang)
}

/** The current language, for code that runs outside a reactive context. */
export function currentLang(): Lang {
  return current
}

/**
 * The language a settings value resolves to: `auto` looks at the browser every
 * time it is asked, so switching the browser's language and reloading is enough.
 * A live `?lang=` still outranks both (see `urlOverride`).
 */
export function effectiveLang(setting: UiLangSetting): Lang {
  if (urlOverride) return urlOverride
  return setting === 'auto' ? detectLang() : setting
}

/** `单数|复数` — English agreement, chosen by `params.n`. Absent for zh/ko. */
function chooseForm(text: string, params?: Params): string {
  if (!text.includes('|')) return text
  const forms = text.split('|')
  const n = typeof params?.n === 'number' ? params.n : undefined
  if (n === undefined) return forms[0]
  if (forms.length >= 3) return n === 0 ? forms[0] : n === 1 ? forms[1] : forms[2]
  return n === 1 ? forms[0] : forms[1]
}

function fill(text: string, params?: Params): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Strings the dictionaries were asked for and did not have.
 *
 * Only ever non-empty in development: the coverage test is what is supposed to
 * catch this, and a missing entry in a shipped build falls back to Chinese, which
 * is what the app did before it had languages at all.
 */
const missing = new Set<string>()

export function missingTranslations(): string[] {
  return [...missing].sort()
}

export function translate(lang: Lang, source: string, params?: Params): string {
  if (lang === 'zh') return fill(chooseForm(source, params), params)
  const hit = DICTS[lang][source]
  if (hit === undefined) {
    missing.add(source)
    return fill(chooseForm(source, params), params)
  }
  return fill(chooseForm(hit, params), params)
}

/**
 * The current language's version of a Chinese string.
 *
 * Outside a component this reads whatever the language is *now*; in markup, use
 * `translator($uiLang)` instead, so the expression re-renders when the language
 * changes.
 *
 * ## Why markup sometimes has to hand the language in
 *
 * Svelte re-renders what it can see. An expression that reads `$uiLang` is
 * tracked; one that calls `t()` is not, because `t` reads a module variable,
 * which is invisible to it. So a label that follows the interface language is
 * either built from `tr` or comes from an accessor that takes the language as
 * its last argument — `langLabel(lang, $uiLang)`, `moduleShort(id, $uiLang)` —
 * which lets the call site hand the reactive value in. Called without it, in a
 * log line or an error message, the accessor answers for the language of that
 * moment, which is what happens-at-a-moment-in-time code wants.
 *
 * The failure to watch for is a bare accessor call in markup: it renders once
 * and then keeps the old language until something else re-renders it.
 */
export function t(source: string, params?: Params): string {
  return translate(current, source, params)
}

/** A `t` bound to one language — what a component derives from the store. */
export function translator(lang: Lang): (source: string, params?: Params) => string {
  return (source, params) => translate(lang, source, params)
}
