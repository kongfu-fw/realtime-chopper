/**
 * The microphone level, as a fraction of a bar to draw.
 *
 * One function for the two places that draw it — the pool inside the record
 * button and the voiceprint beside the clock — because they are the same
 * question asked twice, and a second copy of the arithmetic would eventually be
 * a second scale: the same voice, two different heights, in one header.
 *
 * The scale is decibels, not the linear rms the segmenter reports. Linear rms is
 * unusable as a bar: ordinary speech sits around 0.02–0.2, so nine tenths of the
 * bar would be unreachable and every classroom would draw the same short stub,
 * loud or quiet. In dB the useful range is the one this app already calibrated
 * against a phone on a desk — a quiet room is about −60 dBFS and close speech
 * about −12 — so those two numbers are the ends of the bar.
 *
 * Kept out of the components for the same reason as `tiers.ts`: the ends of the
 * scale are a decision, and a test can hold a decision still where a render
 * cannot.
 */

/** −60 dBFS: a quiet room. Below this the bar is empty. */
export const LEVEL_FLOOR_DB = -60
/** −12 dBFS: close speech. At or above this the bar is full. */
export const LEVEL_CEIL_DB = -12

/**
 * How full the bar should be for a linear rms, from 0 (silence) to 1 (loud).
 *
 * Never returns anything outside 0…1, and never returns `NaN`: a muted
 * microphone reports 0, and `Math.log10(0)` is `-Infinity`, which through
 * `calc()` in a custom property would silently drop the rule — leaving the
 * previous frame's bar on screen. A frozen meter reads as a live one, so a
 * value that is not a level at all has to draw nothing.
 */
export function levelFraction(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return rms > 0 ? 1 : 0
  const db = 20 * Math.log10(rms)
  if (db <= LEVEL_FLOOR_DB) return 0
  if (db >= LEVEL_CEIL_DB) return 1
  return (db - LEVEL_FLOOR_DB) / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB)
}
