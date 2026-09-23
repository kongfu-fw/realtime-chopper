import type { AsrLoadProgress, Lang, LogLevel, SpeechSegment } from '../types'
import type { RecordingInfo } from '../audio/recorder'
import type { MtConfig, MtItem, MtItemResult } from '../mt/client'
import type { SegmenterOptions } from '../asr/segmenter'
import type { DevicePlan } from '../asr/moonshine'
import { describeModuleError, moduleFor, moduleLangFor, type ModuleLang } from '../asr/models'
import { debug, error as logError, info, warn } from '../log/store'

/**
 * Main-thread clients for the three pipeline workers.
 *
 * Each worker gets a thin typed wrapper so the session code reads like the
 * pipeline it implements. Worker crashes are caught here rather than being
 * allowed to kill the pipeline silently: a dead recogniser worker must surface
 * in the log drawer, not as a session that simply stops producing text.
 */

/**
 * Worker crashes are surfaced rather than swallowed: a dead recogniser has to
 * show up in the log drawer instead of looking like a session that quietly
 * stopped producing text.
 *
 * Note the instantiation style: `new Worker(new URL('…', import.meta.url))` is
 * the only form the bundler can resolve statically. Computing the URL first and
 * passing a string silently produces a build with no worker chunks at all.
 */
function guard(worker: Worker, name: string): Worker {
  worker.onerror = (event) => {
    logError('session', `${name} 崩溃了`, { message: event.message, filename: event.filename })
  }
  return worker
}

/**
 * Two recognition workers exist because their runtimes are loaded in mutually
 * exclusive ways: transformers.js (English, Korean) goes through `import()`, so
 * it must live in a module worker, while sherpa-onnx's published runtime is a
 * pair of classic scripts that install globals, so the Chinese engine lives in
 * `static/zh-asr.worker.js`.
 *
 * That URL is a plain string built from BASE_URL on purpose: writing
 * `new URL('…', import.meta.url)` here would make the bundler treat the file as
 * a worker chunk and emit it as a module, and a module worker has no
 * `importScripts` — which is the one API the Chinese runtime needs.
 */
function createAsrWorker(lang: Lang): Worker {
  if (moduleFor(lang).engine === 'sherpa-zh') {
    return new Worker(`${import.meta.env.BASE_URL}zh-asr.worker.js`)
  }
  return new Worker(new URL('../../workers/asr.worker.ts', import.meta.url), {
    type: 'module',
    name: 'asr',
  })
}

type RecordResult =
  | { file: File | Blob | null }
  | { buffer: ArrayBuffer | null }
  | { samples: Float32Array | null }
  | { ok: true }

/** Shape of a `record-result`, before it is narrowed by the caller. */
interface RecordResultMessage {
  type: 'record-result'
  requestId: number
  file?: File | Blob | null
  buffer?: ArrayBuffer | null
  samples?: Float32Array | null
}

export class VadWorkerClient {
  private readonly worker: Worker
  onSegment: ((segment: SpeechSegment) => void) | null = null
  onLevel: ((level: number) => void) | null = null
  onRecording: ((info: RecordingInfo) => void) | null = null

  private nextRequestId = 1
  private readonly waits = new Map<number, (result: RecordResult) => void>()

  constructor() {
    this.worker = guard(
      new Worker(new URL('../../workers/vad.worker.ts', import.meta.url), {
        type: 'module',
        name: 'vad',
      }),
      'vad',
    )
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'segment'; id: number; startMs: number; endMs: number; samples: Float32Array }
        | { type: 'level'; level: number }
        | { type: 'recording'; info: RecordingInfo }
        | RecordResultMessage
      switch (msg.type) {
        case 'segment':
          this.onSegment?.({
            id: msg.id,
            startMs: msg.startMs,
            endMs: msg.endMs,
            samples: msg.samples,
          })
          break
        case 'level':
          this.onLevel?.(msg.level)
          break
        case 'recording':
          this.onRecording?.(msg.info)
          break
        case 'record-result': {
          const wait = this.waits.get(msg.requestId)
          this.waits.delete(msg.requestId)
          if (!wait) break
          if (msg.file !== undefined) wait({ file: msg.file })
          else if (msg.buffer !== undefined) wait({ buffer: msg.buffer })
          else if (msg.samples !== undefined) wait({ samples: msg.samples })
          else wait({ ok: true })
          break
        }
      }
    }
  }

  configure(options: Partial<SegmenterOptions>): void {
    this.worker.postMessage({ type: 'configure', options })
  }

  /** Cap on how long a recording may grow, in minutes. */
  setRecordingLimit(minutes: number): void {
    this.worker.postMessage({ type: 'record-limit', minutes })
  }

  /** Picks up a recording left behind by an earlier page load. */
  attachRecording(): void {
    this.worker.postMessage({ type: 'record-attach' })
  }

  startRecording(): void {
    this.worker.postMessage({ type: 'record-start' })
  }

  /** Resolves once the file's header covers the last sample written. */
  async stopRecording(): Promise<void> {
    await this.request({ type: 'record-stop' }, { ok: true })
  }

  async clearRecording(): Promise<void> {
    await this.request({ type: 'record-clear' }, { ok: true })
  }

  /**
   * Post and wait for the worker's answer.
   *
   * Bounded, and settles every waiter on dispose: a worker that has been torn
   * down (the normal state after a session stops) can no longer answer, and a
   * promise that waits forever would leave "export the recording" spinning.
   */
  private request(payload: Record<string, unknown>, fallback: RecordResult): Promise<RecordResult> {
    const requestId = this.nextRequestId++
    return new Promise((resolve) => {
      const settle = (result: RecordResult) => {
        this.waits.delete(requestId)
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => settle(fallback), 8000)
      this.waits.set(requestId, settle)
      this.worker.postMessage({ ...payload, requestId })
    })
  }

  /** Settles everything still in flight; called when the worker goes away. */
  private settleAll(result: RecordResult): void {
    for (const [, wait] of this.waits) wait(result)
    this.waits.clear()
  }

  /** The whole session as a WAV — disk-backed when OPFS is in use. */
  async recordingFile(): Promise<File | Blob | null> {
    const result = await this.request({ type: 'record-file' }, { file: null })
    return 'file' in result ? result.file : null
  }

  async recordingWav(startMs: number, endMs: number): Promise<Blob | null> {
    const result = await this.request({ type: 'record-slice-wav', startMs, endMs }, { buffer: null })
    if (!('buffer' in result) || !result.buffer) return null
    return new Blob([result.buffer], { type: 'audio/wav' })
  }

  async recordingSamples(startMs: number, endMs: number): Promise<Float32Array | null> {
    const result = await this.request({ type: 'record-slice-pcm', startMs, endMs }, { samples: null })
    return 'samples' in result ? result.samples : null
  }

  dispose(): void {
    this.settleAll({ ok: true })
    this.worker.terminate()
  }

  /** Transfers the buffer: the caller has no further use for this chunk. */
  push(samples: Float32Array, rate: number): void {
    this.worker.postMessage({ type: 'chunk', samples, rate }, [samples.buffer])
  }

  flush(): void {
    this.worker.postMessage({ type: 'flush' })
  }

  reset(): void {
    this.worker.postMessage({ type: 'reset' })
  }
}

export class AsrWorkerClient {
  /**
   * The module this client runs.
   *
   * Two languages can share one module (Korean runs on the Chinese one), and the
   * worker only needs rebuilding when the *module* changes — rebuilding it for a
   * language switch would throw away a model that answers both. Callers compare
   * this, never the language they asked for: after a zh → ko switch the resident
   * client is still the one the request for `zh` created, and that is correct.
   */
  readonly moduleLang: ModuleLang
  private readonly worker: Worker
  onResult:
    | ((result: {
        id: number
        text: string
        rawText: string
        engine: string
        inferMs: number
        startMs: number
        endMs: number
        durationMs: number
      }) => void)
    | null = null
  onProgress: ((progress: AsrLoadProgress) => void) | null = null
  onLoaded: ((info: { device?: string; dtype?: string; reason?: string }) => void) | null = null
  onFailed: ((where: string, message: string, id?: number) => void) | null = null

  /**
   * The in-flight load, if any. Without this the caller has no way to tell
   * "the download finished" from "the worker was asked to start downloading" —
   * which is the difference between a real install dialog and one that marks a
   * 235 MB model as installed the instant you click.
   */
  private pendingLoad: { lang: Lang; settle: (err?: Error) => void } | null = null

  constructor(lang: Lang) {
    this.moduleLang = moduleLangFor(lang)
    this.worker = guard(createAsrWorker(lang), 'asr')
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown> & { type: string }
      switch (msg.type) {
        case 'loaded':
          this.pendingLoad?.settle()
          this.pendingLoad = null
          this.onLoaded?.({
            device: msg.device as string | undefined,
            dtype: msg.dtype as string | undefined,
            reason: msg.reason as string | undefined,
          })
          break
        case 'load-progress':
          this.onProgress?.({
            status: String(msg.status ?? ''),
            file: msg.file as string | undefined,
            progress: msg.progress as number | undefined,
            loaded: msg.loaded as number | undefined,
            total: msg.total as number | undefined,
          })
          break
        // Breadcrumbs from inside the classic worker (runtime init, recogniser
        // construction, freeing the model file, what `locateFile` was asked for).
        // They used to be posted and then dropped on the floor here, which is why
        // a failure that only ever happens on a phone — where there is no console
        // to read — arrived with nothing around it to explain it.
        case 'log':
          forwardAsrLog(String(msg.level ?? 'info') as LogLevel, String(msg.message ?? ''))
          break
        // The older spelling of the same thing: a worker script can stay in the
        // HTTP cache across a reload, and a breadcrumb that only exists in one of
        // the two versions is worse than no breadcrumb at all.
        case 'debug':
          debug('asr', String(msg.message ?? ''))
          break
        case 'result':
          this.onResult?.({
            id: msg.id as number,
            text: String(msg.text ?? ''),
            rawText: String(msg.rawText ?? ''),
            engine: String(msg.engine ?? ''),
            inferMs: Number(msg.inferMs ?? 0),
            startMs: Number(msg.startMs ?? 0),
            endMs: Number(msg.endMs ?? 0),
            durationMs: Number(msg.durationMs ?? 0),
          })
          break
        case 'error':
          if (msg.where === 'load' && this.pendingLoad) {
            // The raw message goes to the log (onFailed below); the rejection the
            // install dialog shows is humanised.
            this.pendingLoad.settle(new Error(describeModuleError(String(msg.message ?? ''))))
            this.pendingLoad = null
          }
          this.onFailed?.(
            String(msg.where ?? 'unknown'),
            String(msg.message ?? '未知错误'),
            msg.id as number | undefined,
          )
          break
      }
    }
  }

  /**
   * Resolves once the module is actually resident and usable — i.e. after the
   * bytes have been downloaded, not after the request was sent. Rejects when the
   * worker reports a load failure, and only then can an install be recorded.
   */
  load(lang: Lang, plan: DevicePlan | null): Promise<void> {
    // A second request supersedes the first; the old one must not hang forever.
    this.pendingLoad?.settle(new Error('已被新的加载请求取代'))
    const done = new Promise<void>((resolve, reject) => {
      this.pendingLoad = {
        lang,
        settle: (err) => (err ? reject(err) : resolve()),
      }
    })
    // The plan travels with the request: the verdict behind it lives in
    // `localStorage`, which a worker does not have. See `DevicePlan`.
    this.worker.postMessage({ type: 'load', lang, plan })
    return done
  }

  recognize(id: number, samples: Float32Array, startMs: number, endMs: number): void {
    // Deliberately structured-cloned rather than transferred: the same samples
    // may still be needed for the per-utterance audio the user can replay.
    this.worker.postMessage({ type: 'recognize', id, samples, startMs, endMs })
  }

  dispose(): void {
    this.pendingLoad?.settle(new Error('识别模块加载已取消'))
    this.pendingLoad = null
    this.worker.postMessage({ type: 'dispose' })
    this.worker.terminate()
  }
}

export class MtWorkerClient {
  private readonly worker: Worker
  onResult: ((result: MtItemResult) => void) | null = null
  private pendingOnce = new Map<
    number,
    { resolve: (value: { texts: string[]; provider: string }) => void; reject: (err: Error) => void }
  >()
  private nextRequestId = 1

  constructor() {
    this.worker = guard(
      new Worker(new URL('../../workers/mt.worker.ts', import.meta.url), {
        type: 'module',
        name: 'mt',
      }),
      'mt',
    )
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown> & { type: string }
      switch (msg.type) {
        case 'result':
          this.onResult?.({
            id: msg.id as number,
            text: (msg.text as string | null) ?? null,
            provider: String(msg.provider ?? ''),
            cached: Boolean(msg.cached),
            error: msg.error as string | undefined,
            ms: msg.ms as number | undefined,
          })
          break
        case 'log':
          forwardWorkerLog(
            msg.level as LogLevel,
            String(msg.message ?? ''),
            msg.detail,
          )
          break
        case 'once-result': {
          const request = this.pendingOnce.get(msg.requestId as number)
          if (!request) break
          this.pendingOnce.delete(msg.requestId as number)
          if (msg.error) request.reject(new Error(String(msg.error)))
          else request.resolve({ texts: (msg.texts as string[]) ?? [], provider: String(msg.provider ?? '') })
          break
        }
        case 'stats':
          info('translate', '翻译缓存状态', {
            cacheSize: msg.cacheSize,
            queued: msg.queued,
          })
          break
      }
    }
  }

  configure(config: MtConfig): void {
    this.worker.postMessage({ type: 'configure', config })
  }

  translate(items: MtItem[]): void {
    this.worker.postMessage({ type: 'translate', items })
  }

  translateOnce(texts: string[], overrides?: Partial<MtConfig>): Promise<{ texts: string[]; provider: string }> {
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      this.pendingOnce.set(requestId, { resolve, reject })
      this.worker.postMessage({ type: 'once', requestId, texts, overrides })
      setTimeout(() => {
        if (this.pendingOnce.delete(requestId)) reject(new Error('翻译自检超时'))
      }, 20000)
    })
  }

  stats(): void {
    this.worker.postMessage({ type: 'stats' })
  }

  clearCache(): void {
    this.worker.postMessage({ type: 'clear-cache' })
  }

  dispose(): void {
    this.worker.terminate()
  }
}

function forwardAsrLog(level: LogLevel, message: string): void {
  if (level === 'error') logError('asr', message)
  else if (level === 'warn') warn('asr', message)
  else if (level === 'debug') debug('asr', message)
  else info('asr', message)
}

function forwardWorkerLog(level: LogLevel, message: string, detail?: unknown): void {
  if (level === 'error') logError('translate', message, detail)
  else if (level === 'warn') warn('translate', message, detail)
  else if (level === 'debug') debug('translate', message, detail)
  else info('translate', message, detail)
}
