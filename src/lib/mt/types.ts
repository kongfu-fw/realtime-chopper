import type { Lang } from '../types'

export type LlmFormat = 'openai' | 'anthropic' | 'gemini'

export interface LlmConfig {
  format: LlmFormat
  baseUrl: string
  model: string
  apiKey: string
}

export interface MtContext {
  /** Source language is always known: the user picked it, and the recogniser is per-language. */
  sl: Lang
  tl: Lang
  /** Overrides the built-in Google widget key when the user supplies their own. */
  googleApiKey?: string
  llm?: LlmConfig
  signal?: AbortSignal
  onDebug?: (message: string, detail?: unknown) => void
}

export interface MtProvider {
  readonly id: string
  readonly label: string
  /** Whether one request may carry several sentences. */
  readonly supportsBatch: boolean
  /** Returns one translation per input, in order. Throws on failure. */
  translate(texts: string[], ctx: MtContext): Promise<string[]>
}

/**
 * Translation failure with a retry classification.
 *
 * The classification matters because the batch pipeline splits a failed batch
 * into single requests before giving up, and it must not do that for a 4xx that
 * will fail identically per sentence (a bad key), while it must do it for a 429
 * that may well succeed when the load is divided differently.
 */
export class MtError extends Error {
  readonly retryable: boolean
  readonly status?: number

  constructor(message: string, options: { retryable: boolean; status?: number; cause?: unknown } = { retryable: false }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MtError'
    this.retryable = options.retryable
    this.status = options.status
  }
}

export function classifyStatus(status: number): MtError {
  return new MtError(`翻译接口返回 HTTP ${status}`, {
    retryable: status === 408 || status === 425 || status === 429 || status >= 500,
    status,
  })
}
