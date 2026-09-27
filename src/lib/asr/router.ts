import type { AsrEngine, ModuleId } from '../types'
import { t } from '../i18n/index.ts'
import { moduleLabel, moduleSpec } from './models'
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
 * Only the transformers.js engine is built here. The sherpa one — Chinese
 * (SenseVoice) and Korean (Zipformer), which is one runtime with two packs — runs
 * on a runtime that can only be evaluated as a classic script, so it lives in its
 * own worker (static/sherpa-asr.worker.js) and never reaches this module worker at
 * all.
 *
 * Note the argument: a *module*, not a language. A module is a set of bytes that
 * answers a language; the two are mapped rather than equated, so a language alone
 * is not what decides which bytes load.
 */
export function createEngine(module: ModuleId, plan: DevicePlan | null): AsrEngine {
  const spec = moduleSpec(module)
  if (spec.engine !== 'moonshine') {
    throw new Error(
      t('{module} 不在本 worker 中运行（{engine} 有自己的 worker）', {
        module: moduleLabel(spec),
        engine: spec.engine,
      }),
    )
  }
  if (!plan) throw new Error(t('没有为 {module} 决定用哪个加速器', { module: moduleLabel(spec) }))
  return new MoonshineEngine(module, plan)
}
