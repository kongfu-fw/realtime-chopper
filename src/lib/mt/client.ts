import type { Lang, LogLevel } from '../types'
import { cacheKey, getCached, putCached } from './cache'
import { providerChainFrom, type MtProviderId } from './providers'
import { PROMPT_VERSION } from './providers/llm'
import { normalizeKey } from './text'
import { MtError, type LlmConfig, type MtContext, type MtProvider } from './types'

/**
 * Translation client.
 *
 * Responsibilities, in the order a sentence travels through them:
 *   1. **Batch** — several sentences per request. Both keyless providers accept
 *      an array, and one request for five sentences costs a fifth of the API
 *      pressure that five requests do, which matters because the free Google key
 *      is rate-limited by someone else's budget.
 *   2. **De-duplicate** — repeated sentences inside one batch are translated
 *      once.
 *   3. **Cache** — provider-aware (see cache.ts).
 *   4. **Retry with backoff**, then **fall back to the next provider**, then
 *      **split the batch into single sentences** before declaring failure. That
 *      last step is the one that keeps a single awkward sentence from stalling a
 *      whole batch.
 */

export interface MtItem {
  id: number
  text: string
}

export interface MtItemResult {
  id: number
  text: string | null
  provider: string
  cached: boolean
  error?: string
  ms?: number
}

export interface MtConfig {
  provider: MtProviderId
  batchWindowMs: number
  useCache: boolean
  googleApiKey: string
  llm: LlmConfig
  sl: Lang
  tl: Lang
  /** Remembered by the session after a probe so a switch survives the session. */
  preferredProvider: MtProviderId | null
}

const MAX_BATCH = 20
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 400

export class MtClient {
  private pending: MtItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly getConfig: () => MtConfig,
    private readonly onResult: (result: MtItemResult) => void,
    private readonly onLog?: (level: LogLevel, message: string, detail?: unknown) => void,
  ) {}

  /** Queue sentences for translation. Results arrive through `onResult`. */
  enqueue(items: MtItem[]): void {
    if (items.length === 0) return
    this.pending.push(...items)
    this.schedule()
  }

  get queued(): number {
    return this.pending.length
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = []
  }

  /** One-shot translation used by the self-check and the settings test button. */
  async translateOnce(texts: string[], overrides?: Partial<MtConfig>): Promise<{ texts: string[]; provider: string }> {
    const config = { ...this.getConfig(), ...overrides }
    const provider = await this.dispatch(texts, config)
    return { texts: provider.texts, provider: provider.provider }
  }

  private schedule(): void {
    if (this.timer) return
    const window = Math.max(0, this.getConfig().batchWindowMs)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, window)
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return
    const batch = this.pending.splice(0, MAX_BATCH)
    const config = this.getConfig()

    // De-duplicate within the batch: Map preserves insertion order, which keeps
    // the request payload in the order the sentences were spoken.
    const groups = new Map<string, number[]>()
    for (const item of batch) {
      const key = normalizeKey(item.text)
      if (!key) {
        this.onResult({ id: item.id, text: '', provider: 'local', cached: false })
        continue
      }
      const ids = groups.get(key)
      if (ids) ids.push(item.id)
      else groups.set(key, [item.id])
    }

    const missing: string[] = []
    for (const [text, ids] of groups) {
      const hit = config.useCache ? this.lookup(text, config) : undefined
      if (hit) {
        for (const id of ids) this.onResult({ id, text: hit.text, provider: hit.provider, cached: true })
      } else {
        missing.push(text)
      }
    }

    if (missing.length > 0) {
      const started = performance.now()
      try {
        const { texts, provider } = await this.dispatch(missing, config)
        const ms = Math.round(performance.now() - started)
        texts.forEach((translated, index) => {
          const source = missing[index]!
          if (config.useCache) this.store(source, translated, config, provider)
          for (const id of groups.get(source) ?? []) {
            this.onResult({ id, text: translated, provider, cached: false, ms })
          }
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.onLog?.('warn', `整批翻译失败，改为逐句重试：${message}`)
        await this.dispatchIndividually(missing, config, groups)
      }
    }

    if (this.pending.length > 0) this.schedule()
  }

  /**
   * Walks the provider chain, retrying retryable failures with backoff before
   * moving on. Returns as soon as some provider answers.
   */
  private async dispatch(
    texts: string[],
    config: MtConfig,
  ): Promise<{ texts: string[]; provider: string }> {
    if (texts.length === 0) return { texts: [], provider: 'local' }
    const chain = providerChainFrom(config.provider, config.preferredProvider)
    const ctx: MtContext = {
      sl: config.sl,
      tl: config.tl,
      googleApiKey: config.googleApiKey,
      llm: config.llm,
      onDebug: (message, detail) => this.onLog?.('debug', message, detail),
    }
    let lastError: unknown
    for (const provider of chain) {
      if (!this.usable(provider, config)) continue
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const out = await provider.translate(texts, ctx)
          return { texts: out, provider: provider.id }
        } catch (err) {
          lastError = err
          const retryable = err instanceof MtError ? err.retryable : true
          if (!retryable) break
          if (attempt === MAX_ATTEMPTS) break
          const wait = BACKOFF_BASE_MS * attempt * attempt
          this.onLog?.('debug', `${provider.label} 第 ${attempt} 次失败，${wait}ms 后重试`, {
            error: err instanceof Error ? err.message : String(err),
          })
          await delay(wait)
        }
      }
      this.onLog?.('warn', `${provider.label} 不可用，尝试下一个翻译来源`, {
        error: lastError instanceof Error ? lastError.message : String(lastError),
      })
    }
    throw lastError instanceof Error ? lastError : new Error('所有翻译来源都失败了')
  }

  private async dispatchIndividually(
    texts: string[],
    config: MtConfig,
    groups: Map<string, number[]>,
  ): Promise<void> {
    for (const text of texts) {
      try {
        const { texts: out, provider } = await this.dispatch([text], config)
        const translated = out[0] ?? ''
        if (config.useCache) this.store(text, translated, config, provider)
        for (const id of groups.get(text) ?? []) {
          this.onResult({ id, text: translated, provider, cached: false })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.onLog?.('error', `这一句翻译失败了：${text.slice(0, 40)}`, { error: message })
        for (const id of groups.get(text) ?? []) {
          this.onResult({ id, text: null, provider: 'none', cached: false, error: message })
        }
      }
    }
  }

  /** A provider with no usable credentials is skipped instead of failing loudly. */
  private usable(provider: MtProvider, config: MtConfig): boolean {
    if (provider.id !== 'llm') return true
    if (config.llm.format === 'gemini') return config.llm.apiKey.trim().length > 0
    return config.llm.apiKey.trim().length > 0
  }

  private lookup(text: string, config: MtConfig): { text: string; provider: string } | undefined {
    for (const provider of providerChainFrom(config.provider, config.preferredProvider)) {
      const hit = getCached(this.keyFor(text, config, provider.id))
      if (hit !== undefined) return { text: hit, provider: provider.id }
    }
    return undefined
  }

  private store(text: string, translated: string, config: MtConfig, provider: string): void {
    putCached(this.keyFor(text, config, provider), translated)
  }

  private keyFor(text: string, config: MtConfig, provider: string): string {
    return cacheKey({
      provider,
      model: modelIdentity(provider, config),
      promptVersion: PROMPT_VERSION,
      sl: config.sl,
      tl: config.tl,
      text,
    })
  }
}

/**
 * The part of a provider's identity that invalidates cached translations when it
 * changes: swapping the LLM model must not reuse the previous model's output.
 */
export function modelIdentity(provider: string, config: MtConfig): string {
  if (provider === 'google') return 'wt_lib'
  if (provider === 'microsoft') return 'edge-translatetext'
  return `${config.llm.format}:${config.llm.model}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
