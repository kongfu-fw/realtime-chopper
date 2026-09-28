import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SEGMENTER, EnergySegmenter, type EmittedSegment } from './segmenter.ts'

/**
 * The coalescing rule, which exists because a recogniser asked about an
 * utterance that is too short answers with something invented rather than with
 * nothing (see `transcript-guard.ts` for the measurements behind that).
 *
 * The numbers asserted here were measured, not chosen: with `coalesceMs` at the
 * Korean module's 1200, the timelines below come out as one 2300 ms-of-speech
 * segment where without it they come out as a 700 ms one and a 1600 ms one.
 */

const RATE = 16000
/** The Korean module's floor; `models.ts` carries the measurements it came from. */
const FLOOR = 1200

/** Voiced harmonics in bursts: loud where it speaks, and nothing between them. */
function voice(ms: number, amplitude = 0.08): Float32Array {
  const out = new Float32Array((ms * RATE) / 1000)
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE
    out[i] =
      (amplitude / 2) *
      (Math.sin(2 * Math.PI * 220 * t) +
        0.6 * Math.sin(2 * Math.PI * 660 * t) +
        0.4 * Math.sin(2 * Math.PI * 1300 * t))
  }
  return out
}

const quiet = (ms: number) => new Float32Array((ms * RATE) / 1000)

function timeline(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function segmenter(coalesceMs: number): EnergySegmenter {
  return new EnergySegmenter({ ...DEFAULT_SEGMENTER, coalesceMs })
}

/** Feeds 100 ms at a time, like the capture path does, and collects what closes. */
function feed(engine: EnergySegmenter, signal: Float32Array): EmittedSegment[] {
  const out: EmittedSegment[] = []
  const chunk = RATE / 10
  for (let i = 0; i + chunk <= signal.length; i += chunk) {
    out.push(...engine.push(signal.subarray(i, i + chunk)))
  }
  return out
}

const spokenMs = (segment: EmittedSegment) => segment.speechMs
const spanMs = (segment: EmittedSegment) => segment.endMs - segment.startMs

test('不足的短句会和下一句合成一句', () => {
  // 700 ms of speech, then a second utterance of 1600 ms. Neither is invented
  // text; the 700 ms one alone is, which is the whole reason for the join.
  const signal = timeline([voice(700), quiet(900), voice(1600), quiet(900)])

  const plain = feed(segmenter(0), signal)
  assert.equal(plain.length, 2, 'with the rule off, the utterance must be untouched')
  assert.equal(spokenMs(plain[0]!), 700)
  assert.equal(spokenMs(plain[1]!), 1600)

  const joined = feed(segmenter(FLOOR), signal)
  assert.equal(joined.length, 1, 'the short utterance was not joined to the next one')
  assert.equal(spokenMs(joined[0]!), 2300)
  assert.equal(spanMs(joined[0]!), 3320)
  // The audio is the two utterances plus the silence that was really between
  // them: nothing was sped up, so every timestamp after this one still holds.
  assert.equal(joined[0]!.samples.length / (RATE / 1000), spanMs(joined[0]!))
  assert.equal(joined[0]!.startMs, 0)
})

test('攒到够长才走：两段短句也能凑成一段', () => {
  const signal = timeline([voice(700), quiet(900), voice(700), quiet(900), voice(600), quiet(900)])
  const engine = segmenter(FLOOR)
  const out = feed(engine, signal)
  // 700 + 700 = 1400 is over the floor, so the first two go together...
  assert.equal(out.length, 1)
  assert.equal(spokenMs(out[0]!), 1400)
  // ...and the third one is below it again, so it waits (and is flushed here,
  // because only 900 ms of silence follow it — see the hold's grace).
  const rest = engine.flush()
  assert.equal(rest.length, 1)
  assert.equal(spokenMs(rest[0]!), 600)
})

test('等不到下一句，短句就自己走', () => {
  // One word, then four seconds of nothing: joining forever would delay the line
  // for the rest of the session, so the hold expires — after 2.5 s of *nothing
  // being said*, and not before.
  const signal = timeline([voice(700), quiet(4000)])
  const engine = segmenter(FLOOR)
  const out = feed(engine, signal)
  assert.equal(out.length, 1, 'the held utterance never came out')
  assert.equal(spokenMs(out[0]!), 700)
  assert.deepEqual(engine.flush(), [], 'it was sent twice')
})

test('停止时手里的话不会被丢掉', () => {
  // 900 ms of silence is not enough to expire the hold, so this one is still
  // held when the session stops: end of stream is the one moment it must go
  // alone rather than be dropped.
  const signal = timeline([voice(700), quiet(900)])
  const engine = segmenter(FLOOR)
  assert.deepEqual(feed(engine, signal), [])
  const flushed = engine.flush()
  assert.equal(flushed.length, 1)
  assert.equal(spokenMs(flushed[0]!), 700)
  assert.equal(spanMs(flushed[0]!), 820)
})

test('够长的话一句都不变', () => {
  // The rule must be invisible to speech that was already long enough: same
  // start, same end, same speech, same audio — no added latency, no re-cut.
  const signal = timeline([voice(2000), quiet(900)])
  const [plain] = feed(segmenter(0), signal)
  const [guarded] = feed(segmenter(FLOOR), signal)
  assert.ok(plain && guarded)
  assert.equal(guarded.startMs, plain.startMs)
  assert.equal(guarded.endMs, plain.endMs)
  assert.equal(spokenMs(guarded), spokenMs(plain))
  assert.equal(guarded.samples.length, plain.samples.length)
})

test('speechMs 数的是话，不是音频', () => {
  // A pause inside the utterance does not close it (that needs `silenceMs`), but
  // it is not speech either: 1720 ms of audio holding 1400 ms of speech. This is
  // why the floor is on this number and not on the segment's length — a longer
  // segment is not a better one.
  const signal = timeline([voice(700), quiet(200), voice(700), quiet(900)])
  const out = feed(segmenter(FLOOR), signal)
  assert.equal(out.length, 1)
  assert.equal(spokenMs(out[0]!), 1400)
  assert.equal(spanMs(out[0]!), 1720)
  assert.ok(spokenMs(out[0]!) < spanMs(out[0]!))
})

test('reset 之后手里的话不会带进下一次', () => {
  const engine = segmenter(FLOOR)
  feed(engine, timeline([voice(700), quiet(900)]))
  engine.reset()
  assert.deepEqual(engine.flush(), [])
})
