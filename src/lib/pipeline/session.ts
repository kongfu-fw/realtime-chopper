import { get, writable, type Writable } from 'svelte/store'
import type {
  Line,
  ModuleId,
  QueueSnapshot,
  SessionState,
  SpeechSegment,
  AsrLoadProgress,
} from '../types'
import type { Settings } from '../store/settings'
import { getSettings, ttsVoiceFor } from '../store/settings'
import { asrCrashCount, clearAsrAttempt, forgetAsrCrashes, markAsrAttempt } from '../boot-guard'
import { startCapture, type CaptureHandle, type CaptureRevival } from '../audio/capture'
import { keepScreenAwake, wakeLockAdvice, type ScreenWakeKeeper } from '../app/wakelock'
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
import {
  describeModuleError,
  localModuleIdFor,
  mayFallBackToLocal,
  moduleIdFor,
  moduleSpec,
  moduleName,
  moduleTooBigForDevice,
} from '../asr/models'
import { planDevice } from '../asr/moonshine'
import { addressProblem, remoteConfigFor } from '../asr/koasr'
import { transcriptFlaw, type TranscriptFlaw } from '../asr/transcript-guard'
import { createTtsEngine, ttsConfigFrom, type SpeakOutcome, type TtsEngine } from '../tts/engine'
import { speechSnapshot } from '../tts/speech'
import { resolveWorkingProvider } from '../mt/probe'
import type { MtConfig, MtItemResult } from '../mt/client'
import { providerName } from '../mt/providers'
import { t } from '../i18n/index.ts'
import { debug, error as logError, info, warn } from '../log/store'

/**
 * Cancellation arrives as an AbortError, either as a DOMException from the
 * signal itself or as an error carrying that name from a layer above it.
 */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * Identity of the read-aloud engine a settings snapshot describes.
 *
 * The proxy URL is part of it because it is baked into the Edge engine at
 * construction: editing the address has to build a new one, or the old URL would
 * keep being asked for sentences.
 */
function speechKeyOf(settings: Settings): string {
  return `${settings.ttsEngine}|${settings.ttsProxyUrl}`
}

/**
 * Why a recognised line was refused, in words.
 *
 * A function rather than a table because `t` reads the language as it is *now*:
 * a table built at import time would keep the language the page happened to
 * load in.
 */
function flawReason(flaw: TranscriptFlaw): string {
  switch (flaw) {
    case 'memorised':
      return t('模型背下来的句子')
    case 'no-script':
      return t('句子里没有这种语言的文字')
    case 'repetition':
      return t('同一句重复了三遍')
  }
}

/**
 * A stalled download must not leave the UI spinning forever. The cap is generous
 * on purpose: the Chinese module is ~235 MB, and a phone on mobile data is
 * legitimately allowed to take minutes.
 */
const MODEL_LOAD_TIMEOUT_MS = 240_000

/**
 * How often a running session checks that the microphone is still delivering.
 *
 * A second, because the failure this exists for leaves no trace anywhere: iOS
 * takes the device away while the page stays on screen, the track ends or the
 * context stops, and nothing fires. Every second the panel goes on saying
 * "recording" over silence is a second of the lesson on the floor.
 */
const CAPTURE_WATCH_MS = 1000

/**
 * How long after one automatic restart the next one is refused.
 *
 * A microphone that dies again seconds after being reopened is not something to
 * keep feeding in a loop: the user is told, and the next return to the app may try
 * again.
 */
const AUTO_RESUME_COOLDOWN_MS = 20_000

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
  /**
   * The microphone's input level: the segmenter's rms of the last frame.
   *
   * Nothing draws this any more, by request. It reached the screen as the record
   * button's halo, then as a fill inside the button, and the verdict on both was the
   * same — a level readout is something to interpret, and interpreting it was a job
   * the reader had to keep doing in the middle of a lesson, at a distance where the
   * interpretation is unreliable anyway (the whole history is in the "电平" section
   * of DOCS.md). "Is it recording?" is answered by the button, and "can it hear
   * me?" by the transcript underneath.
   *
   * Kept because it costs a store write per 100 ms block and it is the one number
   * that answers "was the input even there?" when a session recognises nothing at
   * all: re-deriving it is the hard part, and the dB scale above it lives on this
   * side of the UI. Nothing subscribes today.
   */
  readonly level: Writable<number> = writable(0)
  readonly providerLabel: Writable<string> = writable('')
  /**
   * Which provider is answering, as an *id*.
   *
   * `providerLabel` is what a person reads and is therefore translated; the
   * translation panel needs the id to decide whether to draw the Google mark, and
   * matching on the label's text would stop working the moment the interface is
   * not in Chinese (this used to be `/谷歌/.test(label)`).
   */
  readonly provider: Writable<MtProviderId | null> = writable(null)
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
  /**
   * Keeps the screen on for as long as `capture` is open.
   *
   * Paired with the microphone rather than with `state`: both exist for exactly the
   * span of a session, and the one thing that must never happen is a wake lock
   * left behind by a session that ended (see `releaseScreenLock`).
   */
  private wake: ScreenWakeKeeper | null = null
  private vad: VadWorkerClient | null = null
  private asr: AsrWorkerClient | null = null
  private mt: MtWorkerClient | null = null
  /**
   * The read-aloud engine, replaced in place when the setting changes.
   *
   * Rebuilt rather than reconfigured because the choice changes what a voice even
   * *is*: the platform's `voiceURI` and Edge's `ShortName` are different
   * namespaces, and the two engines have nothing to share but this interface.
   */
  private speech: TtsEngine = createTtsEngine(ttsConfigFrom(getSettings()))
  /** What the current engine was built from, so a rebuild only happens on a real change. */
  private speechKey = speechKeyOf(getSettings())

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
  /** When this session started; the date a filed note is titled with. */
  private startedAt = 0
  /** Recording time banked by the pauses that have already happened, in ms. */
  private elapsedMs = 0
  /** When the stretch of recording now running began; 0 when nothing is running. */
  private runningSince = 0
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
   * bytes, so switching between them must not reload 240 MB. English has two
   * modules to choose from, so the language would not be enough to answer this
   * either. `null` means nothing is loaded.
   */
  private modelModule: ModuleId | null = null
  private startAbort: AbortController | null = null
  private preferredProvider: MtProviderId | null = null
  private stopping = false

  /**
   * Set when a session had to stop because the system took the microphone away,
   * and consumed by the next attempt to bring it back (see `stopAfterMicrophoneLoss`
   * and `maybeResumeAfterLoss`).
   *
   * The distinction it carries is the whole point: a session the *user* ended is
   * over, and a session the system ended is one they are still expecting to be
   * running. Without this flag the app cannot tell the two apart, and the button it
   * draws afterwards is wrong for one of them either way.
   */
  private resumeAfterLoss = false
  /** When the last automatic restart was attempted, for the cooldown. */
  private lastAutoResumeAt = 0
  /** The once-a-second liveness check that runs while a session records. */
  private captureWatch: ReturnType<typeof setInterval> | null = null
  /** Consecutive dead looks, so one blip does not count as a lost microphone. */
  private deadLooks = 0
  /** True while a revival is in flight, so two callers cannot both open a device. */
  private reviving = false

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
  async prepare(module: ModuleId): Promise<void> {
    const spec = moduleSpec(module)
    const configured = getSettings().asrBaseUrl
    // The address is checked *before* a worker is built for it, for two reasons and
    // both matter. The failure it catches has no useful symptom — a page on HTTPS
    // asking for an `http://` service is refused by the browser before a packet
    // exists, which from here is the same `TypeError` as an unreachable host — and
    // a module whose address cannot work should not pay for a worker that is about
    // to be thrown away. See `addressProblem`.
    const addressFault = spec.remote ? addressProblem(configured, location.protocol) : null
    if (addressFault) {
      await this.fallBackToLocal(
        module,
        addressFault === 'empty'
          ? t('还没填识别服务地址')
          : t('地址是 http、页面是 https，浏览器不会发这个请求'),
      )
      return
    }
    const remote = spec.remote ? remoteConfigFor(module, configured, location.origin) : null
    const client = this.ensureAsrClient(module)
    // Which accelerator this attempt will actually use, decided *before* the
    // engine starts — the crash note records it, and the log states it, because a
    // page that dies cannot tell anyone what it was doing. A report that says only
    // "开始安装识别模块" is what made an iPhone's crash unreadable for two rounds:
    // it named the module but not the thing that killed it.
    const settings = getSettings()
    // Moonshine is the only engine with a choice to make: sherpa-onnx's WASM
    // build is CPU-only, so Chinese/Korean has nothing to decide. The plan is
    // handed to the worker with the request; see `DevicePlan`.
    const plan = spec.engine === 'moonshine' ? planDevice(settings.accelerator, settings.precision) : null
    const accelerator = plan?.primary.device ?? 'wasm'
    info(
      'asr',
      t('准备启动{module}：{plan}', {
        module: moduleName(module),
        plan: plan
          ? t('{device}（{dtype}）—— {reason}', {
              device: plan.primary.device,
              dtype: plan.primary.dtype,
              reason: plan.primary.reason,
            })
          : remote
            ? // The address is the whole answer here: there is no accelerator to
              // pick and no file to read, and on a phone this log line is the only
              // way to find out which machine the audio was actually sent to.
              t('网络识别服务 {url}', { url: remote.baseUrl })
            : t('sherpa WebAssembly（CPU）'),
      }),
    )
    // A device that this module has already killed *as often as is conclusive* does
    // not need another demonstration. A killed page cannot report anything, so all
    // a retry can produce is another silent crash — refuse in words, and say why.
    // Keyed by accelerator: two GPU crashes say the GPU is unusable, not that the
    // module is.
    //
    // Two kills settle it on a device that might have been unlucky; on Apple mobile
    // one does, because there the module is bigger than the page budget rather than
    // merely near it (see `moduleTooBigForDevice`) — and every extra demonstration
    // costs the user their whole page, including whatever they were reading. The GPU
    // keeps its own count-2 rule: a WebGPU crash says nothing about whether the CPU
    // could run the same module, and it is not the memory path this is about.
    const crashes = asrCrashCount(module, accelerator)
    const conclusive = accelerator !== 'webgpu' && moduleTooBigForDevice(moduleSpec(module)) ? 1 : 2
    if (crashes >= conclusive) {
      throw new Error(
        accelerator === 'webgpu'
          ? t('这台设备已经在显卡加速（WebGPU）下被关掉页面两次了：请在设置里把「显卡加速」改成 CPU 再试')
          : conclusive === 1
            ? t('{module}在这台设备上装不下：上次启动它时，系统直接把整个页面关掉了（内存不够）。手机上改用英文模块，中文留给电脑。', {
                module: moduleName(module),
              })
            : t('{module}在这台设备上装不下：已经两次在启动时把整个页面关掉了（内存不够），先别试了', {
                module: moduleName(module),
              }),
      )
    }
    // A new install starts the bar over; without this the dialog would open
    // showing the last install's 100%.
    const lastFraction = { value: 0 }
    this.model.set({ status: t('准备识别模块'), progress: 0 })
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
        status: progress.status || prev?.status || t('准备识别模块'),
        progress: fraction ?? prev?.progress,
        loadedBytes: progress.loaded ?? prev?.loadedBytes,
        totalBytes: progress.total ?? prev?.totalBytes,
      }))
    }
    client.onLoaded = (loaded) => {
      this.model.set(null)
      this.modelModule = module
      this.failure.set(null)
      info('asr', t('识别模块已就绪（{device}）', { device: loaded.device ?? 'unknown' }), {
        [t('原因')]: loaded.reason,
      })
    }
    client.onResult = (result) => this.onAsrResult(result)
    client.onFailed = (where, message, id) => {
      logError(
        'asr',
        where === 'load'
          ? t('识别模块加载失败：{message}', { message })
          : t('识别失败：{message}', { message }),
      )
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
        client.load(module, plan, remote),
        MODEL_LOAD_TIMEOUT_MS,
        t('下载太久没动静，检查网络后重试'),
      )
      clearAsrAttempt()
      // It loaded, so whatever killed the page before was not this device being
      // unable to run the module; a stale count would lock out a working device.
      forgetAsrCrashes(module, accelerator)
    } catch (err) {
      clearAsrAttempt()
      if (spec.remote) {
        // A recogniser that does not answer is not a broken install. Everything
        // this module was reached for — a better model — is an upgrade over a
        // local one that is already here, so an unreachable service costs the
        // session a sentence of explanation and nothing else. The opposite choice
        // (fail the start) would turn the laptop being asleep into "the app is
        // broken", which is the report this whole route exists to avoid.
        await this.fallBackToLocal(module, err instanceof Error ? err.message : String(err))
        return
      }
      throw err
    }
  }

  /**
   * Re-routes a remote module to the local one for the same language.
   *
   * One hop and no more: the target is `localModuleIdFor`, which is defined by the
   * device rather than by the settings, so it cannot be remote again. Saying so out
   * loud matters in a classroom — a transcript that quietly changes model has a
   * different error profile, and the next person reading the log needs to know why.
   *
   * On Apple's mobile there is no hop at all (see `mayFallBackToLocal`): the local
   * Korean answer there is the small model this route was built to stop using, so
   * the failure is reported instead. The sentence carries both halves — what is
   * wrong, and the two ways to get a session back — because the alternative to a
   * fallback has to be a *visible* choice, not a hunt through settings.
   */
  private async fallBackToLocal(module: ModuleId, reason: string): Promise<void> {
    const local = localModuleIdFor(moduleSpec(module).lang)
    if (local === module) throw new Error(reason)
    if (!mayFallBackToLocal()) {
      throw new Error(
        t(
          '网络识别服务用不了：{reason}。这台设备不退回本机模型：把服务调通，或者在设置里把「识别走哪里」改成「只用本机模型」。',
          { reason },
        ),
      )
    }
    warn('asr', t('{module}用不了，改用本机模型：{reason}', { module: moduleName(module), reason }))
    // The reason comes last, after the sentence, because it is the part that is a
    // raw detail rather than prose — and because a reason that already carries its
    // own parentheses (`连不上识别服务（…）`) would nest them here.
    this.notice.set(t('网络识别服务用不了，这一场改用本机模型：{reason}', { reason }))
    // The failure state above the button would otherwise keep saying the module
    // could not be prepared while the model that just replaced it is running.
    this.failure.set(null)
    return this.prepare(local)
  }

  async start(): Promise<void> {
    if (get(this.state) === 'recording') return
    // A start answers the "come back after the system took the microphone" state
    // whether the user asked for it or the app did.
    this.resumeAfterLoss = false
    // The moment the note is *about*, stamped here rather than when it is filed:
    // a session can be paused, resumed and ended twenty minutes later, and the
    // title of the note must say when the lecture started.
    this.startedAt = Date.now()
    this.state.set('preparing')
    this.stopping = false
    // A failure from the previous attempt must not linger above the button.
    this.notice.set('')
    this.failure.set(null)
    const abort = new AbortController()
    this.startAbort = abort
    try {
      const settings = getSettings()
      // Resolved once, here: `auto` depends on the device, and asking twice must
      // not be able to answer differently (the check below compares against the
      // same value the load was started with).
      const wanted = moduleIdFor(settings.sourceLang)
      if (this.modelModule !== wanted) {
        this.stage.set(t('正在加载识别模块'))
        this.model.set({ status: t('准备识别模块') })
        await this.prepare(wanted)
        // `null`, not `!== wanted`: `prepare` may have delivered the *local* module
        // for this language instead (see `fallBackToLocal`), and a resident model is
        // what this check is actually about. Comparing against `wanted` would turn
        // a working fallback into "the module could not be installed".
        if (this.modelModule === null) {
          // Never "go and read the log drawer": that drawer only exists in debug
          // mode, so on a phone the old sentence was a dead end. The reason
          // itself travels to the status bar instead.
          const reason = get(this.failure)?.message
          throw new Error(
            reason
              ? t('识别模块没能装好：{reason}', { reason })
              : t('识别模块没能装好，再试一次'),
          )
        }
      }
      this.stage.set(t('正在连接翻译服务'))
      await this.probeProviders()

      this.vad = new VadWorkerClient()
      this.vad.configure({
        silenceMs: settings.silenceMs,
        minSegMs: settings.minSegMs,
        maxSegMs: settings.maxSegMs,
        coalesceMs: this.coalesceMs(),
      })
      this.vad.onSegment = (segment) => this.onSegment(segment)
      this.vad.onLevel = (level) => this.level.set(level)
      this.vad.onRecording = (info) => {
        this.recording.set(info)
        if (info.stopped === 'limit') this.notice.set(t('录音已达上限，后面的不再保存'))
        else if (info.stopped === 'error') this.notice.set(t('录音中断了，语音识别不受影响'))
      }
      this.vad.setRecordingLimit(settings.audioRetentionMin)
      // Recording is what makes every later decision reversible: a sentence the
      // pipeline skips can still be re-cut from the file and recognised.
      if (settings.keepAudio) this.vad.startRecording()
      else this.vad.attachRecording()

      // The module that ended up resident — which is `wanted` unless the network
      // route fell back to the local model, and the client has to match it.
      this.ensureAsrClient(this.modelModule ?? wanted)
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

      // Speech is armed by the tap itself, not here — see `unlockSpeech`.

      this.stage.set(t('正在准备麦克风'))
      // The screen lock goes on *before* the microphone is opened, and the order
      // matters: on a phone the permission prompt is the longest wait in this
      // method, and a screen that locks while it is up costs the whole start.
      await this.keepScreenOn()
      this.capture = await startCapture({
        onChunk: (chunk, rate) => this.vad?.push(chunk, rate),
        signal: abort.signal,
      })
      if (!this.capture.constraintsHonoured) {
        this.notice.set(t('浏览器降低了录音质量，识别可能差一点'))
      }

      // An open microphone flips iOS into the `play-and-record` audio session,
      // and that is the state in which Safari demotes system speech — the read-out
      // either goes to the receiver at a whisper or is not heard at all, with no
      // error anywhere. Printing the session type next to the speaking state is
      // what makes that theory checkable from a phone (see `tts/speech.ts`).
      info('tts', t('开麦后的语音输出状态'), { [t('引擎')]: this.speech.label, ...speechSnapshot() })

      this.stage.set('')
      // The clock starts with the microphone, not with the button: a session that
      // spent a minute downloading a module was not recording for that minute.
      this.elapsedMs = 0
      this.runningSince = Date.now()
      this.state.set('recording')
      this.startLagLoop()
      // The microphone is alive *now*; this is what notices when it stops being so
      // without telling anyone (see `checkCapture`).
      this.startCaptureWatch()
      // Not the bare 开始录音: that is the record button's label, and one string
      // cannot be both a button and a log line in a language where the two read
      // differently ("Start recording" against "Recording started").
      info('session', t('开始录音了'), {
        [t('源语言')]: settings.sourceLang,
        [t('目标语言')]: settings.targetLang,
      })
    } catch (err) {
      await this.teardown()
      if (isAbort(err)) {
        // The user gave up while the permission prompt was open: that is not a
        // failure, and no error should be shouted about it.
        this.stage.set('')
        this.state.set('idle')
        this.notice.set(t('已取消启动'))
        info('session', t('已取消启动'))
        return
      }
      this.stage.set('')
      this.state.set('error')
      const message = err instanceof Error ? err.message : String(err)
      logError('session', t('启动失败：{message}', { message }))
      this.notice.set(message)
      throw err
    }
  }

  /**
   * Stops listening without ending the session.
   *
   * The microphone is released and the recording keeps its shape: the segmenter
   * stays where it is, the open utterance is closed and recognised, and the file
   * the sink is writing stays open. Resuming reopens the microphone and the next
   * samples land after the ones already written, so a note recorded across a pause
   * is one recording with a stretch of silence in it — which is what actually
   * happened: the room went quiet for a while.
   *
   * The state is set *before* the capture is torn down, and that order is the
   * point: `checkCapture`'s once-a-second watch reads it, and a pause that looked
   * like a microphone that had died would be "repaired" by reopening the device
   * the user just asked to close.
   */
  async pause(): Promise<void> {
    if (get(this.state) !== 'recording') return
    // Bank the stretch that just ended, before anything can change the state:
    // this is the number the pause panel's clock is about to draw.
    this.elapsedMs += this.runningSince ? Date.now() - this.runningSince : 0
    this.runningSince = 0
    this.state.set('paused')
    this.stopCaptureWatch()
    await this.releaseScreenLock()
    // Close the utterance that is open, so the last thing said before the pause is
    // recognised now rather than waiting for a resume that may never come (the
    // panel behind this pause offers to file the note instead).
    this.vad?.flush()
    await this.stopCapture()
    info('session', t('已暂停录音'), { lines: get(this.lines).length })
  }

  /**
   * Opens the microphone again, in the same session.
   *
   * A failed reopen leaves the session paused rather than stopped: the transcript,
   * the recording and the note are all still there, the panel that offers to file
   * them is still on screen, and the one thing the user cannot do is carry on
   * listening — which is exactly what the state says.
   */
  async resume(): Promise<void> {
    if (get(this.state) !== 'paused') return
    this.runningSince = Date.now()
    this.state.set('recording')
    try {
      await this.keepScreenOn()
      const abort = this.startAbort ?? (this.startAbort = new AbortController())
      this.capture = await startCapture({
        onChunk: (chunk, rate) => this.vad?.push(chunk, rate),
        signal: abort.signal,
      })
      if (!this.capture.constraintsHonoured) {
        this.notice.set(t('浏览器降低了录音质量，识别可能差一点'))
      }
      this.startCaptureWatch()
      info('session', t('已继续录音'))
    } catch (err) {
      this.state.set('paused')
      const message = err instanceof Error ? err.message : String(err)
      this.notice.set(message)
      warn('capture', t('继续录音失败：{message}', { message }))
      throw err
    }
  }

  /**
   * Throws the transcript away, for the start of a note that is not this one.
   *
   * Called by 开启新录音 and by nothing else: every other start *continues* the
   * transcript, because a stop and a start in the same lesson is one lesson. What
   * makes this different is that the note it belonged to has just been filed —
   * the text is in the history, and leaving it on screen would make the next
   * note look like it had been recorded at the same time as the last one.
   */
  resetTranscript(): void {
    this.lines.set([])
    this.linesById.clear()
    this.nextLineId = 1
    this.readPointer = 1
    this.recordingFile = null
    this.recording.set({ mode: 'off', seconds: 0, bytes: 0, stopped: null })
    this.updateQueues()
  }

  /** When this session started, epoch ms; 0 before the first start. */
  get startedAtMs(): number {
    return this.startedAt
  }

  /**
   * How long this session has been recording, in seconds.
   *
   * Owned here rather than counted inside the clock that draws it, because a
   * session can now be paused: the header's clock and the pause panel's are the
   * same number on two screens, and a clock that counted from the moment its own
   * component was built would say 00:00 on the panel it was just mounted in, and
   * would start over from zero after 继续录音.
   */
  elapsedSeconds(): number {
    const running = this.runningSince ? Date.now() - this.runningSince : 0
    return (this.elapsedMs + running) / 1000
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    // A stop the user asked for is the end of it. Only a session the system ended
    // is brought back by `maybeResumeAfterLoss`, and this is the line that keeps
    // the two from being confused — the involuntary path sets the flag again after
    // this returns.
    this.resumeAfterLoss = false
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
      info('session', t('已停止录音'), { lines: get(this.lines).length })
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
   * Holds a screen wake lock for as long as the session runs, and re-takes it every
   * time the page comes back to the foreground.
   *
   * A phone locks its screen a minute after the last touch, and on iOS that is the
   * end of the recording: the page is frozen and the audio session underneath it is
   * taken away. Nobody touches the screen during a lesson — being left alone is the
   * point of the app — so this is the failure a classroom meets first. See
   * `app/wakelock.ts` for what the API will and will not do.
   *
   * The `visibilitychange` listener is the second half of it: the browser drops the
   * lock every time the page hides, so it has to be asked for again on the way back
   * — and since the page is coming back anyway, that is also where the microphone is
   * checked, because a page that went away may have lost it.
   */
  private async keepScreenOn(): Promise<void> {
    const keeper = keepScreenAwake({
      onIssue: (issue) => {
        // The keeper can outlive the session by an event — a revocation can land
        // while `stop` is still draining — and a sentence about screen locks for a
        // recording that has already ended would be worse than silence.
        // `this.wake` is what says a session is still running.
        if (!this.wake) return
        this.notice.set(wakeLockAdvice(issue))
      },
    })
    this.wake = keeper
    document.addEventListener('visibilitychange', this.onVisibility)
    await keeper.acquire()
  }

  /**
   * Gives the screen back.
   *
   * Every way out of a session goes through `teardown`, so this is called from
   * there and nowhere else: a lock nobody released would keep a phone in a pocket
   * awake until the page was closed, which is a worse favour than the one it does.
   */
  private async releaseScreenLock(): Promise<void> {
    const keeper = this.wake
    this.wake = null
    document.removeEventListener('visibilitychange', this.onVisibility)
    await keeper?.release()
  }

  /**
   * The page came back.
   *
   * The wake lock is re-taken first, because the screen will lock again a minute
   * from now and this is the only place the whole thing can be stopped from
   * repeating. Then the microphone — the lock means this usually has nothing to do,
   * but it is not the only way a page goes away: a manual lock, a phone call, Low
   * Power Mode switching itself on.
   */
  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return
    void this.wake?.acquire()
    if (get(this.state) === 'recording') void this.reviveCapture()
    // A session the *system* ended is one the user still expects to be running, so
    // coming back is where it starts again by itself.
    this.maybeResumeAfterLoss()
  }

  /**
   * Watches the microphone for as long as the session records.
   *
   * Both halves of the failure are here. iOS can take the device away from a page
   * that is still on screen — a call, another app, the system deciding — and then
   * the track ends or the audio context stops with no event and no error. Left
   * alone, the interface goes on saying "recording" over silence, which is the one
   * failure this app exists to prevent: the session looks alive and the transcript
   * quietly ends.
   */
  private startCaptureWatch(): void {
    this.stopCaptureWatch()
    this.deadLooks = 0
    this.captureWatch = setInterval(() => void this.checkCapture(), CAPTURE_WATCH_MS)
  }

  private stopCaptureWatch(): void {
    if (this.captureWatch) clearInterval(this.captureWatch)
    this.captureWatch = null
    this.deadLooks = 0
  }

  private async checkCapture(): Promise<void> {
    if (this.stopping) return
    const capture = this.capture
    if (!capture) return
    if (capture.alive()) {
      this.deadLooks = 0
      return
    }
    // Two looks in a row, not one: iOS mutes a track for a moment whenever another
    // audio session takes the route (a notification chime, the read-aloud starting
    // on the same device), and reopening the microphone over a blip would be a
    // worse repair than the blip.
    this.deadLooks += 1
    if (this.deadLooks < 2) return
    // A hidden page is the foreground handler's business, not this one's: the page
    // is likely suspended anyway, and asking iOS for the device from a hidden page
    // is refused outright.
    if (document.visibilityState !== 'visible') return
    this.deadLooks = 0
    await this.reviveCapture()
  }

  /**
   * Ends a session whose microphone the system took away.
   *
   * `stop()` does the teardown — the file is closed, the queues drain, the button
   * goes back to a start — and this is what remembers, *after* that teardown has
   * cleared it, that the end was not the user's. Then it either starts again on the
   * spot (the usual case: the page is visible and the device is back) or leaves the
   * sentence that says when it will.
   */
  private async stopAfterMicrophoneLoss(): Promise<void> {
    warn('capture', t('麦克风被系统收回了，这一场已停下'))
    await this.stop()
    this.resumeAfterLoss = true
    if (!this.maybeResumeAfterLoss()) {
      this.notice.set(
        t('麦克风被系统收回了，录音已停下（录音和文字都保留着）；回到应用会自动重新开始'),
      )
    }
  }

  /**
   * Starts the next session by itself after one the system ended.
   *
   * Returns whether a start was attempted, so the caller knows whether the user
   * still needs the sentence about coming back.
   *
   * Three gates, and each is one of the ways this could go wrong: only an
   * involuntary end sets the flag (a user's stop is an answer, not an accident),
   * the page has to be on screen (iOS refuses the device from a hidden page, and a
   * session that started while nobody was looking would be a surprise), and one
   * restart per cooldown — a microphone that dies again seconds after being
   * reopened must not be reopened in a loop.
   */
  private maybeResumeAfterLoss(): boolean {
    if (!this.resumeAfterLoss) return false
    if (get(this.state) !== 'idle') return false
    if (document.visibilityState !== 'visible') return false
    if (Date.now() - this.lastAutoResumeAt < AUTO_RESUME_COOLDOWN_MS) return false
    this.lastAutoResumeAt = Date.now()
    this.resumeAfterLoss = false
    info('session', t('麦克风被系统收回后，自动重新开始录音'))
    // A failed restart reports itself (`start` sets the error state and the
    // sentence), and swallowing the rejection here is what keeps the automatic
    // path from turning an expected failure into an unhandled one.
    void this.start().catch(() => undefined)
    return true
  }

  /**
   * Checks that the microphone survived the page being away, and repairs it.
   *
   * The samples the page missed were never produced, so nothing can recover them:
   * the only two answers are to carry on with a hole in the recording, or to stop.
   * A session whose microphone is gone is *stopped*, not left running — pressing on
   * would leave the button saying "recording" while the transcript quietly ended,
   * which is the failure this whole app exists to avoid.
   */
  private async reviveCapture(): Promise<void> {
    const capture = this.capture
    // One repair at a time: the watchdog and the return to the foreground both want
    // the microphone back, and two revivals racing would open two devices — one of
    // which nothing would ever close.
    if (!capture || this.reviving) return
    this.reviving = true
    let outcome: CaptureRevival
    try {
      outcome = await capture.revive()
    } catch {
      // `revive` is written not to throw — it reports `failed` instead — and this
      // is what makes a future break of that promise end the session the same way
      // rather than leave an unhandled rejection behind.
      outcome = 'failed'
    } finally {
      this.reviving = false
    }
    if (outcome === 'ok') {
      debug('capture', t('回到前台：麦克风一直在工作'))
      return
    }
    if (outcome !== 'failed') {
      // The hole is real and unrecoverable, and saying so is the difference between
      // a gap the user understands and one they find later as a missing sentence.
      warn('capture', t('息屏期间没有录到声音，麦克风已恢复'), {
        [t('恢复方式')]: outcome === 'resumed' ? t('继续用同一个音频通道') : t('重新打开麦克风'),
      })
      this.notice.set(t('刚才息屏了一小段，那一段没有录到；录音和识别已继续'))
      return
    }
    await this.stopAfterMicrophoneLoss()
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
    // First, and outside any condition: this is the one thing that has to be given
    // back even when everything below it fails.
    await this.releaseScreenLock()
    this.stopLagLoop()
    this.stopCaptureWatch()
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
   * A recognition client is bound to one module, because the engines do not even
   * share a worker kind. Switching to a language served by a *different* module
   * must never silently keep talking to the previous one — but switching between
   * two languages of the same module (zh ↔ ko) keeps the client, and with it the
   * loaded model — and that is the whole point of comparing modules rather than
   * languages.
   */
  private ensureAsrClient(module: ModuleId): AsrWorkerClient {
    if (!this.asr || this.asr.module !== module) {
      this.asr?.dispose()
      this.asr = new AsrWorkerClient(module)
    }
    return this.asr
  }

  /**
   * Releases the recognition model — used when the source language, or the choice
   * of English module, changes. That is a memory decision as much as a correctness
   * one: only one recognizer is ever supposed to be resident.
   */
  async releaseModel(): Promise<void> {
    this.asr?.dispose()
    this.asr = null
    this.modelModule = null
  }

  async dispose(): Promise<void> {
    await this.teardown()
    this.asr?.dispose()
    this.asr = null
    this.linesById.clear()
  }

  // ------------------------------------------------------------------ capture

  /**
   * How much *speech* an utterance needs before it is worth asking a recogniser
   * about, for the module the current source language routes to.
   *
   * The number belongs to the module rather than to the settings, because it is a
   * property of the model: only Moonshine's Korean finetune was measured inventing
   * text out of short input, so every other language routes to a module that
   * returns zero here and sees exactly the segmentation it saw before.
   */
  private coalesceMs(): number {
    return moduleSpec(moduleIdFor(getSettings().sourceLang)).coalesceMs ?? 0
  }

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
          warn('asr', t('识别超时，跳过这一段'), { segment: segment.id })
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
    const flaw = transcriptFlaw(text, getSettings().sourceLang)
    if (flaw) {
      // The other half of "silence is an empty string", which is only true of the
      // English module: a recogniser has no way to say "I did not understand", so
      // the Korean one says something plausible instead (see the guard for the
      // measurements). Refused text goes to the log rather than into the
      // transcript, and the recording still holds the audio — a line dropped here
      // can be re-cut and read again, which is not true of one translated and read
      // aloud.
      warn('asr', t('识别结果是编的，已丢弃这一段：{text}', { text: text.slice(0, 40) }), {
        [t('语音时长')]: (segment.speechMs / 1000).toFixed(1),
        [t('原因')]: flawReason(flaw),
        [t('引擎')]: result.engine,
      })
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
        warn('session', t('记录超过 {n} 行，最旧的已从界面上移除', { n: MAX_LINES }))
        return next.slice(next.length - MAX_LINES)
      }
      return next
    })
    this.mtQ.push(line)
    debug('asr', t('识别完成：{text}', { text: line.text.slice(0, 40) }), {
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
      coalesceMs: this.coalesceMs(),
    })
    this.vad?.setRecordingLimit(settings.audioRetentionMin)
    this.applyMtConfig()
    if (this.preferredProvider === null) {
      this.providerLabel.set(providerName(settings.mtProvider))
      this.provider.set(settings.mtProvider)
    }
    this.rateController.reset(settings.baseRate)
    this.rate.set(settings.baseRate)
    this.syncSpeechEngine()
  }

  /**
   * Swaps the read-aloud engine when the choice changes, and only then.
   *
   * The old engine is stopped first: a chunk still playing belongs to the engine
   * being replaced, and leaving it talking would be the one way this switch could
   * be audible as a bug.
   */
  private syncSpeechEngine(): void {
    const settings = getSettings()
    const key = speechKeyOf(settings)
    if (key === this.speechKey) return
    this.speech.stop()
    this.speechKey = key
    this.speech = createTtsEngine(ttsConfigFrom(settings))
    info('tts', t('朗读引擎切换为{engine}', { engine: this.speech.label }), {
      [t('代理')]: settings.ttsEngine === 'edge' ? settings.ttsProxyUrl : undefined,
    })
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
      this.providerLabel.set(providerName('llm'))
      this.provider.set('llm')
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
    const label = providerName(provider)
    this.providerLabel.set(label)
    this.provider.set(provider)
    for (const result of results) {
      const name = providerName(result.provider)
      // `attempts > 1` is worth saying out loud: it means the first request met a
      // cold connection rather than a broken provider.
      if (result.ok) {
        const suffix =
          result.attempts && result.attempts > 1
            ? t('，第 {n} 次尝试才通', { n: result.attempts })
            : ''
        info('translate', t('{name}可用（{ms} ms{suffix}）', { name, ms: result.ms, suffix }))
      } else {
        warn('translate', t('{name}不可用', { name }), {
          detail: result.detail,
          attempts: result.attempts,
        })
      }
    }
    if (provider !== settings.mtProvider) {
      this.notice.set(t('谷歌翻译用不了，已换成{label}', { label }))
      warn(
        'translate',
        t('已自动从{from}切换到{to}', { from: providerName(settings.mtProvider), to: label }),
      )
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
      debug(
        'translate',
        t('译文（{provider}{cached}）：{text}', {
          provider: result.provider,
          cached: result.cached ? t(' · 缓存') : '',
          text: result.text.slice(0, 40),
        }),
      )
    }
    if (result.text) this.prefetchSpeech(result.text)
    this.advanceReadPointer()
    this.updateQueues()
  }

  /**
   * Starts fetching the read-out for a sentence the moment it has one.
   *
   * A translation is the last thing standing between speech and the reader, so this
   * is the earliest moment audio *can* be requested — and with the Edge engine the
   * request is a round trip that would otherwise be paid in silence between two
   * sentences. The engine decides whether it has anything to fetch (the platform's
   * own speech does not), and nothing here waits on the answer: a prefetch is a
   * head start, not a stage of the pipeline.
   *
   * The same guards as the reader itself, because a prefetch is work done on the
   * user's behalf: nothing is fetched for a line that will not be read, and nothing
   * at all while auto-read is off.
   */
  private prefetchSpeech(text: string): void {
    const prefetch = this.speech.prefetch
    if (!prefetch) return
    if (!get(this.autoRead) || !this.speech.available) return
    const settings = getSettings()
    prefetch.call(this.speech, text, {
      voiceURI: ttsVoiceFor(settings),
      rate: this.rateController.rate,
      lang: settings.targetLang,
    })
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
    if (!this.speech.available) {
      this.markLine(line.id, { ttsState: 'error' })
      return
    }
    const settings = getSettings()
    this.markLine(line.id, { ttsState: 'speaking' })
    // Sampled *before* speaking on purpose: `speak()` resumes a synthesizer the
    // system left paused, so afterwards this reads false whichever way it went.
    // Only the platform engine has this state — the Edge one cannot be paused by
    // the OS at all, it is ordinary media.
    const state = this.speech.id === 'system' ? speechSnapshot() : null
    if (state?.paused) {
      warn('tts', t('系统把朗读留在了暂停状态（切后台或锁屏之后常见），已尝试恢复'), state)
    }
    let outcome: SpeakOutcome = 'error'
    try {
      outcome = await this.speech.speak(text, {
        voiceURI: ttsVoiceFor(settings),
        rate: this.rateController.rate,
        lang: settings.targetLang,
      })
    } catch (err) {
      // The Edge engine rejects with a reason worth keeping (a 502 from the
      // proxy, a DNS failure, no network); the platform engine never throws, it
      // just goes quiet.
      logError('tts', t('朗读请求失败'), {
        [t('引擎')]: this.speech.label,
        [t('原因')]: err instanceof Error ? err.message : String(err),
      })
      outcome = 'error'
    }
    this.markLine(line.id, { ttsState: outcome === 'done' || outcome === 'cancelled' ? 'done' : 'error' })
    if (outcome === 'stalled') {
      // Silence with no error: the engine accepted the work and never called
      // back. Skipping is the only recovery — waiting is what used to wedge the
      // reader for the rest of the session.
      logError('tts', t('朗读没有等到结束回调，这句跳过'), {
        [t('文本')]: text.slice(0, 30),
        [t('引擎')]: this.speech.label,
        ...(state ?? {}),
      })
      this.notice.set(t('朗读卡住了（这句已跳过）；一直没声音就刷新页面再试'))
    } else if (outcome === 'error') {
      logError('tts', t('朗读失败'), {
        [t('文本')]: text.slice(0, 30),
        [t('引擎')]: this.speech.label,
        ...(state ?? {}),
      })
      const edge = settings.ttsEngine === 'edge'
      const voices = await this.speech.voicesFor(settings.targetLang).catch(() => [])
      if (voices.length === 0) {
        this.notice.set(
          edge
            ? t('TTS 代理没有可用音色：检查设置里的代理地址')
            : t('手机里没有这种语言的朗读声音'),
        )
      } else {
        this.notice.set(
          edge
            ? t('Edge TTS 代理连不上了：检查网络和设置里的代理地址')
            : t('朗读被系统拒绝了：先点一下页面，再确认侧面的静音开关'),
        )
      }
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
      debug(
        'tts',
        t('朗读语速调整为 {rate}x（积压 {n} 句）', { rate: rate.toFixed(2), n: this.readQ.size }),
      )
    }
  }

  /**
   * Arms speech output, and it has to happen *inside* a user gesture (see
   * `TtsEngine.unlock`) — hence a method here for the tap handler to call,
   * rather than a call inside `start()`, which reaches the speech engine only
   * after the model download and the translator probe have awaited the gesture
   * away.
   */
  unlockSpeech(): void {
    this.speech.unlock(getSettings().targetLang)
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
    info('tts', t('已跳到最新，放弃 {n} 句待读内容', { n: skipped }), { pendingInWorker })
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
      this.notice.set(t('这句没有录音，无法重新识别'))
      return
    }
    const id = this.nextRetryId--
    info('asr', t('从录音重新识别这一句（{sec} 秒）', { sec: (samples.length / 16000).toFixed(1) }))
    const result = await this.recognizeSamples({
      id,
      startMs: line.startMs,
      endMs: line.endMs,
      // This range was cut out of the recording on purpose, so all of it counts as
      // speech as far as anything downstream is concerned — nothing analysed it.
      speechMs: line.endMs - line.startMs,
      samples,
    })
    const text = result.text.trim()
    if (!text) {
      this.notice.set(t('重新识别没有听出内容'))
      return
    }
    if (transcriptFlaw(text, getSettings().sourceLang)) {
      // Same reason as the live path: don't overwrite a real line with an invented
      // one. A shorter range is what fixes this, so say that instead of nothing.
      this.notice.set(t('重新识别只听到模型编的内容，没有采用：换个长一点的范围'))
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
      if (!translation) throw new Error(t('翻译没有返回内容'))
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
      warn('translate', t('重新翻译失败：{message}', { message }))
    }
    this.updateQueues()
  }

  /**
   * The session's audio as a blob, wherever it currently lives.
   *
   * From the worker while a session is running, and from the copy the main thread
   * took when it stopped — the worker is gone by then, and the recording is not.
   */
  async recordingBlob(): Promise<Blob | null> {
    return this.vad ? await this.vad.recordingFile() : this.recordingFile
  }

  /** Downloads the session recording as a WAV, wherever it currently lives. */
  async exportRecording(): Promise<void> {
    const file = await this.recordingBlob()
    if (!file) {
      this.notice.set(t('还没有录音可以导出'))
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
    info('storage', t('已导出录音（{mb} MB）', { mb: (file.size / 1024 / 1024).toFixed(1) }))
  }

  async clearRecording(): Promise<void> {
    this.recordingFile = null
    if (this.vad) await this.vad.clearRecording()
    else await deleteRecordingFile()
    this.recording.set(this.vad ? get(this.recording) : { mode: 'off', seconds: 0, bytes: 0, stopped: null })
    info('storage', t('已删除录音'))
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
    info('session', t('等待流水线清空超时，剩余内容已放弃'))
  }
}
