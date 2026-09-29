/// <reference lib="webworker" />
import type { AsrEngine, AsrLoadProgress, Lang, ModuleId } from '../lib/types'
import type { DevicePlan } from '../lib/asr/moonshine'
import type { RemoteAsrConfig } from '../lib/asr/koasr'
import { createEngine } from '../lib/asr/router'
import { setUiLang, t } from '../lib/i18n/index.ts'

/**
 * Recognition worker.
 *
 * Two things live here that must not move to the main thread:
 *  - inference itself (a phone on WebGPU or WASM will happily eat an entire
 *    core for the duration of a segment);
 *  - model lifecycle, because loading a 60–240 MB model must never block
 *    rendering.
 *
 * Recognition requests are chained rather than parallelised: `segQ` guarantees
 * the order utterances were spoken in, and the transcript must come out in that
 * same order (requirement 5).
 */

let engine: AsrEngine | null = null
let chain: Promise<void> = Promise.resolve()

type Inbound =
  | {
      type: 'load'
      /** Which module to load — a language is not enough, `zh` serves `ko` too. */
      module: ModuleId
      /** Device decision made on the main thread; see `DevicePlan`. */
      plan: DevicePlan | null
      /**
       * Address and language for a module that is a *service* rather than a
       * download; `null` for every other module. Sent with the request for the same
       * reason as `plan`: the settings live on a thread this one is not.
       */
      remote?: RemoteAsrConfig | null
      /**
       * The interface language, which has to be sent over: a worker is a separate
       * thread with its own copy of the i18n module, so without it every line this
       * worker writes — the load progress, the plan's reasons, the failures — would
       * come out in whatever language the *browser* is set to instead of the one
       * the user picked.
       */
      uiLang?: Lang
    }
  | { type: 'recognize'; id: number; samples: Float32Array; startMs: number; endMs: number }
  | { type: 'dispose' }

self.onmessage = (event: MessageEvent) => {
  const msg = event.data as Inbound
  switch (msg.type) {
    case 'load':
      if (msg.uiLang) setUiLang(msg.uiLang)
      chain = chain.then(() => handleLoad(msg.module, msg.plan, msg.remote ?? null))
      break
    case 'recognize':
      chain = chain.then(() => handleRecognize(msg.id, msg.samples, msg.startMs, msg.endMs))
      break
    case 'dispose':
      chain = chain.then(() => {
        engine?.dispose()
        engine = null
        postMessage({ type: 'disposed' })
      })
      break
  }
}

async function handleLoad(
  module: ModuleId,
  plan: DevicePlan | null,
  remote: RemoteAsrConfig | null,
): Promise<void> {
  // Compared by module, not by language: one module serves two languages, so
  // treating "still Chinese" as "still loaded" would rebuild a model that already
  // answers Korean as well.
  if (engine && engine.module === module && engine.ready) {
    postMessage({ type: 'loaded', module, device: 'cached', reason: t('模型已在内存中') })
    return
  }
  engine?.dispose()
  engine = null
  try {
    const next = createEngine(module, plan, remote)
    const info = await next.load((progress: AsrLoadProgress) => {
      postMessage({ type: 'load-progress', module, ...progress })
    })
    engine = next
    postMessage({ type: 'loaded', module, ...info })
  } catch (err) {
    postMessage({
      type: 'error',
      where: 'load',
      module,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleRecognize(
  id: number,
  samples: Float32Array,
  startMs: number,
  endMs: number,
): Promise<void> {
  if (!engine || !engine.ready) {
    postMessage({ type: 'error', where: 'recognize', id, message: t('识别模块还没准备好') })
    return
  }
  try {
    const result = await engine.recognize(samples)
    postMessage({
      type: 'result',
      id,
      startMs,
      endMs,
      text: result.text,
      rawText: result.rawText,
      engine: result.engine,
      inferMs: result.inferMs,
      durationMs: Math.round((samples.length / 16000) * 1000),
    })
  } catch (err) {
    postMessage({
      type: 'error',
      where: 'recognize',
      id,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
