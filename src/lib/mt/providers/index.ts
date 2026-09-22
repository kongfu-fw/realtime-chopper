import type { MtProvider } from '../types'
import { googleProvider } from './google'
import { microsoftProvider } from './microsoft'
import { createLlmProvider } from './llm'

export type MtProviderId = 'google' | 'microsoft' | 'llm'

export const PROVIDERS: Record<MtProviderId, MtProvider> = {
  google: googleProvider,
  microsoft: microsoftProvider,
  llm: createLlmProvider(),
}

export const PROVIDER_LABEL: Record<MtProviderId, string> = {
  google: '谷歌翻译',
  microsoft: '微软翻译',
  llm: 'AI 模型',
}

export function getProvider(id: MtProviderId): MtProvider {
  return PROVIDERS[id]
}

/**
 * Ordered candidate list for a request.
 *
 * The user's choice comes first. The keyless providers follow as automatic
 * fallbacks because the primary's availability is not ours to control: the
 * Google widget key can be rate-limited, and Google as a whole is unreachable
 * from some networks. An LLM is never used as an implicit fallback — it costs
 * money and it is far slower, so it has to be chosen deliberately.
 */
export function providerChain(primary: MtProviderId): MtProvider[] {
  const chain: MtProvider[] = [PROVIDERS[primary]]
  if (primary !== 'google') chain.push(PROVIDERS.google)
  if (primary !== 'microsoft') chain.push(PROVIDERS.microsoft)
  return chain
}

/** Same list, but the browser remembers which provider last worked. */
export function providerChainFrom(primary: MtProviderId, preferred: MtProviderId | null): MtProvider[] {
  const chain = providerChain(primary)
  if (!preferred || preferred === primary) return chain
  const index = chain.findIndex((p) => p.id === preferred)
  if (index <= 0) return chain
  const [hit] = chain.splice(index, 1)
  return [hit!, ...chain]
}
