import assert from 'node:assert/strict'
import test from 'node:test'
import { LEVEL_CEIL_DB, LEVEL_FLOOR_DB, levelFraction } from './level.ts'

/**
 * The one arithmetic behind both places that draw the microphone level.
 *
 * The failure modes worth naming before the code exists:
 *
 * - a *linear* rms drawn as if it were a fraction: quiet speech sits around
 *   0.02, so a bar scaled by `rms` directly would look dead for every sound a
 *   classroom makes;
 * - a level of exactly zero (a muted microphone) must not become `-Infinity`
 *   and then `NaN` in a CSS custom property, which silently drops the rule and
 *   leaves the effect at whatever it was;
 * - a loud input must not overflow the bar;
 * - and the two ends of the scale have to mean something a person can check:
 *   the floor is a quiet room and the ceiling is close speech, which is why
 *   they are named constants rather than numbers in a component.
 */

test('silence and a quiet room are both the floor', () => {
  assert.equal(levelFraction(0), 0)
  // -60 dBFS: what a dead-quiet room reads as, and the bottom of the scale.
  assert.equal(levelFraction(10 ** (LEVEL_FLOOR_DB / 20)), 0)
  // Anything below it clamps rather than going negative.
  assert.equal(levelFraction(1e-9), 0)
})

test('close speech is the ceiling, and louder still is the ceiling', () => {
  assert.equal(levelFraction(10 ** (LEVEL_CEIL_DB / 20)), 1)
  assert.equal(levelFraction(1), 1)
})

test('the middle of the scale is the middle of the bar', () => {
  const middle = (LEVEL_FLOOR_DB + LEVEL_CEIL_DB) / 2
  assert.ok(Math.abs(levelFraction(10 ** (middle / 20)) - 0.5) < 1e-6)
})

test('a louder input never draws a shorter bar', () => {
  const steps = [1e-4, 1e-3, 5e-3, 0.02, 0.08, 0.25, 0.9]
  const drawn = steps.map((rms) => levelFraction(rms))
  for (let i = 1; i < drawn.length; i += 1) {
    assert.ok(drawn[i] >= drawn[i - 1], `${steps[i - 1]} → ${steps[i]} drew shorter`)
  }
})

test('a value that is not a level at all draws nothing instead of NaN', () => {
  // `Math.log10` of a negative number is NaN, and a NaN custom property would
  // leave the previous frame's bar on screen — a frozen meter reads as a live
  // one, which is exactly the lie this effect must not tell.
  assert.equal(levelFraction(Number.NaN), 0)
  assert.equal(levelFraction(-0.5), 0)
  assert.equal(levelFraction(Number.POSITIVE_INFINITY), 1)
})
