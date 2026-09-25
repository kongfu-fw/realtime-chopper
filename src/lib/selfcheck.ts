import type { Lang, ModuleId } from './types'
import { getProvider, PROVIDER_LABEL, type MtProviderId } from './mt/providers'
import { probeProvider } from './mt/probe'
import { speechSnapshot } from './tts/speech'
import { createTtsEngine, type SpeakOutcome, type TtsConfig, type TtsEngine } from './tts/engine'
import { ASR_MODULES, MODULE_CACHE_KEYS, MODULE_IDS } from './asr/models'
import { planDevice } from './asr/moonshine'
import { isAppleMobile } from './asr/device'
import type { LlmConfig } from './mt/types'

/**
 * Built-in M0 self-check.
 *
 * The plan makes phase M0 a gate: the architecture rests on numbers that had to
 * be measured rather than assumed (is the speech model fast enough on this
 * device? do the translation endpoints answer from a page origin? can several
 * sentences go in one request? how many voices does this platform actually
 * expose?). Rather than a throwaway script, those measurements are a button in
 * the app, so the answers are available on the device that matters — the phone.
 *
 * It is deliberately read-only: the only thing it changes is a couple of
 * requests to public translation endpoints.
 */

export interface CheckResult {
  label: string
  ok: boolean | 'warn'
  detail: string
}

export interface SelfCheckReport {
  results: CheckResult[]
  provider: MtProviderId
}

export interface SelfCheckOptions {
  provider: MtProviderId
  sl: Lang
  tl: Lang
  googleApiKey: string
  llm: LlmConfig
  /**
   * The read-aloud engine the app is currently set to use.
   *
   * Travelled in rather than guessed: a report that measured the platform
   * synthesiser while the user reads through the Edge proxy would answer a
   * question nobody asked.
   */
  tts: TtsConfig
  /** Runs a short burst to see where rate limiting starts. Off by default. */
  burst?: boolean
}

export async function runSelfCheck(options: SelfCheckOptions): Promise<SelfCheckReport> {
  const results: CheckResult[] = []
  const ctx = {
    sl: options.sl,
    tl: options.tl,
    googleApiKey: options.googleApiKey,
    llm: options.llm,
  }

  // --- environment ---------------------------------------------------------
  results.push({
    label: '运行环境',
    ok: 'warn',
    detail: [
      `安全上下文：${window.isSecureContext ? '是' : '否（麦克风会不可用）'}`,
      `线程隔离（SharedArrayBuffer）：${crossOriginIsolated ? '是' : '否（WASM 单线程）'}`,
      `CPU 核心：${navigator.hardwareConcurrency || '未知'}`,
      `设备：${isAppleMobile() ? `iOS（网页可用内存约 1～1.5 GB）` : '非 iOS'}${
        (navigator as { deviceMemory?: number }).deviceMemory
          ? ` · 内存约 ${(navigator as { deviceMemory?: number }).deviceMemory} GB`
          : ''
      }`,
      `显示语言：${navigator.language}`,
    ].join(' · '),
  })

  // The same plan the pipeline will use, from the same function — a self-check
  // that answered this question its own way could promise a GPU the engine then
  // declines to try.
  const plan = planDevice('auto', 'high')
  results.push({
    label: '识别加速方式',
    ok: plan.primary.device === 'webgpu' ? true : 'warn',
    detail: `将使用 ${plan.primary.device}（${plan.primary.dtype}）—— ${plan.primary.reason}`,
  })

  // --- storage -------------------------------------------------------------
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate) {
      const quotaGb = (estimate.quota ?? 0) / 1024 / 1024 / 1024
      const usageMb = (estimate.usage ?? 0) / 1024 / 1024
      results.push({
        label: '存储空间',
        ok: quotaGb > 1 ? true : 'warn',
        detail: `可用配额约 ${quotaGb.toFixed(2)} GB，已用 ${usageMb.toFixed(1)} MB · 中文模块需要约 230 MB`,
      })
    } else {
      results.push({ label: '存储空间', ok: 'warn', detail: '这个浏览器不提供存储配额信息' })
    }
  } catch {
    results.push({ label: '存储空间', ok: 'warn', detail: '无法读取存储配额' })
  }

  // --- speech recognition modules -----------------------------------------
  for (const module of MODULE_IDS) {
    const spec = ASR_MODULES[module]
    const installed = await isModuleCached(module)
    results.push({
      label: `${spec.label}`,
      ok: installed ? true : 'warn',
      detail: installed
        ? '已缓存，可直接使用'
        : `未安装 · 约 ${(spec.approxBytes / 1024 / 1024).toFixed(0)} MB 下载`,
    })
  }

  // --- translation providers ----------------------------------------------
  for (const id of ['google', 'microsoft'] as MtProviderId[]) {
    const probe = await probeProvider(id, ctx)
    results.push({
      label: `${PROVIDER_LABEL[id]}连通性`,
      ok: probe.ok,
      detail: probe.ok ? `${probe.ms} ms 往返` : `不可用：${probe.detail ?? '未知原因'}`,
    })
  }

  if (options.llm.apiKey.trim() || options.llm.format === 'gemini') {
    const probe = await probeProvider('llm', ctx, 15000)
    results.push({
      label: `AI 模型连通性（${options.llm.model}）`,
      ok: probe.ok,
      detail: probe.ok ? `${probe.ms} ms 往返` : `不可用：${probe.detail ?? '未知原因'}`,
    })
  } else {
    results.push({ label: 'AI 模型连通性', ok: 'warn', detail: '未配置密钥，跳过' })
  }

  // --- batching behaviour --------------------------------------------------
  const primary = options.provider
  try {
    const provider = getProvider(primary)
    const samples = options.sl === 'en' ? ['hello world', 'good morning'] : ['你好，世界', '早上好']
    const started = performance.now()
    const out = await provider.translate(samples, ctx)
    const ms = Math.round(performance.now() - started)
    const aligned = out.length === samples.length && out.every((t) => typeof t === 'string' && t.length > 0)
    results.push({
      label: `${provider.label}批量能力`,
      ok: aligned,
      detail: aligned
        ? `一次请求 ${samples.length} 句正常，${ms} ms · 示例：${out[0]}`
        : `返回 ${out.length} 句，与请求的 ${samples.length} 句不匹配`,
    })
  } catch (err) {
    results.push({
      label: `${PROVIDER_LABEL[primary]}批量能力`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  // --- speech output -------------------------------------------------------
  // Whichever engine the app is set to. The label carries its name so a report
  // from a phone says which one was measured without anyone having to remember.
  const tts = createTtsEngine(options.tts)
  if (tts.available) {
    // Deduplicated: the target language is usually also in the fixed list, and
    // duplicate labels would collide as `{#each}` keys in the drawer.
    const langs = [...new Set<Lang>([options.tl, 'en', 'zh', 'ko'])]
    for (const lang of langs) {
      // A voice list that cannot be fetched is a result, not a crash: the Edge
      // engine's list lives behind the proxy, and "proxy down" is exactly what
      // this line is supposed to reveal.
      const voices = await tts.voicesFor(lang, 2500).catch(() => [])
      results.push({
        label: `${labelOf(lang)}朗读音色（${tts.label}）`,
        ok: voices.length > 0 ? true : 'warn',
        detail:
          voices.length > 0
            ? `${voices.length} 个可用 · 例：${voices.slice(0, 3).map((v) => v.name).join(' / ')}`
            : options.tts.engine === 'edge'
              ? 'TTS 代理没有返回音色：检查设置里的代理地址'
              : '没有可用音色，去系统里装一个',
      })
    }
    results.push(await speechProbe(tts, options.tl))
  } else {
    results.push({
      label: '朗读音色',
      ok: false,
      detail:
        options.tts.engine === 'edge' ? '没有填 TTS 代理地址' : '这个浏览器不支持 speechSynthesis',
    })
  }

  if (options.burst) {
    results.push(await burstProbe(primary, ctx))
  }

  return { results, provider: primary }
}

/**
 * Reads one sentence out loud and reports which ending it got.
 *
 * A voice list only proves the voices exist. It says nothing about whether
 * speech comes back: on iOS `speak()` is *accepted* and then never called back
 * from when the synthesizer was left paused (the page was backgrounded or the
 * screen locked mid-sentence), and a page holding the microphone open has its
 * system speech demoted to the receiver with no error at all. The Edge engine
 * fails differently again — a proxy that is down or a worker that answers 502.
 * All of it looks like "朗读坏掉了" and none of it throws where a user can see,
 * so the only way to tell the cases apart on a phone is to speak and see. This
 * line is loud on purpose — that is the measurement.
 */
async function speechProbe(engine: TtsEngine, lang: Lang): Promise<CheckResult> {
  const label = `朗读试读（${engine.label}）`
  // Platform-specific state, sampled before speaking: `speak()` resumes a
  // synthesizer the system left paused, so afterwards it reads false either way.
  const before = engine.id === 'system' ? speechSnapshot() : null
  const text = lang === 'en' ? 'Reading test, one two three.' : '朗读测试，一二三。'
  const started = performance.now()
  let outcome: SpeakOutcome
  try {
    outcome = await engine.speak(text, { rate: 1, lang })
  } catch (err) {
    // The Edge engine is the one that rejects; its message names the status.
    const reason = err instanceof Error ? err.message : String(err)
    return { label, ok: false, detail: `朗读请求失败：${reason}` }
  }
  const ms = Math.round(performance.now() - started)
  const context = [
    `引擎 ${engine.label}`,
    before ? `语音会话 ${before.session}` : '',
    before ? `系统音色 ${before.voices} 个` : '',
    before?.paused ? '原来是暂停状态（已恢复）' : '',
  ]
    .filter((part) => part !== '')
    .join(' · ')
  if (outcome === 'done') {
    return { label, ok: true, detail: `读完「${text}」用了 ${ms} ms · ${context}` }
  }
  if (outcome === 'stalled') {
    return {
      label,
      ok: false,
      detail: `发了朗读请求但一直没等到结束（等了 ${ms} ms）—— 听不到声音多半就是这种 · ${context}`,
    }
  }
  return { label, ok: false, detail: `朗读被拒绝了（${outcome}）· ${context}` }
}

/**
 * Short burst: five single-sentence requests back to back. Deliberately tiny —
 * the goal is to find out whether the free endpoints throttle a realtime app at
 * all, not to find the exact ceiling.
 */
async function burstProbe(
  provider: MtProviderId,
  ctx: { sl: Lang; tl: Lang; googleApiKey: string; llm?: LlmConfig },
): Promise<CheckResult> {
  const started = performance.now()
  const timings: number[] = []
  let failures = 0
  try {
    const translator = getProvider(provider)
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      try {
        await translator.translate([`probe sentence number ${i + 1}`], { ...ctx, sl: 'en' })
        timings.push(Math.round(performance.now() - t0))
      } catch {
        failures++
      }
    }
  } catch (err) {
    return { label: '连发探测', ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
  const total = Math.round(performance.now() - started)
  return {
    label: '连发探测（5 次单句）',
    ok: failures === 0 ? true : failures < 5 ? 'warn' : false,
    detail: `成功 ${5 - failures}/5 · 耗时 ${timings.join('/')} ms · 总计 ${total} ms${
      failures > 0 ? ' · 出现限流或失败，攒批与缓存是必需项' : ''
    }`,
  }
}

async function isModuleCached(module: ModuleId): Promise<boolean> {
  if (typeof caches === 'undefined') return false
  const owned = MODULE_CACHE_KEYS[module]
  try {
    // Residency means the module's own bucket is there: for sherpa that is the
    // bucket it writes, for Moonshine the transformers.js cache. The old prefix
    // guess (`rc-model-en-…`) was never a bucket that existed, so the English
    // module read as "not installed" on every device that had it.
    return (await caches.keys()).some((key) => owned.includes(key))
  } catch {
    return false
  }
}

function labelOf(lang: Lang): string {
  return lang === 'zh' ? '中文' : lang === 'ko' ? '韩语' : '英文'
}
