import type { AsrLoadProgress, AsrResult, Lang } from '../types'
import { moduleFor } from './models'
import {
  gpuBlockReason,
  looksLikeDeviceFailure,
  rememberGpuFailure,
  rememberGpuSuccess,
  webgpuAvailable,
} from './device'

/**
 * Moonshine via transformers.js (decision: hybrid runtime).
 *
 * transformers.js brings the Moonshine feature extractor with it — no Fbank /
 * CMVN code of our own — and it is the only one of our two runtimes that can
 * use WebGPU, so this is the path the plan's "WebGPU first, WASM fallback"
 * decision actually applies to. sherpa-onnx's WASM build is CPU-only.
 */

export interface LoadProgress {
  file?: string
  /** transformers.js: a percentage 0-100 for the file in flight. */
  progress?: number
  loaded?: number
  total?: number
  status: string
}

type ProgressCallback = (progress: LoadProgress) => void

/**
 * Converts transformers.js progress reports into the app's progress contract
 * (a 0-1 fraction over the whole module) and keeps it monotonic.
 *
 * Two things have to be undone here. The library reports `progress` as a
 * *percentage* (`loaded / total * 100`), and its plain `progress` events describe
 * whichever file is in flight — with the encoder and decoder downloading in
 * parallel that number ricochets between 0 and 100. The library separately emits
 * `progress_total`, whose `loaded`/`total` are summed over every file it knows
 * about, which is the aggregate we actually want.
 */
function toFraction(info: LoadProgress, since: { value: number }): AsrLoadProgress {
  const loaded = typeof info.loaded === 'number' ? info.loaded : undefined
  const total = typeof info.total === 'number' ? info.total : undefined
  const hasBytes = loaded !== undefined && total !== undefined && total > 0
  // `progress_total` is aggregated by the library; a bare `progress` event is
  // per-file and must not drive the bar.
  const reliable = hasBytes && info.status !== 'progress'
  let fraction: number | undefined
  if (reliable) fraction = loaded! / total!
  else if (typeof info.progress === 'number') fraction = info.progress / 100
  if (fraction !== undefined) {
    // Downloads never un-download: a bar that moves backwards reads as a bug even
    // when the underlying number is "more accurate".
    fraction = Math.max(since.value, Math.min(1, fraction))
    since.value = fraction
  }
  return {
    status: statusText(info),
    ...(info.file ? { file: info.file } : {}),
    ...(fraction !== undefined ? { progress: fraction } : {}),
    ...(loaded !== undefined ? { loaded } : {}),
    ...(total !== undefined ? { total } : {}),
  }
}

function statusText(info: LoadProgress): string {
  switch (info.status) {
    case 'initiate':
    case 'download':
      return info.file ? `下载 ${shortName(info.file)}` : '下载识别模块'
    case 'progress':
    case 'progress_total':
      return info.file ? `下载 ${shortName(info.file)}` : '下载识别模块'
    case 'ready':
      return '准备识别模块'
    case 'done':
      return '装配识别模块'
    default:
      return String(info.status)
  }
}

/** Keeps the dialog readable: full repo paths are for the log, not the bar. */
function shortName(file: string): string {
  const parts = file.split('/')
  return parts[parts.length - 1] || file
}

interface AsrPipelineOutput {
  text?: string
}

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<AsrPipelineOutput | AsrPipelineOutput[]>

export interface DeviceChoice {
  device: 'webgpu' | 'wasm'
  dtype: 'fp32' | 'q8' | 'q4'
  reason: string
}

/**
 * The whole plan for one load: what to try, and what to try when that refuses.
 *
 * Both choices are made on the main thread, in one place, and travel to the worker
 * with the load request. That is not tidiness: a worker has no `localStorage`
 * (where the GPU verdict lives), so one that recomputed this decision would see
 * "nothing is known about this device" and pick WebGPU — while the log line and
 * the crash note said CPU. One decision, made on the side that writes the note.
 */
export interface DevicePlan {
  primary: DeviceChoice
  /**
   * The CPU retry for a GPU attempt, or `null` when there is nothing to retry on.
   *
   * The retry itself is not optional — incomplete operator sets are normal on new
   * drivers, and it re-downloads nothing — so its dtype is decided here too,
   * instead of being derived a second time inside the worker.
   */
  fallback: DeviceChoice | null
}

export function planDevice(preference: 'auto' | 'webgpu' | 'wasm', precision: 'high' | 'eco'): DevicePlan {
  const wasmDtype = precision === 'eco' ? 'q4' : 'q8'
  const cpu = (reason: string): DeviceChoice => ({ device: 'wasm', dtype: wasmDtype, reason })
  const gpu = (reason: string): DeviceChoice => ({
    device: 'webgpu',
    dtype: precision === 'eco' ? 'q4' : 'fp32',
    reason,
  })
  const plan = (primary: DeviceChoice): DevicePlan => ({
    primary,
    fallback: primary.device === 'webgpu' ? cpu('显卡不可用，回退到 CPU') : null,
  })
  if (preference === 'wasm') return plan(cpu('用户指定用 CPU'))
  if (preference === 'webgpu') {
    // An explicit choice is an instruction, not a hint: it is tried even if this
    // device failed before (a driver update is exactly how that gets fixed).
    return plan(webgpuAvailable() ? gpu('用户指定用显卡') : cpu('本机没有 WebGPU，改用 CPU'))
  }
  if (!webgpuAvailable()) return plan(cpu('本机没有 WebGPU，改用 CPU'))
  const blocked = gpuBlockReason()
  if (blocked) {
    // Two different reasons arrive here, and both end the same way. Either this
    // platform's WebGPU is fatal rather than merely slow (Apple's mobile WebKit —
    // see `device.ts`), or the GPU attempt did not *throw* last time — it hung or
    // took the page down — which is exactly why the verdict has to be remembered:
    // nothing was catchable at the time.
    return plan(cpu(`${blocked}，改用 CPU`))
  }
  return plan(gpu('使用显卡加速'))
}

/**
 * How long a WebGPU attempt gets before the WASM fallback takes over.
 *
 * The failure this exists for is a hang, not a throw: on a browser whose WebGPU
 * support is brand new, `requestDevice()`/session creation can simply never
 * settle, and a `try/catch` around it waits forever. Without this, that hang ate
 * the whole 240 s load budget and then reported a *network* problem — the fallback
 * that would have worked never got a turn.
 *
 * Generous on purpose: this must never fire during a legitimate first download of
 * the 62 MB module (the retry would then re-download), only on a genuinely stuck
 * device.
 */
const WEBGPU_ATTEMPT_TIMEOUT_MS = 90_000

/**
 * Races one attempt against a deadline.
 *
 * If the abandoned attempt ever does land, its session is disposed: an ONNX
 * session nobody is holding would otherwise keep a second copy of the model in
 * memory for the rest of the session.
 */
function withAttemptTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
      void work
        .then((value) => (value as { dispose?: () => unknown } | null)?.dispose?.())
        .catch(() => undefined)
    }, ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

export class MoonshineEngine {
  readonly id = 'moonshine'
  private pipe: AsrPipeline | null = null
  private actual: DeviceChoice | null = null

  constructor(
    readonly lang: Lang,
    /**
     * The device decision made *before this worker was asked to load*; see
     * `DevicePlan`. Passed in rather than recomputed here because only the main
     * thread can read the verdict and write the note a killed page leaves behind.
     */
    private readonly plan: DevicePlan,
  ) {}

  get device(): DeviceChoice | null {
    return this.actual
  }

  get ready(): boolean {
    return this.pipe !== null
  }

  async load(onProgress?: ProgressCallback): Promise<DeviceChoice> {
    if (this.pipe && this.actual) return this.actual
    const spec = moduleFor(this.lang)
    if (!spec.hfModelId) throw new Error(`没有为 ${this.lang} 配置 Moonshine 模型`)

    const { env, pipeline } = await import('@huggingface/transformers')
    // Load from the Hugging Face CDN and keep the result in the browser cache;
    // there is no bundler-copied model directory in a static deployment.
    env.allowLocalModels = false
    env.useBrowserCache = true
    if (env.backends?.onnx?.wasm) {
      // Threads need SharedArrayBuffer, which needs COOP/COEP headers. Those
      // headers would also require every third-party response we consume to
      // send CORP, so we stay single-threaded instead.
      env.backends.onnx.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
    }

    const attempts = this.plan.fallback ? [this.plan.primary, this.plan.fallback] : [this.plan.primary]

    let lastError: unknown
    const since = { value: 0 }
    for (const attempt of attempts) {
      try {
        const work = pipeline('automatic-speech-recognition', spec.hfModelId, {
          device: attempt.device,
          dtype: attempt.dtype,
          progress_callback: (p: LoadProgress) => {
            // A failed WebGPU attempt retries on WASM, which re-downloads nothing
            // but re-reports from the start; `since` keeps the bar honest across
            // both attempts instead of snapping back to zero.
            onProgress?.(toFraction(p, since))
          },
        }) as Promise<AsrPipeline>
        const settled = attempt.device === 'webgpu'
          ? await withAttemptTimeout(
              work,
              WEBGPU_ATTEMPT_TIMEOUT_MS,
              `显卡加速没能在 ${Math.round(WEBGPU_ATTEMPT_TIMEOUT_MS / 1000)} 秒内启动，改用 CPU`,
            )
          : await work
        this.pipe = settled
        this.actual = attempt
        if (attempt.device === 'webgpu') rememberGpuSuccess()
        return attempt
      } catch (err) {
        lastError = err
        // A WebGPU failure is expected on some drivers and on Safari builds
        // where the operator set is incomplete; the WASM retry is not optional.
        if (attempt.device === 'webgpu') {
          const message = err instanceof Error ? err.message : String(err)
          // Only a device failure is worth remembering — a download that died
          // halfway says nothing about the GPU, and `since` tells the two apart.
          if (since.value > 0.99 && looksLikeDeviceFailure(message)) {
            rememberGpuFailure(message.slice(0, 140))
          }
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Moonshine 模型加载失败')
  }

  async recognize(samples: Float32Array): Promise<AsrResult> {
    if (!this.pipe) throw new Error('识别模块还没准备好')
    const started = performance.now()
    const output = await this.pipe(samples, { sampling_rate: 16000 })
    const text = Array.isArray(output) ? (output[0]?.text ?? '') : (output.text ?? '')
    return {
      text: text.trim(),
      rawText: text,
      engine: `moonshine-${this.lang}${this.actual ? `-${this.actual.device}` : ''}`,
      inferMs: Math.round(performance.now() - started),
    }
  }

  dispose(): void {
    const pipe = this.pipe as unknown as { dispose?: () => Promise<void> } | null
    this.pipe = null
    this.actual = null
    void pipe?.dispose?.().catch(() => undefined)
  }
}
