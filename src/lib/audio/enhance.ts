// Spelled with its extension, like every module a Node test has to load: the test
// runner resolves ESM specifiers literally, while the bundler accepts both.
import { rms } from './level.ts'

/**
 * The speech front-end: everything between "the browser handed us samples" and
 * "the recogniser sees a sentence".
 *
 * Why it exists at all. The pipeline used to hand the microphone's signal more or
 * less straight to the models, and the plan that decided that assumed the quiet,
 * headphone-driven, close-talk setup the rest of the capture path is written for.
 * The moment the speaker is four or five metres away — a phone on a desk in a
 * classroom — three things that never mattered at 30 cm become the whole problem:
 *
 *  1. **The decimation aliased.** 48 kHz to 16 kHz went through
 *     `resampleLinear` in `resample.ts`, and 48/16 is exactly 3, so a linear
 *     interpolation degenerated into "keep every third sample" — no filter at all.
 *     Measured on pure tones through that function: 9 kHz, 12 kHz and 17 kHz all
 *     came out at rms 0.7071, i.e. full amplitude, unchanged. Everything between
 *     8 and 24 kHz was folded back into the speech band, and a classroom puts a
 *     lot of energy up there — air hiss, chairs, paper, whisper sibilance. It also
 *     inflated the level the segmenter tracks its noise floor on, which raises the
 *     bar for exactly the speech that is already the quietest.
 *  2. **There was no level control at all.** `capture.ts` asks the platform for
 *     `autoGainControl: false` — correctly, because the platform's AGC is tuned to
 *     a mouth 20 cm from the phone and pumps the room up during pauses. But that
 *     leaves nothing in its place, so a speaker at 5 m arrives around −45 dBFS,
 *     twenty-odd dB under what these models are trained on, with nothing to bring
 *     it back.
 *  3. **Nothing separates speech from the room.** The segmenter's thresholds are
 *     all ratios against a tracked floor, and a classroom at 0 dB SNR leaves it
 *     little to work with: `minRangeShare` (speech must span half its own peak
 *     over the floor) stops being true, so segments close late, merge, or never
 *     open at all.
 *
 * This module fixes those three, in that order, on the one signal that both the
 * recogniser and the session recording consume — `vad.worker` calls it once, at
 * the top of the `chunk` case, and everything downstream (including the WAV the
 * user exports) sees the same enhanced audio. That identity is worth keeping: the
 * recording exists so a sentence the pipeline dropped can be cut out and
 * recognised again, and it can only stand in for the recogniser's input if it *is*
 * the recogniser's input.
 *
 * What it deliberately does not do: no pre-emphasis, no presence tilt, no
 * bandwidth extension. Every one of those changes the spectrum the models were
 * trained on, and none of them is needed once the three real defects above are
 * gone. Measured decisions are in the constants, not in taste.
 *
 * Cost, because this runs on a phone: the decimator is ~96 multiply-adds per
 * output sample (1.5 M/s at 16 kHz), the denoiser is one 512-point FFT per 16 ms,
 * the rest is a biquad and a multiply. That is a few percent of one core, next to
 * an inference path that is measured in hundreds of milliseconds per sentence.
 */

/** The rate the models, the segmenter, the recording and the VAD are all defined at. */
export const TARGET_RATE = 16000

/**
 * Anti-aliasing decimator — the fix for defect 1 above.
 *
 * A windowed-sinc low-pass evaluated as a precomputed polyphase table: one row per
 * fractional sample offset, so the inner loop is a dot product and no `sin` is
 * computed per sample. The table is built once per input rate, and each row is
 * normalised to unity DC gain, which is what keeps a constant input a constant
 * output at *every* phase (the passband ripple of a windowed sinc, removed
 * exactly, for free).
 *
 * Two numbers decide quality, and both are comments rather than magic:
 *
 *  - **Cutoff** at 45% of the output rate (`0.45 / ratio` in input-rate units):
 *    7.2 kHz for 48 kHz in. The speech band the models read (mel up to 8 kHz) is
 *    untouched; what would fold onto its top edge is not.
 *  - **Length** of 2 × `halfTaps` input samples. With a Blackman window the
 *    stopband floor is ~74 dB regardless of length; the length buys transition
 *    width. At 48 kHz, 96 taps puts the stopband edge near 10 kHz — so 10–24 kHz
 *    arrives at −74 dB or better, and 7.2–10 kHz is on the slope. Against 0 dB
 *    everywhere, "somewhere between −6 and −74 dB" is the whole ballgame.
 *
 * Streaming, because chunks arrive by the hundredth of a second: the filter state
 * is the tail of the previous chunk, and the output rate is exactly `1/ratio`
 * times the input rate in steady state, so nothing downstream drifts.
 */
export class AntiAliasResampler {
  /** Fractional phases in the polyphase table. 256 gives a max phase error of 1/512 sample. */
  private static readonly PHASES = 256

  private inRate = 0
  private outRate = 0
  private ratio = 1
  private tables = new Float32Array(0)
  /** Tail of the stream so far, needed by the next output sample. */
  private history = new Float32Array(0)
  /** Absolute input index of `history[0]`, so positions survive chunk boundaries. */
  private consumed = 0
  /** Absolute index of the next output sample to produce. */
  private nextOut = 0

  /** Half the filter length, in input samples. See the class comment for the trade. */
  private readonly halfTaps: number

  // NB: no TypeScript parameter properties anywhere in this file. `node --test`
  // strips types instead of compiling them, and a parameter property is real
  // syntax it refuses — which would make the module untestable.
  constructor(halfTaps = 48) {
    this.halfTaps = halfTaps
  }

  /**
   * Resamples one chunk. The returned array is always freshly allocated (or a
   * view of one), so a caller may filter it in place; an empty result is normal
   * and means "not enough input yet for even one output sample".
   */
  process(input: Float32Array, inRate: number, outRate: number): Float32Array {
    if (input.length === 0) return new Float32Array(0)
    // Same rate on both sides is not "almost a no-op": it is the one case where
    // the answer is exact and the filter must not be applied at all.
    if (inRate === outRate) {
      // Forget the streaming state: a later rate change must rebuild, not resume
      // a filter built for a different ratio.
      this.inRate = 0
      return input
    }
    this.configure(inRate, outRate)

    const n = 2 * this.halfTaps
    const buf = new Float32Array(this.history.length + input.length)
    buf.set(this.history, 0)
    buf.set(input, this.history.length)
    const bufStart = this.consumed
    const bufEnd = bufStart + buf.length

    // How many outputs can be completed: output `k` sits at input position
    // `k * ratio` and reads `s - half + 1 … s + half`, so it needs one sample
    // *after* its centre. The +2 is slack for the rounding of `ratio`.
    const out = new Float32Array(Math.ceil(input.length / this.ratio) + Math.ceil(n / this.ratio) + 2)
    let count = 0
    for (;;) {
      const p = this.nextOut * this.ratio
      const s = Math.floor(p)
      if (s + this.halfTaps > bufEnd - 1) break
      const local = s - this.halfTaps + 1 - bufStart
      const phase = Math.round((p - s) * AntiAliasResampler.PHASES) % AntiAliasResampler.PHASES
      const row = phase * n
      let acc = 0
      for (let i = 0; i < n; i++) acc += this.tables[row + i]! * buf[local + i]!
      out[count++] = acc
      this.nextOut++
    }

    // Keep only what the *next* output sample can still need; anything older is
    // dead weight that would grow with the session.
    const keepFrom = Math.max(bufStart, Math.floor(this.nextOut * this.ratio) - this.halfTaps + 1)
    this.history = buf.slice(keepFrom - bufStart, bufEnd - bufStart)
    this.consumed = keepFrom
    return count === out.length ? out : out.subarray(0, count)
  }

  reset(): void {
    this.inRate = 0
    this.outRate = 0
    this.history = new Float32Array(0)
    this.consumed = 0
    this.nextOut = 0
  }

  private configure(inRate: number, outRate: number): void {
    if (this.inRate === inRate && this.outRate === outRate) return
    this.inRate = inRate
    this.outRate = outRate
    this.ratio = inRate / outRate
    // The stream is considered silent before t = 0 — a half-window of zeros —
    // rather than "the first window cannot be computed": the filter then has no
    // special case at all, and the first output sample exists immediately.
    this.history = new Float32Array(this.halfTaps)
    this.consumed = -this.halfTaps
    this.nextOut = 0
    this.buildTables()
  }

  private buildTables(): void {
    const half = this.halfTaps
    const n = 2 * half
    const phases = AntiAliasResampler.PHASES
    // Cutoff in cycles per *input* sample. Downsampling needs it below the output
    // Nyquist (0.5 / ratio); upsampling only needs filter support below the input
    // Nyquist. 0.45 leaves a 10% margin for the transition band in both cases.
    const fc = this.ratio > 1 ? 0.45 / this.ratio : 0.45
    const tables = new Float32Array(phases * n)
    for (let p = 0; p < phases; p++) {
      const frac = p / phases
      let sum = 0
      for (let m = -half + 1; m <= half; m++) {
        const t = m - frac
        const u = Math.abs(t) / half
        const window = u >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u)
        // The ideal low-pass at `fc` cycles/sample is 2·fc·sinc(2·fc·t); its DC
        // gain is normalised away below, so only the argument's factor of two
        // matters — leave it out and the cutoff lands at half of `fc` (measured:
        // flat to 2 kHz, −14 dB at 4 kHz, dead from 5 kHz).
        const x = 2 * Math.PI * fc * t
        const tap = (x === 0 ? 1 : Math.sin(x) / x) * window
        tables[p * n + (m + half - 1)] = tap
        sum += tap
      }
      // Unity DC gain per phase: the kernel's samples never sum to exactly 1 (the
      // tail of the sinc is cut off), and the residue is what would otherwise show
      // up as a level that depends on where the sample happened to land.
      const gain = sum === 0 ? 1 : 1 / sum
      for (let i = 0; i < n; i++) tables[p * n + i]! *= gain
    }
    this.tables = tables
  }
}

/**
 * Second-order Butterworth high-pass, applied in place, at 16 kHz.
 *
 * Cheap, and it answers two things a phone at arm's length on a desk produces in
 * quantity: rumble and handling/table thumps below ~85 Hz, and the DC offset some
 * capture paths carry. None of it is speech (the models' lowest mel band starts
 * at 0 Hz but its energy is dominated by hiss), and all of it is *loud* relative
 * to a distant voice, which is why it matters to the segmenter's floor even
 * though it is inaudible in the recognition.
 */
export class HighPass {
  private readonly b0: number
  private readonly b1: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(rate: number, cutoffHz = 85) {
    const w0 = (2 * Math.PI * cutoffHz) / rate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
    const a0 = 1 + alpha
    // RBJ audiocookbook high-pass, normalised by a0.
    this.b0 = ((1 + cos) / 2) / a0
    this.b1 = (-(1 + cos)) / a0
    this.b2 = ((1 + cos) / 2) / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(x: Float32Array): void {
    for (let i = 0; i < x.length; i++) {
      const input = x[i]!
      const y = this.b0 * input + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
      this.x2 = this.x1
      this.x1 = input
      this.y2 = this.y1
      this.y1 = y
      x[i] = y
    }
  }
}

/**
 * Iterative radix-2 complex FFT, with the bit-reversal permutation and the twiddle
 * tables precomputed.
 *
 * Written out rather than pulled in because it is 40 lines and the project has no
 * numerical dependency worth adding for it — and because a dependency here would
 * have to be trusted for *every* sample of a session.
 */
class Fft {
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  private readonly rev: Uint32Array

  readonly n: number

  constructor(n: number) {
    this.n = n
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = Math.sin((2 * Math.PI * i) / n)
    }
    this.rev = new Uint32Array(n)
    const bits = Math.log2(n)
    for (let i = 0; i < n; i++) {
      let x = i
      let r = 0
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1)
        x >>= 1
      }
      this.rev[i] = r
    }
  }

  /** In place. `inverse` conjugates the twiddles and scales by 1/n. */
  transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.n
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!
      if (j <= i) continue
      const tr = re[i]!
      const ti = im[i]!
      re[i] = re[j]!
      im[i] = im[j]!
      re[j] = tr
      im[j] = ti
    }
    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2
      const step = n / size
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + halfSize; j++, k += step) {
          const l = j + halfSize
          const c = this.cos[k]!
          const s = inverse ? this.sin[k]! : -this.sin[k]!
          const tr = re[l]! * c - im[l]! * s
          const ti = re[l]! * s + im[l]! * c
          re[l] = re[j]! - tr
          im[l] = im[j]! - ti
          re[j] = re[j]! + tr
          im[j] = im[j]! + ti
        }
      }
    }
    if (!inverse) return
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n
      im[i] = im[i]! / n
    }
  }
}

/**
 * Single-channel spectral noise suppression — defect 3.
 *
 * 512-point STFT (32 ms at 16 kHz) with a 50% hop, square-root-Hann on both the
 * analysis and the synthesis side. That pair is chosen so that the gain-1 case
 * reconstructs the input *exactly* (Hann at 50% overlap sums to 1), which is the
 * property that makes the whole stage safe to leave switched on: what it does not
 * need to suppress, it does not touch.
 *
 * Three choices carry the weight:
 *
 *  - **The noise estimate is learned, not tracked by a ratchet.** A frame is
 *    declared *room* when its total energy is within `QUIET_RATIO` of the quietest
 *    frame seen in the last second (a segmented sliding minimum: eight sub-windows
 *    of 0.128 s, the classic construction, because a plain minimum would never let
 *    the estimate follow a room that gets louder). During those frames the per-bin
 *    magnitudes are averaged into the estimate and *only then* — which is why the
 *    estimate lands on the noise's true mean rather than on a fraction of it.
 *    Outside them the estimate may only fall, never rise: a vowel held for ten
 *    seconds can pull a bin down but cannot teach the stage that the speaker is
 *    noise. Until that first second is up there is nothing to learn from and the
 *    stage stays transparent.
 *
 *    Both halves of that rule were needed: a per-bin minimum tracker measured
 *    −0.7 dB of suppression on stationary noise (it settles twenty times below the
 *    noise mean, so subtracting it twice removes almost nothing).
 *  - **A power-subtraction gain with an over-subtraction factor**, clamped into
 *    `[MIN_GAIN, 1]`: `g = 1 − α · noise / magnitude`. Unlike a Wiener mask it
 *    actually reaches the floor in a cell that holds only noise — which is the whole
 *    point — while a cell 20 dB above the room keeps −1 dB. Whatever the room is
 *    loud enough to reach is faded, not switched off, so a quiet headphone session
 *    comes out nearly untouched.
 *  - **Smoothing in both directions** (three bins across frequency, first-order in
 *    time). Musical noise is the classic failure of spectral subtraction, and it is
 *    worse for a recogniser than for an ear: isolated surviving bins are what a
 *    model reads as a consonant.
 *
 * A steady tone *is* removed, deliberately: HVAC, a fan, a projector's ballast and
 * mains hum are the things between a distant speaker and the microphone, and none
 * of them is speech. The cost is that a long monotone note would be too, which is
 * the trade this stage is here to make. And at 0 dB SNR no blind estimator does
 * well — what this is built for is the ordinary case, a speaker 10-20 dB above a
 * stationary room.
 */
export class SpectralNoiseSuppressor {
  /** 512 samples is 32 ms at 16 kHz: two glottal pulses of a low-pitched voice, and 31 Hz per bin. */
  private static readonly FRAME = 512
  private static readonly HOP = 256
  /**
   * How many times the estimated noise amplitude is subtracted from each bin.
   *
   * Above 1 on purpose, and it is the constant that decides the trade. The floor
   * below is what gives a noise-only cell its suppression; this is what decides how
   * far above the room a cell has to be before it is left alone (with α = 1.4, a
   * cell 10 dB above the local noise keeps ~−5 dB and one 20 dB above keeps −1 dB).
   */
  private static readonly OVER_SUBTRACTION = 1.4
  /** Never fully close a bin: −14 dB, low enough to help, high enough not to gate. */
  private static readonly MIN_GAIN = 0.2
  /**
   * A frame is room (and may teach the noise estimate) while its energy stays
   * within this factor of the quietest frame in the last two seconds.
   *
   * 2 is set from the statistics: a noise-only frame sits between ~0.8× and ~2× the
   * mean, so this catches most of them, while a speaker 10 dB above the room is
   * already ~14× the floor and is never mistaken for one. At 0 dB SNR the two
   * overlap, and the estimate then leans on the slower correction below.
   */
  private static readonly QUIET_RATIO = 2
  /** Averaging rate into the noise estimate during a room frame. */
  private static readonly NOISE_LEARN = 0.1
  /** How fast a bin may fall while speech is present, per frame. */
  private static readonly NOISE_FALL = 0.05
  /** Sub-windows of 4 frames (0.128 s) whose minimum is the ~1 s floor. */
  private static readonly FLOOR_WINDOWS = 8
  private static readonly SUB_FRAMES = 4
  /** Time smoothing of the gain, per frame. */
  private static readonly GAIN_SMOOTH = 0.5

  private readonly fft = new Fft(SpectralNoiseSuppressor.FRAME)
  private readonly window: Float32Array
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly noise: Float32Array
  private readonly gain: Float32Array
  private readonly smoothed: Float32Array
  private readonly inBuf: Float32Array
  private primed = false
  private inFill = 0
  private readonly outAcc: Float32Array
  private speechPower = 0
  private noisePower = 0

  // Sliding-minimum machinery for the frame-level gate. Frame energy is a sum over
  // 257 bins, so its own spread is small (a few dB) — which is exactly why the
  // quiet-frame test is made on it and not on a single bin.
  private readonly floorRing: Float64Array
  private floorIndex = 0
  private subMin = Number.POSITIVE_INFINITY
  private subFrames = 0

  constructor() {
    const n = SpectralNoiseSuppressor.FRAME
    const bins = n / 2 + 1
    this.window = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
      this.window[i] = Math.sqrt(hann)
    }
    this.re = new Float64Array(n)
    this.im = new Float64Array(n)
    this.noise = new Float32Array(bins)
    this.gain = new Float32Array(bins)
    this.smoothed = new Float32Array(bins).fill(1)
    this.inBuf = new Float32Array(n)
    this.outAcc = new Float32Array(n)
    this.floorRing = new Float64Array(SpectralNoiseSuppressor.FLOOR_WINDOWS).fill(Number.POSITIVE_INFINITY)
  }

  /** Estimated speech-to-noise ratio of the last frame, in dB. */
  get snrDb(): number {
    return 10 * Math.log10((this.speechPower + 1e-20) / (this.noisePower + 1e-20))
  }

  /**
   * Enhances one chunk. Output length equals input length, offset by one hop
   * (16 ms) of algorithmic delay — a frame can only be filtered once it has been
   * filled, which is the price of doing this in the frequency domain at all.
   */
  process(input: Float32Array): Float32Array {
    const n = SpectralNoiseSuppressor.FRAME
    const hop = SpectralNoiseSuppressor.HOP
    const out = new Float32Array((Math.ceil(input.length / hop) + 1) * hop)
    let written = 0
    let read = 0
    for (;;) {
      const take = Math.min(input.length - read, n - this.inFill)
      if (take > 0) {
        this.inBuf.set(input.subarray(read, read + take), this.inFill)
        read += take
        this.inFill += take
      }
      if (this.inFill < n) break
      this.enhanceFrame()
      out.set(this.outAcc.subarray(0, hop), written)
      written += hop
      this.inBuf.copyWithin(0, hop)
      this.outAcc.copyWithin(0, hop)
      this.outAcc.fill(0, n - hop)
      this.inFill -= hop
    }
    return written === out.length ? out : out.subarray(0, written)
  }

  private enhanceFrame(): void {
    const n = SpectralNoiseSuppressor.FRAME
    const half = n / 2
    for (let i = 0; i < n; i++) {
      this.re[i] = this.inBuf[i]! * this.window[i]!
      this.im[i] = 0
    }
    this.fft.transform(this.re, this.im, false)

    // --- the frame-level quiet test (see QUIET_RATIO) ---
    let frameEnergy = 0
    for (let k = 0; k <= half; k++) frameEnergy += this.re[k]! * this.re[k]! + this.im[k]! * this.im[k]!
    this.subMin = Math.min(this.subMin, frameEnergy)
    this.subFrames++
    if (this.subFrames >= SpectralNoiseSuppressor.SUB_FRAMES) {
      this.floorRing[this.floorIndex] = this.subMin
      this.floorIndex = (this.floorIndex + 1) % SpectralNoiseSuppressor.FLOOR_WINDOWS
      this.subMin = Number.POSITIVE_INFINITY
      this.subFrames = 0
      this.primed = true
    }
    let floor = Number.POSITIVE_INFINITY
    for (let i = 0; i < this.floorRing.length; i++) floor = Math.min(floor, this.floorRing[i]!)
    // A frame whose own total energy is at *or below* the floor is quiet by
    // definition; the ratio is what admits the rest of the room frames.
    //
    // …and nothing may be learned at all before the ring has context. There is no
    // way for a blind estimator to tell "the room" from "the speaker" in the first
    // second of a session — the speaker may simply have started talking first — and
    // of the two ways to be wrong, learning speech as the room eats the first
    // sentence the user says, while staying transparent for a second only leaves a
    // second of room tone in the recording. So until the ring has filled, the
    // estimate stays at zero and the stage does nothing (a zero estimate means a
    // gain of exactly 1).
    const quiet = frameEnergy <= floor * SpectralNoiseSuppressor.QUIET_RATIO
    const learn = this.primed

    let frameNoise = 0
    let frameSpeech = 0
    for (let k = 0; k <= half; k++) {
      const magnitude = Math.hypot(this.re[k]!, this.im[k]!)
      const estimate = this.noise[k]!
      if (!learn) {
        // deliberately nothing: see above
      } else if (quiet) {
        this.noise[k] = estimate + (magnitude - estimate) * SpectralNoiseSuppressor.NOISE_LEARN
      } else if (magnitude < estimate) {
        // Speech is present. The estimate may still fall — that is what lets a
        // wrongly-high start correct itself without waiting for a pause — but it
        // may not rise, so a held vowel cannot be learned as part of the room.
        this.noise[k] = estimate + (magnitude - estimate) * SpectralNoiseSuppressor.NOISE_FALL
      }
      frameNoise += this.noise[k]! * this.noise[k]!
      frameSpeech += magnitude * magnitude
    }
    this.noisePower = frameNoise
    this.speechPower = Math.max(0, frameSpeech - frameNoise)

    // Per-bin gain by power subtraction, clamped so no bin is ever shut:
    // `1 − α·noise/magnitude` in amplitudes, which is the classic form and —
    // unlike a Wiener mask — actually reaches the floor in a cell that holds only
    // noise. The +1e-12 keeps a digitally silent bin from producing NaN.
    for (let k = 0; k <= half; k++) {
      const magnitude = Math.hypot(this.re[k]!, this.im[k]!)
      const subtraction = (SpectralNoiseSuppressor.OVER_SUBTRACTION * this.noise[k]!) / (magnitude + 1e-9)
      this.gain[k] = Math.max(SpectralNoiseSuppressor.MIN_GAIN, 1 - subtraction)
    }
    // Three bins across (in place: `prev` holds the value this pass has not yet
    // overwritten), then one step of the time recurrence towards it.
    let prev = this.gain[0]!
    for (let k = 0; k <= half; k++) {
      const current = this.gain[k]!
      const next = k < half ? this.gain[k + 1]! : current
      this.gain[k] = (prev + 2 * current + next) / 4
      prev = current
    }
    for (let k = 0; k <= half; k++) {
      const previous = this.smoothed[k]!
      this.smoothed[k] = previous + (this.gain[k]! - previous) * SpectralNoiseSuppressor.GAIN_SMOOTH
    }

    // Same gain on the conjugate bin, or the inverse transform is no longer real.
    for (let k = 0; k <= half; k++) {
      const g = this.smoothed[k]!
      this.re[k] = this.re[k]! * g
      this.im[k] = this.im[k]! * g
      // Strictly inside, not `<= half`: at the Nyquist bin the mirror *is* the
      // bin, and applying the gain twice would square it there alone.
      if (k > 0 && k < half) {
        const mirror = n - k
        this.re[mirror] = this.re[mirror]! * g
        this.im[mirror] = this.im[mirror]! * g
      }
    }
    this.fft.transform(this.re, this.im, true)
    for (let i = 0; i < n; i++) this.outAcc[i] = this.outAcc[i]! + this.re[i]! * this.window[i]!
  }
}

/**
 * A slow, bounded gain that puts a distant speaker back where the models expect
 * them — defect 2.
 *
 * The target is the project's own reference level: the segmenter's tuning is
 * written against "real speech at rms 0.08", which is also the anchor the level
 * ring's scale was calibrated on. Normalising the speech envelope to that number
 * means a phone at 4 m and a phone at 40 cm hand the recogniser the same magnitude.
 *
 * Three things keep it from being the platform AGC this project switches off:
 *
 *  - **The gain follows an envelope, not the instantaneous level.** A peak-style
 *    follower with a slow release, so a syllable does not move it.
 *  - **It is bounded and asymmetric**: at most ×8 up (+18 dB, the distance case
 *    this exists for) and at most ÷4 down, rising over ~150 ms and falling over
 *    ~1.5 s. The platform's version rides the level continuously, which is what
 *    makes it pump the room up between words. The ceiling is not a safety limit but
 *    a deliberate stopping point: the residual room is amplified along with the
 *    voice, and +18 dB already brings a speaker most of a room away back to a level
 *    these models read. Past it the honest thing to do is leave the level short and
 *    let the level ring — which shows the raw input — tell the user to move closer,
 *    rather than paper over a five-metre distance with a recording full of hiss.
 *  - **It only moves while someone is talking.** During a pause the gain is held,
 *    not raised: raising it is how a gate ends up amplifying the room and calling
 *    it speech. What is already lifted stays lifted (no pumping, and no dive when a
 *    sentence ends).
 *
 * A soft limiter sits at the end, so the boost cannot clip the 16-bit recording.
 */
export class AutoGain {
  /** Speech level the output is driven towards: the project's own reference rms. */
  private static readonly TARGET_RMS = 0.08
  private static readonly MAX_GAIN = 8
  private static readonly MIN_GAIN = 0.25
  /** Envelope release per 10 ms frame: ~ −1 dB per 120 ms of silence. */
  private static readonly ENVELOPE_RELEASE = 0.92
  private static readonly ATTACK_MS = 150
  private static readonly RELEASE_MS = 1500
  private static readonly FRAME_MS = 10
  /** Below this, whatever arrives is room, not speech, and must not move anything. */
  private static readonly GATE = 0.0015

  private envelope = AutoGain.TARGET_RMS
  private room = AutoGain.GATE
  private current = 1

  get gain(): number {
    return this.current
  }

  /** In place; returns the same array for convenience. */
  process(x: Float32Array): Float32Array {
    const frame = (AutoGain.FRAME_MS * TARGET_RATE) / 1000
    let offset = 0
    while (offset + frame <= x.length) {
      let power = 0
      for (let i = offset; i < offset + frame; i++) power += x[i]! * x[i]!
      const level = Math.sqrt(power / frame)
      this.update(level)
      this.apply(x, offset, offset + frame)
      offset += frame
    }
    // A tail shorter than a frame is carried at the current gain rather than
    // measured: measuring three samples would let one sample decide the next frame.
    if (offset < x.length) this.apply(x, offset, x.length)
    return x
  }

  private update(level: number): void {
    // Room estimate first, because it is what the gate is measured against.
    // Minimum-tracking like the denoiser's: instant down, very slow up.
    this.room = level < this.room ? level : this.room * 1.0002
    // Everything below is speech-only, and the order here is load-bearing. An
    // envelope left to decay through a pause forces the gain to climb back — by up
    // to ×8 — at the first word of the next sentence, which is a burst of gain on
    // every sentence boundary: measured on a close, loud talker it put the output
    // peak 3.5 dB *above* the input's, with a gain that never exceeded 1. Freezing
    // both while nothing is being said is the principle the class is built on; it
    // just has to be enforced before the envelope moves, not after.
    if (level <= Math.max(this.room * 3, AutoGain.GATE)) return
    this.envelope = Math.max(level, this.envelope * AutoGain.ENVELOPE_RELEASE)
    const wanted = Math.min(
      AutoGain.MAX_GAIN,
      Math.max(AutoGain.MIN_GAIN, AutoGain.TARGET_RMS / Math.max(this.envelope, 1e-6)),
    )
    const tau = wanted > this.current ? AutoGain.ATTACK_MS : AutoGain.RELEASE_MS
    const step = 1 - Math.exp(-AutoGain.FRAME_MS / tau)
    this.current += (wanted - this.current) * step
  }

  private apply(x: Float32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const amplified = x[i]! * this.current
      // Soft knee above 0.9, asymptotic to 1: a bounded boost must not be able to
      // wrap a peak around into a click in the recorded file.
      const magnitude = Math.abs(amplified)
      x[i] = magnitude <= 0.9 ? amplified : Math.sign(amplified) * (0.9 + 0.1 * Math.tanh((magnitude - 0.9) / 0.1))
    }
  }

  reset(): void {
    this.envelope = AutoGain.TARGET_RMS
    this.room = AutoGain.GATE
    this.current = 1
  }
}

/** What the front-end can say about the audio it just processed, for the log and the meter. */
export interface FrontendStats {
  /**
   * Level of the signal as the microphone delivered it, before denoising and
   * before any gain — i.e. the honest answer to "how far away is the speaker".
   *
   * This is what the level ring draws, and it is the opposite of what it used to
   * be. Before this module the ring showed the segmenter's frame rms, which was the
   * same signal the recogniser got. With an AGC in the path that number is pinned
   * near the target whenever anyone talks at all, so a phone five metres away would
   * show a healthy ring while the audio is unusable — a meter that cannot report
   * the one failure it is there to report. The ring's dB scale (−60 ≈ quiet room,
   * −12 ≈ close speech) was chosen for a raw level in the first place, so the
   * anchor and the number agree again.
   */
  inputRms: number
  inputDb: number
  outputDb: number
  gainDb: number
  snrDb: number
}

/**
 * The front-end as the worker sees it: one call per chunk, 16 kHz out, plus the
 * numbers worth writing down.
 *
 * Order matters and is not arbitrary. The high-pass comes after the decimation
 * (it is defined at the rate the models use, and running it three times as often
 * buys nothing), the denoiser before the AGC (its whole method is a *ratio* to the
 * noise floor, so it must see the signal at the level the microphone produced),
 * and the AGC last (so its envelope sees a signal that has already had the room
 * pushed down, rather than one where the room competes with the speaker).
 */
export class SpeechFrontend {
  private readonly resampler = new AntiAliasResampler()
  private readonly highPass: HighPass
  private readonly denoiser: SpectralNoiseSuppressor
  private readonly agc = new AutoGain()
  private last: FrontendStats = { inputRms: 0, inputDb: -120, outputDb: -120, gainDb: 0, snrDb: 0 }

  private readonly outRate: number

  constructor(outRate: number = TARGET_RATE) {
    this.outRate = outRate
    this.highPass = new HighPass(outRate)
    this.denoiser = new SpectralNoiseSuppressor()
  }

  get stats(): FrontendStats {
    return this.last
  }

  process(samples: Float32Array, rate: number): Float32Array {
    let audio = this.resampler.process(samples, rate, this.outRate)
    if (audio.length === 0) return audio
    // Never filter the caller's buffer in place: at matching rates the resampler
    // hands back the input itself, and that array belongs to whoever sent it.
    if (audio === samples) audio = new Float32Array(samples)
    this.highPass.process(audio)
    const inputRms = rms(audio)
    // Both stages below always return a freshly allocated array, so filtering in
    // place cannot reach back into the caller's samples.
    const output = this.agc.process(this.denoiser.process(audio))
    this.last = {
      inputRms,
      inputDb: db(inputRms),
      outputDb: db(rms(output)),
      gainDb: db(this.agc.gain),
      snrDb: this.denoiser.snrDb,
    }
    return output
  }

  reset(): void {
    this.resampler.reset()
    this.agc.reset()
  }
}

function db(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-6))
}
