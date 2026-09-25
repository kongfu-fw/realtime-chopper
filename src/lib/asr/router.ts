import type { AsrEngine, ModuleId } from '../types'
import { moduleSpec } from './models'
import { MoonshineEngine, type DevicePlan } from './moonshine'

/**
 * Routing: which *module* the user's choices selected decides which single
 * engine is built here.
 *
 * The plan's default of English-source exists precisely so that the first visit
 * downloads ~60 MB instead of the Chinese module's ~380 MB — but the consequence
 * is that the user must switch the source language manually before speaking
 * Chinese or Korean. There is no language auto-detection: the models are
 * monolingual (Moonshine Base, a Chinese zipformer CTC), so a wrong guess does
 * not degrade gracefully, it produces nonsense.
 *
 * Only the transformers.js engines are built here. Both sherpa engines (Chinese
 * via SenseVoice, and the punctuated English one via NeMo CTC) run on a runtime
 * that can only be evaluated as a classic script, so they live in their own
 * worker (static/sherpa-asr.worker.js) and never reach this module worker at all.
 *
 * Note the argument: a *module*, not a language. English now has two modules and
 * the choice between them is the user's, so a language is not enough to say which
 * bytes should load.
 */
export function createEngine(module: ModuleId, plan: DevicePlan | null): AsrEngine {
  const spec = moduleSpec(module)
  if (spec.engine !== 'moonshine') {
    throw new Error(`${spec.label} 不在本 worker 中运行（${spec.engine} 有自己的 worker）`)
  }
  if (!plan) throw new Error(`没有为 ${spec.label} 决定用哪个加速器`)
  return new MoonshineEngine(module, plan)
}
