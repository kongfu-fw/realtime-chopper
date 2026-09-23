import { get, writable, type Writable } from 'svelte/store'
import type {
  Lang,
  Line,
  QueueSnapshot,
  SessionState,
  SpeechSegment,
  AsrLoadProgress,
} from '../types'
import type { Settings } from '../store/settings'
import { getSettings } from '../store/settings'
import { asrCrashCount, clearAsrAttempt, forgetAsrCrashes, markAsrAttempt } from '../boot-guard'
import { startCapture, type CaptureHandle } from '../audio/capture'
import {
  deleteRecordingFile,
  pcmSliceFromBlob,
  wavSliceFromBlob,
  type RecordingInfo,
} from '../audio/recorder'
import { OrderedQueue, pump } from './queues'
import { RateController } from './rate'
import { estimateLagSeconds, estimateSpeechSeconds } from './latency'
import { AsrWorkerClient, MtWorkerClient, VadWorkerClient } from '../workers'
import { describeModuleError, MODULE_NAME, moduleFor, moduleLangFor, type ModuleLang } from '../asr/models'
import { planDevice } from '../asr/moonshine'
import { SpeechEngine, speechSupported } from '../tts/speech'
import { resolveWorkingProvider } from '../mt/probe'
import type { MtConfig, MtItemResult } from '../mt/client'
import { debug, error as logError, info, warn } from '../log/store'

/**
 * Cancellation arrives as an AbortError, either as a DOMException from the
 * signal itself or as an error carrying that name from a layer above it.
 */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * A stalled download must not leave the UI spinning forever. The cap is generous
 * on purpose: the Chinese module is ~235 MB, and a phone on mobile data is
 * legitimately allowed to take minutes.
 */
const MODEL_LOAD_TIMEOUT_MS = 240_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
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
import type { MtProviderId } from '../mt/providers'

/**
 * Session orchestrator.
 *
 * Owns the four ordered queues and every transition between them:
 *
 *   microphone → vad(16k mono) → segQ → asr → line → mtQ → translate → readQ → speech
 *
 * Ordering rules that the rest of the design depends on:
 *  - `segQ` is consumed strictly serially, so utterances come out in the order
 *    they were spoken even though recognition itself is async.
 *  - A line is only handed to the reader when every earlier line has a settled
 *    translation. Without that gate a single slow sentence would let later
 *    sentences overtake it and the read-out would scramble.
 *  - Nothing is ever dropped automatically. A translation that fails *does*
 *    advance the gate — a failed sentence has nothing to read, and blocking the
 *    pipeline on it forever would be worse than skipping silence.
 */

const MAX_LINES = 2000

export interface ModelState {
  status: string
  progress?: number
  loadedBytes?: number
  totalBytes?: number
}

/**
 * The last recognition-module failure, kept in full.
 *
 * `message` is the sentence a user should read; `raw` is what the runtime actually
 * said. Keeping both matters because the humanised sentence is deliberately vague
 * ("模块没能装好") and the raw one is the only thing that identifies the bug — and
 * on a phone there is no console to read it from.
 */
export interface LoadFailure {
  where: string
  message: string
  raw: string
  at: number
}

export class Session {
  readonly lines: Writable<Line[]> = writable([])
  readonly state: Writable<SessionState> = writable('idle')
  readonly queues: Writable<QueueSnapshot> = writable({
    seg: 0,
    mt: 0,
    tts: 0,
    lagSeconds: 0,
    failed: 0,
  })
  readonly notice: Writable<string> = writable('')
  readonly rate: Writable<number> = writable(1)
  readonly level: Writable<number> = writable(0)
  readonly providerLabel: Writable<string> = writable('')
  readonly model: Writable<ModelState | null> = writable(null)
  /** Last module failure, so the UI can explain it without a log drawer. */
  readonly failure: Writable<LoadFailure | null> = writable(null)
  /**
   * What `start()` is busy with, in words a user can read.
   *
   * Starting is model load + provider probe + microphone, which is seconds of
   * looking at a spinner that says nothing. The status bar shows this instead of
   * a fixed guess about the permission prompt.
   */
  readonly stage: Writable<string> = writable('')
  readonly autoRead: Writable<boolean> = writable(true)
  /**
   * The continuous recording of this session.
   *
   * `null` until the worker has reported in. `bytes > 0` means there is
   * something to export, and every line can be replayed from it — including the
   * ones that came out wrong, which is the whole point of keeping it.
   */
  readonly recording: Writable<RecordingInfo | null> = writable(null)

  private readonly settings: Settings

  private capture: CaptureHandle | null = null
  private vad: VadWorkerClient | null = null
  private asr: AsrWorkerClient | null = null
  private mt: MtWorkerClient | null = null
  private readonly speech = new SpeechEngine()

  private readonly segQ = new OrderedQueue<SpeechSegment>('seg')
  private readonly mtQ = new OrderedQueue<Line>('mt')
  private readonly readQ = new OrderedQueue<Line>('read')

  private readonly rateController = new RateController(1)
  /**
   * The finished recording, held on the main thread.
   *
   * The worker that writes the file is disposed when a session stops, so once
   * that happens this is what replay, re-recognition and export read from.
   */
  private recordingFile: File | Blob | null = null
  /** Ids for re-recognition requests; negative so they never collide with segment ids. */
  private nextRetryId = -1

  private linesById = new Map<number, Line>()
  private nextLineId = 1
  private readPointer = 1
  /** Recognition results waiting to be matched to the segment that produced them. */
  private asrWaiters = new Map<
    number,
    (value: { text: string; rawText: string; engine: string; inferMs: number }) => void
  >()

  private lagTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Which *module* is resident — not which language: zh and ko are the same
   * bytes, so switching between them must not reload 240 MB. `null` means
   * nothing is loaded.
   */
  private modelModuleLang: ModuleLang | null = null
  private startAbort: AbortController | null = null
  private preferredProvider: MtProviderId | null = null
  private stopping = false

  constructor() {
    this.settings = getSettings()
    this.rateController.reset(this.settings.baseRate)
    this.rate.set(this.settings.baseRate)
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Loads (and downloads, if needed) the recognition module for `lang`.
   *
   * Resolves only once the module is genuinely usable, which is what lets both
   * `start()` and the install dialog treat the returned promise as proof of a
   * finished install. Progress while it runs arrives through `onProgress`.
   */
  async prepare(lang: Settings['sourceLang']): Promise<void> {
    const client = this.ensureAsrClient(lang)
    const module = moduleLangFor(lang)
    // Which accelerator this attempt will actually use, decided *before* the
    // engine starts — the crash note records it, and the log states it, because a
    // page that dies cannot tell anyone what it was doing. A report that says only
    // "开始安装识别模块" is what made an iPhone's crash unreadable for two rounds:
    // it named the module but not the thing that killed it.
    const settings = getSettings()
    // Moonshine is the only engine with a choice to make: sherpa-onnx's WASM
    // build is CPU-only, so Chinese/Korean has nothing to decide. The plan is
    // handed to the worker with the request; see `DevicePlan`.
    const plan =
      moduleFor(lang).engine === 'moonshine' ? planDevice(settings.accelerator, settings.precision) : null
    const accelerator = plan?.primary.device ?? 'wasm'
    info(
      'asr',
      `准备启动${MODULE_NAME[module]}：${plan ? `${plan.primary.device}（${plan.primary.dtype}）—— ${plan.primary.reason}` : 'sherpa WebAssembly（CPU）'}`,
    )
    // A device that this module has already killed twice *the same way* does not
    // need a third demonstration. A killed page cannot report anything, so all a
    // retry can produce is another silent crash — refuse in words, and say why.
    // Keyed by accelerator: two GPU crashes say the GPU is unusable, not that the
    // module is.
    if (asrCrashCount(module, accelerator) >= 2) {
      throw new Error(
        accelerator === 'webgpu'
          ? `这台设备已经在显卡加速（WebGPU）下被关掉页面两次了：请在设置里把「显卡加速」改成 CPU 再试`
          : `${MODULE_NAME[module]}在这台设备上装不下：已经两次在启动时把整个页面关掉了（内存不够），先别试了`,
      )
    }
    // A new install starts the bar over; without this the dialog would open
    // showing the last install's 100%.
    const lastFraction = { value: 0 }
    this.model.set({ status: '准备识别模块', progress: 0 })
    client.onProgress = (progress: AsrLoadProgress) => {
      // Merged, not replaced. Status-only reports ("Running...", "初始化识别模块")
      // carry no numbers, and replacing the whole state with them used to blank
      // the percentage and drop the bar back to its 6% stub — the jitter that
      // made the download look broken while it was progressing fine.
      const fraction = progress.progress !== undefined
        ? Math.max(lastFraction.value, Math.min(1, progress.progress))
        : undefined
      if (fraction !== undefined) lastFraction.value = fraction
      this.model.update((prev) => ({
        status: progress.status || prev?.status || '准备识别模块',
        progress: fraction ?? prev?.progress,
        loadedBytes: progress.loaded ?? prev?.loadedBytes,
        totalBytes: progress.total ?? prev?.totalBytes,
      }))
    }
    client.onLoaded = (loaded) => {
      this.model.set(null)
      this.modelModuleLang = moduleLangFor(lang)
      this.failure.set(null)
      info('asr', `识别模块已就绪（${loaded.device ?? 'unknown'}）`, { reason: loaded.reason })
    }
    client.onResult = (result) => this.onAsrResult(result)
    client.onFailed = (where, message, id) => {
      logError('asr', where === 'load' ? `识别模块加载失败：${message}` : `识别失败：${message}`)
      if (where === 'load') {
        this.failure.set({ where, message: describeModuleError(message), raw: message, at: Date.now() })
      }
      if (id !== undefined) {
        const wait = this.asrWaiters.get(id)
        this.asrWaiters.delete(id)
        wait?.({ text: '', rawText: '', engine: '', inferMs: 0 })
      }
    }
    // From here to the end of the load the page may be killed by the system
    // without a word. The note is what tells the *next* load that it happened, and
    // under which accelerator; a load that ends in any way we can report clears it.
    // See `lib/boot-guard.ts`.
    markAsrAttempt(module, accelerator)
    try {
      await withTimeout(
        client.load(lang, plan),
        MODEL_LOAD_TIMEOUT_MS,
        '下载太久没动静，检查网络后重试',
      )
      clearAsrAttempt()
      // It loaded, so whatever killed the page before was not this device being
      // unable to run the module; a stale count would lock out a working device.
      forgetAsrCrashes(module, accelerator)
    } catch (err) {
      clearAsrAttempt()
      throw err
    }
  }

  async start(): Promise<void> {
    if (get(this.state) === 'recording') return
    this.state.set('preparing')
    this.stopping = false
    // A failure from the previous attempt must not linger above the button.
    this.notice.set('')
    this.failure.set(null)
    const abort = new AbortController()
    this.startAbort = abort
    try {
      const settings = getSettings()
      if (this.modelModuleLang !== moduleLangFor(settings.sourceLang)) {
        this.stage.set('正在加载识别模块')
        this.model.set({ status: '准备识别模块' })
        await this.prepare(settings.sourceLang)
        if (this.modelModuleLang !== moduleLangFor(settings.sourceLang)) {
          // Never "go and read the log drawer": that drawer only exists in debug
          // mode, so on a phone the old sentence was a dead end. The reason
          // itself travels to the status bar instead.
          const reason = get(this.failure)?.message
          throw new Error(reason ? `识别模块没能装好：${reason}` : '识别模块没能装好，再试一次')
        }
      }
      this.stage.set('正在连接翻译服务')
      await this.probeProviders()

      this.vad = new VadWorkerClient()
      this.vad.configure({
        silenceMs: settings.silenceMs,
        minSegMs: settings.minSegMs,
        maxSegMs: settings.maxSegMs,
      })
      this.vad.onSegment = (segment) => this.onSegment(segment)
      this.vad.onLevel = (level) => this.level.set(level)
      this.vad.onRecording = (info) => {
        this.recording.set(info)
        if (info.stopped === 'limit') this.notice.set('录音已达上限，后面的不再保存')
        else if (info.stopped === 'error') this.notice.set('录音中断了，语音识别不受影响')
      }
      this.vad.setRecordingLimit(settings.audioRetentionMin)
      // Recording is what makes every later decision reversible: a sentence the
      // pipeline skips can still be re-cut from the file and recognised.
      if (settings.keepAudio) this.vad.startRecording()
      else this.vad.attachRecording()

      this.ensureAsrClient(settings.sourceLang)
      this.ensureMtClient()

      // Recognition pump: one segment in flight at a time, in order.
      this.segQ.reopen()
      pump(this.segQ, (segment) => this.recognize(segment))

      // Translation pump: moves settled lines to the worker in order.
      this.mtQ.reopen()
      pump(this.mtQ, (line) => this.requestTranslation(line))

      // Reading pump: speaks lines in the order they were spoken.
      this.readQ.reopen()
      pump(this.readQ, (line) => this.readLine(line))

      this.speech.unlock(settings.targetLang)

      this.stage.set('正在准备麦克风')
      this.capture = await startCapture({
        onChunk: (chunk, rate) => this.vad?.push(chunk, rate),
        onLevel: (level) => this.level.set(level),
        signal: abort.signal,
      })
      if (!this.capture.constraintsHonoured) {
        this.notice.set('浏览器降低了录音质量，识别可能差一点')
      }

      this.stage.set('')
      this.state.set('recording')
      this.startLagLoop()
      info('session', '开始录音', {
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
      })
    } catch (err) {
      await this.teardown()
      if (isAbort(err)) {
        // The user gave up while the permission prompt was open: that is not a
        // failure, and no error should be shouted about it.
        this.stage.set('')
        this.state.set('idle')
        this.notice.set('已取消启动')
        info('session', '已取消启动')
        return
      }
      this.stage.set('')
      this.state.set('error')
      const message = err instanceof Error ? err.message : String(err)
      logError('session', `启动失败：${message}`)
      this.notice.set(message)
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.state.set('stopping')
    try {
      // The microphone goes first. Everything else can be told to drain, but a
      // recording that is still being appended to after its WAV header was
      // written ends up declaring less audio than the file holds.
      await this.stopCapture()
      this.vad?.flush()
      await this.waitForPipeline(6000)
    } finally {
      await this.finishRecording()
      await this.teardown()
      this.stage.set('')
      this.state.set('idle')
      this.stopping = false
      this.notice.set('')
      info('session', '已停止录音', { lines: get(this.lines).length })
    }
  }

  /** Lets the UI abandon a start that is stuck on the microphone prompt. */
  abortStart(): void {
    this.startAbort?.abort()
  }

  /** Detaches the microphone, leaving whatever audio is already queued queued. */
  private async stopCapture(): Promise<void> {
    const capture = this.capture
    this.capture = null
    await capture?.stop()
  }

  /**
   * Finalises the recording before the worker that holds it is torn down: the
   * file's WAV header has to cover the last samples, and the main thread needs a
   * copy it can read once the worker is gone.
   */
  private async finishRecording(): Promise<void> {
    const vad = this.vad
    if (!vad) return
    await vad.stopRecording()
    const info = get(this.recording)
    if (info && info.bytes > 0) this.recordingFile = await vad.recordingFile()
  }

  /** Everything the session owns must go away on stop, including the model. */
  private async teardown(): Promise<void> {
    this.startAbort = null
    this.stopLagLoop()
    this.segQ.close()
    this.mtQ.close()
    this.readQ.close()
    await this.stopCapture()
    if (this.vad) {
      // Closing the worker without this leaves the file's header describing less
      // audio than it contains — every path out of a session comes through here.
      await this.vad.stopRecording()
      this.vad.dispose()
    }
    this.vad = null
    this.mt?.dispose()
    this.mt = null
    this.mtQ.drain()
    this.readQ.drain()
    this.segQ.drain()
    this.speech.stop()
    this.level.set(0)
    this.updateQueues()
  }

  /**
   * A recognition client is bound to one module, because the two engines do not
   * even share a worker kind. Switching to a language served by a *different*
   * module must never silently keep talking to the previous one — but switching
   * between two languages of the same module (zh ↔ ko) keeps the client, and with
   * it the loaded model.
   */
  private ensureAsrClient(lang: Lang): AsrWorkerClient {
    if (!this.asr || this.asr.moduleLang !== moduleLangFor(lang)) {
      this.asr?.dispose()
      this.asr = new AsrWorkerClient(lang)
    }
    return this.asr
  }

  /** Releases the recognition model — used when the source language changes. */
  async releaseModel(): Promise<void> {
    this.asr?.dispose()
    this.asr = null
    this.modelModuleLang = null
  }

  async dispose(): Promise<void> {
    await this.teardown()
    this.asr?.dispose()
    this.asr = null
    this.linesById.clear()
  }

  // ------------------------------------------------------------------ capture

  private onSegment(segment: SpeechSegment): void {
    // Always full-duplex: the app keeps listening while it reads out loud. Audio
    // from its own voice only reaches the microphone when the output is a
    // speaker, and the headphone prompt covers that case.
    this.segQ.push(segment)
    this.updateQueues()
  }

  /**
   * Sends one utterance to the recogniser and waits for its answer.
   *
   * Split out from `recognize` because re-recognition needs the same call with
   * samples cut from the recording rather than from the microphone, but must not
   * append a second line for a sentence that already has one.
   */
  private recognizeSamples(
    segment: SpeechSegment,
  ): Promise<{ text: string; rawText: string; engine: string; inferMs: number }> {
    const client = this.asr
    if (!client) return Promise.resolve({ text: '', rawText: '', engine: '', inferMs: 0 })
    return new Promise((resolve) => {
      this.asrWaiters.set(segment.id, resolve)
      client.recognize(segment.id, segment.samples, segment.startMs, segment.endMs)
      // A recogniser that never answers must not stall the queue forever.
      setTimeout(() => {
        if (this.asrWaiters.delete(segment.id)) {
          warn('asr', '识别超时，跳过这一段', { segment: segment.id })
          resolve({ text: '', rawText: '', engine: '', inferMs: 0 })
        }
      }, 30_000)
    })
  }

  private async recognize(segment: SpeechSegment): Promise<void> {
    const result = await this.recognizeSamples(segment)
    const text = result.text.trim()
    if (!text) {
      // Silence, music or a non-speech noise burst: not worth a line.
      this.updateQueues()
      return
    }
    this.appendLine({ segment, ...result, text })
    this.updateQueues()
  }

  private onAsrResult(result: {
    id: number
    text: string
    rawText: string
    engine: string
    inferMs: number
  }): void {
    const wait = this.asrWaiters.get(result.id)
    this.asrWaiters.delete(result.id)
    wait?.({ text: result.text, rawText: result.rawText, engine: result.engine, inferMs: result.inferMs })
  }

  private appendLine(input: {
    segment: SpeechSegment
    text: string
    rawText: string
    engine: string
    inferMs: number
  }): void {
    const line: Line = {
      id: this.nextLineId++,
      startMs: input.segment.startMs,
      endMs: input.segment.endMs,
      text: input.text,
      rawText: input.rawText || input.text,
      engine: input.engine,
      inferMs: input.inferMs,
      translation: null,
      mtState: 'pending',
      ttsState: 'idle',
    }
    this.linesById.set(line.id, line)
    this.lines.update((list) => {
      const next = [...list, line]
      if (next.length > MAX_LINES) {
        const overflow = next.slice(0, next.length - MAX_LINES)
        for (const dropped of overflow) this.linesById.delete(dropped.id)
        warn('session', `记录超过 ${MAX_LINES} 行，最旧的已从界面上移除`)
        return next.slice(next.length - MAX_LINES)
      }
      return next
    })
    this.mtQ.push(line)
    debug('asr', `识别完成：${line.text.slice(0, 40)}`, {
      engine: line.engine,
      inferMs: line.inferMs,
      durationMs: line.endMs - line.startMs,
    })
  }

  // ----------------------------------------------------------------- translate

  private applyMtConfig(): void {
    const settings = getSettings()
    const config: MtConfig = {
      provider: settings.mtProvider,
      batchWindowMs: settings.mtBatchWindowMs,
      useCache: settings.mtCache,
      googleApiKey: settings.googleApiKey,
      llm: {
        format: settings.llmFormat,
        baseUrl: settings.llmBaseUrl,
        model: settings.llmModel,
        apiKey: settings.llmApiKey,
      },
      sl: settings.sourceLang,
      tl: settings.targetLang,
      preferredProvider: this.preferredProvider,
    }
    this.mt?.configure(config)
  }

  /** Called when the user changes anything in settings. */
  applySettings(): void {
    const settings = getSettings()
    this.vad?.configure({
      silenceMs: settings.silenceMs,
      minSegMs: settings.minSegMs,
      maxSegMs: settings.maxSegMs,
    })
    this.vad?.setRecordingLimit(settings.audioRetentionMin)
    this.applyMtConfig()
    if (this.preferredProvider === null) {
      const label = settings.mtProvider === 'llm' ? 'AI 模型' : settings.mtProvider === 'google' ? '谷歌翻译' : '微软翻译'
      this.providerLabel.set(label)
    }
    this.rateController.reset(settings.baseRate)
    this.rate.set(settings.baseRate)
  }

  private async probeProviders(): Promise<void> {
    const settings = getSettings()
    // Probe once per page load: the answer cannot change mid-session, and the
    // probe itself can block for seconds on networks where Google is filtered.
    if (this.preferredProvider !== null) {
      this.applyMtConfig()
      return
    }
    if (settings.mtProvider === 'llm') {
      this.providerLabel.set('AI 模型')
      this.applyMtConfig()
      return
    }
    const { provider, results } = await resolveWorkingProvider(settings.mtProvider, {
      sl: settings.sourceLang,
      tl: settings.targetLang,
      googleApiKey: settings.googleApiKey,
      llm: {
        format: settings.llmFormat,
        baseUrl: settings.llmBaseUrl,
        model: settings.llmModel,
        apiKey: settings.llmApiKey,
      },
    })
    this.preferredProvider = provider
    const label = provider === 'google' ? '谷歌翻译' : '微软翻译'
    this.providerLabel.set(label)
    for (const result of results) {
      const name = result.provider === 'google' ? '谷歌翻译' : '微软翻译'
      // `attempts > 1` is worth saying out loud: it means the first request met a
      // cold connection rather than a broken provider.
      if (result.ok) {
        const suffix = result.attempts && result.attempts > 1 ? `，第 ${result.attempts} 次尝试才通` : ''
        info('translate', `${name}可用（${result.ms} ms${suffix}）`)
      } else {
        warn('translate', `${name}不可用`, { detail: result.detail, attempts: result.attempts })
      }
    }
    if (provider !== settings.mtProvider) {
      this.notice.set(`谷歌翻译用不了，已换成${label}`)
      warn('translate', `已自动从${settings.mtProvider}切换到${label}`)
    }
    this.applyMtConfig()
  }

  private async requestTranslation(line: Line): Promise<void> {
    // `mtCache` controls whether repeated sentences are remembered, never
    // whether translation happens at all.
    this.mt?.translate([{ id: line.id, text: line.text }])
  }

  private onTranslation(result: MtItemResult): void {
    const line = this.linesById.get(result.id)
    if (!line) return
    const updated: Line = {
      ...line,
      translation: result.text,
      mtState: result.text === null ? 'failed' : result.cached ? 'cached' : 'ok',
      mtProvider: result.provider,
      ...(result.error ? { error: result.error } : {}),
    }
    this.linesById.set(updated.id, updated)
    this.patchLine(updated)
    if (result.text) {
      debug('translate', `译文（${result.provider}${result.cached ? ' · 缓存' : ''}）：${result.text.slice(0, 40)}`)
    }
    this.advanceReadPointer()
    this.updateQueues()
  }

  /**
   * Hands settled lines to the reader strictly in order. A pending translation
   * blocks its successors on purpose: reading out of order is worse than reading
   * late. A *failed* line does not block — it has nothing to say.
   */
  private advanceReadPointer(): void {
    for (;;) {
      const line = this.linesById.get(this.readPointer)
      if (!line) return
      if (line.mtState === 'pending') return
      this.readPointer++
      if (line.mtState === 'failed') continue
      if (line.translation) this.readQ.push(line)
      else continue
    }
  }

  // -------------------------------------------------------------------- speak

  private async readLine(line: Line): Promise<void> {
    const text = line.translation
    if (!text) return
    if (!get(this.autoRead)) {
      this.markLine(line.id, { ttsState: 'idle' })
      return
    }
    if (!speechSupported()) {
      this.markLine(line.id, { ttsState: 'error' })
      return
    }
    const settings = getSettings()
    this.markLine(line.id, { ttsState: 'speaking' })
    let outcome: 'done' | 'cancelled' | 'error' = 'error'
    try {
      outcome = await this.speech.speak(text, {
        voiceURI: settings.voiceURI,
        rate: this.rateController.rate,
        lang: settings.targetLang,
      })
    } catch {
      outcome = 'error'
    }
    this.markLine(line.id, { ttsState: outcome === 'error' ? 'error' : 'done' })
    if (outcome === 'error') {
      logError('tts', '朗读失败，可能是这个语言没有可用音色', { text: text.slice(0, 30) })
      const voices = await this.speech.voicesFor(settings.targetLang)
      if (voices.length === 0) this.notice.set('手机里没有这种语言的朗读声音')
    }
    this.updateRateFromBacklog()
    this.updateQueues()
  }

  private updateRateFromBacklog(): void {
    const settings = getSettings()
    const { rate, changed } = this.rateController.update({
      backlog: this.readQ.size + (this.speech.speaking ? 1 : 0),
      baseRate: settings.baseRate,
      maxRate: settings.maxRate,
      auto: settings.autoSpeedup,
    })
    if (changed) {
      this.rate.set(rate)
      debug('tts', `朗读语速调整为 ${rate.toFixed(2)}x（积压 ${this.readQ.size} 句）`)
    }
  }

  /**
   * Requirement 19: clicking a translation line reads from that line to the
   * newest one. Implemented by moving the read pointer back and re-queuing, so
   * the normal ordered pump does the work and the live queue simply continues
   * afterwards.
   */
  speakFrom(lineId: number): void {
    this.speech.stop()
    this.readQ.drain()
    this.readPointer = lineId
    this.rateController.reset(getSettings().baseRate)
    this.rate.set(getSettings().baseRate)
    this.advanceReadPointer()
    this.updateQueues()
  }

  /**
   * The only place the app drops anything, and it takes a deliberate user
   * action: stop reading the backlog and pick up from the newest settled line.
   */
  skipToLatest(): void {
    const skipped = this.readQ.drain().length
    this.speech.stop()
    const lines = get(this.lines)
    const newest = [...lines].reverse().find((line) => line.mtState !== 'pending')
    const pendingInWorker = Math.max(0, get(this.queues).mt)
    if (newest) this.readPointer = newest.id + 1
    else this.readPointer = lines.length + 1
    this.rateController.reset(getSettings().baseRate)
    this.rate.set(getSettings().baseRate)
    this.advanceReadPointer()
    this.updateQueues()
    info('tts', `已跳到最新，放弃 ${skipped} 句待读内容`, { pendingInWorker })
  }

  retryLine(lineId: number): void {
    const line = this.linesById.get(lineId)
    if (!line) return
    const updated: Line = { ...line, mtState: 'pending', translation: null }
    delete (updated as { error?: string }).error
    this.linesById.set(lineId, updated)
    this.patchLine(updated)
    if (this.mt) {
      this.mt.translate([{ id: lineId, text: line.text }])
      this.readPointer = Math.min(this.readPointer, lineId)
    } else {
      // Nothing is running, so there is no queue to put it in: translate it here.
      void this.retranslate(updated)
    }
    this.updateQueues()
  }

  /**
   * One line's audio, cut out of the session recording on demand.
   *
   * On demand rather than stored per line: keeping a separate copy of every
   * utterance is what made long sessions expensive, and the recording already
   * holds the same samples.
   */
  async lineAudio(lineId: number): Promise<Blob | null> {
    const line = this.linesById.get(lineId)
    if (!line) return null
    if (this.vad) return this.vad.recordingWav(line.startMs, line.endMs)
    return this.recordingFile ? wavSliceFromBlob(this.recordingFile, line.startMs, line.endMs) : null
  }

  private async recordingSamples(startMs: number, endMs: number): Promise<Float32Array | null> {
    if (this.vad) return this.vad.recordingSamples(startMs, endMs)
    return this.recordingFile ? pcmSliceFromBlob(this.recordingFile, startMs, endMs) : null
  }

  /**
   * Runs recognition again for one line, using the audio from the recording
   * instead of a fresh microphone segment. This is the recovery path: a sentence
   * that was cut badly or recognised wrongly is still in the file, so it can be
   * redone rather than lost.
   */
  async reRecognize(lineId: number): Promise<void> {
    const line = this.linesById.get(lineId)
    if (!line) return
    const samples = await this.recordingSamples(line.startMs, line.endMs)
    if (!samples || samples.length === 0) {
      this.notice.set('这句没有录音，无法重新识别')
      return
    }
    const id = this.nextRetryId--
    info('asr', `从录音重新识别这一句（${(samples.length / 16000).toFixed(1)} 秒）`)
    const result = await this.recognizeSamples({ id, startMs: line.startMs, endMs: line.endMs, samples })
    const text = result.text.trim()
    if (!text) {
      this.notice.set('重新识别没有听出内容')
      return
    }
    const updated: Line = {
      ...(this.linesById.get(lineId) ?? line),
      text,
      rawText: result.rawText || text,
      engine: result.engine,
      inferMs: result.inferMs,
      translation: null,
      mtState: 'pending',
    }
    delete (updated as { error?: string }).error
    this.linesById.set(lineId, updated)
    this.patchLine(updated)
    await this.retranslate(updated)
  }

  /**
   * A translation client, created on first use.
   *
   * Re-doing one sentence must work whether or not a session is running — the
   * worker that normally translates is disposed when a session stops, and
   * without this the corrected sentence would be translated by nobody.
   */
  private ensureMtClient(): MtWorkerClient {
    if (!this.mt) {
      this.mt = new MtWorkerClient()
      this.mt.onResult = (result) => this.onTranslation(result)
      this.applyMtConfig()
    }
    return this.mt
  }

  /** One sentence in, its translation out, using a client of our own if needed. */
  private async translateStandalone(text: string): Promise<string> {
    const borrowed = !this.mt
    const client = this.ensureMtClient()
    try {
      const out = await client.translateOnce([text])
      const translation = out?.texts[0] ?? null
      if (!translation) throw new Error('翻译没有返回内容')
      return translation
    } finally {
      if (borrowed && get(this.state) !== 'recording') {
        this.mt?.dispose()
        this.mt = null
      }
    }
  }

  /**
   * Translates one line in place, without touching the read queue: a correction
   * should fix the text on screen, not insert an old sentence back into the
   * read-out.
   */
  private async retranslate(line: Line): Promise<void> {
    try {
      const translation = await this.translateStandalone(line.text)
      this.markLine(line.id, { translation, mtState: 'ok', ttsState: 'idle' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.markLine(line.id, { mtState: 'failed', error: message })
      warn('translate', `重新翻译失败：${message}`)
    }
    this.updateQueues()
  }

  /** Downloads the session recording as a WAV, wherever it currently lives. */
  async exportRecording(): Promise<void> {
    const file = this.vad ? await this.vad.recordingFile() : this.recordingFile
    if (!file) {
      this.notice.set('还没有录音可以导出')
      return
    }
    this.recordingFile = file
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '')
    const url = URL.createObjectURL(file)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `realtime-chopper-${stamp}.wav`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    info('storage', `已导出录音（${(file.size / 1024 / 1024).toFixed(1)} MB）`)
  }

  async clearRecording(): Promise<void> {
    this.recordingFile = null
    if (this.vad) await this.vad.clearRecording()
    else await deleteRecordingFile()
    this.recording.set(this.vad ? get(this.recording) : { mode: 'off', seconds: 0, bytes: 0, stopped: null })
    info('storage', '已删除录音')
  }

  // ------------------------------------------------------------------ helpers

  private markLine(id: number, patch: Partial<Line>): void {
    const line = this.linesById.get(id)
    if (!line) return
    const updated = { ...line, ...patch }
    this.linesById.set(id, updated)
    this.patchLine(updated)
  }

  private patchLine(updated: Line): void {
    this.lines.update((list) => list.map((line) => (line.id === updated.id ? updated : line)))
  }

  private updateQueues(): void {
    const pending: Line[] = []
    for (const line of this.linesById.values()) {
      if (line.id >= this.readPointer && line.mtState !== 'pending' && line.translation) pending.push(line)
    }
    const inFlight = this.speech.speaking
      ? estimateSpeechSeconds(this.linesById.get(this.readPointer - 1)?.translation ?? '', this.rateController.rate)
      : 0
    const failed = [...this.linesById.values()].filter((line) => line.mtState === 'failed').length
    this.queues.set({
      seg: this.segQ.size,
      mt: this.mtQ.size,
      tts: this.readQ.size,
      lagSeconds: estimateLagSeconds(pending, this.rateController.rate, inFlight),
      failed,
    })
  }

  private startLagLoop(): void {
    this.stopLagLoop()
    // Queue depths are pushed on change, but the lag estimate also depends on
    // the sentence currently being spoken, so it is refreshed on a timer.
    this.lagTimer = setInterval(() => this.updateQueues(), 500)
  }

  private stopLagLoop(): void {
    if (this.lagTimer) clearInterval(this.lagTimer)
    this.lagTimer = null
  }

  private async waitForPipeline(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const idle = this.segQ.size === 0 && this.mtQ.size === 0 && this.readQ.size === 0 && !this.speech.speaking
      if (idle) return
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    info('session', '等待流水线清空超时，剩余内容已放弃')
  }
}
