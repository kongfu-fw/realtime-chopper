import type { AsrEngine, AsrResult, Lang, ModuleId } from '../types'
import { t } from '../i18n/index.ts'
// `.ts` on both of these, like every relative import in the modules a test can
// reach: `node --test` strips types rather than compiling them, and its resolver
// takes the specifier literally. See `messages.test.ts` for the same convention.
import { pcmToWav } from '../audio/recorder.ts'
import { moduleSpec } from './models.ts'

/**
 * koasr: a recogniser on the other end of a socket.
 *
 * `../kuakuaASR` — FastAPI + uvicorn in front of faster-whisper (CTranslate2, CPU
 * int8) running `ghost613/faster-whisper-large-v3-turbo-korean`, a Korean finetune
 * of Whisper large-v3-turbo. The service transcribes *files*, so this engine sends
 * one: `POST {base}/v1/transcriptions` as `multipart/form-data`, with the segment as
 * a WAV, and reads the JSON back.
 *
 * ## Why this route, out of the three the service offers
 *
 * The multipart one is the only one that takes a file, which is what a
 * `SpeechSegment` is once `pcmToWav` has written a header — and `FormData` is the
 * browser's own multipart encoder, so nothing here hand-rolls a boundary. The
 * async route (`POST /v1/jobs`) transcribes the same bytes and adds a poll per
 * utterance, which on a 4-second round trip is a second round trip nobody asked
 * for; it exists for lecture files, and this app already has its own segmenter.
 * (The previous service on this port had a third, raw-binary route
 * `POST /v1/asr`, and DOCS.md used to name it — it is gone, along with the health
 * path `/health`, which is `/healthz` here.)
 *
 * ## `vad_filter` is pinned, and that is a finding rather than a default
 *
 * The service's own Silero VAD is what stands between an utterance and the
 * hallucination class this project already fought on the local Korean model. Both
 * halves were measured on the running service, against 2.0 s of digital silence:
 *
 *   vad_filter=true   ->  `""` in 0.04 s
 *   vad_filter=false  ->  `홍 사장의 발언에 국감장이 술렁이자 조정식의…` in 8.8 s
 *
 * That second line is the whole reason this field is sent instead of left to the
 * service's configuration: a fabricated sentence, slower than a real one, and
 * nothing on screen to say it was invented. Pinning it means the app's behaviour
 * cannot be changed by an environment variable on the other machine. It costs
 * nothing real — a 1.1 s utterance still transcribes with the filter on.
 *
 * ## What it is not
 *
 * It is not a second pipeline. Everything downstream of a recogniser — the
 * transcript guard, the queues, the translation, the read-out — is unchanged, and
 * that is the point: an engine is chosen by a table entry (`ASR_MODULES['ko-net']`),
 * so the route to the network is the same route as a download. See `router.ts`.
 *
 * ## The cost is a constant, not a rate
 *
 * Measured against the service on this project's machine (2 slots, one request in
 * flight): 2.3 s of audio -> 4.3 s, 7.9 s -> 4.6 s, 18.5 s -> 5.2 s. Whisper pads
 * every input to its 30 s window and the encoder runs over all of it, so most of
 * that is a *fixed* cost per request and the audio length barely matters. Three
 * consequences, all of them already acted on: `coalesceMs` on this module merges
 * short utterances into one round trip, the request budget below is dominated by
 * its floor rather than by its slope, and the quiet failure of a *long* utterance
 * is not the timeout — it is the queue.
 *
 * Re-measured ten minutes later, on the same machine and the same way: 6.1 s, 6.5 s
 * and 7.4 s for the same three clips. The *shape* is the point and it held (the
 * length of the audio still costs very little), but the level moved by about 40% —
 * this is one process on one CPU, and how warm it is belongs to the machine rather
 * than to the code. Nothing here should be read as a promise of 4 seconds; that is
 * why the budget below is generous and why `queue_depth` is on the health line.
 *
 * ## The one thing that has to be got right is the address
 *
 * This fetch leaves the page, so it inherits everything a fetch is subject to —
 * including a trap in this deployment. The phone opens the app over `https://…`
 * (a microphone needs a secure context; see DOCKER.md), and a page served over
 * HTTPS is not allowed to call `http://…`: the browser refuses before a packet
 * exists, and from JS a refused request and an unreachable server look identical
 * (`TypeError: Failed to fetch`). So the address is checked against the page's own
 * scheme *before* it is used (`addressProblem`) and reported as the deployment
 * mistake it is rather than as “the service is down”. The fix is one command and
 * is written down in DOCS.md: serve the service as a path on the hostname the app
 * is already served from.
 *
 * A second trap used to live in the service rather than in the address, and it is
 * written down here so it does not have to be diagnosed twice: an early version
 * sent no CORS headers, so a *cross-origin* address (a tailnet hostname of its
 * own, or another port on the same host) was refused by the browser even though
 * the request arrived — the service logged a finished transcription and the page
 * reported a network error. It now runs `CORSMiddleware` with `allow_origins`
 * taken from `KOASR_CORS_ORIGINS` (default `*`), measured on the running service:
 * `OPTIONS /v1/transcriptions` answers `200` with `access-control-allow-origin: *`,
 * and so does the POST. Cross-origin is therefore a deployment choice rather than
 * a trap, and `/asr` stays the default because it needs no configuration on either
 * side — not because it is the only address that works. See DOCS.md.
 */

/**
 * Everything the engine needs that it cannot look up itself.
 *
 * It travels from the main thread with the load request, like `DevicePlan` and
 * `uiLang`, for the same reason those do: the engine runs inside a worker, and a
 * worker has no `localStorage` — only the main thread knows what the user
 * configured.
 */
export interface RemoteAsrConfig {
  /**
   * Where the service is, already resolved to an absolute URL — either an
   * `http(s)://host:port` or, for the same-origin deployment, the page's own
   * origin plus a path. See `resolveBaseUrl`.
   */
  baseUrl: string
  /** ISO-639-1, sent as the multipart field `language`. */
  language: string
  /**
   * Floor on how long one request may take, in ms.
   *
   * A floor rather than the value, because the budget has to grow with the audio:
   * `requestTimeoutMs` computes the real one. It exists so a service configured to
   * be slower than the measurements here does not have to be recompiled, and it is
   * deliberately below the session's own 30 s recognise timeout — see there.
   */
  timeoutMs: number
}

/** The sync transcription route: one file in, one transcript out. */
const TRANSCRIBE_PATH = '/v1/transcriptions'
/** The health route, which is how a load finds out whether anything is there. */
const HEALTH_PATH = '/healthz'

/** Every segment in this app is 16 kHz mono (`SpeechSegment`). */
const SAMPLE_RATE = 16000

/**
 * How long the *connection* check may take before the service counts as absent.
 *
 * Short on purpose, and much shorter than a recognition: the decision it feeds is
 * “fall back to the local model”, and either way someone is standing in a
 * classroom waiting. A machine on the same network answers a `GET` immediately or
 * not at all.
 */
const HEALTH_TIMEOUT_MS = 8000

/** Ceiling for one recognition, whatever its length. */
const MAX_REQUEST_TIMEOUT_MS = 25_000
/** Floor for one recognition: a short clip still pays the service's fixed cost. */
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000

/**
 * How long a request carrying this much audio is allowed.
 *
 * The measurements behind the shape, taken against the running service (see the
 * header): 2.3 s of audio costs 4.3 s, 7.9 s costs 4.6 s, 18.5 s costs 5.2 s. So
 * the honest model is “about five seconds, plus very little”, and the budget is
 * generous against it — which is deliberate, because the numbers were taken on an
 * idle service with one request in flight, and the two ways this gets slower (a
 * queue on the far side, a machine busy with something else) are invisible from
 * here. A budget that fires is a *lost sentence*, so the floor is what short
 * utterances get and the growing term is slack rather than a model of the cost.
 *
 * The ceiling sits below the session's own 30 s recognise timeout on purpose. A
 * slow service should produce *this* engine's sentence (“the service did not
 * answer in time”), logged against the segment, rather than nothing at all —
 * which is what the session's timeout resolves to.
 */
export function requestTimeoutMs(
  sampleCount: number,
  floorMs = DEFAULT_REQUEST_TIMEOUT_MS,
): number {
  const durationMs = (sampleCount / SAMPLE_RATE) * 1000
  return Math.round(
    Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(floorMs, 6000 + durationMs * 2)),
  )
}

/**
 * Why this address cannot be called from this page, or `null` when it can.
 *
 * Worth its existence because the failure it catches is otherwise unreadable: the
 * browser blocks the request as mixed content, `fetch` rejects, and every
 * explanation the app could offer (“服务没开” / “网络不通” / “地址写错了”) is wrong.
 * It is an incompatibility between the address and how the app was opened, and it
 * has one fix.
 *
 * An empty address is reported separately, because “nothing is configured” and
 * “what you configured cannot work” need different sentences.
 */
export function addressProblem(baseUrl: string, pageProtocol: string): 'empty' | 'insecure' | null {
  const url = baseUrl.trim()
  if (!url) return 'empty'
  if (pageProtocol === 'https:' && /^http:\/\//i.test(url)) return 'insecure'
  return null
}

/**
 * A configured address, as an absolute URL with no trailing slash.
 *
 * Relative paths are accepted on purpose (`/asr`), and they are the recommended
 * form: resolved against the page's own origin they cannot be mixed content and
 * need no CORS header from anyone, so the only deployment that has to be trusted
 * is the one already serving the app.
 *
 * The `origin` is handed in rather than read from `location` here: inside a worker
 * that is the same origin, but the caller is the only place that knows which page
 * this app is, and one place deciding that is one place to be wrong.
 */
export function resolveBaseUrl(baseUrl: string, origin: string): string {
  const url = baseUrl.trim()
  if (!url) return origin.replace(/\/+$/, '')
  return new URL(url, origin).toString().replace(/\/+$/, '')
}

/**
 * The config for a module, or `null` when that module is not a remote one.
 *
 * Called on the main thread, next to the settings, so that the worker never has
 * to know what a setting is — it receives an address and a language, the same way
 * it receives a `DevicePlan` instead of deciding which accelerator to use.
 */
export function remoteConfigFor(
  module: ModuleId,
  baseUrl: string,
  origin: string,
): RemoteAsrConfig | null {
  const spec = moduleSpec(module)
  if (!spec.remote) return null
  return {
    baseUrl: resolveBaseUrl(baseUrl, origin),
    language: spec.lang,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  }
}

/**
 * A `fetch` that always settles, and says why when it did not.
 *
 * Every caller is inside a queue somebody is watching. An abort signal that never
 * fires and a promise that never settles are the same bug from the outside, so
 * the deadline is not optional — and neither is turning our own abort into a
 * sentence, because `AbortError` on screen would be indistinguishable from the
 * browser's mixed-content refusal.
 */
async function fetchWithTimeout(
  url: string,
  ms: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(t('识别服务 {sec} 秒没有回应', { sec: Math.round(ms / 1000) }))
    }
    // A request that never left the page fails with the browser's own words —
    // `Failed to fetch`, or `fetch failed` outside one — which name neither what
    // failed nor what to do about it. Ours says what it was, and *keeps* the raw
    // text, because that text is the only thing that tells "the service is off"
    // apart from "the address is wrong" apart from "DNS is not resolving" — and on
    // a phone it is the only copy of it anyone can read.
    throw new Error(
      t('连不上识别服务（{reason}）', { reason: err instanceof Error ? err.message : String(err) }),
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What `/healthz` says, reduced to the parts that are used.
 *
 * The full body also carries `active_jobs`, `jobs_completed`, `jobs_failed` and
 * `uptime_s`; the app has no use for a counter of a machine's whole life, but
 * `queue_depth` is worth a log line: it is the number that explains a request that
 * took longer than the ones before it.
 */
interface HealthInfo {
  status?: string
  engine?: string
  model_id?: string
  queue_depth?: number
}

/** What `/v1/transcriptions` says with `response_format=json`. */
interface TranscriptResponse {
  text?: string
  language?: string
  duration?: number
}

/**
 * The service's error message, from FastAPI's `detail`.
 *
 * Two shapes arrive on the same field, and both are real: our own failures are a
 * string (`"EngineError: transcription failed: …"`), while a rejected form is an
 * array of validation objects. Anything else — an HTML error page from a proxy, an
 * empty body — returns `''`, and the caller falls back to the status code, which is
 * still better than printing `[object Object]` at a teacher.
 */
async function errorDetail(response: Response): Promise<string> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return ''
  }
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        item && typeof item === 'object' && 'msg' in item ? String((item as { msg: unknown }).msg) : '',
      )
      .filter(Boolean)
      .join('；')
  }
  return ''
}

export class KoasrEngine implements AsrEngine {
  readonly id = 'koasr'
  readonly module: ModuleId
  readonly lang: Lang
  private connected = false
  /** The service's own name for the weights it loaded; shown as the log's dtype. */
  private model = ''
  /** Assigned rather than a parameter property, so `node --test` can load this file. */
  private readonly config: RemoteAsrConfig

  constructor(module: ModuleId, config: RemoteAsrConfig) {
    this.module = module
    this.config = config
    this.lang = moduleSpec(module).lang
  }

  get ready(): boolean {
    return this.connected
  }

  /**
   * “Loading” a service means proving it is there.
   *
   * The health route is what makes the fallback in `session.prepare` possible at
   * all. Without a check *before* the first utterance, an unreachable service
   * would only be discovered one sentence later — with that sentence already lost
   * and the transcript already behind. A `GET /healthz` costs one round trip and
   * answers the same question that first recognition would have.
   */
  async load(onProgress?: (progress: { status: string }) => void): Promise<{
    device?: string
    dtype?: string
    reason?: string
  }> {
    onProgress?.({ status: t('正在连接识别服务') })
    const response = await fetchWithTimeout(`${this.config.baseUrl}${HEALTH_PATH}`, HEALTH_TIMEOUT_MS)
    if (!response.ok) {
      throw new Error(t('识别服务没有就绪（HTTP {status}）', { status: response.status }))
    }
    let info: HealthInfo = {}
    try {
      info = (await response.json()) as HealthInfo
    } catch {
      // A body we cannot read is not a failure to *connect*: the service answered,
      // and answering is the question this method is asking.
      info = {}
    }
    // `draining` is a 200 with a service that has stopped taking work — a
    // restart in progress. Treating it as ready would hand it a session it will
    // refuse, one failed utterance later.
    if (info.status && info.status !== 'ok') {
      throw new Error(t('识别服务正在关闭（{status}）', { status: info.status }))
    }
    this.model = typeof info.model_id === 'string' ? info.model_id : ''
    this.connected = true
    return {
      device: t('网络识别服务'),
      ...(this.model ? { dtype: this.model.split('/').pop() ?? this.model } : {}),
      ...(info.engine
        ? { reason: t('服务在用 {engine}，队列 {depth}', { engine: info.engine, depth: info.queue_depth ?? 0 }) }
        : {}),
    }
  }

  /**
   * One utterance over the wire.
   *
   * The file is a WAV from the same encoder the session recording uses, so what
   * the service receives is bit-for-bit the audio this app decided was a sentence
   * — which is also what makes a bad answer here a statement about the recogniser
   * rather than about a resampling step nobody can see.
   *
   * An empty `text` is returned as an empty string rather than as an error, and
   * that is deliberate: the service's VAD reports a clip it heard no words in that
   * way, in about a fortieth of a second, and it is the same “not worth a line” the
   * pipeline already knows how to handle.
   */
  async recognize(samples: Float32Array): Promise<AsrResult> {
    if (!this.connected) throw new Error(t('识别服务还没连上'))
    const started = performance.now()
    const timeout = requestTimeoutMs(samples.length, this.config.timeoutMs)
    // No `Content-Type` header: `FormData` owns the boundary and the browser (or
    // undici) writes it, and a hand-set one would disagree with the body.
    const form = new FormData()
    form.append('file', pcmToWav(samples), 'segment.wav')
    form.append('language', this.config.language)
    form.append('response_format', 'json')
    // Pinned against a `KOASR_VAD_FILTER=false` on the other machine; the
    // measurements are in the header, and the short version is that this field is
    // the difference between `""` and an invented sentence.
    form.append('vad_filter', 'true')
    const response = await fetchWithTimeout(`${this.config.baseUrl}${TRANSCRIBE_PATH}`, timeout, {
      method: 'POST',
      body: form,
    })
    if (!response.ok) {
      const detail = await errorDetail(response)
      if (detail) throw new Error(t('识别服务出错了：{message}', { message: detail }))
      throw new Error(t('识别服务出错了（HTTP {status}）', { status: response.status }))
    }
    let body: TranscriptResponse
    try {
      body = (await response.json()) as TranscriptResponse
    } catch {
      throw new Error(t('识别服务返回了看不懂的内容'))
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    return {
      text,
      rawText: text,
      // The language is in the engine name because the service can be pointed at
      // other weights, and a log line saying only `koasr` would make two different
      // recognisers look like one.
      engine: `koasr-${this.lang}`,
      inferMs: Math.round(performance.now() - started),
    }
  }

  dispose(): void {
    // Nothing is held to release: no session, no weights, no socket of our own.
    // The next load probes again, which is the right answer for a service that can
    // be restarted between two sessions — and it is also why `releaseModel` costs
    // nothing on this path.
    this.connected = false
    this.model = ''
  }
}
