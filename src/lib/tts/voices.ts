import { get, writable } from 'svelte/store'
import { settings, type Settings } from '../store/settings'
import { createTtsEngine, ttsConfigFrom, type VoiceOption } from './engine.ts'

/**
 * The voice list, fetched before the dialog that shows it is opened.
 *
 * The dialog used to fetch it in its own `$effect`, which meant the `<select>`
 * rendered a placeholder (`正在读取音色…`) and then grew its option list a moment
 * later — the row moved under the finger that was already reaching for it, and the
 * scroll position of the dialog changed with it. The fix is not to render later or
 * to reserve room: it is that the answer should already be here.
 *
 * So the list is kept warm for the *current* settings rather than asked for on
 * open. Three things ask for it, and they are all the same call:
 *
 *  - the settings store itself (a subscription below), so switching the target
 *    language or the engine refreshes the list on the screen the dialog opens over;
 *  - the first user gesture (`App.svelte`), because iOS publishes no voices at all
 *    until the page has spoken — the list that came back empty at startup is asked
 *    again the moment speech has been armed;
 *  - the dialog, for the one case nothing else covers: it was opened with a key
 *    that has never been asked for (a proxy address typed into another screen, then
 *    this one opened before the store's own write came back).
 */

/**
 * What the list is for: the engine, the proxy it talks to, and the language being
 * read. Any of the three changing is a different list — the system engine's
 * `voiceURI`s and the proxy's `ShortName`s are two namespaces with nothing in
 * common, and a Chinese voice cannot read English.
 */
export function voiceKey(settings: Settings): string {
  const proxy = settings.ttsEngine === 'edge' ? settings.ttsProxyUrl : ''
  return `${settings.ttsEngine}|${proxy}|${settings.targetLang}`
}

export interface VoiceList {
  /** Which settings this list answers for; see `voiceKey`. */
  key: string
  voices: VoiceOption[]
  loading: boolean
  /** Why the list is empty, when it is empty for a reason worth naming. */
  error: string
}

const EMPTY: VoiceList = { key: '', voices: [], loading: false, error: '' }

const cache = new Map<string, VoiceList>()

/** What the dialog renders. Never empty for the current settings once it has been asked. */
export const voiceList = writable<VoiceList>(EMPTY)

/**
 * A finished load replaces the cache, and the screen only when it is the screen's
 * own list — a slow answer for the engine the user just left must not land on top
 * of the one they are looking at.
 */
function publish(next: VoiceList): void {
  cache.set(next.key, next)
  if (get(voiceList).key === next.key) voiceList.set(next)
}

/**
 * Makes sure the list for these settings is loaded (or already is), and shows it.
 *
 * Idempotent and cheap to call often: a cached list with voices in it is the
 * answer, and nothing is asked again. An **empty** list is not an answer — it is a
 * question the platform has not answered yet (iOS before the first utterance, a
 * proxy that is not up) — so it is asked again next time rather than cached as
 * final, and the dialog opening is one of the times it is asked.
 */
export function ensureVoices(settings: Settings): void {
  const key = voiceKey(settings)
  const cached = cache.get(key)
  if (cached?.loading || cached?.voices.length) {
    if (get(voiceList).key !== key) voiceList.set(cached)
    return
  }

  const state: VoiceList = { key, voices: [], loading: true, error: '' }
  cache.set(key, state)
  voiceList.set(state)

  const engine = createTtsEngine(ttsConfigFrom(settings))
  if (!engine.available) {
    // Nothing to ask and nothing to report as a failure: *why* this engine cannot
    // speak — no proxy address, or no `speechSynthesis` at all — is a fact about
    // the setting, and the dialog says it in its own words (see `ReadSettings`).
    publish({ key, voices: [], loading: false, error: '' })
    return
  }
  void engine.voicesFor(settings.targetLang, 2500).then(
    (voices) => publish({ key, voices, loading: false, error: '' }),
    (err: unknown) =>
      publish({
        key,
        voices: [],
        loading: false,
        // A failing proxy used to surface as "没有可用音色", which reads as "your
        // phone has no voices" — the opposite of what just happened.
        error: err instanceof Error ? err.message : String(err),
      }),
  )
}

/**
 * The list to render for these settings, given what the store holds.
 *
 * The store answers for the key it was last asked about; anything else is a list
 * that is about to be loaded (`ensureVoices` runs in the same update as this), and
 * it renders as the loading state rather than as the previous engine's voices.
 */
export function voiceListFor(settings: Settings, list: VoiceList): VoiceList {
  const key = voiceKey(settings)
  return list.key === key ? list : { key, voices: [], loading: true, error: '' }
}

// Kept warm rather than primed once: the two settings that decide the list (the
// target language and the engine) are changed on the screen this dialog opens
// over, and subscribing also runs the callback once, which is what loads the
// startup list without anything else having to remember to ask.
settings.subscribe((value) => ensureVoices(value))
