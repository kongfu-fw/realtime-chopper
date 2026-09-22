import type { Line } from '../types'

/**
 * Lag estimation for the subtitle bar (requirement 20).
 *
 * We cannot know the real duration of speech that has not been synthesised, so
 * we estimate: CJK scripts are counted per character, everything else per word.
 * The number is shown to the user as an approximation and drives the point at
 * which "跳到最新" appears.
 */

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/

const CJK_CHARS_PER_SECOND = 4.6
const WORDS_PER_SECOND = 2.6

export function estimateSpeechSeconds(text: string, rate: number): number {
  const safeRate = rate <= 0 ? 1 : rate
  let cjk = 0
  let words = 0
  let currentWord = false
  for (const ch of text) {
    if (CJK.test(ch)) {
      cjk++
      currentWord = false
    } else if (/\s/.test(ch)) {
      currentWord = false
    } else if (ch === ',' || ch === '.' || ch === '!' || ch === '?') {
      currentWord = false
    } else if (!currentWord) {
      currentWord = true
      words++
    }
  }
  const seconds = cjk / CJK_CHARS_PER_SECOND + words / WORDS_PER_SECOND
  return seconds / safeRate
}

/**
 * Seconds of audio still queued: everything already translated but not yet
 * read, plus a rough allowance for the sentence still in flight.
 */
export function estimateLagSeconds(pending: Line[], rate: number, inFlight = 0): number {
  let total = 0
  for (const line of pending) {
    const text = line.translation ?? ''
    if (text) total += estimateSpeechSeconds(text, rate)
  }
  return Math.round((total + inFlight) * 10) / 10
}
