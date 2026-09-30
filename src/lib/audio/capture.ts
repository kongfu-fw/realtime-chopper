import { info, warn } from '../log/store'
import { t } from '../i18n/index.ts'

/**
 * Microphone capture (requirement 13).
 *
 * The whole point of this module is the constraint set: echo cancellation, noise
 * suppression and automatic gain control are all switched off, because they are
 * exactly what makes a recogniser hear processed speech instead of the room.
 * The cost is that we must not play our own TTS through the speakers — the plan
 * handles that by requiring headphones (a soft check in the UI, not a hard gate)
 * plus a half-duplex mode that stops feeding the recogniser while the app talks.
 *
 * Audio is tapped with an AudioWorklet, not MediaRecorder or ScriptProcessor:
 * a worklet runs on the audio thread, so jank on the main thread cannot drop
 * microphone samples, and we get raw Float32 instead of an encoded container.
 */

const WORKLET_SOURCE = `
class RcTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const ms = options?.processorOptions?.chunkMs ?? 100
    this.size = Math.max(1, Math.round(sampleRate * ms / 1000))
    this.buf = new Float32Array(this.size)
    this.count = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buf[this.count++] = channel[i]
      if (this.count === this.size) {
        const out = this.buf.slice(0)
        this.port.postMessage(out, [out.buffer])
        this.count = 0
      }
    }
    return true
  }
}
registerProcessor('rc-tap', RcTap)
`

/** What the phone's own loudspeaker is assumed to deliver, for the one path with no context. */
const FALLBACK_SAMPLE_RATE = 48_000

/** How long `resume()` is given before the device is reopened instead; see `withDeadline`. */
const RESUME_DEADLINE_MS = 1500

export interface CaptureOptions {
  /** 100 ms of 16 kHz-bounded audio arrives here. */
  onChunk: (chunk: Float32Array, sampleRate: number) => void
  /**
   * Lets the user abandon a start while the permission prompt is still open.
   *
   * There is deliberately no level callback here. There used to be — the peak of
   * each block, for the record button's halo — and having two producers for one
   * meter (this one, and a second measurement of the same audio inside the vad
   * worker, at a different rate and a different scale) is what made the halo read as
   * broken. The level now has exactly one producer, in the vad worker, and it is the
   * level of the signal *before* the front-end's gain; see `reportLevel` there for
   * why that is the number a user can act on.
   */
  signal?: AbortSignal
}

/**
 * How a repair after the page was hidden went.
 *
 * - `ok` — nothing had to be done (or the browser had already put itself back);
 * - `resumed` — the same device and the same graph, resumed;
 * - `reopened` — the device was opened again and the graph rebuilt;
 * - `failed` — the microphone is gone, and the session has to decide what a
 *   recording without one is (see the session's `reviveCapture`).
 *
 * The middle two are not the same as `ok` for one reason: the samples the page
 * missed while it was away were never produced, so there is a hole in the audio
 * that nothing can fill. Saying which repair happened is how the gap gets from
 * here to the log and to the user.
 */
export type CaptureRevival = 'ok' | 'resumed' | 'reopened' | 'failed'

export interface CaptureHandle {
  stop: () => Promise<void>
  /**
   * The rate the graph is running at **now**, not the one it started with: a
   * reopened capture builds a fresh `AudioContext`, and a browser is free to give
   * the second one a different rate.
   */
  readonly sampleRate: number
  /** False when the browser silently downgraded our constraints (iOS often does). */
  readonly constraintsHonoured: boolean
  readonly settings: MediaTrackSettings
  /**
   * Whether samples are flowing at this instant.
   *
   * Both halves are needed: iOS can end the track (the device is taken away) or
   * leave it live while it suspends the audio context, and the two want different
   * repairs — see `revive`.
   */
  alive: () => boolean
  /**
   * Brings the microphone back after the page was hidden.
   *
   * iOS suspends a whole page when the screen locks, and nothing about that
   * survives unchanged: the context comes back `suspended` (Safari also has
   * `interrupted`, its own extra state), and the track is often ended outright.
   * The cheap repair is tried first because it is the common one and it keeps the
   * same graph; only then is the device opened from scratch.
   */
  revive: () => Promise<CaptureRevival>
}

/**
 * Turns the browser's microphone failures into something a user can act on.
 *
 * Left raw, these surface as "Permission denied" or "NotReadableError" — which
 * tells the user nothing about what to click next.
 */
export function describeCaptureError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return t('麦克风权限被拒绝了：点地址栏的锁图标，允许麦克风后再试一次')
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return t('没找到麦克风，看看麦克风或耳机插好了没')
    case 'NotReadableError':
    case 'TrackStartError':
      return t('麦克风被别的软件占用了，关掉会议或录音软件再试')
    case 'OverconstrainedError':
      return t('这个麦克风不符合音质要求，换一个再用')
    case 'AbortError':
      return t('启动被中断了，再点一次')
    default:
      return t('麦克风打不开：{error}', { error: err instanceof Error ? err.message : String(err) })
  }
}

export async function startCapture(options: CaptureOptions): Promise<CaptureHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(t('这个浏览器不能录音，换个浏览器试试'))
  }

  const constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 48000,
    },
    video: false,
  }

  // The live graph, in variables rather than in constants, because a revival
  // replaces all of it: the device, the context and the three nodes together.
  let stream: MediaStream | null = null
  let track: MediaStreamTrack | null = null
  let settings: MediaTrackSettings = {}
  let honoured = true
  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let node: AudioWorkletNode | null = null
  let silence: GainNode | null = null
  let closed = false

  /**
   * A fresh context with the tap processor installed.
   *
   * The processor is loaded from a Blob URL rather than served as a file: it is
   * a few hundred bytes, and a separate module in `static/` would be one more
   * request before the first sample as well as one more thing to keep in sync
   * with this file. The URL is revoked as soon as the module is in.
   */
  async function makeContext(): Promise<AudioContext> {
    const ctx = new AudioContext()
    try {
      // iOS keeps the context suspended until a user gesture resumes it.
      if (ctx.state === 'suspended') await ctx.resume()
      const blobUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
      )
      try {
        await ctx.audioWorklet.addModule(blobUrl)
      } finally {
        URL.revokeObjectURL(blobUrl)
      }
    } catch (err) {
      // A context that never got its processor is still a context: left open it
      // counts against the page's audio limit (and on iOS, against the number of
      // contexts a single page may create at all).
      await ctx.close().catch(() => undefined)
      throw err
    }
    return ctx
  }

  /** What the browser actually applied, which is not always what we asked for. */
  function applyTrack(input: MediaStream): void {
    track = input.getAudioTracks()[0] ?? null
    settings = track?.getSettings() ?? {}
    honoured =
      settings.echoCancellation !== true &&
      settings.noiseSuppression !== true &&
      settings.autoGainControl !== true
    if (!honoured) {
      warn('capture', t('浏览器没有完全遵守高保真拾音设置，识别质量可能受影响'), {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        sampleRate: settings.sampleRate,
      })
    }
  }

  /** Connects the tap to `ctx` and starts delivering blocks to `options.onChunk`. */
  function wire(input: MediaStream, ctx: AudioContext): void {
    source = ctx.createMediaStreamSource(input)
    // One output, not zero. A node with `numberOfOutputs: 0` cannot be connected
    // at all (`connect` throws "output index (0) exceeds number of outputs (0)"),
    // and without a downstream path the audio graph would never pull it, so
    // `process()` would never run. The processor writes nothing into its output,
    // so that output is silent by construction — the zero-gain node after it is
    // belt and braces, and nothing is ever routed to the speakers.
    node = new AudioWorkletNode(ctx, 'rc-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { chunkMs: 100 },
    })
    silence = ctx.createGain()
    silence.gain.value = 0
    source.connect(node)
    node.connect(silence)
    silence.connect(ctx.destination)
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      options.onChunk(event.data, ctx.sampleRate)
    }
  }

  /** Detaches the nodes of the current graph; the device is `detach`'s business. */
  function unwire(): void {
    if (node) node.port.onmessage = null
    try {
      node?.disconnect()
      source?.disconnect()
      silence?.disconnect()
    } catch {
      /* nothing was connected */
    }
    source = null
    node = null
    silence = null
  }

  /**
   * Releases the device and the context of the current attempt.
   *
   * Called on a failed start, on stop, and at the beginning of a revival — so it
   * has to be safe on a half-built graph, and it has to leave nothing open: a
   * microphone that is still recording after an error is the one failure in this
   * module the user cannot see.
   */
  async function detach(): Promise<void> {
    unwire()
    const input = stream
    stream = null
    track?.stop()
    input?.getTracks().forEach((t) => t.stop())
    track = null
    const ctx = context
    context = null
    await ctx?.close().catch(() => undefined)
  }

  try {
    stream = await getUserMediaAbortable(constraints, options.signal)
  } catch (err) {
    // Cancelling is not a capture failure: rethrow it untouched so the caller
    // can distinguish "the user changed their mind" from "the microphone is
    // broken" (the wrapper below would lose the AbortError type).
    if (err instanceof Error && err.name === 'AbortError') throw err
    throw new Error(describeCaptureError(err), { cause: err })
  }
  applyTrack(stream)

  let started: AudioContext
  try {
    started = await makeContext()
    context = started
    wire(stream, started)
  } catch (err) {
    // Before this, a failure here left the microphone open and the audio context
    // running with nothing holding them: the user saw an error, and their mic
    // stayed hot.
    await detach()
    throw new Error(
      t('音频启动失败，换个浏览器或设备再试：{error}', {
        error: err instanceof Error ? err.message : String(err),
      }),
      { cause: err },
    )
  }

  info('capture', t('麦克风已开启'), {
    sampleRate: started.sampleRate,
    channelCount: settings.channelCount,
    constraintsHonoured: honoured,
  })

  const handle: CaptureHandle = {
    get sampleRate() {
      return context?.sampleRate ?? FALLBACK_SAMPLE_RATE
    },
    get constraintsHonoured() {
      return honoured
    },
    get settings() {
      return settings
    },
    alive: () =>
      !closed &&
      track !== null &&
      track.readyState === 'live' &&
      !track.muted &&
      context !== null &&
      context.state === 'running',
    revive: async (): Promise<CaptureRevival> => {
      // A stopped session has no microphone to bring back, and opening one after
      // stop is exactly the hot-microphone bug `detach` exists to prevent.
      if (closed) return 'failed'
      if (handle.alive()) return 'ok'

      // The cheap repair: the device is still ours and only the context went to
      // sleep, which is the common shape — iOS leaves the track live across a
      // screen lock. A track that reports itself `muted` is tried here too rather
      // than sent straight to the expensive path: that flag is how a browser says
      // "no data right now", which a resumed context is allowed to undo, and
      // reopening a device that was never lost is the more disruptive repair of
      // the two. It is raced against a deadline because resume() is not promised
      // to settle while the context is `interrupted`.
      if (track && track.readyState === 'live' && context) {
        try {
          await withDeadline(context.resume(), RESUME_DEADLINE_MS)
          if (handle.alive()) return 'resumed'
        } catch {
          /* the device has to be opened again; see below */
        }
      }

      // The expensive repair: iOS ended the track, so the device is opened from
      // scratch. The whole graph goes with it — an `AudioContext` cannot be handed
      // another stream, and rebuilding around a dead track is not worth keeping.
      try {
        await detach()
        if (closed) return 'failed'
        const input = await getUserMediaAbortable(constraints)
        if (closed) {
          input.getTracks().forEach((t) => t.stop())
          return 'failed'
        }
        stream = input
        applyTrack(input)
        context = await makeContext()
        wire(input, context)
        info('capture', t('麦克风已重新打开'), { sampleRate: context.sampleRate })
        return handle.alive() ? 'reopened' : 'failed'
      } catch (err) {
        // Half-built counts as open: whatever did get as far as the device is
        // released here rather than handed to a session that is about to stop.
        await detach()
        warn('capture', t('麦克风没能重新打开：{error}', { error: describeCaptureError(err) }))
        return 'failed'
      }
    },
    stop: async () => {
      if (closed) return
      closed = true
      await detach()
      info('capture', t('麦克风已关闭'))
    },
  }
  return handle
}

/**
 * `getUserMedia` has no abort signal of its own, and a permission prompt can
 * stay unanswered indefinitely — which used to leave the UI spinning with no
 * way out. Racing the promise lets the user cancel; if the microphone is
 * granted after the cancellation, its tracks are stopped so the device is not
 * left open.
 */
function getUserMediaAbortable(
  constraints: MediaStreamConstraints,
  signal?: AbortSignal,
): Promise<MediaStream> {
  if (!signal) return navigator.mediaDevices.getUserMedia(constraints)
  return new Promise<MediaStream>((resolve, reject) => {
    const onAbort = () => reject(new DOMException(t('启动被取消'), 'AbortError'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    navigator.mediaDevices.getUserMedia(constraints).then(
      (stream) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        resolve(stream)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * Races a promise the browser is allowed to leave unsettled.
 *
 * Only `resume()` needs this. Safari has a state of its own — `interrupted`,
 * entered for phone calls and screen locks — in which the promise may not settle
 * until the interruption ends, and "until the user picks the phone up again" is
 * indistinguishable from "never" for a caller that has to decide what to do next.
 *
 * The rejection reason is never shown to anyone: the one caller treats it purely
 * as "the cheap repair did not work", and its own message follows from there.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('audio context resume timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}
