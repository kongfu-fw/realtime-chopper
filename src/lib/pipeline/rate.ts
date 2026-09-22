/**
 * Requirement 6: speaking rate follows the length of the pending-TTS queue.
 *
 * Constraints from the platform: `SpeechSynthesisUtterance.rate` only applies
 * to an utterance that has not started yet, so a rate change lands on the next
 * sentence, never mid-sentence. Adjusting the rate is therefore free — nothing
 * has to be re-synthesised — but it can never rescue the sentence already
 * being spoken.
 */

const STEP = 0.15
/** Sentences of buffer before a change is applied, to stop the rate oscillating. */
const HYSTERESIS = 3

export interface RateInput {
  /** Sentences waiting in the TTS queue (excluding the one being spoken). */
  backlog: number
  baseRate: number
  maxRate: number
  auto: boolean
}

export function targetRate({ backlog, baseRate, maxRate, auto }: RateInput): number {
  if (!auto) return clamp(baseRate, 0.5, 2)
  // Backlog of 1 (the sentence about to be spoken) is the steady state.
  const wanted = baseRate + STEP * Math.max(0, backlog - 1)
  return clamp(Math.max(baseRate, wanted), baseRate, Math.min(maxRate, 2))
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Applies hysteresis so the spoken rate changes at most once every few
 * sentences instead of wobbling on every arrival.
 */
export class RateController {
  private current: number

  constructor(initial: number) {
    this.current = initial
  }

  get rate(): number {
    return this.current
  }

  update(input: RateInput): { rate: number; changed: boolean } {
    const wanted = targetRate(input)
    const drift = Math.abs(wanted - this.current)
    const meaningful = this.current === 0 || drift >= STEP * HYSTERESIS || wanted === input.baseRate
    if (!meaningful) return { rate: this.current, changed: false }
    const changed = Math.abs(wanted - this.current) > 0.001
    this.current = wanted
    return { rate: this.current, changed }
  }

  reset(rate: number): void {
    this.current = rate
  }
}
