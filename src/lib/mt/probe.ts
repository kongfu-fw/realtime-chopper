import type { Lang } from '../types'
import { MtError, type MtContext } from './types'
import { getProvider, PROVIDERS, type MtProviderId } from './providers'

/**
 * Reachability probing.
 *
 * Google is unreachable from some networks, and when it is, requests usually
 * hang instead of failing fast. The plan therefore copies the one good idea
 * from the extension this project learned the endpoint from: run the smallest
 * possible real translation against the same endpoint the provider uses, with a
 * short timeout, and treat anything other than a clean answer as "unreachable".
 *
 * The probe runs once before the first request of a session and again whenever
 * the provider setting changes — never per sentence.
 */

export const GOOGLE_PROBE_TIMEOUT_MS = 3000

/**
 * Attempts per provider. A cold TLS connection legitimately needs more than one:
 * measured against Google's endpoint, the first request of a fresh page took
 * 8714 ms while the two after it took 28 ms and 31 ms. With a single 3 s probe
 * that cold start reads as "provider is down" and the whole session silently
 * degrades to the fallback — which is exactly what happened the first time this
 * ran for real. So a retryable failure is retried once (worst case 6 s) before
 * the provider is written off.
 */
const PROBE_ATTEMPTS = 2

export interface ProbeResult {
  provider: MtProviderId
  ok: boolean
  ms: number
  detail?: string
  /** How many requests it took; >1 means the first one hit a cold connection. */
  attempts?: number
}

interface ProbeAttempt extends ProbeResult {
  retryable: boolean
}

export async function probeProvider(
  provider: MtProviderId,
  ctx: MtContext,
  timeoutMs = GOOGLE_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  let attempts = 0
  let last: ProbeAttempt | null = null
  while (attempts < PROBE_ATTEMPTS) {
    attempts += 1
    last = await attemptProbe(provider, ctx, timeoutMs)
    if (last.ok) return { ...last, attempts }
    if (!last.retryable) break
    if (attempts < PROBE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  return {
    provider,
    ok: false,
    ms: last?.ms ?? 0,
    detail: last?.detail,
    attempts,
  }
}

async function attemptProbe(
  provider: MtProviderId,
  ctx: MtContext,
  timeoutMs: number,
): Promise<ProbeAttempt> {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const translator = getProvider(provider)
    const [translated] = await translator.translate(['hello'], {
      ...ctx,
      sl: 'en',
      tl: ctx.tl === 'en' ? 'zh' : ctx.tl,
      signal: controller.signal,
    })
    const ok = typeof translated === 'string' && translated.trim().length > 0
    return {
      provider,
      ok,
      ms: Math.round(performance.now() - started),
      retryable: true,
      ...(ok ? {} : { detail: '返回内容为空' }),
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      provider,
      ok: false,
      ms: Math.round(performance.now() - started),
      detail: aborted
        ? `等待 ${timeoutMs} ms 没有响应（可能是冷连接或网络不通）`
        : err instanceof Error
          ? err.message
          : String(err),
      // A rejected key or a malformed request stays rejected; everything else is
      // worth a second try on a connection that is now warm.
      retryable: err instanceof MtError ? err.retryable : true,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probes the keyless providers and returns the first that answers, honouring
 * the user's selection first so an explicit choice is never overridden by a
 * faster fallback.
 */
export async function resolveWorkingProvider(
  primary: MtProviderId,
  ctx: MtContext,
): Promise<{ provider: MtProviderId; results: ProbeResult[] }> {
  const order: MtProviderId[] = [primary]
  if (primary !== 'google') order.push('google')
  if (primary !== 'microsoft') order.push('microsoft')
  const results: ProbeResult[] = []
  for (const id of order) {
    const result = await probeProvider(id, ctx)
    results.push(result)
    if (result.ok) return { provider: id, results }
  }
  return { provider: primary, results }
}

export function providerLabel(id: MtProviderId): string {
  return PROVIDERS[id].label
}

export function needsKey(id: MtProviderId): boolean {
  return id === 'llm'
}

export type { Lang }
