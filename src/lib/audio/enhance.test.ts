import assert from 'node:assert/strict'
import test from 'node:test'
import { EnergySegmenter } from '../asr/segmenter.ts'
import {
  AntiAliasResampler,
  AutoGain,
  HighPass,
  SpectralNoiseSuppressor,
  SpeechFrontend,
} from './enhance.ts'

/**
 * The capture front-end, pinned down by measurement.
 *
 * Every number below came out of this module before it was written down, and each
 * one stands for a defect that used to be in the pipeline rather than a preference:
 * the decimation aliased (9–24 kHz folded into the speech band at full amplitude),
 * there was no level control at all for a speaker at 4 m, and nothing separated a
 * voice from the room it was in. The thresholds are deliberately loose — two or
 * three times the observed margin — because the point is to catch a regression
 * (a filter that stops filtering, a gate that starts eating speech), not to freeze
 * the last decimal place.
 *
 * Node resolves ESM specifiers literally, so the import carries the `.ts` extension.
 */

const RATE = 16000

/** Full-scale sine rms, the reference every amplitude below is relative to. */
const FULL = Math.SQRT1_2

/** Deterministic noise: a test that fails once every ten runs is not a test. */
function noiseSource(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x3fffffff - 1
  }
}

function tone(rate: number, hz: number, samples: number): Float32Array {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

/**
 * Speech-shaped test signal: voiced bursts of 300 ms separated by 300 ms of quiet.
 *
 * Not a recording and not trying to be — what the stages below care about is a
 * signal that is loud in bursts and absent between them, so that "what happened to
 * the speech" and "what happened to the room" can be measured separately. The
 * harmonics give it energy across the band, like a voice and unlike a pure tone.
 */
function speech(seconds: number, amplitude: number, rate = RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) {
    const t = i / rate
    if (t % 0.6 >= 0.3) continue
    out[i] =
      (amplitude / 2) *
      (Math.sin(2 * Math.PI * 220 * t) + 0.6 * Math.sin(2 * Math.PI * 660 * t) + 0.4 * Math.sin(2 * Math.PI * 1300 * t))
  }
  return out
}

function addNoise(signal: Float32Array, amplitude: number, seed = 99): Float32Array {
  const random = noiseSource(seed)
  const out = Float32Array.from(signal)
  for (let i = 0; i < out.length; i++) out[i] = out[i]! + amplitude * random()
  return out
}

/** rms over the loud half of a cycle and over the quiet half, skipping the first 40%. */
function speechAndRoom(signal: Float32Array, rate = RATE): [number, number] {
  let speechPower = 0
  let speechCount = 0
  let roomPower = 0
  let roomCount = 0
  for (let i = Math.floor(signal.length * 0.4); i < signal.length; i++) {
    const phase = (i / rate) % 0.6
    if (phase < 0.25) {
      speechPower += signal[i]! * signal[i]!
      speechCount++
    } else if (phase > 0.35 && phase < 0.55) {
      roomPower += signal[i]! * signal[i]!
      roomCount++
    }
  }
  return [Math.sqrt(speechPower / speechCount), Math.sqrt(roomPower / roomCount)]
}

function rms(signal: Float32Array, from = 0): number {
  let sum = 0
  for (let i = from; i < signal.length; i++) sum += signal[i]! * signal[i]!
  return Math.sqrt(sum / Math.max(1, signal.length - from))
}

function decibels(ratio: number): number {
  return 20 * Math.log10(Math.max(ratio, 1e-12))
}

/** Energy at one frequency, by correlation — enough to ask "did this tone survive". */
function amplitudeAt(signal: Float32Array, hz: number, rate = RATE): number {
  let re = 0
  let im = 0
  let count = 0
  for (let i = Math.floor(signal.length / 2); i < signal.length; i++) {
    re += signal[i]! * Math.cos((2 * Math.PI * hz * i) / rate)
    im += signal[i]! * Math.sin((2 * Math.PI * hz * i) / rate)
    count++
  }
  return (2 * Math.hypot(re, im)) / count
}

/** Feeds a whole signal through a streaming stage in realistic 100 ms pieces. */
function stream(process: (chunk: Float32Array) => Float32Array, input: Float32Array, chunk = 4800): Float32Array {
  const parts: Float32Array[] = []
  for (let i = 0; i + chunk <= input.length; i += chunk) parts.push(process(input.subarray(i, i + chunk)))
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// ---------------------------------------------------------------- decimation

test('抗混叠：8 kHz 以上的东西不再折回语音带', () => {
  // This is the defect the module was written for. 48/16 is exactly 3, so the
  // linear interpolation this replaced kept every third sample and folded
  // everything between 8 and 24 kHz into the speech band — full amplitude, no
  // attenuation at all. A classroom puts a lot of energy up there.
  // A fresh instance per tone: this is a streaming filter, so reusing one would
  // measure the previous tone's tail as much as this one's.
  const through = (hz: number) => {
    const out = new AntiAliasResampler().process(tone(48000, hz, 48000), 48000, RATE)
    assert.equal(out.length > 15900, true, `${hz} Hz produced ${out.length} samples`)
    return rms(out) / FULL
  }
  for (const hz of [500, 2000, 4000, 6000]) {
    assert.ok(through(hz) > 0.95, `${hz} Hz was attenuated in the passband`)
  }
  for (const hz of [8000, 12000, 17000]) {
    const leaked = through(hz)
    assert.ok(leaked < 0.02, `${hz} Hz aliased back into the band (${leaked})`)
  }
})

test('抗混叠在 44.1 kHz 上同样成立，且所有分数相位都被走到', () => {
  // 44.1/16 is not an integer, so this is also the test that the polyphase table
  // is indexed correctly: every output sample lands on a different fractional
  // offset, and a mistake there shows up as ripple in the passband.
  const out = new AntiAliasResampler().process(tone(44100, 3000, 44100), 44100, RATE)
  assert.ok(out.length > 15900)
  assert.ok(rms(out) / FULL > 0.9, 'the 3 kHz tone lost level on an uneven ratio')
  const high = new AntiAliasResampler().process(tone(44100, 9000, 44100), 44100, RATE)
  assert.ok(rms(high) / FULL < 0.02, '9 kHz aliased on a 44.1 kHz stream')
})

test('重采样是流式的：输出不随分块漂移', () => {
  const resampler = new AntiAliasResampler()
  const input = tone(48000, 1000, 48000 * 5)
  const out = stream((chunk) => resampler.process(chunk, 48000, RATE), input)
  // One fixed window of ramp-in, no accumulating drift: five seconds in must be
  // five seconds out, or every timestamp the segmenter keeps would slide.
  assert.ok(Math.abs(out.length - input.length / 3) < 64, `drifted to ${out.length} of ${input.length / 3}`)
  assert.ok(rms(out, 1600) / FULL > 0.98, 'the tone lost level across chunk boundaries')
})

test('同速率时直接返回输入，不做多余滤波', () => {
  const resampler = new AntiAliasResampler()
  const input = tone(RATE, 1000, 1600)
  assert.equal(resampler.process(input, RATE, RATE), input)
})

// ---------------------------------------------------------------- high pass

test('高通：桌面隆隆声和直流被去掉，语音的低音区留下', () => {
  const cut = (hz: number) => {
    const signal = tone(RATE, hz, RATE)
    new HighPass(RATE).process(signal)
    return rms(signal, 1600) / FULL
  }
  assert.ok(cut(25) < 0.2, '25 Hz survived the high-pass')
  assert.ok(cut(85) > 0.6 && cut(85) < 0.8, 'the corner is not at 85 Hz')
  assert.ok(cut(1000) > 0.98, '1 kHz was affected')
})

// ---------------------------------------------------------------- denoiser

test('降噪：只在噪声的帧里，噪声真的被压下去了', () => {
  const denoiser = new SpectralNoiseSuppressor()
  const room = addNoise(new Float32Array(RATE * 4), 0.05)
  const out = denoiser.process(room)
  // Measured at −13.5 dB, i.e. essentially the −14 dB floor. The first second is
  // the estimate learning the room, so it is excluded.
  const reduction = decibels(rms(out, RATE) / rms(room, RATE))
  assert.ok(reduction < -10, `stationary room noise came out only ${reduction.toFixed(1)} dB down`)
})

test('降噪：语音保住，房间被压掉，信噪比因此上升', () => {
  const cases: Array<[number, number]> = [
    [0.005, 8], // ~20 dB SNR
    [0.016, 8], // ~10 dB SNR
  ]
  for (const [noise, expectedGain] of cases) {
    const denoiser = new SpectralNoiseSuppressor()
    const noisy = addNoise(speech(6, 0.05), noise)
    const out = denoiser.process(noisy)
    const [speechBefore, roomBefore] = speechAndRoom(noisy)
    const [speechAfter, roomAfter] = speechAndRoom(out)
    const improvement = decibels(speechAfter / roomAfter) - decibels(speechBefore / roomBefore)
    assert.ok(improvement > expectedGain, `SNR improved by only ${improvement.toFixed(1)} dB at noise ${noise}`)
    // What matters as much: it must not be paying for that with the voice.
    const kept = decibels(speechAfter / speechBefore)
    assert.ok(kept > -3, `the speech was attenuated by ${kept.toFixed(1)} dB`)
  }
})

test('降噪：干净信号原样通过（增益为 1 时重构是精确的）', () => {
  const clean = speech(6, 0.05)
  const out = new SpectralNoiseSuppressor().process(clean)
  const [before] = speechAndRoom(clean)
  const [after] = speechAndRoom(out)
  assert.ok(Math.abs(decibels(after / before)) < 1, 'the stage is not transparent on clean audio')
})

test('降噪：帧长不变，只有一格窗口的启动延迟', () => {
  const denoiser = new SpectralNoiseSuppressor()
  const input = addNoise(speech(2, 0.05), 0.01)
  const out = denoiser.process(input)
  assert.ok(input.length - out.length < 512 && input.length - out.length >= 0, `${input.length} -> ${out.length}`)
})

// ---------------------------------------------------------------- gain

test('自动增益：把远处的说话声抬到模型训练的电平上', () => {
  // All three land inside the ×8 ceiling, which is the case the ceiling is set to
  // cover — a speaker at four or five metres. The extreme below is tested
  // separately, because there the honest answer is "as far as the ceiling goes".
  for (const amplitude of [0.02, 0.03, 0.05]) {
    const reference = speech(8, amplitude)
    const out = new AutoGain().process(Float32Array.from(reference))
    const [before] = speechAndRoom(reference)
    const [after] = speechAndRoom(out)
    // The target is the project's own reference level, "real speech at rms 0.08".
    assert.ok(Math.abs(decibels(after / 0.08)) < 3, `landed at ${after.toFixed(4)} instead of 0.08`)
    assert.ok(decibels(after / before) > 0, 'a distant speaker was not lifted')
  }
})

test('自动增益：增益有上限，响的人被压下来，峰值不破 1', () => {
  const loud = speech(8, 0.3)
  const [before] = speechAndRoom(loud)
  // `process` filters in place, so the reference has to be measured before it runs.
  const out = new AutoGain().process(loud)
  const [after] = speechAndRoom(out)
  assert.ok(after < before, 'a loud speaker was not attenuated')
  let peak = 0
  for (const sample of out) peak = Math.max(peak, Math.abs(sample))
  assert.ok(peak < 1, 'the output clipped')
})

test('自动增益：极远处只抬到上限为止，但确实抬到了上限', () => {
  // −54 dBFS is a speaker most of a room away. The ceiling is deliberate: the
  // residual room is lifted with the voice, and +18 dB is already enough to bring a
  // distant voice back to a level these models read without turning the recording
  // into hiss. What the level ring reports (the raw input) is what tells the user to
  // move closer at this point, rather than the AGC papering over it.
  const reference = speech(8, 0.005)
  const [before] = speechAndRoom(reference)
  const gain = new AutoGain()
  const out = gain.process(reference)
  const [after] = speechAndRoom(out)
  assert.ok(expectedGainCeiling(gain.gain), `gain settled at ${gain.gain}`)
  assert.ok(Math.abs(decibels(after / before) - 18.06) < 0.2, `lifted by ${decibels(after / before).toFixed(1)} dB`)
})

/** The ×8 ceiling, spelled once so the test above can name it. */
function expectedGainCeiling(gain: number): boolean {
  return Math.abs(gain - 8) < 0.01
}

test('自动增益：停顿时不往上爬（那正是平台 AGC 被关掉的原因）', () => {
  const gain = new AutoGain()
  gain.process(speech(3, 0.01))
  const held = gain.gain
  const room = addNoise(new Float32Array(RATE * 3), 0.0004)
  gain.process(room)
  assert.ok(Math.abs(gain.gain - held) < 0.02, `the gain moved from ${held} to ${gain.gain} during silence`)
})

test('自动增益：每句话开头不会冒出一股增益', () => {
  // The bug this pins down: an envelope that decays through a pause makes the gain
  // climb back up (up to ×8) at the first word after it, so every sentence boundary
  // gets a burst of gain. Nothing above unity is ever *wanted* for a loud talker, so
  // the output peak cannot legitimately exceed the input's — it did, by 3.5 dB.
  const loud = speech(8, 0.5)
  let inputPeak = 0
  for (const sample of loud) inputPeak = Math.max(inputPeak, Math.abs(sample))
  const out = new AutoGain().process(loud)
  let outputPeak = 0
  for (const sample of out) outputPeak = Math.max(outputPeak, Math.abs(sample))
  assert.ok(outputPeak <= inputPeak + 1e-6, `peak grew from ${inputPeak.toFixed(3)} to ${outputPeak.toFixed(3)}`)
})

// ---------------------------------------------------------------- whole chain

test('前级整体：远场教室信号出来时更干净、更响，长度不变', () => {
  const seconds = 8
  const input = new Float32Array(48000 * seconds)
  const far = speech(seconds, 0.004, 48000) // a speaker 4–5 m away, ~ −48 dBFS
  const random = noiseSource(7)
  for (let i = 0; i < input.length; i++) {
    input[i] =
      far[i]! +
      0.0004 * random() + // room hiss
      0.0002 * Math.sin((2 * Math.PI * 30 * i) / 48000) // rumble, which the high-pass owes us
  }

  const frontend = new SpeechFrontend()
  const out = stream((chunk) => frontend.process(chunk, 48000), input)
  assert.ok(Math.abs(out.length - input.length / 3) < 1024, `length drifted: ${out.length}`)

  const [speechBefore, roomBefore] = speechAndRoom(input, 48000)
  const [speechAfter, roomAfter] = speechAndRoom(out)
  const improvement = decibels(speechAfter / roomAfter) - decibels(speechBefore / roomBefore)
  assert.ok(improvement > 8, `end-to-end SNR improved by only ${improvement.toFixed(1)} dB`)
  assert.ok(decibels(speechAfter / speechBefore) > 6, 'the distant speaker was not brought up to level')

  // The stats are what the level ring and the log read, so they have to describe
  // the audio honestly: input is the raw microphone level, not the amplified one.
  assert.ok(frontend.stats.inputRms > 0 && frontend.stats.inputRms < speechBefore * 2)
  assert.ok(frontend.stats.gainDb > 6 && frontend.stats.gainDb <= 18.1)
  assert.ok(frontend.stats.outputDb > frontend.stats.inputDb)
})

test('整条链路：远场教室里，前级让分段器听见了原本听不见的话', () => {
  // The complaint this module was written for, measured end to end instead of stage
  // by stage: a speaker four or five metres away in a room that is almost as loud
  // as they are, with most of the room's energy above 8 kHz where a naive decimator
  // folds it straight back onto the voice.
  const seconds = 12
  const input = new Float32Array(48000 * seconds)
  const voice = speech(seconds, 0.01, 48000)
  const random = noiseSource(5)
  for (let i = 0; i < input.length; i++) {
    input[i] =
      voice[i]! +
      0.0025 * random() +
      0.0025 * Math.sin((2 * Math.PI * 11000 * i) / 48000) +
      0.001 * Math.sin((2 * Math.PI * 9000 * i) / 48000)
  }

  /** What the pipeline did before this module existed: every third sample, unfiltered. */
  const naive = () => {
    const out = new Float32Array(Math.floor(input.length / 3))
    for (let i = 0; i < out.length; i++) out[i] = input[i * 3]!
    return out
  }

  const spokenSeconds = (signal: Float32Array) => {
    const segmenter = new EnergySegmenter()
    let kept = 0
    for (let i = 0; i + 1600 <= signal.length; i += 1600) {
      for (const segment of segmenter.push(signal.subarray(i, i + 1600))) kept += segment.samples.length / RATE
    }
    for (const segment of segmenter.flush()) kept += segment.samples.length / RATE
    return kept
  }

  const before = spokenSeconds(naive())
  // One front-end for the whole signal: it is a streaming filter, so a fresh one
  // per chunk would measure its restart transient twelve times over.
  const frontend = new SpeechFrontend()
  const after = spokenSeconds(stream((chunk) => frontend.process(chunk, 48000), input))

  assert.ok(before < 2, `the unfiltered path somehow found ${before.toFixed(1)} s of speech`)
  assert.ok(after > 8, `only ${after.toFixed(1)} s of the 12 s came out as speech`)
})

test('前级整体：12 kHz 的音调不会出现在 4 kHz 上', () => {
  const input = tone(48000, 12000, 48000 * 3).map((value) => value * 0.3)
  const frontend = new SpeechFrontend()
  const out = stream((chunk) => frontend.process(chunk, 48000), input)
  // A decimator that just drops samples puts this at 4 kHz with ~0.3 amplitude.
  const alias = amplitudeAt(out, 4000)
  assert.ok(alias < 0.01, `the 12 kHz tone aliased to 4 kHz at ${alias.toFixed(3)}`)
  assert.ok(amplitudeAt(out, 12000 % 8000) < 0.01)
})
