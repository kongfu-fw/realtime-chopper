import { info, warn } from '../log/store'

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

export interface CaptureOptions {
  /** 100 ms of 16 kHz-bounded audio arrives here. */
  onChunk: (chunk: Float32Array, sampleRate: number) => void
  /** Current input level, for the record button pulse. */
  onLevel?: (level: number) => void
  /** Lets the user abandon a start while the permission prompt is still open. */
  signal?: AbortSignal
}

export interface CaptureHandle {
  stop: () => Promise<void>
  sampleRate: number
  /** False when the browser silently downgraded our constraints (iOS often does). */
  constraintsHonoured: boolean
  settings: MediaTrackSettings
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
      return '麦克风权限被拒绝了：点地址栏的锁图标，允许麦克风后再试一次'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没找到麦克风，看看麦克风或耳机插好了没'
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风被别的软件占用了，关掉会议或录音软件再试'
    case 'OverconstrainedError':
      return '这个麦克风不符合音质要求，换一个再用'
    case 'AbortError':
      return '启动被中断了，再点一次'
    default:
      return `麦克风打不开：${err instanceof Error ? err.message : String(err)}`
  }
}

export async function startCapture(options: CaptureOptions): Promise<CaptureHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('这个浏览器不能录音，换个浏览器试试')
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

  let stream: MediaStream
  try {
    stream = await getUserMediaAbortable(constraints, options.signal)
  } catch (err) {
    // Cancelling is not a capture failure: rethrow it untouched so the caller
    // can distinguish "the user changed their mind" from "the microphone is
    // broken" (the wrapper below would lose the AbortError type).
    if (err instanceof Error && err.name === 'AbortError') throw err
    throw new Error(describeCaptureError(err), { cause: err })
  }
  const track = stream.getAudioTracks()[0]
  const settings = track?.getSettings() ?? {}
  const constraintsHonoured =
    settings.echoCancellation !== true &&
    settings.noiseSuppression !== true &&
    settings.autoGainControl !== true
  if (!constraintsHonoured) {
    warn('capture', '浏览器没有完全遵守高保真拾音设置，识别质量可能受影响', {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      sampleRate: settings.sampleRate,
    })
  }

  let context: AudioContext
  try {
    context = new AudioContext()
    // iOS keeps the context suspended until a user gesture resumes it.
    if (context.state === 'suspended') await context.resume()

    const blobUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
    )
    await context.audioWorklet.addModule(blobUrl)
    URL.revokeObjectURL(blobUrl)
  } catch (err) {
    track?.stop()
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      `音频启动失败，换个浏览器或设备再试：${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  let source: MediaStreamAudioSourceNode | null = null
  let node: AudioWorkletNode | null = null
  let silence: GainNode | null = null
  try {
    source = context.createMediaStreamSource(stream)
    // One output, not zero. A node with `numberOfOutputs: 0` cannot be connected
    // at all (`connect` throws "output index (0) exceeds number of outputs (0)"),
    // and without a downstream path the audio graph would never pull it, so
    // `process()` would never run. The processor writes nothing into its output,
    // so that output is silent by construction — the zero-gain node after it is
    // belt and braces, and nothing is ever routed to the speakers.
    node = new AudioWorkletNode(context, 'rc-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { chunkMs: 100 },
    })
    silence = context.createGain()
    silence.gain.value = 0
    source.connect(node)
    node.connect(silence)
    silence.connect(context.destination)
  } catch (err) {
    // Before this, a failure here left the microphone open and the audio context
    // running with nothing holding them: the user saw an error, and their mic
    // stayed hot.
    try {
      node?.disconnect()
      source?.disconnect()
      silence?.disconnect()
    } catch {
      /* nothing was connected */
    }
    track?.stop()
    stream.getTracks().forEach((t) => t.stop())
    await context.close().catch(() => undefined)
    throw new Error(
      `音频启动失败，换个浏览器或设备再试：${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const chunk = event.data
    options.onChunk(chunk, context.sampleRate)
    options.onLevel?.(levelOf(chunk))
  }

  info('capture', '麦克风已开启', {
    sampleRate: context.sampleRate,
    channelCount: settings.channelCount,
    constraintsHonoured,
  })

  return {
    sampleRate: context.sampleRate,
    constraintsHonoured,
    settings,
    stop: async () => {
      if (node) node.port.onmessage = null
      try {
        node?.disconnect()
        source?.disconnect()
        silence?.disconnect()
      } catch {
        /* already torn down */
      }
      track?.stop()
      stream.getTracks().forEach((t) => t.stop())
      await context.close().catch(() => undefined)
      info('capture', '麦克风已关闭')
    },
  }
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
    const onAbort = () => reject(new DOMException('启动被取消', 'AbortError'))
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

function levelOf(chunk: Float32Array): number {
  let peak = 0
  for (let i = 0; i < chunk.length; i += 8) {
    const v = Math.abs(chunk[i] ?? 0)
    if (v > peak) peak = v
  }
  return peak
}
