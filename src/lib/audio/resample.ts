/**
 * Resampling.
 *
 * We deliberately ask the microphone for its native rate (48 kHz on iOS) rather
 * than requesting 16 kHz from `getUserMedia`, because Safari only honours part
 * of the constraint set and the quality win for requirement 13 comes from
 * having echo cancellation and AGC *off*, not from the forced rate. Conversion
 * to 16 kHz happens here, off the main thread.
 */
export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate) return input
  const ratio = inputRate / outputRate
  const length = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const left = Math.floor(pos)
    const right = Math.min(input.length - 1, left + 1)
    const frac = pos - left
    const a = input[left] ?? 0
    const b = input[right] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

/** Root-mean-square level, used by the VAD and the record button meter. */
export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / Math.max(1, samples.length))
}
