/// <reference lib="webworker" />
import { EnergySegmenter, type SegmenterOptions } from '../lib/asr/segmenter'
import { resampleLinear } from '../lib/audio/resample'
import { RecordingSink } from '../lib/audio/recorder'

/**
 * Segmentation worker.
 *
 * Runs off the main thread for the same reason the recogniser does: with the
 * target hardware being a phone, every millisecond on the main thread shows up
 * as jank in the transcript list. Audio arrives at the device's native rate
 * (48 kHz on iOS) and is converted to the 16 kHz the models expect here.
 *
 * It also owns the session recording, and that is not a coincidence: this is the
 * one place that sees every sample the microphone produced, on the same clock as
 * `startMs`/`endMs` of the segments it emits, and OPFS's synchronous write handle
 * only exists inside a worker anyway (see lib/audio/recorder.ts).
 */

const MODEL_RATE = 16000

const segmenter = new EnergySegmenter()

/**
 * How often the input level is reported, for the halo on the record button.
 *
 * The segmenter calls back once per *frame* — a hundred times a second at the
 * default 10 ms frame — and the meter can use none of that: a hundred
 * `postMessage`s a second across the thread boundary, plus a style write each, to
 * move a shadow by a fraction of a pixel. 15 Hz is above what an eye reads as
 * smooth for a level, and every report lands with 66 ms to settle.
 *
 * What is sent is the segmenter's own `rms` of the frame — the same number its
 * speech threshold is compared against — rather than a second measurement of the
 * same audio taken elsewhere. The halo and the recogniser then agree about what
 * "loud" means, so the meter cannot disagree with the thing that decides whether
 * the user is being heard.
 *
 * Exactly one producer writes the level, and that is the point of removing the
 * other one: `capture.ts` used to report the *peak* of each 100 ms block into the
 * same store, at a tenth of this rate and a few times this size. The two together
 * made the halo flicker between two scales, and the smaller of them — the one
 * that also arrived last, most of the time — is what the ring was mostly drawn
 * from, which is why it looked like a level meter that never moved.
 */
const LEVEL_INTERVAL_MS = 1000 / 15
let lastLevelAt = 0
segmenter.onLevel = (level) => {
  const now = Date.now()
  if (now - lastLevelAt < LEVEL_INTERVAL_MS) return
  lastLevelAt = now
  postMessage({ type: 'level', level })
}

const recording = new RecordingSink((info) => postMessage({ type: 'recording', info }))

let nextId = 1

function reply(requestId: number, payload: Record<string, unknown>): void {
  postMessage({ type: 'record-result', requestId, ...payload })
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as
    | { type: 'configure'; options: Partial<SegmenterOptions> }
    | { type: 'reset' }
    | { type: 'flush' }
    | { type: 'chunk'; samples: Float32Array; rate: number }
    | { type: 'record-attach' }
    | { type: 'record-start' }
    | { type: 'record-stop'; requestId?: number }
    | { type: 'record-clear'; requestId?: number }
    | { type: 'record-limit'; minutes: number }
    | { type: 'record-file'; requestId: number }
    | { type: 'record-slice-wav'; requestId: number; startMs: number; endMs: number }
    | { type: 'record-slice-pcm'; requestId: number; startMs: number; endMs: number }

  switch (msg.type) {
    case 'configure':
      segmenter.configure(msg.options)
      break
    case 'record-limit':
      recording.configure(msg.minutes)
      break
    case 'record-attach': {
      const info = await recording.attach()
      postMessage({ type: 'recording', info })
      break
    }
    case 'record-start': {
      const info = await recording.start()
      postMessage({ type: 'recording', info })
      break
    }
    case 'record-stop': {
      const info = await recording.stop()
      postMessage({ type: 'recording', info })
      // The acknowledgement matters: it is what guarantees the file's WAV header
      // covers the last samples before the session disposes this worker.
      if (msg.requestId !== undefined) reply(msg.requestId, {})
      break
    }
    case 'record-clear': {
      const info = await recording.clear()
      postMessage({ type: 'recording', info })
      if (msg.requestId !== undefined) reply(msg.requestId, {})
      break
    }
    case 'record-file': {
      const file = await recording.file()
      reply(msg.requestId, { file })
      break
    }
    case 'record-slice-wav': {
      const buffer = await recording.wavSlice(msg.startMs, msg.endMs)
      reply(msg.requestId, { buffer })
      break
    }
    case 'record-slice-pcm': {
      const samples = await recording.pcmSlice(msg.startMs, msg.endMs)
      reply(msg.requestId, { samples })
      break
    }
    case 'reset':
      segmenter.reset()
      nextId = 1
      break
    case 'flush':
      for (const segment of segmenter.flush()) {
        postMessage(
          { type: 'segment', id: nextId++, startMs: segment.startMs, endMs: segment.endMs, samples: segment.samples },
          [segment.samples.buffer],
        )
      }
      break
    case 'chunk': {
      const pcm16 =
        msg.rate === MODEL_RATE ? msg.samples : resampleLinear(msg.samples, msg.rate, MODEL_RATE)
      // Recorded before segmentation, and regardless of segmentation: the file is
      // the copy that is complete by construction. Anything the pipeline later
      // decides to drop can be recovered from here.
      recording.append(pcm16)
      for (const segment of segmenter.push(pcm16)) {
        postMessage(
          { type: 'segment', id: nextId++, startMs: segment.startMs, endMs: segment.endMs, samples: segment.samples },
          [segment.samples.buffer],
        )
      }
      break
    }
  }
}
