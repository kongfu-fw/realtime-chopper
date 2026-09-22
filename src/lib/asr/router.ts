import type { AsrEngine, Lang } from '../types'
import { moduleFor } from './models'
import { MoonshineEngine } from './moonshine'

/**
 * Routing: the source language the user picked in the title bar decides which
 * single-language model runs.
 *
 * The plan's default of English-source exists precisely so that the first visit
 * downloads ~60 MB instead of the Chinese module's ~380 MB — but the consequence
 * is that the user must switch the source language manually before speaking
 * Chinese or Korean. There is no language auto-detection: the models are
 * monolingual (Moonshine Base, Moonshine Base-KO, a Chinese zipformer CTC), so a
 * wrong guess does not degrade gracefully, it produces nonsense.
 *
 * Only the transformers.js engines are built here. Chinese runs on sherpa-onnx,
 * whose runtime can only be evaluated as a classic script, so it lives in its own
 * worker (static/zh-asr.worker.js) and never reaches this module worker at all.
 */
export function createEngine(
  lang: Lang,
  preference: 'auto' | 'webgpu' | 'wasm',
  precision: 'high' | 'eco',
): AsrEngine {
  const spec = moduleFor(lang)
  if (spec.engine !== 'moonshine') {
    throw new Error(`${lang} 不在本 worker 中运行（${spec.engine} 有自己的 worker）`)
  }
  return new MoonshineEngine(lang, preference, precision)
}
