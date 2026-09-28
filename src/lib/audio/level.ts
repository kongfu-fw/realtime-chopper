/**
 * Level measurement.
 *
 * This file used to be `resample.ts` and held a linear-interpolation resampler,
 * which is what the capture path used to get from the microphone's 48 kHz to the
 * 16 kHz the models read. That function is gone rather than kept around: 48/16 is
 * exactly 3, so it degenerated into "keep every third sample" with no filtering at
 * all, and every frequency between 8 and 24 kHz — most of a classroom's hiss,
 * paper, chairs and whisper sibilance — was folded into the speech band at full
 * amplitude. The decimation now lives in `enhance.ts`, as a windowed-sinc
 * anti-alias filter, and it is tested there against the tones that used to prove
 * the defect.
 *
 * What is left here is the one measurement several modules genuinely share: the
 * segmented detector's thresholds, the front-end's report of how much level the
 * microphone delivered, and the tests around both. Keeping it separate from either
 * of them is what lets them agree about what "loud" means.
 */
export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / Math.max(1, samples.length))
}
