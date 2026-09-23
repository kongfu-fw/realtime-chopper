/// <reference lib="webworker" />
import type { AsrEngine, AsrLoadProgress, Lang } from '../lib/types'
import type { DevicePlan } from '../lib/asr/moonshine'
import { createEngine } from '../lib/asr/router'

/**
 * Recognition worker.
 *
 * Two things live here that must not move to the main thread:
 *  - inference itself (a phone on WebGPU or WASM will happily eat an entire
 *    core for the duration of a segment);
 *  - model lifecycle, because loading a 60–230 MB model must never block
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
      lang: Lang
      /** Device decision made on the main thread; see `DevicePlan`. */
      plan: DevicePlan | null
    }
  | { type: 'recognize'; id: number; samples: Float32Array; startMs: number; endMs: number }
  | { type: 'dispose' }

self.onmessage = (event: MessageEvent) => {
  const msg = event.data as Inbound
  switch (msg.type) {
    case 'load':
      chain = chain.then(() => handleLoad(msg.lang, msg.plan))
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

async function handleLoad(lang: Lang, plan: DevicePlan | null): Promise<void> {
  if (engine && engine.lang === lang && engine.ready) {
    postMessage({ type: 'loaded', lang, device: 'cached', reason: '模型已在内存中' })
    return
  }
  engine?.dispose()
  engine = null
  try {
    const next = createEngine(lang, plan)
    const info = await next.load((progress: AsrLoadProgress) => {
      postMessage({ type: 'load-progress', lang, ...progress })
    })
    engine = next
    postMessage({ type: 'loaded', lang, ...info })
  } catch (err) {
    postMessage({
      type: 'error',
      where: 'load',
      lang,
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
    postMessage({ type: 'error', where: 'recognize', id, message: '识别模块还没准备好' })
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
