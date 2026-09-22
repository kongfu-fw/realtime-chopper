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
segmenter.onLevel = (level) => {
  // ~10 messages/second is plenty for a level meter and keeps postMessage cheap.
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
