import type { Lang } from '../types'

/**
 * What the recogniser is allowed to put in the transcript.
 *
 * Why this exists. `session.ts` used to filter recognition results on one
 * condition — "the text is empty" — on the assumption that a model handed
 * silence or room noise says so by returning nothing. That assumption holds for
 * the English Moonshine module and is **false for the Korean one**: handed
 * anything it cannot read, `moonshine-base-ko-ONNX` answers with a sentence it
 * memorised during training and never with an empty string. Measured on this
 * repo (q8, the app's own call options, macOS TTS Korean as the speech):
 *
 *   0.6 s of clear Korean speech   → "audiotext"          (any level, −48…−8 dBFS)
 *   "네." / "맞아요." / "질문이 있어요." (0.26–1.06 s) → "audiotext"
 *   1.5 s of silence               → "언망 언망 언"
 *   1.5 s of room noise            → "지금까지 뉴스 스"
 *   4.0 s of room noise            → "다음 영상에서 만나요."
 *   the same 0.6 s to the English module → "We are not the" (right words)
 *   silence / room noise to the English module → "" (nothing to filter)
 *
 * So the Korean module's output has to be *screened*, not merely checked for
 * emptiness, and the screening has to work on the text alone: it is the one
 * thing every engine, device and language shares. Three rules, in the order
 * they are applied — the first that matches is the reason:
 *
 *  1. `memorised` — the text contains one of the strings on this model's
 *     measured list of conclusions (below). Small on purpose: only strings
 *     actually observed, never a guess at what else it might say.
 *  2. `no-script` — a whole short utterance in a script the requested language
 *     does not use. `audiotext` is Latin with no Hangul in a Korean session.
 *     Long lines are exempt: a speaker switching language mid-sentence is a
 *     real thing, a one-word utterance that is in no script of the target
 *     language is a model inventing one.
 *  3. `repetition` — the same unit three or more times over the whole line, the
 *     classic autoregressive runaway ("언망 언망 언망", "우리는 육. 우리는 육.
 *     우리는 육."). Costs a genuine "네. 네. 네." — see the note on the rule.
 *
 * What is deliberately *not* here: a level or SNR gate. The failure is not
 * quieter audio — the same 0.6 s slice is invented at every level from −48 to
 * −8 dBFS — so a level test would refuse speech that the model reads fine and
 * accept the invented text it does not. Duration is the *input* side of this
 * problem and lives in the segmenter (`coalesceMs`).
 *
 * Dropping is not silent: `session.ts` writes the text and the reason to the
 * log, so a sentence this file got wrong can be found instead of guessed at.
 */
export type TranscriptFlaw = 'memorised' | 'no-script' | 'repetition'

/**
 * The script a language's transcript is written in, when it has one of its own.
 *
 * English returns `null` rather than "Latin": the English module answers
 * non-speech with an empty string and reads a 0.6 s slice correctly (both
 * measured above), so there is nothing a script rule would catch, and requiring
 * Latin would start refusing lines that are legitimately numbers or names.
 */
function requiredScript(lang: Lang): RegExp | null {
  // Hangul syllables, plus the jamo blocks — a transcript can open on a
  // consonant that is written as a letter rather than composed into a syllable.
  if (lang === 'ko') return /[\u1100-\u11ff\u3131-\u318e\uac00-\ud7af]/
  // Han, including the extension A and compatibility blocks.
  if (lang === 'zh') return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
  return null
}

/**
 * Sentences the Korean module has been *measured* to emit when it has nothing
 * to read, normalised the way `normalise` does it.
 *
 * Two of them are endings of the Korean video-caption register — "see you in the
 * next video", "that was the news" — which is the strongest hint available about
 * what this finetune was trained on; its model card says nothing about it, and a
 * copy of the English card at that. The point of the list is not completeness (it
 * cannot be) but that the string the user actually saw is refused by name, and
 * that adding the next one is a one-line change with a measurement behind it.
 */
const MEMORISED: Partial<Record<Lang, readonly string[]>> = {
  ko: ['audiotext', '다음영상에서만나요', '지금까지뉴스'],
}

/**
 * The text reduced to what survives translation: lower case, letters and digits.
 *
 * Matching has to survive the model's punctuation and spacing choices —
 * "다음 영상에서 만나요." and "다음 영상에서만나요" are the same sentence — so
 * everything that is not a letter or a digit is removed from both sides.
 */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * The line as words, punctuation taken off each of them.
 *
 * Only used for the repetition rule, where the compared units are whatever the
 * model put between spaces: "육." and "육" have to count as the same word.
 */
function units(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((word) => word.length > 0)
}

/**
 * Whether the whole line is the same thing repeated.
 *
 * A period of up to three units, repeated to the end of the line, at least
 * three times: "X X X", "X Y X Y X Y", "X Y Z X Y Z X Y Z". Requiring the
 * pattern to reach the end is what keeps "네. 알겠습니다" and a chorus out of
 * this rule.
 *
 * The accepted cost, stated rather than hidden: a real triple "네. 네. 네."
 * is dropped too. Three identical units is a normal thing to say and the
 * cheapest possible loop marker, and the trade is deliberate — a lost "yes yes
 * yes" is visible in the log and re-recognisable from the recording, while a
 * loop kept in the transcript is translated, read aloud and believed.
 */
function repeatsItself(words: string[]): boolean {
  for (let period = 1; period <= 3; period++) {
    if (words.length < period * 3) continue
    let periodic = true
    for (let i = period; i < words.length; i++) {
      if (words[i] !== words[i - period]) {
        periodic = false
        break
      }
    }
    if (periodic) return true
  }
  return false
}

/**
 * Why this recognised line must not become a transcript line, or `null` to keep
 * it. The order of the checks is the order of their confidence.
 */
export function transcriptFlaw(text: string, lang: Lang): TranscriptFlaw | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const flattened = normalise(trimmed)
  for (const phrase of MEMORISED[lang] ?? []) {
    if (flattened.includes(phrase)) return 'memorised'
  }

  const script = requiredScript(lang)
  const words = units(trimmed)
  if (script && !script.test(trimmed) && words.length <= 2) return 'no-script'

  if (repeatsItself(words)) return 'repetition'

  return null
}
