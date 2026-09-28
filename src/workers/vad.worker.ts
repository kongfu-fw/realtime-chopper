/// <reference lib="webworker" />
import { EnergySegmenter, type SegmenterOptions } from '../lib/asr/segmenter'
import { RecordingSink } from '../lib/audio/recorder'
import { SpeechFrontend, TARGET_RATE, type FrontendStats } from '../lib/audio/enhance'

/**
 * Segmentation worker.
 *
 * Runs off the main thread for the same reason the recogniser does: with the
 * target hardware being a phone, every millisecond on the main thread shows up
 * as jank in the transcript list.
 *
 * Audio arrives at the device's native rate (48 kHz on iOS) and goes through the
 * speech front-end here — anti-aliased decimation to the 16 kHz the models expect,
 * then high-pass, noise suppression and a bounded gain (see lib/audio/enhance.ts
 * for what each of those is for and what was measured). Both consumers of that
 * audio sit below it: the segmenter and the session recording. That ordering is
 * deliberate, and it is what keeps the recording a faithful copy of the
 * recogniser's input rather than a second, differently-processed signal.
 *
 * It also owns the session recording, and that is not a coincidence: this is the
 * one place that sees every sample the microphone produced, on the same clock as
 * `startMs`/`endMs` of the segments it emits, and OPFS's synchronous write handle
 * only exists inside a worker anyway (see lib/audio/recorder.ts).
 */

const segmenter = new EnergySegmenter()
const frontend = new SpeechFrontend(TARGET_RATE)

/**
 * The level ring, and the pickup summary behind it.
 *
 * The number the ring draws is now the level of the signal *as the microphone
 * delivered it* — before the noise suppression and before the gain — and that is a
 * change of meaning worth stating, because the ring has been through this argument
 * twice. It used to be the segmenter's own frame rms, chosen so that the meter and
 * the recogniser agreed about what "loud" meant; `capture.ts` having reported the
 * peak of each block into the same store was what made it flicker between two
 * scales. Both of those still hold — there is exactly one producer and one number —
 * but with a gain stage in the path the post-gain number is pinned near its target
 * whenever anyone speaks at all. A phone five metres from the speaker would then
 * show a healthy ring while the audio is unusable, which is the one failure this
 * meter exists to report. The input level is also the number its own dB scale was
 * calibrated against (−60 ≈ quiet room, −12 ≈ close speech), so anchoring on it
 * makes the ring agree with its labels again.
 *
 * Cadence: one report per received chunk, i.e. 10 Hz. The chunk *is* the natural
 * rate here — every other rate in this pipeline is derived from it — and it is
 * above what an eye reads as smooth. (The 15 Hz this replaces existed because the
 * level then came from 10 ms frames; nothing needs that resolution to move a
 * shadow by a fraction of a pixel.)
 *
 * The summary is for the diagnostic report rather than the screen: "the phone is
 * four metres away" is a fact the user can act on, and the only way to see it on a
 * phone is to write it into the log. Every five seconds is enough to characterise a
 * session and little enough to leave the ring buffer readable.
 */
const STATS_INTERVAL_MS = 5000
let lastStatsAt = 0

function reportLevel(stats: FrontendStats): void {
  postMessage({ type: 'level', level: stats.inputRms })
  const now = Date.now()
  if (now - lastStatsAt < STATS_INTERVAL_MS) return
  lastStatsAt = now
  postMessage({
    type: 'audio',
    inputDb: stats.inputDb,
    outputDb: stats.outputDb,
    gainDb: stats.gainDb,
    snrDb: stats.snrDb,
  })
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
      frontend.reset()
      nextId = 1
      break
    case 'flush':
      for (const segment of segmenter.flush()) {
        postMessage(
          {
            type: 'segment',
            id: nextId++,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speechMs: segment.speechMs,
            samples: segment.samples,
          },
          [segment.samples.buffer],
        )
      }
      break
    case 'chunk': {
      const pcm16 = frontend.process(msg.samples, msg.rate)
      // Recorded before segmentation, and regardless of segmentation: the file is
      // the copy that is complete by construction. Anything the pipeline later
      // decides to drop can be recovered from here.
      recording.append(pcm16)
      for (const segment of segmenter.push(pcm16)) {
        postMessage(
          {
            type: 'segment',
            id: nextId++,
            startMs: segment.startMs,
            endMs: segment.endMs,
            speechMs: segment.speechMs,
            samples: segment.samples,
          },
          [segment.samples.buffer],
        )
      }
      reportLevel(frontend.stats)
      break
    }
  }
}
