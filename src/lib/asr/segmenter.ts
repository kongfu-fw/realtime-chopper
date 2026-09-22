import { rms } from '../audio/resample'

/**
 * Utterance segmentation — the missing requirement.
 *
 * SenseVoice and Moonshine are both non-streaming, so "real time" can only mean
 * "cut the audio into utterances and recognise each one as it closes". The
 * cutting rule therefore *is* the latency knob: everything the user perceives
 * as delay starts with the silence that has to be observed before a segment is
 * declared finished.
 *
 * This is an energy + adaptive-noise-floor detector. It costs nothing, ships no
 * extra model and behaves predictably in the quiet, headphone-driven setup the
 * plan mandates. `sherpa-onnx`'s silero VAD can be swapped in behind the same
 * interface once the module is installed (see `vad.ts`).
 */

export interface SegmenterOptions {
  /** Silence needed before an utterance is considered finished. */
  silenceMs: number
  /** Utterances shorter than this are discarded as noise. */
  minSegMs: number
  /** Hard cut so a monologue still produces output. */
  maxSegMs: number
  /** Audio kept from just before the trigger, so the first syllable survives. */
  preRollMs: number
  /** Frame length for analysis. */
  frameMs?: number
}

export interface EmittedSegment {
  startMs: number
  endMs: number
  samples: Float32Array
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  silenceMs: 500,
  minSegMs: 600,
  maxSegMs: 8000,
  preRollMs: 150,
}

/**
 * Tuning of the energy detector, relative to the input level on purpose.
 *
 * An *absolute* threshold is what made the same recording segment correctly at
 * one volume and break into 1-2 s pieces at another. The old rule was
 * `level > max(0.0035, noiseFloor * 2.6)`, and the noise floor was only updated
 * on frames already classified as silence — so on a quiet microphone, where the
 * speaker's soft syllables fell below 0.0035, those syllables fed the floor back
 * upward, which raised the threshold, which classified more syllables as
 * silence. Measured on real speech at RMS 0.08 the floor settled 4x above the
 * actual room tone and every dip inside a sentence closed the utterance.
 *
 * Everything here is a ratio against the tracked noise floor or the tracked peak,
 * so the detector behaves the same at any input gain.
 */
export interface VadTuning {
  /** A frame this many times above the noise floor opens an utterance. */
  enterOverNoise: number
  /**
   * …and this many times above it keeps one open.
   *
   * Lower than the opening ratio on purpose: a syllable gap, a breath or a soft
   * consonant is a dip, not a pause, and must not be allowed to end a sentence.
   */
  stayOverNoise: number
  /** Speech must span at least this share of its own peak over the floor. */
  minRangeShare: number
  /** Absolute gate: quieter than this is dither, whatever the ratios say. */
  absoluteMin: number
  /**
   * Where the floor search starts, before anything is known about the room.
   *
   * Deliberately high — "assume a noisy room until proved otherwise". The floor
   * can drop immediately, so a quiet room is learned within a few frames, but a
   * noisy one is never mistaken for speech while it is being learned. Starting low
   * instead is what let steady room noise register as one endless utterance.
   */
  initialFloor: number
  /** Per-frame upward creep of the floor once a pause has been observed. */
  floorRiseOnPause: number
  /** Per-frame upward creep of the floor the rest of the time (deliberately tiny). */
  floorRise: number
  /** The floor may never sit further below the speech envelope than this. */
  floorMinShare: number
  /** Per-frame release of the speech envelope (×0.95 per second at 10 ms frames). */
  peakRelease: number
}

export const DEFAULT_TUNING: VadTuning = {
  enterOverNoise: 2.4,
  stayOverNoise: 1.25,
  minRangeShare: 0.5,
  absoluteMin: 0.0015,
  initialFloor: 0.01,
  floorRiseOnPause: 0.03,
  floorRise: 0.0002,
  floorMinShare: 0.02,
  peakRelease: 0.9995,
}
/** A quiet run this long is a pause rather than a syllable gap, so the floor may rise. */
const FLOOR_CONFIRM_MS = 250
/** Tail kept after the last speech frame, in milliseconds. */
const TAIL_MS = 120
/**
 * How far back from the hard limit a length-forced cut may be moved, in ms.
 *
 * Cutting exactly at the limit slices a word in half. Both halves are then
 * transcribed without the context that word needed and the model fills the gap
 * with a guess: measured on 2 minutes of continuous speech, seams came out both
 * duplicated and wrong ("The driver chased in call for the boy…", and 26 "gold"
 * for 20 occurrences). Moving the cut to the quietest frame in the tail puts it
 * in a natural gap between words instead.
 */
const SOFT_CUT_WINDOW_MS = 1500

export class EnergySegmenter {
  private opts: Required<SegmenterOptions>
  private tuning: VadTuning
  private frameSamples: number

  private timeMs = 0
  /** Quiet envelope: the best estimate of what the room sounds like. */
  private noiseFloor = DEFAULT_TUNING.initialFloor
  /** Loud envelope: the best estimate of how loud the speaker gets. */
  private speechPeak = 0.001
  /** Hysteresis state of the signal, independent of any segment being open. */
  private inSpeech = false
  /** Consecutive frames classified as quiet; confirms a pause before the floor rises. */
  private quietRunMs = 0
  private preRoll: Float32Array[] = []
  private active: Float32Array[] = []
  /**
   * Index into `active` of the most recent frame classified as speech.
   *
   * The tail trim needs a **position**, not a count. Deriving it from
   * `activeSpeechMs` — the number of frames that happened to be classified as
   * speech — treats every non-speech frame as if it were at the very end of the
   * utterance, so each syllable gap, breath and quiet consonant deletes an equal
   * slice of the *end* of the sentence: a measured 5.15 s utterance came out as
   * 3.93 s of audio, with the last words simply gone (and the panel reporting the
   * shortened length, which reads exactly like "it only recognises one second").
   */
  private lastSpeechFrame = -1
  private activeSpeechMs = 0
  private activeMs = 0
  private trailingSilenceMs = 0
  private segmentStartMs = 0
  private leftover = new Float32Array(0)

  onLevel: ((level: number) => void) | null = null

  constructor(options: SegmenterOptions = DEFAULT_SEGMENTER, tuning: Partial<VadTuning> = {}) {
    this.opts = { frameMs: 10, ...options }
    this.tuning = { ...DEFAULT_TUNING, ...tuning }
    this.frameSamples = Math.round((16000 * this.opts.frameMs) / 1000)
  }

  configure(options: Partial<SegmenterOptions>): void {
    this.opts = { ...this.opts, ...options }
    this.frameSamples = Math.round((16000 * this.opts.frameMs) / 1000)
  }

  /** Feed 16 kHz mono audio; returns any utterances that closed. */
  push(input: Float32Array): EmittedSegment[] {
    const out: EmittedSegment[] = []
    this.leftover = concat(this.leftover, input)
    let offset = 0
    while (this.leftover.length - offset >= this.frameSamples) {
      const frame = this.leftover.subarray(offset, offset + this.frameSamples)
      offset += this.frameSamples
      const emitted = this.consumeFrame(frame)
      if (emitted) out.push(emitted)
    }
    // Rebuilt rather than sliced: a fresh Float32Array keeps the concrete
    // ArrayBuffer type the typed-array generics expect.
    this.leftover = new Float32Array(this.leftover.subarray(offset))
    return out
  }

  /** Close whatever is open, e.g. when the user stops recording. */
  flush(): EmittedSegment[] {
    if (this.active.length === 0) return []
    const frameMs = this.opts.frameMs
    const frames = this.active.slice(0, this.tailIndex())
    const samples = concatAll(frames)
    const startMs = this.segmentStartMs
    const endMs = startMs + frames.length * frameMs
    const speechMs = this.activeSpeechMs
    this.resetActive()
    if (speechMs < this.opts.minSegMs) return []
    return [{ startMs, endMs, samples }]
  }

  reset(): void {
    this.leftover = new Float32Array(0)
    this.timeMs = 0
    this.noiseFloor = this.tuning.initialFloor
    this.speechPeak = 0.001
    this.inSpeech = false
    this.quietRunMs = 0
    this.preRoll = []
    this.resetActive()
  }

  /**
   * How many frames to keep when the utterance ended in silence: everything up
   * to the last speech frame, plus a short tail.
   *
   * Bounded by the buffer, so an utterance that is still talking when it closes
   * is never shortened.
   */
  private tailIndex(): number {
    if (this.lastSpeechFrame < 0) return 1
    const tailFrames = Math.ceil(TAIL_MS / this.opts.frameMs)
    return Math.max(1, Math.min(this.active.length, this.lastSpeechFrame + 1 + tailFrames))
  }

  /**
   * How many frames to keep when the utterance hit the length limit: cut at the
   * quietest frame in the tail of the window rather than at the limit itself, so
   * the cut lands between words instead of inside one. Everything after the cut
   * is carried into the next segment, so no audio is lost either way.
   */
  private softCutIndex(): number {
    const frames = this.active
    const windowFrames = Math.min(frames.length, Math.round(SOFT_CUT_WINDOW_MS / this.opts.frameMs))
    let quietest = Number.POSITIVE_INFINITY
    let cut = frames.length
    for (let i = frames.length - windowFrames; i < frames.length; i++) {
      const level = rms(frames[i]!)
      if (level < quietest) {
        quietest = level
        cut = i + 1
      }
    }
    return Math.max(1, Math.min(cut, frames.length))
  }

  /**
   * Tracks the loud and quiet envelopes of the input, then decides — with
   * hysteresis — whether this frame is speech.
   *
   * Both envelopes are relative to the input, so the decision does not depend on
   * the microphone's absolute level: a sentence's quiet syllables sit at the same
   * fraction of the speaker's range whether the room is loud or the input gain is
   * low. That is the property the old fixed-floor rule did not have, and the
   * reason it segmented the same recording correctly at one volume and cut it into
   * 1-2 s pieces at another.
   */
  private classify(level: number, frameMs: number): boolean {
    const t = this.tuning
    // Loud envelope: instant attack, slow release. The span has to survive the
    // quiet passages inside a sentence, not just the loud ones.
    this.speechPeak = Math.max(level, this.speechPeak * t.peakRelease)
    // Quiet envelope. Downward it follows immediately — a lower level is always
    // better evidence about the room. Upward it is deliberately reluctant: quickly
    // after a confirmed pause, and by a barely visible amount otherwise, so that
    // sustained speech (whose own quiet syllables look like a floor) cannot drag
    // the threshold up into the speaker's range the way the old rule did.
    if (level < this.noiseFloor) {
      this.noiseFloor = this.noiseFloor * 0.7 + level * 0.3
    } else {
      const rise = this.quietRunMs >= FLOOR_CONFIRM_MS ? t.floorRiseOnPause : t.floorRise
      this.noiseFloor += (level - this.noiseFloor) * rise
    }
    // …and never so far below the peak that a single dropout could make the
    // detector deaf to its own threshold.
    this.noiseFloor = Math.max(this.noiseFloor, this.speechPeak * t.floorMinShare)

    const wasSpeech = this.inSpeech
    this.quietRunMs = wasSpeech ? 0 : Math.min(this.quietRunMs + frameMs, FLOOR_CONFIRM_MS)

    const floor = Math.max(this.noiseFloor, t.absoluteMin)
    const span = this.speechPeak - floor
    const hasSpeechRange =
      this.speechPeak >= t.absoluteMin && span >= t.minRangeShare * this.speechPeak
    const threshold = floor * (wasSpeech ? t.stayOverNoise : t.enterOverNoise)
    this.inSpeech = hasSpeechRange && level > threshold
    return this.inSpeech
  }

  private resetActive(): void {
    this.active = []
    this.lastSpeechFrame = -1
    this.activeSpeechMs = 0
    this.activeMs = 0
    this.trailingSilenceMs = 0
  }

  private consumeFrame(frame: Float32Array): EmittedSegment | null {
    const level = rms(frame)
    const frameMs = this.opts.frameMs
    const isSpeech = this.classify(level, frameMs)
    this.onLevel?.(level)

    if (!this.active.length) {
      if (isSpeech) {
        // Open a segment, prepending the pre-roll so the attack is not clipped.
        this.active = [...this.preRoll, frame]
        this.activeMs = (this.preRoll.length + 1) * frameMs
        this.activeSpeechMs = frameMs
        this.segmentStartMs = Math.max(0, this.timeMs - this.preRoll.length * frameMs)
        this.trailingSilenceMs = 0
        this.lastSpeechFrame = this.active.length - 1
        this.preRoll = []
      } else {
        const keepFrames = Math.ceil(this.opts.preRollMs / frameMs)
        this.preRoll.push(frame)
        if (this.preRoll.length > keepFrames) this.preRoll.shift()
      }
      this.timeMs += frameMs
      return null
    }

    this.active.push(frame)
    this.activeMs += frameMs
    if (isSpeech) {
      this.activeSpeechMs += frameMs
      this.lastSpeechFrame = this.active.length - 1
      this.trailingSilenceMs = 0
    } else {
      this.trailingSilenceMs += frameMs
    }

    const shouldClose = this.trailingSilenceMs >= this.opts.silenceMs
    const tooLong = this.activeMs >= this.opts.maxSegMs
    this.timeMs += frameMs
    if (!shouldClose && !tooLong) return null

    return this.close(shouldClose ? 'silence' : 'max')
  }

  private close(reason: 'silence' | 'max'): EmittedSegment | null {
    const frameMs = this.opts.frameMs
    const startMs = this.segmentStartMs
    const speechMs = this.activeSpeechMs
    // On a silence close, trim the hangover down to a short tail: the rest is
    // wasted inference and hurts recognition on short utterances. A length-forced
    // cut picks its own boundary, for the reason documented on SOFT_CUT_WINDOW_MS.
    const keep = reason === 'silence' ? this.tailIndex() : this.softCutIndex()
    const frames = this.active.slice(0, keep)
    const samples = concatAll(frames)
    const endMs = startMs + frames.length * frameMs
    const speechDuration = speechMs
    // Only a length-forced cut continues immediately: the tail of a long
    // monologue must not be swallowed. Silence-trimmed frames, on the other
    // hand, are *discarded* — carrying them into the next utterance used to
    // prepend ~200 ms of silence to every segment and shift its start time.
    const remainder =
      reason === 'max' && this.active.length > frames.length ? this.active.slice(frames.length) : []
    this.resetActive()
    if (remainder.length) {
      this.active = remainder
      this.activeMs = remainder.length * frameMs
      this.activeSpeechMs = remainder.length * frameMs
      // The tail of a long monologue is carried over verbatim, so it counts as
      // speech for both the length filter and the next trim.
      this.lastSpeechFrame = remainder.length - 1
      this.trailingSilenceMs = 0
      this.segmentStartMs = endMs
    }
    if (speechDuration < this.opts.minSegMs) return null
    return { startMs, endMs, samples }
  }
}

// Return type is inferred so it stays `Float32Array<ArrayBuffer>` rather than
// widening to `Float32Array<ArrayBufferLike>`.
function concat(a: Float32Array, b: Float32Array) {
  // Always allocate: returning `b` would leak the caller's buffer type (and
  // alias their memory) back into the segmenter's own state.
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function concatAll(frames: Float32Array[]): Float32Array {
  const total = frames.reduce((n, f) => n + f.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}
