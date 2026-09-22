import type { AsrLoadProgress, AsrResult, Lang } from '../types'
import { moduleFor } from './models'

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

export function chooseDevice(preference: 'auto' | 'webgpu' | 'wasm', precision: 'high' | 'eco'): DeviceChoice {
  const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  if (preference === 'wasm') {
    return { device: 'wasm', dtype: precision === 'eco' ? 'q4' : 'q8', reason: '用户指定用 CPU' }
  }
  if (preference === 'webgpu' && !hasWebGpu) {
    return { device: 'wasm', dtype: precision === 'eco' ? 'q4' : 'q8', reason: '本机没有 WebGPU，改用 CPU' }
  }
  if (hasWebGpu) {
    return { device: 'webgpu', dtype: precision === 'eco' ? 'q4' : 'fp32', reason: '使用显卡加速' }
  }
  return { device: 'wasm', dtype: precision === 'eco' ? 'q4' : 'q8', reason: '本机没有 WebGPU，改用 CPU' }
}

export class MoonshineEngine {
  readonly id = 'moonshine'
  private pipe: AsrPipeline | null = null
  private actual: DeviceChoice | null = null

  constructor(
    readonly lang: Lang,
    private readonly preference: 'auto' | 'webgpu' | 'wasm',
    private readonly precision: 'high' | 'eco',
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

    const choice = chooseDevice(this.preference, this.precision)
    const attempts: DeviceChoice[] = choice.device === 'webgpu'
      ? [choice, { device: 'wasm', dtype: this.precision === 'eco' ? 'q4' : 'q8', reason: '显卡不可用，回退到 CPU' }]
      : [choice]

    let lastError: unknown
    const since = { value: 0 }
    for (const attempt of attempts) {
      try {
        this.pipe = (await pipeline('automatic-speech-recognition', spec.hfModelId, {
          device: attempt.device,
          dtype: attempt.dtype,
          progress_callback: (p: LoadProgress) => {
            // A failed WebGPU attempt retries on WASM, which re-downloads nothing
            // but re-reports from the start; `since` keeps the bar honest across
            // both attempts instead of snapping back to zero.
            onProgress?.(toFraction(p, since))
          },
        })) as AsrPipeline
        this.actual = attempt
        return attempt
      } catch (err) {
        lastError = err
        // A WebGPU failure is expected on some drivers and on Safari builds
        // where the operator set is incomplete; the WASM retry is not optional.
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
