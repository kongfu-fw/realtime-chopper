import type { AsrLoadProgress, AsrResult, Lang, ModuleId } from '../types'
import { t } from '../i18n/index.ts'
import { moduleSpec } from './models'
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
 *
 * One decode parameter is set by hand rather than left to the library: the output
 * token budget, taken from this model's paper instead of from the library's
 * whole-seconds approximation of it (`TOKENS_PER_SECOND`).
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
      return info.file ? t('下载 {file}', { file: shortName(info.file) }) : t('下载识别模块')
    case 'progress':
    case 'progress_total':
      return info.file ? t('下载 {file}', { file: shortName(info.file) }) : t('下载识别模块')
    case 'ready':
      return t('准备识别模块')
    case 'done':
      return t('装配识别模块')
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

/** Every segment in this app is already 16 kHz mono (`SpeechSegment`). */
const SAMPLE_RATE = 16000

/**
 * How many output tokens a segment is allowed, from the model's own paper.
 *
 * Moonshine repeats itself on short utterances, so its authors' evaluation uses
 * "a heuristic limit of 6 output tokens per second of audio to avoid repeated
 * output sequences" (arXiv:2410.15608v2). transformers.js applies a version of
 * that rule — `Math.floor(audio.length / rate) * 6`, i.e. **whole seconds only** —
 * and for the segments this app actually produces that is measurably too tight:
 * the VAD emits from 600 ms up (`minSegMs`), so anything under a second gets a
 * budget of 0, which `generate` treats as "one token".
 *
 * Measured on this repo (Moonshine Base q8 on wasm, 0.6–1.9 s slices of a known
 * 11 s speech sample, real audio):
 *
 *   0.85 s in  → library budget 0  → "And"          (the rest of the words are lost)
 *              → our budget 5      → "And so"
 *   1.10 s in  → library budget 6  → "And so my"     (identical either way)
 *   1.90 s in  → library budget 6  → "And so my fellow Merr"
 *              → our budget 11     → "…Merrimeters and so my"
 *
 * So the trade is explicit and worth keeping: the paper's rate, rounded rather
 * than floored, stops sub-second utterances from being cut to their first word —
 * and lets a genuine repetition run ~4 tokens longer before the cap bites it. The
 * cap exists to *bound* looping (the paper keeps the same limit on datasets where
 * WER is still >100%), not to make every loop short, so under-budgeting real words
 * is the worse of the two errors. Do not "fix" this back to `floor` — a segment
 * shorter than a second is normal here, not an edge case.
 *
 * Passing the budget in the call options works because the ASR pipeline spreads
 * caller options *after* its own (`{ max_new_tokens, ...kwargs, ...inputs }` in
 * `_call_moonshine`), so ours wins. A future transformers.js could reorder that;
 * if it does, this silently reverts to the floor-based rule above — which is why
 * the numbers are written down here instead of only in the commit.
 */
const TOKENS_PER_SECOND = 6

/** The paper's per-second budget for one clip. `1` is a floor, nothing more. */
function tokenBudget(samples: number): number {
  return Math.max(1, Math.round((samples / SAMPLE_RATE) * TOKENS_PER_SECOND))
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
    fallback: primary.device === 'webgpu' ? cpu(t('显卡不可用，回退到 CPU')) : null,
  })
  if (preference === 'wasm') return plan(cpu(t('用户指定用 CPU')))
  if (preference === 'webgpu') {
    // An explicit choice is an instruction, not a hint: it is tried even if this
    // device failed before (a driver update is exactly how that gets fixed).
    return plan(webgpuAvailable() ? gpu(t('用户指定用显卡')) : cpu(t('本机没有 WebGPU，改用 CPU')))
  }
  if (!webgpuAvailable()) return plan(cpu(t('本机没有 WebGPU，改用 CPU')))
  const blocked = gpuBlockReason()
  if (blocked) {
    // Two different reasons arrive here, and both end the same way. Either this
    // platform's WebGPU is fatal rather than merely slow (Apple's mobile WebKit —
    // see `device.ts`), or the GPU attempt did not *throw* last time — it hung or
    // took the page down — which is exactly why the verdict has to be remembered:
    // nothing was catchable at the time.
    return plan(cpu(t('{reason}，改用 CPU', { reason: blocked })))
  }
  return plan(gpu(t('使用显卡加速')))
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
  /** The module whose bytes this engine loaded — what a caller must compare. */
  readonly module: ModuleId
  /** The language it transcribes, taken from the module rather than passed twice. */
  readonly lang: Lang
  private pipe: AsrPipeline | null = null
  private actual: DeviceChoice | null = null

  constructor(
    module: ModuleId,
    /**
     * The device decision made *before this worker was asked to load*; see
     * `DevicePlan`. Passed in rather than recomputed here because only the main
     * thread can read the verdict and write the note a killed page leaves behind.
     */
    private readonly plan: DevicePlan,
  ) {
    this.module = module
    this.lang = moduleSpec(module).lang
  }

  get device(): DeviceChoice | null {
    return this.actual
  }

  get ready(): boolean {
    return this.pipe !== null
  }

  async load(onProgress?: ProgressCallback): Promise<DeviceChoice> {
    if (this.pipe && this.actual) return this.actual
    const spec = moduleSpec(this.module)
    if (!spec.hfModelId) throw new Error(t('没有为 {module} 配置 Moonshine 模型', { module: this.module }))

    const { env, pipeline } = await import('@huggingface/transformers')
    // Load from the Hugging Face CDN and keep the result in the browser cache;
    // there is no bundler-copied model directory in a static deployment.
    env.allowLocalModels = false
    env.useBrowserCache = true
    if (env.backends?.onnx?.wasm) {
      // Threads need SharedArrayBuffer, which needs COOP/COEP headers — the pair
      // `vite.config.ts` and `deploy/nginx.conf` now send, so this is 4 workers
      // instead of 1 on a desktop (measured 1.8× on a 7.4 s clip). It stays a
      // capability check rather than a constant because those headers belong to
      // the deployment, not the build: the same bundle served without them
      // reports `crossOriginIsolated === false`, and the honest answer there is
      // one thread, not a throw on a missing `SharedArrayBuffer`.
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
              t('显卡加速没能在 {sec} 秒内启动，改用 CPU', {
                sec: Math.round(WEBGPU_ATTEMPT_TIMEOUT_MS / 1000),
              }),
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
    throw lastError instanceof Error ? lastError : new Error(t('Moonshine 模型加载失败'))
  }

  async recognize(samples: Float32Array): Promise<AsrResult> {
    if (!this.pipe) throw new Error(t('识别模块还没准备好'))
    const started = performance.now()
    // `max_new_tokens` is ours, not the library's default: see `TOKENS_PER_SECOND`.
    const output = await this.pipe(samples, {
      sampling_rate: SAMPLE_RATE,
      max_new_tokens: tokenBudget(samples.length),
    })
    const text = Array.isArray(output) ? (output[0]?.text ?? '') : (output.text ?? '')
    return {
      text: text.trim(),
      rawText: text,
      engine: `moonshine-${this.module}${this.actual ? `-${this.actual.device}` : ''}`,
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
